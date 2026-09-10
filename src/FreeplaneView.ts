import { FileView, TFile, Notice, WorkspaceLeaf, Menu, MarkdownRenderer, Component } from "obsidian";
import { SnapshotHistory } from "./history";
import { parseMm, serializeDoc, serializeMm, nodeById, setText, toggleFolded, richContentSource, setRichContent, moveNode } from "./mm/xml";
import { layoutMap } from "./mm/layout";
import { toMarkdown } from "./mm/md";
import { renderMap } from "./mm/render";
import { askUnsaved } from "./ui/UnsavedPrompt";
import { settings } from "./settings";
import { matchAction } from "./hotkeys";
import { hashText, recoveryKey, readEnvelope, writeEnvelope, readCache, writeCache, deleteRecovery } from "./recovery";
import { askRecovery, askConfirm } from "./ui/RecoveryPrompt";

export const VIEW_TYPE_FREEPLANE = "freeplane-mm-view";

export class FreeplaneView extends FileView {
  plugin: any;
  doc: Document | null = null;
  originalText = "";
  dirty = false;
  loadedPath: string | null = null;
  pendingFile: TFile | null = null;
  history = new SnapshotHistory();
  layout: any = null;
  selectedId: string | null = null;
  selectedIds = new Set<string>();
  lastRichClick: any = null;
  zoom = 1;
  mdSizes: Record<string, { w: number; h: number }> = {};
  imageSizes: Record<string, { w: number; h: number }> = {};
  imageLoads = new Set<string>();
  mdComponent: any = null;
  mdPass = 0;
  richExpanded = new Set<string>();
  sidebarHidden = true;
  canvasEl!: HTMLElement;
  svg!: SVGSVGElement;
  sidebarEl!: HTMLElement;
  saving = false;
  lastSavedAt = 0;
  dragging: any = null;
  dropHint: any = null;
  panning: any = null;
  suppressNextClick = false;
  hoverLinkEl: any = null;
  hoverPop: any = null;
  recoveryTimer = 0;

  constructor(leaf: WorkspaceLeaf, plugin: any) { super(leaf); this.plugin = plugin; }
  getViewType(): string { return VIEW_TYPE_FREEPLANE; }
  getDisplayText(): string {
    if (this.loadedPath) return this.loadedPath.split("/").pop() || "Freeplane map";
    return this.file ? this.file.basename : "Freeplane map";
  }
  getIcon(): string { return "network"; }
  canAcceptExtension(extension: string): boolean { return extension === "mm"; }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("fp-view");
    this.canvasEl = this.contentEl.createDiv({ cls: "fp-canvas" });
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
    this.svg.setAttribute("class", "fp-svg");
    this.canvasEl.appendChild(this.svg);
    this.sidebarEl = this.contentEl.createDiv({ cls: "fp-sidebar" });
    if (this.sidebarHidden) this.sidebarEl.style.display = "none";

    // ALL hotkeys come from hotkeys.json, dispatched in capture phase
    this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
      if (this.app.workspace.activeLeaf !== this.leaf) return;
      if (this.isEditableTarget(e.target)) return;
      const action = matchAction(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      this.runAction(action);
    }, true);

    this.registerDomEvent(document, "pointermove", (e: PointerEvent) => this.onDragMove(e));
    this.registerDomEvent(document, "pointerup", (e: PointerEvent) => this.onDragEnd(e));
    this.registerDomEvent(this.canvasEl, "wheel", (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const step = e.deltaY > 0 ? -0.1 : 0.1;
      const nz = Math.min(3, Math.max(0.3, Math.round((this.zoom + step) * 100) / 100));
      if (nz === this.zoom) return;
      this.zoomAt(nz, e);
    }, { passive: false } as any);

    this.registerDomEvent(this.canvasEl, "click", (e: MouseEvent) => {
      if (this.suppressNextClick) { this.suppressNextClick = false; return; }
      if (this.isEditableTarget(e.target)) return;
      const t = e.target as Element;
      const link = t.closest ? t.closest("a.internal-link, a.external-link, .fp-rich-link") : null;
      if (link) {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault(); e.stopPropagation();
          const href = link.getAttribute("data-href") || link.getAttribute("href") || "";
          if (href) this.app.workspace.openLinkText(href, this.file?.path || "", false);
        }
        return;
      }
      if (t.closest && t.closest(".fp-node")) return;
      if (this.selectedId) { this.clearSelection(); this.renderAll(); }
    });

    this.registerDomEvent(this.canvasEl, "contextmenu", (e: MouseEvent) => {
      const t = e.target as Element;
      const link = t.closest?.("a.internal-link, a.external-link, .fp-rich-link");
      if (link) { e.preventDefault(); this.openLinkMenu(link, e); return; }
      if (t.closest && t.closest(".fp-node")) return;
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((it) => it.setTitle("Show/hide details").onClick(() => this.toggleAllDetails()));
      menu.addItem((it) => it.setTitle("Fit map").onClick(() => this.fitMap()));
      menu.addItem((it) => it.setTitle("Center map").onClick(() => this.centerOnContent()));
      menu.showAtMouseEvent(e);
    });

    this.registerDomEvent(this.canvasEl, "pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      const t = e.target as Element;
      if (t.closest && (t.closest(".fp-node") || t.closest(".fp-inline-edit") || t.closest("a"))) return;
      if (this.isEditableTarget(e.target)) return;
      this.hidePreview();
      this.panning = { startX: e.clientX, startY: e.clientY, scrollLeft: this.canvasEl.scrollLeft, scrollTop: this.canvasEl.scrollTop, moved: false };
    });
    this.registerDomEvent(document, "pointermove", (e: PointerEvent) => {
      if (!this.panning) return;
      const dx = e.clientX - this.panning.startX, dy = e.clientY - this.panning.startY;
      if (!this.panning.moved && Math.hypot(dx, dy) < 4) return;
      this.panning.moved = true;
      this.canvasEl.addClass("fp-panning");
      this.canvasEl.scrollLeft = this.panning.scrollLeft - dx;
      this.canvasEl.scrollTop = this.panning.scrollTop - dy;
    });
    this.registerDomEvent(document, "pointerup", () => {
      if (!this.panning) return;
      if (this.panning.moved) this.suppressNextClick = true;
      this.panning = null;
      this.canvasEl.removeClass("fp-panning");
    });

    this.registerDomEvent(this.canvasEl, "mouseover", (e: MouseEvent) => this.onLinkHoverOver(e));
    this.registerDomEvent(this.canvasEl, "mouseout", (e: MouseEvent) => this.onLinkHoverOut(e));
    this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => { if (e.key === "Control" || e.key === "Meta") this.setCtrlPreview(true); });
    this.registerDomEvent(document, "keyup", (e: KeyboardEvent) => { if (e.key === "Control" || e.key === "Meta") this.setCtrlPreview(false); });

    this.registerEvent(this.app.vault.on("modify", async (file) => {
      if (!(file instanceof TFile)) return;
      if (!this.file || file.path !== this.file.path) return;
      if (this.saving) return;
      if (Date.now() - this.lastSavedAt < 1000) return;
      if (this.dirty) { new Notice("Freeplane file changed on disk while you have unsaved edits."); return; }
      await this.loadFile(file);
    }));

    try {
      this.addAction("save", "Save map", () => this.save());
      this.addAction("undo-2", "Undo", () => this.undo());
      this.addAction("redo-2", "Redo", () => this.redo());
      this.addAction("panel-right", "Toggle side panel", () => this.toggleSidebar());
    } catch (e) { console.error("Freeplane: addAction failed", e); }

    const initialFile = this.file || this.pendingFile;
    if (initialFile) { try { await this.loadFile(initialFile); } catch {} }
  }

  /** Execute a hotkey action id defined in hotkeys.json. */
  runAction(id: string) {
    switch (id) {
      case "freeplane:save": this.save(); break;
      case "freeplane:undo": this.undo(); break;
      case "freeplane:redo": this.redo(); break;
      case "freeplane:rename": if (this.selectedId) this.startTextEdit(this.selectedId); break;
      case "freeplane:edit-details": if (this.selectedId) this.startRichEdit(this.selectedId, "DETAILS"); break;
      case "freeplane:edit-note": if (this.selectedId) this.startRichEdit(this.selectedId, "NOTE"); break;
      case "freeplane:toggle-preview": if (this.selectedId) this.toggleRichPreview(this.selectedId); break;
      case "freeplane:fold": if (this.selectedId) this.toggleFold(this.selectedId); break;
      case "freeplane:nav-up": this.selectSiblingNav(-1); break;
      case "freeplane:nav-down": this.selectSiblingNav(1); break;
      case "freeplane:nav-left": this.selectParentNav(); break;
      case "freeplane:nav-right": this.selectFirstChildNav(); break;
      case "freeplane:move-up": this.moveSelectedSibling(-1); break;
      case "freeplane:move-down": this.moveSelectedSibling(1); break;
      case "freeplane:promote": this.promoteSelected(); break;
      case "freeplane:demote": this.demoteSelected(); break;
      case "freeplane:new-sibling-below": this.createSiblingAfterSelected(); break;
      case "freeplane:new-sibling-above": this.createSiblingBeforeSelected(); break;
      case "freeplane:new-child": this.createChildOfSelected(); break;
      case "freeplane:delete": if (this.selectedId) this.deleteSelectedNodes(); break;
    }
  }

  async onUnloadFile(file: TFile) {
    try { await this.flushRecovery(); } catch {}
    const proto: any = Object.getPrototypeOf(Object.getPrototypeOf(this));
    try { if (proto?.onUnloadFile) await proto.onUnloadFile.call(this, file); } catch (e) { console.error(e); }
  }
  async onClose() {
    try { await this.flushRecovery(); } catch {}
    const proto: any = Object.getPrototypeOf(Object.getPrototypeOf(this));
    try { if (proto?.onClose) await proto.onClose.call(this); } catch (e) { console.error(e); }
  }

  async onLoadFile(file: TFile) {
    try {
      if (this.dirty && this.loadedPath && this.loadedPath !== file.path) {
        let action: "save" | "discard" | "cancel" = "cancel";
        try {
          action = await Promise.race([
            new Promise<"save" | "discard" | "cancel">((res) => window.setTimeout(() => askUnsaved(this.app, "You have unsaved changes in the current Freeplane map.").then(res), 0)),
            new Promise<"save" | "discard" | "cancel">((res) => window.setTimeout(() => res("cancel"), 8000))
          ]);
        } catch { action = "cancel"; }
        if (action === "save") await this.save();
        else if (action === "cancel") {
          new Notice("Switch cancelled. Save or discard changes first.");
          const cur = this.loadedPath ? this.app.vault.getAbstractFileByPath(this.loadedPath) : null;
          if (cur instanceof TFile) (this as any).file = cur;
          this.renderAll();
          return;
        }
      }
      await this.loadFile(file);
    } catch (e) {
      console.error("Freeplane: onLoadFile error:", e);
      this.renderError(String((e as any)?.message || e));
    }
  }

  async closeWithPrompt() {
    if (this.dirty) {
      const a = await askUnsaved(this.app, "You have unsaved changes in this Freeplane map.");
      if (a === "save") await this.save();
      else if (a === "cancel") return;
    }
    this.leaf.detach();
  }

  async loadFile(file: TFile) {
    if (!this.canvasEl) { this.pendingFile = file; return; }
    this.pendingFile = null;
    try {
      (this as any).file = file;
      const text = await this.app.vault.read(file);
      const rec = await this.checkRecovery(file, text);
      this.originalText = rec.mmText;
      this.doc = parseMm(rec.xml);
      this.mdSizes = {};
      this.imageSizes = {};
      this.imageLoads.clear();
      this.syncRichExpanded();
      this.loadedPath = file.path;
      this.history.clear();
      this.history.undoStack = rec.undo.slice(0, 50);   // restored undo history
      this.history.redoStack = rec.redo.slice(0, 50);
      this.dirty = rec.dirty;
      this.clearSelection();
      this.renderAll();
      this.centerOnContent();
      requestAnimationFrame(() => this.centerOnContent());
      window.setTimeout(() => this.centerOnContent(), 100);
    } catch (e: any) {
      this.doc = null; this.loadedPath = null;
      this.renderError(e?.message || String(e));
      throw e;
    }
  }

  renderError(message: string) {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Cannot open .mm file" });
    this.contentEl.createEl("pre", { text: message });
    this.contentEl.createEl("p", { text: "The file was not modified." });
  }

  async renderMarkdownPass() {
    const divs = Array.from(this.svg.querySelectorAll(".fp-md")) as HTMLElement[];
    if (divs.length === 0) return;
    const token = ++this.mdPass;
    const comp = new Component();
    try { this.addChild(comp); } catch {}
    const source = this.file?.path || "";
    await Promise.all(divs.map(async (div) => {
      const id = div.getAttribute("data-id") || "";
      const n = this.layout?.byId?.[id];
      if (!n) return;
      div.innerHTML = "";
      try { await (MarkdownRenderer as any).render(this.app, toMarkdown(n.text), div, source, comp); }
      catch { div.textContent = n.text; }
    }));
    if (token !== this.mdPass) return;
    const old = this.mdComponent;
    this.mdComponent = comp;
    if (old && old !== comp) { try { this.removeChild(old); } catch {} }
    if (this.measureMd(token)) this.renderAll();
    else window.setTimeout(() => { if (token === this.mdPass && this.measureMd(token)) this.renderAll(); }, 700);
  }

  measureMd(token: number): boolean {
    if (token !== this.mdPass) return false;
    const divs = Array.from(this.svg.querySelectorAll(".fp-md")) as HTMLElement[];
    let changed = false;
    for (const div of divs) {
      const id = div.getAttribute("data-id") || "";
      const w = Math.max(60, Math.ceil(div.scrollWidth) + 2);
      const h = Math.max(30, Math.ceil(div.scrollHeight) + 2);
      const used = this.mdSizes[id];
      if (!used || Math.abs(used.w - w) > 2 || Math.abs(used.h - h) > 2) { this.mdSizes[id] = { w, h }; changed = true; }
    }
    return changed;
  }

  zoomStep(delta: number) {
    const nz = Math.min(3, Math.max(0.1, Math.round((this.zoom + delta) * 100) / 100));
    if (nz === this.zoom) return;
    const r = this.canvasEl.getBoundingClientRect();
    this.zoomAt(nz, { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 } as any);
  }

  zoomAt(newZoom: number, e?: WheelEvent) {
    if (!this.svg || !this.layout) { this.zoom = newZoom; this.applyZoom(); return; }
    let u: { x: number; y: number } | null = null;
    if (this.selectedId) { const n = this.layout.byId[this.selectedId]; if (n) u = { x: n.x + n.width / 2, y: n.y + n.titleHeight / 2 }; }
    if (!u && e) u = clientToSvg(this.svg, e.clientX, e.clientY);
    let before: { x: number; y: number } | null = null;
    const c = this.canvasEl.getBoundingClientRect();
    if (u) {
      const pt = this.svg.createSVGPoint(); pt.x = u.x; pt.y = u.y;
      const ctm = this.svg.getScreenCTM();
      if (ctm) { const sp = pt.matrixTransform(ctm); before = { x: sp.x - c.left, y: sp.y - c.top }; }
    }
    this.zoom = newZoom;
    this.applyZoom();
    if (u && before) {
      const pt = this.svg.createSVGPoint(); pt.x = u.x; pt.y = u.y;
      const ctm2 = this.svg.getScreenCTM();
      const c2 = this.canvasEl.getBoundingClientRect();
      if (ctm2) {
        const sp = pt.matrixTransform(ctm2);
        const after = { x: sp.x - c2.left, y: sp.y - c2.top };
        this.canvasEl.scrollLeft += after.x - before.x;
        this.canvasEl.scrollTop += after.y - before.y;
      }
    }
  }

  onLinkHoverOver(e: MouseEvent) {
    const t = e.target as Element;
    const link = t.closest ? t.closest("a.internal-link, .fp-rich-link") : null;
    if (link === this.hoverLinkEl) return;
    this.hidePreview();
    this.hoverLinkEl = link;
    if (link && (e.ctrlKey || e.metaKey)) this.showPreview(link);
  }
  onLinkHoverOut(e: MouseEvent) {
    const t = e.target as Element;
    const link = t.closest ? t.closest("a.internal-link, .fp-rich-link") : null;
    if (!link) return;
    const to = e.relatedTarget as Element | null;
    if (to && link.contains(to)) return;
    this.hoverLinkEl = null;
    this.hidePreview();
  }
  setCtrlPreview(on: boolean) {
    if (on && this.hoverLinkEl) this.showPreview(this.hoverLinkEl);
    else if (!on) this.hidePreview();
  }
  async showPreview(link: Element) {
    this.hidePreview();
    const href = link.getAttribute("data-href") || link.getAttribute("href") || "";
    if (!href) return;
    const target = (this.app.metadataCache as any).getFirstLinkpathDest(href, this.file?.path || "");
    if (!target) return;
    const el = document.body.createDiv({ cls: "fp-preview" });
    const rect = link.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 420)) + "px";
    el.style.top = rect.bottom + 6 + "px";
    const comp = new Component();
    try { this.addChild(comp); } catch {}
    this.hoverPop = { el, comp };
    try {
      if (target.extension === "md") {
        const text = await this.app.vault.cachedRead(target);
        await (MarkdownRenderer as any).render(this.app, text, el, target.path, comp);
      } else {
        await (MarkdownRenderer as any).render(this.app, "![[" + target.name + "]]", el, this.file?.path || "", comp);
      }
    } catch { el.textContent = target.path; }
  }
  hidePreview() {
    if (!this.hoverPop) return;
    const pop = this.hoverPop;
    this.hoverPop = null;
    try { this.removeChild(pop.comp); } catch {}
    pop.el.remove();
  }

  fitMap() {
    if (!this.layout || !this.canvasEl) return;
    const b = this.layout.bounds as number[];
    if (!b) return;
    const bw = b[2] - b[0], bh = b[3] - b[1];
    if (bw <= 0 || bh <= 0) return;
    const pad = 40;
    const z = Math.min((this.canvasEl.clientWidth - 2 * pad) / bw, (this.canvasEl.clientHeight - 2 * pad) / bh);
    this.zoom = Math.min(3, Math.max(0.1, Math.round(z * 100) / 100));
    this.applyZoom();
    this.centerOnContent();
  }
  centerOnContent() {
    if (!this.layout || !this.canvasEl) return;
    const vb = this.layout.viewBox as number[], b = this.layout.bounds as number[];
    if (!vb || !b) return;
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    this.canvasEl.scrollLeft = (cx - vb[0]) * this.zoom - this.canvasEl.clientWidth / 2;
    this.canvasEl.scrollTop = (cy - vb[1]) * this.zoom - this.canvasEl.clientHeight / 2;
  }
  applyZoom() {
    if (!this.svg || !this.layout) return;
    this.svg.setAttribute("width", String(Math.round(this.layout.width * this.zoom)));
    this.svg.setAttribute("height", String(Math.round(this.layout.height * this.zoom)));
  }

  clearSelection() { this.selectedId = null; this.selectedIds.clear(); }
  selectOnly(id: string | null) {
    this.selectedId = id;
    this.selectedIds = id ? new Set([id]) : new Set();
  }
  selectNode(id: string, additive = false) {
    if (!additive) {
      if (this.selectedIds.size === 1 && this.selectedIds.has(id)) return;
      this.selectOnly(id);
    } else if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
      if (this.selectedId === id) this.selectedId = Array.from(this.selectedIds).pop() || null;
    } else {
      this.selectedIds.add(id);
      this.selectedId = id;
    }
    this.renderAll();
  }

  resolveImageUrl(uri: string): string {
    if (!uri) return "";
    try {
      const decoded = decodeURIComponent(uri).replace(/^file:\/\//i, "");
      const base = this.file?.parent?.path || "";
      const parts = (decoded.startsWith("/") ? decoded.slice(1) : (base ? base + "/" : "") + decoded).split("/");
      const clean: string[] = [];
      for (const part of parts) { if (!part || part === ".") continue; if (part === "..") clean.pop(); else clean.push(part); }
      const file = this.app.vault.getAbstractFileByPath(clean.join("/"));
      return file instanceof TFile ? this.app.vault.getResourcePath(file) : "";
    } catch { return ""; }
  }
  measureImage(id: string, url: string) {
    if (!url || this.imageSizes[id] || this.imageLoads.has(id)) return;
    this.imageLoads.add(id);
    const probe = new Image();
    probe.onload = () => {
      this.imageLoads.delete(id);
      const scale = Math.min(1, 480 / Math.max(1, probe.naturalWidth), 360 / Math.max(1, probe.naturalHeight));
      this.imageSizes[id] = { w: Math.max(40, probe.naturalWidth * scale), h: Math.max(30, probe.naturalHeight * scale) };
      this.renderAll();
    };
    probe.onerror = () => this.imageLoads.delete(id);
    probe.src = url;
  }

  openLinkMenu(link: Element, e: MouseEvent) {
    const href = link.getAttribute("data-href") || link.getAttribute("href") || "";
    if (!href) return;
    const menu = new Menu();
    menu.addItem((it) => it.setTitle("Open").onClick(() => this.openLink(href, false)));
    menu.addItem((it) => it.setTitle("Open in new tab").onClick(() => this.openLink(href, true)));
    menu.addItem((it) => it.setTitle("Open with default app").onClick(() => this.openLinkDefault(href)));
    menu.showAtMouseEvent(e);
  }
  openLink(href: string, newTab: boolean) {
    if (/^(https?|mailto):/i.test(href)) { window.open(href, newTab ? "_blank" : "_self"); return; }
    this.app.workspace.openLinkText(href, this.file?.path || "", newTab ? "tab" : false);
  }
  async openLinkDefault(href: string) {
    if (/^(https?|mailto):/i.test(href)) { window.open(href, "_blank"); return; }
    const target = (this.app.metadataCache as any).getFirstLinkpathDest(href, this.file?.path || "");
    if (!(target instanceof TFile)) { new Notice("Linked file not found."); return; }
    try {
      const appAny = this.app as any;
      const adapter = this.app.vault.adapter as any;
      const fullPath = typeof adapter.getFullPath === "function" ? adapter.getFullPath(target.path) : target.path;
      if (typeof appAny.openWithDefaultApp === "function") await appAny.openWithDefaultApp(fullPath);
      else {
        const electron = (window as any).require?.("electron");
        if (!electron?.shell?.openPath) throw new Error("Desktop shell is unavailable");
        const error = await electron.shell.openPath(fullPath);
        if (error) throw new Error(error);
      }
    } catch (err: any) { new Notice("Could not open with the default app: " + (err?.message || err)); }
  }

  renderAll() {
    if (!this.doc || !this.svg) return;
    if (!this.selectedId) this.selectedIds.clear();
    else if (!this.selectedIds.has(this.selectedId)) this.selectedIds = new Set([this.selectedId]);
    let anchor: { x: number; y: number } | null = null;
    if (this.svg.getAttribute("viewBox") && this.canvasEl.clientWidth > 0) {
      const r = this.canvasEl.getBoundingClientRect();
      anchor = clientToSvg(this.svg, r.left + r.width / 2, r.top + r.height / 2);
    }
    this.layout = layoutMap(this.doc, this.richExpanded, this.mdSizes, this.imageSizes);
    renderMap(this.svg, this.layout, this.selectedIds, {
      select: (id: string, e: MouseEvent) => this.selectNode(id, e.shiftKey),
      toggleFold: (id: string) => this.toggleFold(id),
      toggleRich: (id: string) => this.toggleRichPreview(id),
      startDrag: (id: string, e: PointerEvent) => this.startDrag(id, e),
      editText: (id: string) => this.startTextEdit(id),
      editRich: (id: string, type: "DETAILS" | "NOTE") => this.startRichEdit(id, type),
      richClick: (id: string, type: "DETAILS" | "NOTE") => this.richLineClicked(id, type),
      contextMenu: (id: string, e: MouseEvent) => this.openNodeMenu(id, e),
      linkContextMenu: (link: Element, e: MouseEvent) => this.openLinkMenu(link, e),
      imageUrl: (uri: string) => this.resolveImageUrl(uri),
      imageLoaded: (id: string, image: SVGImageElement) => this.measureImage(id, image.getAttribute("href") || "")
    });
    this.applyZoom();
    if (anchor) {
      const pt = this.svg.createSVGPoint(); pt.x = anchor.x; pt.y = anchor.y;
      const ctm = this.svg.getScreenCTM();
      if (ctm) {
        const sp = pt.matrixTransform(ctm);
        const r2 = this.canvasEl.getBoundingClientRect();
        this.canvasEl.scrollLeft += sp.x - (r2.left + r2.width / 2);
        this.canvasEl.scrollTop += sp.y - (r2.top + r2.height / 2);
      }
    }
    this.renderMarkdownPass();
    this.renderSidebar();
    (this.leaf as any).updateHeader?.();
  }

  renderSidebar() {
    this.sidebarEl.empty();
    if (!this.doc) return;
    if (!this.selectedId) {
      const zr = this.sidebarEl.createDiv({ cls: "fp-zoom-row" });
      zr.createEl("button", { text: "+" }).addEventListener("click", () => this.zoomStep(0.1));
      zr.createEl("button", { text: "−" }).addEventListener("click", () => this.zoomStep(-0.1));
      if (this.dirty) {
        const rbRow = this.sidebarEl.createDiv({ cls: "fp-zoom-row" });
        rbRow.createEl("button", { text: "Roll back to last save" }).addEventListener("click", () => this.rollbackToSaved());
      }
      this.sidebarEl.createEl("p", { text: "Select a node. Double-click to edit its text. Drag nodes to move them." });
      this.sidebarEl.createEl("p", { text: "Hotkeys are configured in hotkeys.json (plugin folder)." });
      return;
    }
    const el = nodeById(this.doc, this.selectedId);
    if (!el) { this.clearSelection(); this.renderSidebar(); return; }
    this.sidebarEl.createEl("h3", { text: "Node" });
    const idEl = this.sidebarEl.createEl("code");
    idEl.textContent = "ID: " + (el.getAttribute("ID") || "(none)");
    this.sidebarEl.createEl("label", { text: "Text" });
    const textInput = this.sidebarEl.createEl("textarea") as HTMLTextAreaElement;
    textInput.rows = 3;
    this.attachSuggest(textInput);
    textInput.value = el.getAttribute("TEXT") || "";
    this.sidebarEl.createEl("label", { text: "DETAILS richcontent" });
    const details = this.sidebarEl.createEl("textarea");
    this.attachSuggest(details);
    details.value = richContentSource(el, "DETAILS");
    this.sidebarEl.createEl("label", { text: "NOTE richcontent" });
    const note = this.sidebarEl.createEl("textarea");
    this.attachSuggest(note);
    note.value = richContentSource(el, "NOTE");
    const update = this.sidebarEl.createEl("button", { text: "Update node", cls: "mod-cta" });
    const doUpdate = () => {
      try { this.updateWholeNode(this.selectedId!, textInput.value, details.value, note.value); new Notice("Node updated."); }
      catch (e: any) { new Notice("Node not updated: " + (e?.message || String(e))); }
    };
    update.addEventListener("click", doUpdate);
  }

  richLineClicked(id: string, type: "DETAILS" | "NOTE") {
    const now = Date.now();
    const last = this.lastRichClick;
    if (last && last.id === id && last.type === type && now - last.time < 450) { this.lastRichClick = null; this.startRichEdit(id, type); }
    else this.lastRichClick = { id, type, time: now };
  }
  selectSiblingNav(dir: -1 | 1) {
    if (!this.doc || !this.selectedId) return;
    const el = nodeById(this.doc, this.selectedId);
    if (!el || !el.parentElement) return;
    const sibs = this.nodeChildren(el.parentElement);
    if (sibs.length === 0) return;
    const idx = sibs.indexOf(el);
    const id = sibs[(idx + dir + sibs.length) % sibs.length].getAttribute("ID");
    if (id) { this.selectedId = id; this.renderAll(); }
  }
  selectParentNav() {
    if (!this.doc || !this.selectedId) return;
    const el = nodeById(this.doc, this.selectedId);
    if (!el) return;
    const p = el.parentElement;
    if (!p || p.nodeName.toLowerCase() !== "node") return;
    const id = p.getAttribute("ID");
    if (id) { this.selectedId = id; this.renderAll(); }
  }
  selectFirstChildNav() {
    if (!this.doc || !this.selectedId) return;
    const el = nodeById(this.doc, this.selectedId);
    if (!el) return;
    const before = serializeDoc(this.doc);
    let changed = false;
    if (el.getAttribute("FOLDED") === "true") { el.removeAttribute("FOLDED"); changed = true; }
    const first = this.nodeChildren(el)[0];
    if (!first) {
      const p = el.parentElement;
      if (p && p.nodeName.toLowerCase() === "node") {
        const sibs = this.nodeChildren(p);
        const idx = sibs.indexOf(el);
        const tgt = idx === 0 ? sibs[sibs.length - 1] : sibs[0];
        if (tgt) { this.selectedId = tgt.getAttribute("ID"); if (changed) this.commit(before); else this.renderAll(); }
      }
      return;
    }
    if (first.getAttribute("FOLDED") === "true") { first.removeAttribute("FOLDED"); changed = true; }
    this.selectedId = first.getAttribute("ID");
    if (changed) this.commit(before); else this.renderAll();
  }

  openNodeMenu(id: string, e: MouseEvent) {
    if (!this.selectedIds.has(id)) { this.selectOnly(id); this.renderAll(); }
    const menu = new Menu();
    menu.addItem((it) => it.setTitle("Rename").onClick(() => this.startTextEdit(id)));
    menu.addItem((it) => it.setTitle("Edit details").onClick(() => this.startRichEdit(id, "DETAILS")));
    menu.addItem((it) => it.setTitle("Edit note").onClick(() => this.startRichEdit(id, "NOTE")));
    menu.addItem((it) => it.setTitle(this.selectedIds.size > 1 ? "Delete selected" : "Delete").onClick(() => this.deleteSelectedNodes()));
    menu.addItem((it) => it.setTitle("Collapse all").onClick(() => this.collapseChildren(id)));
    menu.addItem((it) => it.setTitle("Expand all").onClick(() => this.expandAll(id)));
    menu.showAtMouseEvent(e);
  }
  deleteNode(id: string) {
    this.selectOnly(id);
    this.deleteSelectedNodes();
  }
  selectedTopNodes(): Element[] {
    if (!this.doc) return [];
    const all = Array.from(this.selectedIds).map((id) => nodeById(this.doc!, id)).filter((el): el is Element => !!el);
    return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
  }
  deleteSelectedNodes() {
    if (!this.doc || !this.selectedId) return;
    const nodes = this.selectedTopNodes();
    if (!nodes.length) return;
    const primary = nodeById(this.doc, this.selectedId) || nodes[nodes.length - 1];
    const parent = primary.parentElement;
    if (!parent || parent.nodeName.toLowerCase() !== "node") return;
    const selected = new Set(nodes);
    const siblings = this.nodeChildren(parent);
    const index = siblings.indexOf(primary);
    let nextSelection: Element | null = null;
    for (let i = index - 1; i >= 0; i--) { if (!selected.has(siblings[i])) { nextSelection = siblings[i]; break; } }
    if (!nextSelection) for (let i = index + 1; i < siblings.length; i++) { if (!selected.has(siblings[i])) { nextSelection = siblings[i]; break; } }
    if (!nextSelection) nextSelection = parent;
    const before = serializeDoc(this.doc);
    nodes.forEach((el) => el.remove());
    this.selectOnly(nextSelection.getAttribute("ID"));
    this.commit(before);
  }
  toggleAllDetails() {
    if (!this.doc) return;
    const rcs = Array.from(this.doc.querySelectorAll('richcontent[TYPE="DETAILS"], richcontent[TYPE="NOTE"]'));
    if (!rcs.length) { new Notice("This map has no details or notes."); return; }
    const show = rcs.some((rc) => rc.getAttribute("HIDDEN") === "true");
    const before = serializeDoc(this.doc);
    rcs.forEach((rc) => { if (show) rc.removeAttribute("HIDDEN"); else rc.setAttribute("HIDDEN", "true"); });
    this.commit(before);
  }
  collapseChildren(id: string) { this.setFoldRecursive(id, true); }
  expandAll(id: string) { this.setFoldRecursive(id, false); }
  setFoldRecursive(id: string, folded: boolean) {
    if (!this.doc || !id) return;
    const el = nodeById(this.doc, id);
    if (!el) return;
    const before = serializeDoc(this.doc);
    const targets = [el, ...Array.from(el.querySelectorAll("node"))];
    let changed = false;
    for (const t of targets) {
      const has = t.getAttribute("FOLDED") === "true";
      if (folded && !has) { if (this.nodeChildren(t).length > 0) { t.setAttribute("FOLDED", "true"); changed = true; } }
      else if (!folded && has) { t.removeAttribute("FOLDED"); changed = true; }
    }
    if (changed) this.commit(before);
  }
  toggleSidebar(forceHidden?: boolean) {
    this.sidebarHidden = typeof forceHidden === "boolean" ? forceHidden : !this.sidebarHidden;
    if (this.sidebarEl) this.sidebarEl.style.display = this.sidebarHidden ? "none" : "";
  }
  syncRichExpanded() {
    this.richExpanded = new Set<string>();
    if (!this.doc) return;
    this.doc.querySelectorAll("richcontent").forEach((rc: any) => {
      const type = rc.getAttribute("TYPE");
      if (type !== "DETAILS" && type !== "NOTE") return;
      if (rc.getAttribute("HIDDEN") === "true") return;
      const p = rc.parentElement;
      if (p && p.nodeName.toLowerCase() === "node") { const id = p.getAttribute("ID"); if (id) this.richExpanded.add(id); }
    });
  }
  toggleRichPreview(id: string) {
    if (!this.doc) return;
    const el = nodeById(this.doc, id);
    if (!el) return;
    const rcs = Array.from(el.children).filter((c) => c.nodeName.toLowerCase() === "richcontent" && (c.getAttribute("TYPE") === "DETAILS" || c.getAttribute("TYPE") === "NOTE"));
    if (rcs.length === 0) return;
    const showing = this.richExpanded.has(id);
    const before = serializeDoc(this.doc);
    rcs.forEach((rc) => { if (showing) rc.setAttribute("HIDDEN", "true"); else rc.removeAttribute("HIDDEN"); });
    this.syncRichExpanded();
    this.selectedId = id;
    this.commit(before);
  }
  updateWholeNode(id: string, text: string, details: string, note: string) {
    if (!this.doc) return;
    const el = nodeById(this.doc, id);
    if (!el) return;
    const before = serializeDoc(this.doc);
    setText(el, text);
    setRichContent(this.doc, el, "DETAILS", details);
    setRichContent(this.doc, el, "NOTE", note);
    this.commit(before);
  }
  updateRichContent(id: string, type: "DETAILS" | "NOTE", source: string) {
    if (!this.doc) return;
    const el = nodeById(this.doc, id);
    if (!el) return;
    const before = serializeDoc(this.doc);
    setRichContent(this.doc, el, type, source);
    this.commit(before);
  }

  createMmNode(text = ""): Element | null {
    if (!this.doc) return null;
    const el = this.doc.createElement("node");
    const now = String(Date.now());
    if (text) el.setAttribute("TEXT", text);
    el.setAttribute("ID", this.generateNodeId());
    el.setAttribute("CREATED", now);
    el.setAttribute("MODIFIED", now);
    return el;
  }
  generateNodeId(): string {
    if (!this.doc) return "ID_" + Math.random().toString(36).slice(2, 10);
    const existing = new Set<string>();
    this.doc.querySelectorAll("node[ID]").forEach((n) => { const id = n.getAttribute("ID"); if (id) existing.add(id); });
    let id = "";
    do { id = "ID_" + Math.floor(Math.random() * 1000000000); } while (existing.has(id));
    return id;
  }
  nodeChildren(el: Element): Element[] { return Array.from(el.children).filter((c) => c.nodeName.toLowerCase() === "node"); }
  nextNodeSibling(el: Element): Element | null { let n = el.nextElementSibling; while (n && n.nodeName.toLowerCase() !== "node") n = n.nextElementSibling; return n; }
  prevNodeSibling(el: Element): Element | null { let n = el.previousElementSibling; while (n && n.nodeName.toLowerCase() !== "node") n = n.previousElementSibling; return n; }

  moveSelectedSibling(dir: -1 | 1) {
    if (!this.doc || !this.selectedId) return;
    const el = nodeById(this.doc, this.selectedId);
    if (!el || !el.parentElement) return;
    const parent = el.parentElement;
    const sibs = this.nodeChildren(parent);
    const idx = sibs.indexOf(el);
    if (idx < 0 || sibs.length < 2) return;
    const before = serializeDoc(this.doc);
    if (dir < 0) { if (idx === 0) parent.insertBefore(el, this.nextNodeSibling(sibs[sibs.length - 1])); else parent.insertBefore(el, sibs[idx - 1]); }
    else { if (idx === sibs.length - 1) parent.insertBefore(el, sibs[0]); else parent.insertBefore(el, this.nextNodeSibling(sibs[idx + 1])); }
    this.commit(before);
  }
  promoteSelected() {
    if (!this.doc || !this.selectedId) return;
    const el = nodeById(this.doc, this.selectedId);
    if (!el) return;
    const parent = el.parentElement;
    if (!parent || parent.nodeName.toLowerCase() !== "node") return;
    const grand = parent.parentElement;
    if (!grand || grand.nodeName.toLowerCase() === "map") return;
    const before = serializeDoc(this.doc);
    grand.insertBefore(el, this.nextNodeSibling(parent));
    el.removeAttribute("POSITION");
    this.commit(before);
  }
  demoteSelected() {
    if (!this.doc || !this.selectedId) return;
    const el = nodeById(this.doc, this.selectedId);
    if (!el) return;
    const prev = this.prevNodeSibling(el);
    if (!prev) return;
    const before = serializeDoc(this.doc);
    prev.appendChild(el);
    prev.removeAttribute("FOLDED");
    el.removeAttribute("POSITION");
    this.commit(before);
  }
  createSiblingBeforeSelected() {
    if (!this.doc || !this.selectedId) return;
    const cur = nodeById(this.doc, this.selectedId);
    if (!cur || !cur.parentElement) return;
    const parent = cur.parentElement;
    if (parent.nodeName.toLowerCase() === "map") return;
    const node = this.createMmNode();
    if (!node) return;
    if (parent.parentElement?.nodeName.toLowerCase() === "map") node.setAttribute("POSITION", cur.getAttribute("POSITION") || "right");
    const before = serializeDoc(this.doc);
    parent.insertBefore(node, cur);
    this.selectedId = node.getAttribute("ID");
    this.commit(before);
    window.setTimeout(() => { if (this.selectedId) this.startTextEdit(this.selectedId); }, 0);
  }
  createSiblingAfterSelected() {
    if (!this.doc || !this.selectedId) return;
    const cur = nodeById(this.doc, this.selectedId);
    if (!cur || !cur.parentElement) return;
    const parent = cur.parentElement;
    if (parent.nodeName.toLowerCase() === "map") return;
    const node = this.createMmNode();
    if (!node) return;
    if (parent.parentElement?.nodeName.toLowerCase() === "map") node.setAttribute("POSITION", cur.getAttribute("POSITION") || "right");
    const before = serializeDoc(this.doc);
    parent.insertBefore(node, this.nextNodeSibling(cur));
    this.selectedId = node.getAttribute("ID");
    this.commit(before);
    window.setTimeout(() => { if (this.selectedId) this.startTextEdit(this.selectedId); }, 0);
  }
  createChildOfSelected() {
    if (!this.doc || !this.selectedId) return;
    const cur = nodeById(this.doc, this.selectedId);
    if (!cur) return;
    const node = this.createMmNode();
    if (!node) return;
    if (cur.parentElement?.nodeName.toLowerCase() === "map") node.setAttribute("POSITION", "right");
    const before = serializeDoc(this.doc);
    cur.appendChild(node);
    cur.removeAttribute("FOLDED");
    this.selectedId = node.getAttribute("ID");
    this.commit(before);
    window.setTimeout(() => { if (this.selectedId) this.startTextEdit(this.selectedId); }, 0);
  }

  updateNodeText(id: string, text: string) {
    if (!this.doc) return;
    const el = nodeById(this.doc, id);
    if (!el) return;
    if ((el.getAttribute("TEXT") || "") === text) return;
    const before = serializeDoc(this.doc);
    setText(el, text);
    delete this.mdSizes[id];
    this.commit(before);
  }
  toggleFold(id: string) {
    if (!this.doc) return;
    const el = nodeById(this.doc, id);
    if (!el) return;
    const before = serializeDoc(this.doc);
    if (!toggleFolded(el)) return;
    this.commit(before);
  }
  applyRichContent(type: "DETAILS" | "NOTE", source: string) {
    if (!this.doc || !this.selectedId) return;
    const el = nodeById(this.doc, this.selectedId);
    if (!el) return;
    const before = serializeDoc(this.doc);
    setRichContent(this.doc, el, type, source);
    this.commit(before);
  }
  commit(before: string) { this.history.push(before); this.dirty = true; this.syncRichExpanded(); this.renderAll(); this.scheduleRecovery(); }
  undo() { if (!this.doc) return; const c = serializeDoc(this.doc); const p = this.history.undo(c); if (!p) { new Notice("Nothing to undo."); return; } this.restoreSnapshot(p); }
  redo() { if (!this.doc) return; const c = serializeDoc(this.doc); const n = this.history.redo(c); if (!n) { new Notice("Nothing to redo."); return; } this.restoreSnapshot(n); }
  restoreSnapshot(xml: string) { try { this.doc = parseMm(xml); this.syncRichExpanded(); this.dirty = true; this.renderAll(); } catch { new Notice("Could not restore snapshot."); } }

  async save(force = false) {
    if (!this.doc || !this.file) { new Notice("No Freeplane map is open."); return; }
    if (!this.dirty && !force) { new Notice("No changes to save."); return; }
    const xml = serializeMm(this.doc, this.originalText);
    try { parseMm(xml); } catch (e: any) { new Notice("Refusing to save invalid XML: " + (e?.message || String(e))); return; }
    this.saving = true;
    try {
      const vault = this.app.vault as any;
      if (typeof vault.process === "function") await vault.process(this.file, () => xml);
      else await this.app.vault.modify(this.file, xml);
      this.originalText = xml;
      this.dirty = false;
      this.lastSavedAt = Date.now();
      await this.clearRecovery();
      new Notice("Saved Freeplane map.");
      (this.leaf as any).updateHeader?.();
    } finally { this.saving = false; }
  }

  startDrag(id: string, e: PointerEvent) {
    if (!this.doc || e.button !== 0) return;
    e.preventDefault();
    const el = nodeById(this.doc, id);
    if (!el) return;
    const wasSelected = this.selectedIds.has(id);
    let els = wasSelected ? this.selectedTopNodes() : [el];
    if (!wasSelected && e.shiftKey) {
      const existing = this.selectedTopNodes();
      els = [...existing, el].filter((n, i, all) => !all.some((other, j) => i !== j && other.contains(n)));
    }
    this.dragging = { id, el, ids: els.map((n) => n.getAttribute("ID") || ""), els, wasSelected, additive: e.shiftKey,
      startX: e.clientX, startY: e.clientY, started: false };
  }
  onDragMove(e: PointerEvent) {
    if (!this.dragging || !this.layout) return;
    if (!this.dragging.started) {
      const dx = e.clientX - this.dragging.startX, dy = e.clientY - this.dragging.startY;
      if (Math.hypot(dx, dy) < 5) return;
      this.dragging.started = true;
      if (!this.dragging.wasSelected) {
        if (this.dragging.additive) { this.selectedIds.add(this.dragging.id); this.selectedId = this.dragging.id; }
        else this.selectOnly(this.dragging.id);
      }
      this.canvasEl.addClass("fp-dragging");
    }
    const pt = clientToSvg(this.svg, e.clientX, e.clientY);
    this.dropHint = this.hitTest(pt);
    this.updateDropOverlay();
  }
  onDragEnd(_e: PointerEvent) {
    if (!this.dragging) return;
    const drag = this.dragging, hint = this.dropHint;
    this.dragging = null; this.dropHint = null;
    this.canvasEl.removeClass("fp-dragging");
    this.updateDropOverlay();
    if (!drag.started || !hint || !this.doc) return;
    this.suppressNextClick = true;
    if (drag.ids.includes(hint.id)) return;
    const before = serializeDoc(this.doc);
    const ordered = [...drag.els].sort((a: Element, b: Element) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
    if (hint.mode === "after") ordered.reverse();
    let changed = false;
    for (const el of ordered) {
      const id = el.getAttribute("ID") || "";
      changed = moveNode(this.doc, id, hint.id, hint.mode, hint.side) || changed;
    }
    if (changed) this.commit(before); else this.renderAll();
  }
  hitTest(pt: { x: number; y: number }) {
    if (!this.layout || !this.dragging) return null;
    const nodes = this.layout.nodes as any[];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const pad = 20;
      const inside = pt.x >= n.x - pad && pt.x <= n.x + n.width + pad && pt.y >= n.y - pad && pt.y <= n.y + n.height + pad;
      if (!inside) continue;
      if (this.dragging.ids.includes(n.id)) continue;
      if (this.dragging.els.some((el: Element) => el.contains(n.el))) continue;
      let mode: "child" | "before" | "after" = "child";
      if (n.depth > 0) { const top = n.y + n.height * 0.25, bottom = n.y + n.height * 0.75; if (pt.y < top) mode = "before"; else if (pt.y > bottom) mode = "after"; }
      if (n.depth === 0 && mode !== "child") continue;
      return { id: n.id, mode, side: this.sideFromPoint(pt) };
    }
    return null;
  }
  sideFromPoint(pt: { x: number; y: number }): "left" | "right" {
    const root = this.layout?.byId?.[this.layout?.rootId];
    if (!root) return "right";
    return pt.x < root.x + root.width / 2 ? "left" : "right";
  }
  updateDropOverlay() {
    let overlay = this.svg.querySelector("#fp-drop") as SVGRectElement | null;
    if (!this.dropHint) { overlay?.remove(); return; }
    const n = this.layout?.byId?.[this.dropHint.id];
    if (!n) { overlay?.remove(); return; }
    if (!overlay) { overlay = document.createElementNS("http://www.w3.org/2000/svg", "rect"); overlay.id = "fp-drop"; this.svg.appendChild(overlay); }
    overlay.setAttribute("class", "fp-drop fp-drop-" + this.dropHint.mode);
    if (this.dropHint.mode === "child") {
      overlay.setAttribute("x", String(n.x - 2)); overlay.setAttribute("y", String(n.y - 2));
      overlay.setAttribute("width", String(n.width + 4)); overlay.setAttribute("height", String(n.height + 4)); overlay.setAttribute("rx", "8");
    } else {
      const lineY = this.dropHint.mode === "before" ? n.y - 2 : n.y + n.height + 2;
      overlay.setAttribute("x", String(n.x)); overlay.setAttribute("y", String(lineY - 1));
      overlay.setAttribute("width", String(n.width)); overlay.setAttribute("height", "2"); overlay.setAttribute("rx", "1");
    }
  }

  startTextEdit(id: string) {
    const n = this.layout?.byId?.[id];
    if (!n) return;
    const nodeG = this.svg.querySelector('.fp-node[data-id="' + cssEscape(id) + '"]') as SVGGElement | null;
    if (!nodeG) return;
    const box = nodeG.getBoundingClientRect();
    const canvasBox = this.canvasEl.getBoundingClientRect();
    const input = this.canvasEl.createEl("textarea", { cls: "fp-inline-edit" }) as HTMLTextAreaElement;
    this.attachSuggest(input);
    input.value = n.text || "";
    input.style.left = (box.left - canvasBox.left + this.canvasEl.scrollLeft) + "px";
    input.style.top = (box.top - canvasBox.top + this.canvasEl.scrollTop) + "px";
    const scale = box.width / Math.max(n.width, 1);
    const resizeEdit = () => {
      const fs = 13 * scale;
      input.style.fontSize = fs + "px";
      const lines = input.value.split("\n");
      let longest = 0, visual = 0;
      for (const ln of lines) { longest = Math.max(longest, ln.length); visual += Math.max(1, Math.ceil(ln.length / settings.nodeMaxWidthSymbols)); }
      const chars = Math.min(Math.max(longest, 8), settings.nodeMaxWidthSymbols);
      input.style.width = Math.max(chars * fs * 0.55 + 24, box.width) + "px";
      input.style.height = Math.max(visual * fs * 1.35 + 14, box.height) + "px";
    };
    resizeEdit();
    input.addEventListener("input", resizeEdit);
    let done = false;
    const commit = () => { if (done) return; done = true; const v = input.value; input.remove(); this.updateNodeText(id, v); };
    const cancel = () => { if (done) return; done = true; input.remove(); };
    input.addEventListener("keydown", (e: KeyboardEvent) => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); } if (e.key === "Escape") { e.preventDefault(); cancel(); } });
    input.addEventListener("blur", () => commit());
    this.canvasEl.appendChild(input);
    input.focus();
    const tl = input.value.length;
    input.setSelectionRange(tl, tl);
  }

  startRichEdit(id: string, type: "DETAILS" | "NOTE") {
    if (!this.doc) return;
    const n = this.layout?.byId?.[id];
    const el = nodeById(this.doc, id);
    if (!n || !el) return;
    const richEl = this.svg.querySelector('.fp-rich-line[data-id="' + cssEscape(id) + '"][data-type="' + type + '"], .fp-rich-label[data-id="' + cssEscape(id) + '"][data-type="' + type + '"]') as SVGElement | null;
    const box = richEl ? richEl.getBoundingClientRect() : this.svg.querySelector('.fp-node[data-id="' + cssEscape(id) + '"]')?.getBoundingClientRect();
    if (!box) return;
    const canvasBox = this.canvasEl.getBoundingClientRect();
    const ta = this.canvasEl.createEl("textarea", { cls: "fp-inline-edit fp-inline-rich-edit" }) as HTMLTextAreaElement;
    this.attachSuggest(ta);
    ta.value = richContentSource(el, type);
    ta.style.left = `${box.left - canvasBox.left + this.canvasEl.scrollLeft}px`;
    ta.style.top = `${box.top - canvasBox.top + this.canvasEl.scrollTop}px`;
    ta.style.width = `${Math.max(n.width, 320)}px`;
    ta.style.height = `120px`;
    let done = false;
    const commit = () => { if (done) return; done = true; const v = ta.value; ta.remove(); this.updateRichContent(id, type, v); };
    const cancel = () => { if (done) return; done = true; ta.remove(); };
    ta.addEventListener("keydown", (e: KeyboardEvent) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); cancel(); } if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); } });
    ta.addEventListener("blur", () => commit());
    this.canvasEl.appendChild(ta);
    ta.focus();
    const tl2 = ta.value.length;
    ta.setSelectionRange(tl2, tl2);
  }

  /** Debounced stash write after every commit. */
  scheduleRecovery() {
    if (!this.doc || !this.file) return;
    if (this.recoveryTimer) window.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = window.setTimeout(() => { this.recoveryTimer = 0; this.flushRecovery(); }, 800);
  }

  /** Write current doc + undo/redo stacks to recovery/<map>.tmp + cache. */
  async flushRecovery() {
    if (this.recoveryTimer) { window.clearTimeout(this.recoveryTimer); this.recoveryTimer = 0; }
    if (!this.doc || !this.file || !this.dirty) return;
    try {
      const dir = (this.plugin.manifest as any).dir || "";
      const adapter = this.app.vault.adapter;
      const key = recoveryKey(this.file.path);
      const xml = serializeMm(this.doc, this.originalText);
      await writeEnvelope(adapter, dir, key, {
        xml,
        undo: this.history.undoStack.slice(),
        redo: this.history.redoStack.slice(),
        at: Date.now(),
        mmPath: this.file.path,
        baseHash: hashText(this.originalText),
        baseMtime: (this.file as any).stat?.mtime || 0
      });
      const cache = await readCache(adapter, dir);
      cache[key] = {
        mmPath: this.file.path,
        hash: hashText(this.originalText),        // mm-on-disk fingerprint
        mtime: (this.file as any).stat?.mtime || 0,
        at: Date.now()
      };
      await writeCache(adapter, dir, cache);
    } catch (e) { console.error("Freeplane: recovery write failed", e); }
  }

  /** Remove this map's stash (after save / discard / save-as). */
  async clearRecovery() {
    if (this.recoveryTimer) { window.clearTimeout(this.recoveryTimer); this.recoveryTimer = 0; }
    if (!this.file) return;
    try {
      const dir = (this.plugin.manifest as any).dir || "";
      await deleteRecovery(this.app.vault.adapter, dir, recoveryKey(this.file.path));
    } catch {}
  }

  /**
   * On open: if a stash exists and the mm is unchanged (hash/mtime match),
   * resume it silently with undo history. If the mm changed externally, ask:
   * overwrite mm / save recovered as new mm / lose recovered changes.
   */
  async checkRecovery(file: TFile, text: string): Promise<{ xml: string; undo: string[]; redo: string[]; dirty: boolean; mmText: string }> {
    const none = { xml: text, undo: [] as string[], redo: [] as string[], dirty: false, mmText: text };
    try {
      const dir = (this.plugin.manifest as any).dir || "";
      const adapter = this.app.vault.adapter;
      const key = recoveryKey(file.path);
      const env = await readEnvelope(adapter, dir, key);
      if (!env || !env.xml) return none;

      const cache = (await readCache(adapter, dir))[key];
      // The content hash is authoritative. TFile.stat can be stale and some
      // filesystems have coarse mtimes, so an mtime match must not suppress a
      // genuine recovery conflict. New envelopes carry their own baseline so
      // an interrupted cache.json write cannot make the recovery prompt vanish.
      const baseHash = env.baseHash || cache?.hash;
      const same = !!baseHash && baseHash === hashText(text);

      if (same) {
        // mm untouched since the stash: resume unsaved work silently
        return { xml: env.xml, undo: env.undo || [], redo: env.redo || [], dirty: true, mmText: text };
      }

      const choice = await askRecovery(this.app, file.name);

      if (choice === "overwrite") {
        await this.app.vault.modify(file, env.xml);
        await deleteRecovery(adapter, dir, key);
        new Notice("Recovered changes written over " + file.name);
        return { xml: env.xml, undo: env.undo || [], redo: env.redo || [], dirty: false, mmText: env.xml };
      }

      if (choice === "saveas") {
        const base = file.parent ? file.parent.path : "";
        const name = file.basename + " recovered";
        let p = (base ? base + "/" : "") + name + ".mm";
        let i = 1;
        while (this.app.vault.getAbstractFileByPath(p)) { p = (base ? base + "/" : "") + name + " " + i + ".mm"; i++; }
        await this.app.vault.create(p, env.xml);
        await deleteRecovery(adapter, dir, key);
        new Notice("Recovered changes saved as " + p);
        return none;
      }

      await deleteRecovery(adapter, dir, key);
      new Notice("Recovered changes discarded for " + file.name);
      return none;
    } catch (e) {
      console.error("Freeplane: recovery check failed", e);
      return none;
    }
  }

  /** Discard unsaved changes: reload from disk, clear history + recovery stash. */
  async rollbackToSaved() {
    if (!this.doc || !this.file) return;
    if (!this.dirty) { new Notice("No unsaved changes to roll back."); return; }
    const ok = await askConfirm(
      this.app,
      "Roll back to last save?",
      "All unsaved changes (and the recovery stash) will be discarded.",
      "Roll back"
    );
    if (!ok) return;
    try {
      const text = await this.app.vault.read(this.file);
      this.originalText = text;
      this.doc = parseMm(text);
      this.syncRichExpanded();
      this.history.clear();
      this.dirty = false;
      this.clearSelection();
      this.renderAll();
      this.centerOnContent();
      await this.clearRecovery();
      new Notice("Rolled back to the last saved state.");
    } catch (e) {
      console.error("Freeplane: rollback failed", e);
      new Notice("Rollback failed.");
    }
  }

  attachSuggest(input: any) { new LinkSuggest(this, input); }
  isEditableTarget(target: EventTarget | null): boolean {
    if (!target) return false;
    const el = target as HTMLElement;
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
  }
}

class LinkSuggest {
  view: any; input: any;
  popup: HTMLElement | null = null;
  items: any[] = []; index = 0; open = false;
  matchStart = 0; partialEnd = 0; embed = false; query = "";
  constructor(view: any, input: any) {
    this.view = view; this.input = input;
    input.addEventListener("keydown", (e: KeyboardEvent) => this.handleKey(e));
    input.addEventListener("input", () => this.update());
    input.addEventListener("blur", () => window.setTimeout(() => this.close(), 150));
  }
  handleKey(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); e.stopImmediatePropagation(); this.move(1); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); e.stopImmediatePropagation(); this.move(-1); return true; }
    if (e.key === "Enter" || e.key === "Tab") {
      if (this.items.length) { e.preventDefault(); e.stopImmediatePropagation(); this.accept(this.items[this.index]); return true; }
      this.close(); return false;
    }
    if (e.key === "Escape") { e.stopImmediatePropagation(); this.close(); return true; }
    return false;
  }
  move(d: number) { if (!this.items.length) return; this.index = (this.index + d + this.items.length) % this.items.length; this.refreshSel(); }
  refreshSel() { if (!this.popup) return; Array.from(this.popup.children).forEach((c, i) => { (c as HTMLElement).toggleClass("selected", i === this.index); }); }
  update() {
    const caret = this.input.selectionStart ?? this.input.value.length;
    const upto = this.input.value.slice(0, caret);
    const m = /(!?)\[\[([^\[\]]*)$/.exec(upto);
    if (!m) { this.close(); return; }
    this.embed = m[1] === "!";
    this.matchStart = caret - m[0].length;
    this.partialEnd = caret;
    this.query = m[2];
    this.buildList();
    if (this.items.length) this.showPopup(); else this.close();
  }
  label(f: any): string { return f.extension === "md" ? f.basename : f.name; }
  buildList() {
    const q = this.query.toLowerCase();
    const cur = this.view.file?.path;
    const files = this.view.app.vault.getAllLoadedFiles().filter((f: any) => f instanceof TFile && f.path !== cur);
    const hits = files.map((f) => ({ f, l: this.label(f) })).filter((x) => !q || x.l.toLowerCase().includes(q) || x.f.path.toLowerCase().includes(q));
    hits.sort((a, b) => { const as = a.l.toLowerCase().startsWith(q) ? 0 : 1, bs = b.l.toLowerCase().startsWith(q) ? 0 : 1; if (as !== bs) return as - bs; return a.l.length - b.l.length; });
    this.items = hits.slice(0, 8).map((x) => x.f);
    this.index = 0;
  }
  showPopup() {
    if (!this.popup) this.popup = document.body.createDiv({ cls: "fp-suggest" });
    this.popup.empty();
    const r = this.input.getBoundingClientRect();
    this.popup.style.left = r.left + "px";
    this.popup.style.top = r.bottom + 4 + "px";
    this.popup.style.width = Math.max(r.width, 260) + "px";
    this.popup.style.display = "block";
    this.items.forEach((f, i) => {
      const item = this.popup!.createDiv({ cls: "fp-suggest-item" + (i === this.index ? " selected" : "") });
      item.createSpan({ text: this.label(f) });
      if (f.parent && f.parent.path !== "/") item.createSpan({ cls: "fp-suggest-path", text: "  " + f.parent.path });
      item.addEventListener("mouseenter", () => { this.index = i; this.refreshSel(); });
      item.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); this.accept(f); });
    });
    this.open = true;
  }
  accept(f: any) {
    const insert = (this.embed ? "![[" : "[[") + this.label(f) + "]]";
    const v = this.input.value;
    const caret = this.input.selectionStart ?? this.partialEnd;
    this.input.value = v.slice(0, this.matchStart) + insert + v.slice(caret);
    const pos = this.matchStart + insert.length;
    this.input.setSelectionRange(pos, pos);
    this.input.focus();
    this.close();
  }
  close() { this.open = false; if (this.popup) this.popup.style.display = "none"; }
}

function clientToSvg(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const pt = svg.createSVGPoint(); pt.x = clientX; pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const t = pt.matrixTransform(ctm.inverse());
  return { x: t.x, y: t.y };
}
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/["\\]/g, "\\$&");
}
