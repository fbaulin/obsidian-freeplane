import { FileView, TFile, Notice, WorkspaceLeaf, Menu, MarkdownRenderer, Component } from "obsidian";
import { SnapshotHistory } from "./history";
import {
  parseMm,
  serializeDoc,
  serializeMm,
  nodeById,
  setText,
  toggleFolded,
  richContentSource,
  setRichContent,
  moveNode
} from "./mm/xml";
import { layoutMap } from "./mm/layout";
import { toMarkdown } from "./mm/md";
import { renderMap } from "./mm/render";
import { askUnsaved } from "./ui/UnsavedPrompt";

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
  lastRichClick: any = null;
  zoom = 1;
  mdSizes: Record<string, { w: number; h: number }> = {};
  mdComponent: any = null;
  mdPass = 0;
  richExpanded = new Set<string>();
  sidebarHidden = true;

  canvasEl: HTMLElement;
  svg: SVGSVGElement;
  sidebarEl: HTMLElement;

  saving = false;
  lastSavedAt = 0;

  dragging: any = null;
  dropHint: any = null;

  constructor(leaf: WorkspaceLeaf, plugin: any) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_FREEPLANE; }

  getDisplayText(): string {
    if (this.loadedPath) return this.loadedPath.split("/").pop() || "Freeplane map";
    return this.file ? this.file.basename : "Freeplane map";
  }

  getIcon(): string { return "network"; }

  canAcceptExtension(extension: string): boolean { return extension === "mm"; }

  async onOpen() {
    console.log("Freeplane: onOpen start");
    this.contentEl.empty();
    this.contentEl.addClass("fp-view");

    this.canvasEl = this.contentEl.createDiv({ cls: "fp-canvas" });
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
    this.svg.setAttribute("class", "fp-svg");
    this.canvasEl.appendChild(this.svg);
    this.sidebarEl = this.contentEl.createDiv({ cls: "fp-sidebar" });
    if (this.sidebarHidden) this.sidebarEl.style.display = "none";
    if (this.sidebarHidden) this.sidebarEl.style.display = "none";

    // ----- critical input listeners first -----
    this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
      if (this.app.workspace.activeLeaf !== this.leaf) return;
      this.handleKeydown(e);
    });

    // capture-phase shortcuts: run before Obsidian's global hotkey dispatcher
    this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
      if (this.app.workspace.activeLeaf !== this.leaf) return;
      if (this.isEditableTarget(e.target)) return;
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        e.stopPropagation();
        this.save();
      } else if (k === "e") {
        e.preventDefault();
        e.stopPropagation();
        if (this.selectedId) this.startTextEdit(this.selectedId);
      } else if (k === "d") {
        e.preventDefault();
        e.stopPropagation();
        if (this.selectedId) this.startRichEdit(this.selectedId, "DETAILS");
      } else if (k === " ") {
        e.preventDefault();
        e.stopPropagation();
        if (this.selectedId) this.toggleRichPreview(this.selectedId);
      }
    }, true);

    this.registerDomEvent(document, "pointermove", (e: PointerEvent) => this.onDragMove(e));
    this.registerDomEvent(document, "pointerup", (e: PointerEvent) => this.onDragEnd(e));
    this.registerDomEvent(this.canvasEl, "wheel", (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const step = e.deltaY > 0 ? -0.1 : 0.1;
      const newZoom = Math.min(3, Math.max(0.3, Math.round((this.zoom + step) * 100) / 100));
      if (newZoom === this.zoom) return;
      this.zoomAt(newZoom, e);
    }, { passive: false } as any);

    this.registerDomEvent(this.canvasEl, "click", (e: MouseEvent) => {
      if (this.isEditableTarget(e.target)) return;
      const t = e.target as Element;

      const link = t.closest ? t.closest("a.internal-link, a.external-link, .fp-rich-link") : null;
      if (link) {
        e.preventDefault();
        e.stopPropagation();
        const href = link.getAttribute("data-href") || link.getAttribute("href") || "";
        if (href) this.app.workspace.openLinkText(href, this.file?.path || "", false);
        return;
      }

      if (t.closest && t.closest(".fp-node")) return;
      if (this.selectedId) {
        this.selectedId = null;
        this.renderAll();
      }
    });

    console.log("Freeplane: onOpen listeners registered");

    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!(file instanceof TFile)) return;
        if (!this.file || file.path !== this.file.path) return;
        if (this.saving) return;
        if (Date.now() - this.lastSavedAt < 1000) return;
        if (this.dirty) {
          new Notice("Freeplane file changed on disk while you have unsaved edits.");
          return;
        }
        await this.loadFile(file);
      })
    );

    // ----- non-critical extras, isolated so they can never kill the view -----
    try {
      this.addAction("save", "Save map", () => { this.save(); });
      this.addAction("undo-2", "Undo", () => { this.undo(); });
      this.addAction("redo-2", "Redo", () => { this.redo(); });
      this.addAction("panel-right", "Toggle side panel", () => { this.toggleSidebar(); });
    } catch (e) { console.error("Freeplane: addAction failed", e); }
    try { this.initSaveHotkey(); } catch (e) { console.error("Freeplane: initSaveHotkey failed", e); }

    const initialFile = this.file || this.pendingFile;
    if (initialFile) {
      try { await this.loadFile(initialFile); } catch { /* renderError already shown */ }
    }
    console.log("Freeplane: onOpen done");
  }

  async onUnloadFile(file: TFile) {
    console.log("Freeplane: onUnloadFile", file?.path);
    const proto: any = Object.getPrototypeOf(Object.getPrototypeOf(this));
    try {
      if (proto && typeof proto.onUnloadFile === "function") await proto.onUnloadFile.call(this, file);
    } catch (e) {
      console.error("Freeplane: base onUnloadFile failed", e);
    }
  }

  async onClose() {
    console.log("Freeplane: onClose start");
    const proto: any = Object.getPrototypeOf(Object.getPrototypeOf(this));
    try {
      if (proto && typeof proto.onClose === "function") await proto.onClose.call(this);
    } catch (e) {
      console.error("Freeplane: base onClose failed", e);
    }
    console.log("Freeplane: onClose done");
  }

  async onLoadFile(file: TFile) {
    try {
      if (this.dirty && this.loadedPath && this.loadedPath !== file.path) {
        let action: "save" | "discard" | "cancel" = "cancel";
        try {
          action = await Promise.race([
            new Promise<"save" | "discard" | "cancel">((resolve) => {
              window.setTimeout(() => {
                askUnsaved(this.app, "You have unsaved changes in the current Freeplane map.").then(resolve);
              }, 0);
            }),
            new Promise<"save" | "discard" | "cancel">((resolve) =>
              window.setTimeout(() => resolve("cancel"), 8000)
            )
          ]);
        } catch {
          action = "cancel";
        }

        if (action === "save") {
          await this.save();
        } else if (action === "cancel") {
          new Notice("Switch cancelled. Save or discard changes first.");
          const current = this.loadedPath
            ? this.app.vault.getAbstractFileByPath(this.loadedPath)
            : null;
          if (current instanceof TFile) (this as any).file = current;
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
      const action = await askUnsaved(this.app, "You have unsaved changes in this Freeplane map.");
      if (action === "save") await this.save();
      else if (action === "cancel") return;
    }
    this.leaf.detach();
  }

  initSaveHotkey() {
    const tryRegister = () => {
      const scope = (this as any).scope;
      if (!scope || typeof scope.register !== "function") return false;
      scope.register([], "Mod+s", (e: KeyboardEvent) => {
        e.preventDefault();
        this.save();
        return false;
      });
      return true;
    };
    if (tryRegister()) return;
    const t = window.setInterval(() => {
      if (tryRegister()) {
        window.clearInterval(t);
        console.log("Freeplane: Mod+S registered via view scope");
      }
    }, 200);
    this.registerInterval(t);
  }

  async loadFile(file: TFile) {
    if (!this.canvasEl) {
      this.pendingFile = file;
      return;
    }
    this.pendingFile = null;

    try {
      (this as any).file = file;
      const text = await this.app.vault.read(file);
      this.originalText = text;
      this.doc = parseMm(text);
      this.syncRichExpanded();
      this.loadedPath = file.path;
      this.history.clear();
      this.dirty = false;
      this.selectedId = null;
      this.renderAll();
    } catch (e: any) {
      this.doc = null;
      this.loadedPath = null;
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
      try {
        await (MarkdownRenderer as any).render(this.app, toMarkdown(n.text), div, source, comp);
      } catch {
        div.textContent = n.text;
      }
    }));

    if (token !== this.mdPass) return;

    const old = this.mdComponent;
    this.mdComponent = comp;
    if (old && old !== comp) { try { this.removeChild(old); } catch {} }

    if (this.measureMd(token)) this.renderAll();
    else window.setTimeout(() => {
      if (token === this.mdPass && this.measureMd(token)) this.renderAll();
    }, 700);
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
      if (!used || Math.abs(used.w - w) > 2 || Math.abs(used.h - h) > 2) {
        this.mdSizes[id] = { w, h };
        changed = true;
      }
    }
    return changed;
  }

  zoomAt(newZoom: number, e?: WheelEvent) {
    if (!this.svg || !this.layout) {
      this.zoom = newZoom;
      this.applyZoom();
      return;
    }

    // anchor: selected node center, else the mouse cursor
    let u: { x: number; y: number } | null = null;

    if (this.selectedId) {
      const n = this.layout.byId[this.selectedId];
      if (n) u = { x: n.x + n.width / 2, y: n.y + n.titleHeight / 2 };
    }

    if (!u && e) {
      u = clientToSvg(this.svg, e.clientX, e.clientY);
    }

    let before: { x: number; y: number } | null = null;
    const c = this.canvasEl.getBoundingClientRect();

    if (u) {
      const pt = this.svg.createSVGPoint();
      pt.x = u.x;
      pt.y = u.y;
      const ctm = this.svg.getScreenCTM();
      if (ctm) {
        const sp = pt.matrixTransform(ctm);
        before = { x: sp.x - c.left, y: sp.y - c.top };
      }
    }

    this.zoom = newZoom;
    this.applyZoom();

    if (u && before) {
      const pt = this.svg.createSVGPoint();
      pt.x = u.x;
      pt.y = u.y;
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

  applyZoom() {
    if (!this.svg || !this.layout) return;
    this.svg.setAttribute("width", String(Math.round(this.layout.width * this.zoom)));
    this.svg.setAttribute("height", String(Math.round(this.layout.height * this.zoom)));
  }

  renderAll() {
    if (!this.doc || !this.svg) return;

    this.layout = layoutMap(this.doc, this.richExpanded, this.mdSizes);

    renderMap(this.svg, this.layout, this.selectedId, {
      select: (id: string) => {
        if (this.selectedId !== id) {
          this.selectedId = id;
          this.renderAll();
        }
      },
      toggleFold: (id: string) => this.toggleFold(id),
      toggleRich: (id: string) => this.toggleRichPreview(id),
      startDrag: (id: string, e: PointerEvent) => this.startDrag(id, e),
      editText: (id: string) => this.startTextEdit(id),
      editRich: (id: string, type: "DETAILS" | "NOTE") => this.startRichEdit(id, type),
      richClick: (id: string, type: "DETAILS" | "NOTE") => this.richLineClicked(id, type),
      contextMenu: (id: string, e: MouseEvent) => this.openNodeMenu(id, e)
    });

    this.applyZoom();
    this.renderMarkdownPass();
    this.renderSidebar();
    (this.leaf as any).updateHeader?.();
  }

  renderSidebar() {
    this.sidebarEl.empty();

    if (!this.doc) return;

    if (!this.selectedId) {
      this.sidebarEl.createEl("p", {
        text: "Select a node. Double-click to edit its text. Drag nodes to move them."
      });
      this.sidebarEl.createEl("p", {
        text: "Hotkeys: arrows navigate, Ctrl+arrows move, Ctrl+E rename, Ctrl+D details, Ctrl+Space preview, Space fold, Enter sibling, Insert child."
      });
      return;
    }

    const el = nodeById(this.doc, this.selectedId);

    if (!el) {
      this.selectedId = null;
      this.renderSidebar();
      return;
    }

    this.sidebarEl.createEl("h3", { text: "Node" });

    const idEl = this.sidebarEl.createEl("code");
    idEl.textContent = "ID: " + (el.getAttribute("ID") || "(none)");

    this.sidebarEl.createEl("label", { text: "Text" });
    const textInput = this.sidebarEl.createEl("textarea", { rows: 3 }) as HTMLTextAreaElement;
    this.attachSuggest(textInput);
    textInput.value = el.getAttribute("TEXT") || "";

    this.sidebarEl.createEl("label", {
      text: "DETAILS richcontent"
    });
    const details = this.sidebarEl.createEl("textarea");
    this.attachSuggest(details);
    details.value = richContentSource(el, "DETAILS");

    this.sidebarEl.createEl("label", {
      text: "NOTE richcontent"
    });
    const note = this.sidebarEl.createEl("textarea");
    this.attachSuggest(note);
    note.value = richContentSource(el, "NOTE");

    const update = this.sidebarEl.createEl("button", {
      text: "Update node",
      cls: "mod-cta"
    });

    update.addEventListener("click", () => {
      try {
        this.updateWholeNode(
          this.selectedId!,
          textInput.value,
          details.value,
          note.value
        );
        new Notice("Node updated.");
      } catch (e: any) {
        new Notice("Node not updated: " + (e?.message || String(e)));
      }
    });
  }

  richLineClicked(id: string, type: "DETAILS" | "NOTE") {
    const now = Date.now();
    const last = this.lastRichClick;
    if (last && last.id === id && last.type === type && now - last.time < 450) {
      this.lastRichClick = null;
      this.startRichEdit(id, type);
    } else {
      this.lastRichClick = { id, type, time: now };
    }
  }

  selectSiblingNav(dir: -1 | 1) {
    if (!this.doc || !this.selectedId) return;
    const el = nodeById(this.doc, this.selectedId);
    if (!el || !el.parentElement) return;
    const siblings = this.nodeChildren(el.parentElement);
    if (siblings.length === 0) return;
    const idx = siblings.indexOf(el);
    const next = (idx + dir + siblings.length) % siblings.length;
    const id = siblings[next].getAttribute("ID");
    if (id) { this.selectedId = id; this.renderAll(); }
  }

  selectParentNav() {
    if (!this.doc || !this.selectedId) return;
    const el = nodeById(this.doc, this.selectedId);
    if (!el) return;
    const parent = el.parentElement;
    if (!parent || parent.nodeName.toLowerCase() !== "node") return;
    const id = parent.getAttribute("ID");
    if (id) { this.selectedId = id; this.renderAll(); }
  }

  selectFirstChildNav() {
    if (!this.doc || !this.selectedId) return;
    const el = nodeById(this.doc, this.selectedId);
    if (!el) return;

    const before = serializeDoc(this.doc);
    let changed = false;

    // open the node we leave so the child is visible
    if (el.getAttribute("FOLDED") === "true") { el.removeAttribute("FOLDED"); changed = true; }

    const first = this.nodeChildren(el)[0];
    if (!first) return;

    // open the node we enter
    if (first.getAttribute("FOLDED") === "true") { first.removeAttribute("FOLDED"); changed = true; }

    this.selectedId = first.getAttribute("ID");
    if (changed) this.commit(before);
    else this.renderAll();
  }

  openNodeMenu(id: string, e: MouseEvent) {
    if (this.selectedId !== id) {
      this.selectedId = id;
      this.renderAll();
    }

    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Rename").onClick(() => this.startTextEdit(id)));
    menu.addItem((item) => item.setTitle("Edit details").onClick(() => this.startRichEdit(id, "DETAILS")));
    menu.addItem((item) => item.setTitle("Edit note").onClick(() => this.startRichEdit(id, "NOTE")));
    menu.addItem((item) => item.setTitle("Delete").onClick(() => this.deleteNode(id)));
    menu.addItem((item) => item.setTitle("Collapse all").onClick(() => this.collapseChildren(id)));
    menu.addItem((item) => item.setTitle("Expand all").onClick(() => this.expandAll(id)));
    menu.showAtMouseEvent(e);
  }

  deleteNode(id: string) {
    if (!this.doc || !id) return;
    const el = nodeById(this.doc, id);
    if (!el) return;

    const parent = el.parentElement;
    // protect the root node
    if (!parent || parent.nodeName.toLowerCase() !== "node") return;

    const before = serializeDoc(this.doc);
    if (this.selectedId === id) {
      this.selectedId = parent.getAttribute("ID");
    }
    el.remove();
    this.commit(before);
  }

  collapseChildren(id: string) {
    this.setFoldRecursive(id, true);
  }

  expandAll(id: string) {
    this.setFoldRecursive(id, false);
  }

  setFoldRecursive(id: string, folded: boolean) {
    if (!this.doc || !id) return;
    const el = nodeById(this.doc, id);
    if (!el) return;

    const before = serializeDoc(this.doc);
    const targets = [el, ...Array.from(el.querySelectorAll("node"))];
    let changed = false;

    for (const t of targets) {
      const has = t.getAttribute("FOLDED") === "true";
      if (folded && !has) {
        if (this.nodeChildren(t).length > 0) {
          t.setAttribute("FOLDED", "true");
          changed = true;
        }
      } else if (!folded && has) {
        t.removeAttribute("FOLDED");
        changed = true;
      }
    }

    if (changed) this.commit(before);
  }

  toggleSidebar(forceHidden?: boolean) {
    this.sidebarHidden =
      typeof forceHidden === "boolean" ? forceHidden : !this.sidebarHidden;

    if (this.sidebarEl) {
      this.sidebarEl.style.display = this.sidebarHidden ? "none" : "";
    }

  }

  syncRichExpanded() {
    this.richExpanded = new Set<string>();
    if (!this.doc) return;
    this.doc.querySelectorAll("richcontent").forEach((rc: any) => {
      const type = rc.getAttribute("TYPE");
      if (type !== "DETAILS" && type !== "NOTE") return;
      if (rc.getAttribute("HIDDEN") === "true") return;
      const parent = rc.parentElement;
      if (parent && parent.nodeName.toLowerCase() === "node") {
        const id = parent.getAttribute("ID");
        if (id) this.richExpanded.add(id);
      }
    });
  }

  toggleRichPreview(id: string) {
    if (!this.doc) return;
    const el = nodeById(this.doc, id);
    if (!el) return;

    const rcs = Array.from(el.children).filter(
      (c) =>
        c.nodeName.toLowerCase() === "richcontent" &&
        (c.getAttribute("TYPE") === "DETAILS" || c.getAttribute("TYPE") === "NOTE")
    );
    if (rcs.length === 0) return;

    const showing = this.richExpanded.has(id);
    const before = serializeDoc(this.doc);

    rcs.forEach((rc) => {
      if (showing) rc.setAttribute("HIDDEN", "true");
      else rc.removeAttribute("HIDDEN");
    });

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

  handleKeydown(e: KeyboardEvent) {
    const key = e.key;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && key.toLowerCase() === "z") {
      if (this.isEditableTarget(e.target)) return;
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }

    if (this.isEditableTarget(e.target)) return;

    if (!this.selectedId) return;

    if (key === " ") {
      e.preventDefault();
      this.toggleFold(this.selectedId);
      return;
    }

    if (mod && key === "ArrowUp") {
      e.preventDefault();
      this.moveSelectedSibling(-1);
      return;
    }

    if (mod && key === "ArrowDown") {
      e.preventDefault();
      this.moveSelectedSibling(1);
      return;
    }

    if (mod && key === "ArrowLeft") {
      e.preventDefault();
      this.promoteSelected();
      return;
    }

    if (mod && key === "ArrowRight") {
      e.preventDefault();
      this.demoteSelected();
      return;
    }

    if (key === "ArrowUp") {
      e.preventDefault();
      this.selectSiblingNav(-1);
      return;
    }

    if (key === "ArrowDown") {
      e.preventDefault();
      this.selectSiblingNav(1);
      return;
    }

    if (key === "ArrowLeft") {
      e.preventDefault();
      this.selectParentNav();
      return;
    }

    if (key === "ArrowRight") {
      e.preventDefault();
      this.selectFirstChildNav();
      return;
    }

    if (key === "Enter") {
      e.preventDefault();
      this.createSiblingAfterSelected();
      return;
    }

    if (key === "Insert") {
      e.preventDefault();
      this.createChildOfSelected();
      return;
    }

    if (key === "Delete") {
      e.preventDefault();
      this.deleteNode(this.selectedId);
      return;
    }
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

    this.doc.querySelectorAll("node[ID]").forEach((n) => {
      const id = n.getAttribute("ID");
      if (id) existing.add(id);
    });

    let id = "";

    do {
      id = "ID_" + Math.floor(Math.random() * 1000000000);
    } while (existing.has(id));

    return id;
  }

  nodeChildren(el: Element): Element[] {
    return Array.from(el.children).filter(
      (c) => c.nodeName.toLowerCase() === "node"
    );
  }

  nextNodeSibling(el: Element): Element | null {
    let n = el.nextElementSibling;

    while (n && n.nodeName.toLowerCase() !== "node") {
      n = n.nextElementSibling;
    }

    return n;
  }

  prevNodeSibling(el: Element): Element | null {
    let n = el.previousElementSibling;

    while (n && n.nodeName.toLowerCase() !== "node") {
      n = n.previousElementSibling;
    }

    return n;
  }

  moveSelectedSibling(dir: -1 | 1) {
    if (!this.doc || !this.selectedId) return;

    const el = nodeById(this.doc, this.selectedId);
    if (!el || !el.parentElement) return;

    const parent = el.parentElement;
    const siblings = this.nodeChildren(parent);
    const idx = siblings.indexOf(el);

    if (idx < 0 || siblings.length < 2) return;

    const before = serializeDoc(this.doc);

    if (dir < 0) {
      if (idx === 0) {
        const last = siblings[siblings.length - 1];
        parent.insertBefore(el, this.nextNodeSibling(last));
      } else {
        parent.insertBefore(el, siblings[idx - 1]);
      }
    } else {
      if (idx === siblings.length - 1) {
        parent.insertBefore(el, siblings[0]);
      } else {
        parent.insertBefore(el, this.nextNodeSibling(siblings[idx + 1]));
      }
    }

    this.commit(before);
  }

  promoteSelected() {
    if (!this.doc || !this.selectedId) return;

    const el = nodeById(this.doc, this.selectedId);
    if (!el) return;

    const parent = el.parentElement;
    if (!parent || parent.nodeName.toLowerCase() !== "node") return;

    const grand = parent.parentElement;

    // Do not create multiple <map><node> roots.
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

  createSiblingAfterSelected() {
    if (!this.doc || !this.selectedId) return;

    const current = nodeById(this.doc, this.selectedId);
    if (!current || !current.parentElement) return;

    const parent = current.parentElement;
    if (parent.nodeName.toLowerCase() === "map") return;

    const node = this.createMmNode();
    if (!node) return;

    if (parent.parentElement?.nodeName.toLowerCase() === "map") {
      node.setAttribute("POSITION", current.getAttribute("POSITION") || "right");
    }

    const before = serializeDoc(this.doc);
    parent.insertBefore(node, this.nextNodeSibling(current));

    this.selectedId = node.getAttribute("ID");
    this.commit(before);

    window.setTimeout(() => {
      if (this.selectedId) this.startTextEdit(this.selectedId);
    }, 0);
  }

  createChildOfSelected() {
    if (!this.doc || !this.selectedId) return;

    const current = nodeById(this.doc, this.selectedId);
    if (!current) return;

    const node = this.createMmNode();
    if (!node) return;

    if (current.parentElement?.nodeName.toLowerCase() === "map") {
      node.setAttribute("POSITION", "right");
    }

    const before = serializeDoc(this.doc);

    current.appendChild(node);
    current.removeAttribute("FOLDED");

    this.selectedId = node.getAttribute("ID");
    this.commit(before);

    window.setTimeout(() => {
      if (this.selectedId) this.startTextEdit(this.selectedId);
    }, 0);
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

  commit(before: string) {
    this.history.push(before);
    this.dirty = true;
    this.syncRichExpanded();
    this.renderAll();
  }

  undo() {
    if (!this.doc) return;
    const current = serializeDoc(this.doc);
    const prev = this.history.undo(current);
    if (!prev) { new Notice("Nothing to undo."); return; }
    this.restoreSnapshot(prev);
  }

  redo() {
    if (!this.doc) return;
    const current = serializeDoc(this.doc);
    const next = this.history.redo(current);
    if (!next) { new Notice("Nothing to redo."); return; }
    this.restoreSnapshot(next);
  }

  restoreSnapshot(xml: string) {
    try {
      this.doc = parseMm(xml);
      this.syncRichExpanded();
      this.dirty = true;
      this.renderAll();
    } catch {
      new Notice("Could not restore snapshot.");
    }
  }

  async save(force = false) {
    if (!this.doc || !this.file) { new Notice("No Freeplane map is open."); return; }
    if (!this.dirty && !force) { new Notice("No changes to save."); return; }

    const xml = serializeMm(this.doc, this.originalText);
    try { parseMm(xml); } catch (e: any) {
      new Notice("Refusing to save invalid XML: " + (e?.message || String(e)));
      return;
    }

    this.saving = true;
    try {
      const vault = this.app.vault as any;
      if (typeof vault.process === "function") await vault.process(this.file, () => xml);
      else await this.app.vault.modify(this.file, xml);
      this.originalText = xml;
      this.dirty = false;
      this.lastSavedAt = Date.now();
      new Notice("Saved Freeplane map.");
      (this.leaf as any).updateHeader?.();
    } finally {
      this.saving = false;
    }
  }

  // ---------------- drag & drop ----------------

  startDrag(id: string, e: PointerEvent) {
    if (!this.doc || e.button !== 0) return;
    e.preventDefault();
    console.log("FP DRAG start", id);
    const el = nodeById(this.doc, id);
    if (!el) return;
    this.dragging = { id, el, startX: e.clientX, startY: e.clientY, started: false };
  }

  onDragMove(e: PointerEvent) {
    if (!this.dragging || !this.layout) return;
    if (!this.dragging.started) {
      const dx = e.clientX - this.dragging.startX;
      const dy = e.clientY - this.dragging.startY;
      if (Math.hypot(dx, dy) < 5) return;
      this.dragging.started = true;
      console.log("FP DRAG moving");
      this.canvasEl.addClass("fp-dragging");
    }
    const pt = clientToSvg(this.svg, e.clientX, e.clientY);
    this.dropHint = this.hitTest(pt);
    if (this.dropHint) console.log("FP DRAG hint", this.dropHint.mode, this.dropHint.id);
    this.updateDropOverlay();
  }

  onDragEnd(_e: PointerEvent) {
    if (!this.dragging) return;
    console.log("FP DRAG end");
    const drag = this.dragging;
    const hint = this.dropHint;
    this.dragging = null;
    this.dropHint = null;
    this.canvasEl.removeClass("fp-dragging");
    this.updateDropOverlay();

    if (!drag.started || !hint || !this.doc) return;
    if (hint.id === drag.id) return;

    const before = serializeDoc(this.doc);
    const changed = moveNode(this.doc, drag.id, hint.id, hint.mode, hint.side);
    if (changed) this.commit(before);
    else this.renderAll();
  }

  hitTest(pt: { x: number; y: number }) {
    if (!this.layout || !this.dragging) return null;
    const nodes = this.layout.nodes as any[];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const pad = 20;
      const inside =
        pt.x >= n.x - pad &&
        pt.x <= n.x + n.width + pad &&
        pt.y >= n.y - pad &&
        pt.y <= n.y + n.height + pad;
      if (!inside) continue;
      if (n.id === this.dragging.id) continue;
      if (this.dragging.el.contains(n.el)) continue;

      let mode: "child" | "before" | "after" = "child";
      if (n.depth > 0) {
        const top = n.y + n.height * 0.25;
        const bottom = n.y + n.height * 0.75;
        if (pt.y < top) mode = "before";
        else if (pt.y > bottom) mode = "after";
      }
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
    if (!overlay) {
      overlay = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      overlay.id = "fp-drop";
      this.svg.appendChild(overlay);
    }
    overlay.setAttribute("class", "fp-drop fp-drop-" + this.dropHint.mode);
    if (this.dropHint.mode === "child") {
      overlay.setAttribute("x", String(n.x - 2));
      overlay.setAttribute("y", String(n.y - 2));
      overlay.setAttribute("width", String(n.width + 4));
      overlay.setAttribute("height", String(n.height + 4));
      overlay.setAttribute("rx", "8");
    } else {
      const lineY = this.dropHint.mode === "before" ? n.y - 2 : n.y + n.height + 2;
      overlay.setAttribute("x", String(n.x));
      overlay.setAttribute("y", String(lineY - 1));
      overlay.setAttribute("width", String(n.width));
      overlay.setAttribute("height", "2");
      overlay.setAttribute("rx", "1");
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
    input.style.width = Math.max(box.width, 80) + "px";
    input.style.height = Math.max(box.height, 60) + "px";

    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const value = input.value;
      input.remove();
      this.updateNodeText(id, value);
    };
    const cancel = () => {
      if (done) return;
      done = true;
      input.remove();
    };

    input.addEventListener("keydown", (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
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

    const richEl = this.svg.querySelector(
      '.fp-rich-line[data-id="' + cssEscape(id) + '"][data-type="' + type + '"], .fp-rich-label[data-id="' + cssEscape(id) + '"][data-type="' + type + '"]'
    ) as SVGElement | null;

    const box = richEl
      ? richEl.getBoundingClientRect()
      : this.svg.querySelector('.fp-node[data-id="' + cssEscape(id) + '"]')?.getBoundingClientRect();

    if (!box) return;

    const canvasBox = this.canvasEl.getBoundingClientRect();

    const textarea = this.canvasEl.createEl("textarea", {
      cls: "fp-inline-edit fp-inline-rich-edit"
    }) as HTMLTextAreaElement;

    this.attachSuggest(textarea);
    textarea.value = richContentSource(el, type);

    textarea.style.left = `${box.left - canvasBox.left + this.canvasEl.scrollLeft}px`;
    textarea.style.top = `${box.top - canvasBox.top + this.canvasEl.scrollTop}px`;
    textarea.style.width = `${Math.max(n.width, 320)}px`;
    textarea.style.height = `120px`;

    let done = false;

    const commit = () => {
      if (done) return;
      done = true;
      const value = textarea.value;
      textarea.remove();
      this.updateRichContent(id, type, value);
    };

    const cancel = () => {
      if (done) return;
      done = true;
      textarea.remove();
    };

    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      e.stopPropagation();

      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commit();
      }
    });

    textarea.addEventListener("blur", () => {
      commit();
    });

    this.canvasEl.appendChild(textarea);
    textarea.focus();
    const tl2 = textarea.value.length;
    textarea.setSelectionRange(tl2, tl2);
  }

  attachSuggest(input: any) {
    new LinkSuggest(this, input);
  }

  isEditableTarget(target: EventTarget | null): boolean {
    if (!target) return false;
    const el = target as HTMLElement;
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
  }
}

class LinkSuggest {
  view: any;
  input: any;
  popup: HTMLElement | null = null;
  items: any[] = [];
  index = 0;
  open = false;
  matchStart = 0;
  partialEnd = 0;
  embed = false;
  query = "";

  constructor(view: any, input: any) {
    this.view = view;
    this.input = input;
    input.addEventListener("keydown", (e: KeyboardEvent) => this.handleKey(e));
    input.addEventListener("input", () => this.update());
    input.addEventListener("blur", () => window.setTimeout(() => this.close(), 150));
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); e.stopImmediatePropagation(); this.move(1); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); e.stopImmediatePropagation(); this.move(-1); return true; }
    if (e.key === "Enter" || e.key === "Tab") {
      if (this.items.length) {
        e.preventDefault(); e.stopImmediatePropagation();
        this.accept(this.items[this.index]);
        return true;
      }
      this.close();
      return false;
    }
    if (e.key === "Escape") {
      e.stopImmediatePropagation();
      this.close();
      return true;
    }
    return false;
  }

  move(d: number) {
    if (!this.items.length) return;
    this.index = (this.index + d + this.items.length) % this.items.length;
    this.refreshSel();
  }

  refreshSel() {
    if (!this.popup) return;
    Array.from(this.popup.children).forEach((c, i) => {
      (c as HTMLElement).toggleClass("selected", i === this.index);
    });
  }

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
    if (this.items.length) this.showPopup();
    else this.close();
  }

  label(f: any): string {
    return f.extension === "md" ? f.basename : f.name;
  }

  buildList() {
    const q = this.query.toLowerCase();
    const cur = this.view.file?.path;

    let files: any[];
    if (this.embed) {
      files = this.view.app.vault.getAllLoadedFiles()
        .filter((f: any) => f instanceof TFile && f.path !== cur);
    } else {
      files = this.view.app.vault.getMarkdownFiles()
        .filter((f: any) => f.path !== cur);
    }

    const hits = files
      .map((f) => ({ f, l: this.label(f) }))
      .filter((x) => !q || x.l.toLowerCase().includes(q) || x.f.path.toLowerCase().includes(q));

    hits.sort((a, b) => {
      const as = a.l.toLowerCase().startsWith(q) ? 0 : 1;
      const bs = b.l.toLowerCase().startsWith(q) ? 0 : 1;
      if (as !== bs) return as - bs;
      return a.l.length - b.l.length;
    });

    this.items = hits.slice(0, 8).map((x) => x.f);
    this.index = 0;
  }

  showPopup() {
    if (!this.popup) {
      this.popup = document.body.createDiv({ cls: "fp-suggest" });
    }
    this.popup.empty();

    const r = this.input.getBoundingClientRect();
    this.popup.style.left = r.left + "px";
    this.popup.style.top = r.bottom + 4 + "px";
    this.popup.style.width = Math.max(r.width, 260) + "px";
    this.popup.style.display = "block";

    this.items.forEach((f, i) => {
      const item = this.popup!.createDiv({ cls: "fp-suggest-item" + (i === this.index ? " selected" : "") });
      item.createSpan({ text: this.label(f) });
      if (f.parent && f.parent.path !== "/") {
        item.createSpan({ cls: "fp-suggest-path", text: "  " + f.parent.path });
      }
      item.addEventListener("mouseenter", () => { this.index = i; this.refreshSel(); });
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.accept(f);
      });
    });

    this.open = true;
  }

  accept(f: any) {
    const insert = (this.embed ? "![[" : "[[") + this.label(f) + "]]";
    const v = this.input.value;
    const caret = this.input.selectionStart ?? this.partialEnd;
    const nv = v.slice(0, this.matchStart) + insert + v.slice(caret);
    this.input.value = nv;
    const pos = this.matchStart + insert.length;
    this.input.setSelectionRange(pos, pos);
    this.input.focus();
    this.close();
  }

  close() {
    this.open = false;
    if (this.popup) this.popup.style.display = "none";
  }
}

function clientToSvg(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const t = pt.matrixTransform(ctm.inverse());
  return { x: t.x, y: t.y };
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/["\\]/g, "\\$&");
}
