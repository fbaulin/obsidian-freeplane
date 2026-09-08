/**
 * FreeplaneView.ts
 * The mind-map view: an Obsidian FileView for `.mm` files.
 * Owns the SVG canvas, the side panel, all editing operations, hotkeys,
 * drag & drop, zoom/pan, link previews and the Markdown rendering pass.
 * The .mm file on disk is authoritative: read into a DOM, mutate the DOM,
 * write back only on explicit save (never on close).
 */
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

/** View type id used for registration and leaf lookups. */
export const VIEW_TYPE_FREEPLANE = "freeplane-mm-view";

/**
 * FileView for Freeplane maps (one instance per leaf).
 * Lifecycle: onOpen builds the UI; onLoadFile/loadFile parse the file;
 * every mutation flows through commit() (undo snapshot + re-render with a
 * stable viewport); save() is the only place the file is written.
 */
export class FreeplaneView extends FileView {
  plugin: any;                                            // parent plugin object

  doc: Document | null = null;                            // live .mm DOM
  originalText = "";                                      // text as last saved
  dirty = false;                                          // unsaved changes?
  loadedPath: string | null = null;                       // path currently in doc
  pendingFile: TFile | null = null;                       // file waiting for UI

  history = new SnapshotHistory();                        // undo/redo snapshots

  layout: any = null;                                     // last layout tree
  selectedId: string | null = null;                       // selected node id
  lastRichClick: any = null;                              // manual dbl-click state
  zoom = 1;                                               // current zoom factor
  mdSizes: Record<string, { w: number; h: number }> = {}; // measured md sizes
  mdComponent: any = null;                                // Component of md pass
  mdPass = 0;                                             // md pass cancel token
  richExpanded = new Set<string>();                       // ids w/ visible preview
  sidebarHidden = true;                                   // panel hidden by default

  canvasEl: HTMLElement;                                  // scrollable canvas div
  svg: SVGSVGElement;                                     // map svg root
  sidebarEl: HTMLElement;                                 // right side panel

  saving = false;                                         // guards modify loop
  lastSavedAt = 0;                                        // last save timestamp

  dragging: any = null;                                   // node drag state
  dropHint: any = null;                                   // current drop target
  panning: any = null;                                    // canvas pan state
  suppressNextClick = false;                              // swallow post-pan click
  hoverLinkEl: any = null;                                // link under cursor
  hoverPop: any = null;                                   // open preview popover

  /** Store leaf + plugin reference. */
  constructor(leaf: WorkspaceLeaf, plugin: any) {
    super(leaf);
    this.plugin = plugin;
  }

  /** View type id for the workspace. */
  getViewType(): string { return VIEW_TYPE_FREEPLANE; }

  /** Tab title: file name of the loaded map. */
  getDisplayText(): string {
    if (this.loadedPath) return this.loadedPath.split("/").pop() || "Freeplane map";
    return this.file ? this.file.basename : "Freeplane map";
  }

  /** Tab icon. */
  getIcon(): string { return "network"; }

  /** Accept only .mm files in this view. */
  canAcceptExtension(extension: string): boolean { return extension === "mm"; }

  /**
   * Build the UI (canvas + svg + sidebar) and register every input listener
   * (keys, wheel zoom, click/deselect, menus, pan, link hover), the vault
   * modify watcher and header actions; finally load the initial file.
   */
  async onOpen() {
    console.log("Freeplane: onOpen start");
    this.contentEl.empty();                               // clear leaf container
    this.contentEl.addClass("fp-view");

    this.canvasEl = this.contentEl.createDiv({ cls: "fp-canvas" });    // scroll area
    // SVG root must live in the SVG namespace (createEl would break it)
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
    this.svg.setAttribute("class", "fp-svg");
    this.canvasEl.appendChild(this.svg);
    this.sidebarEl = this.contentEl.createDiv({ cls: "fp-sidebar" });  // right panel
    if (this.sidebarHidden) this.sidebarEl.style.display = "none";     // hidden default

    // ----- critical input listeners first -----
    // Normal-phase keys: navigation & structural hotkeys (handleKeydown)
    this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
      if (this.app.workspace.activeLeaf !== this.leaf) return;         // active view only
      this.handleKeydown(e);
    });
    // Capture-phase shortcuts run before Obsidian's global hotkey dispatcher;
    // physical e.code keeps them layout-independent (RU/EN).
    this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
      if (this.app.workspace.activeLeaf !== this.leaf) return;
      if (this.isEditableTarget(e.target)) return;                     // typing? skip
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return; // Ctrl-only combos
      const k = e.code;
      if (k === "KeyS") {                     // Ctrl+S = save
        e.preventDefault();
        e.stopPropagation();
        this.save();
      } else if (k === "KeyE") {              // Ctrl+E = rename selected
        e.preventDefault();
        e.stopPropagation();
        if (this.selectedId) this.startTextEdit(this.selectedId);
      } else if (k === "KeyD") {              // Ctrl+D = edit DETAILS
        e.preventDefault();
        e.stopPropagation();
        if (this.selectedId) this.startRichEdit(this.selectedId, "DETAILS");
      } else if (e.key === " ") {             // Ctrl+Space = toggle preview
        e.preventDefault();
        e.stopPropagation();
        if (this.selectedId) this.toggleRichPreview(this.selectedId);
      }
    }, true);
    // Document-level plumbing for node dragging
    this.registerDomEvent(document, "pointermove", (e: PointerEvent) => this.onDragMove(e));
    this.registerDomEvent(document, "pointerup", (e: PointerEvent) => this.onDragEnd(e));
    // Ctrl+wheel zoom anchored on selection or cursor
    this.registerDomEvent(this.canvasEl, "wheel", (e: WheelEvent) => {
      if (!e.ctrlKey) return;                                          // plain wheel scrolls
      e.preventDefault();
      const step = e.deltaY > 0 ? -0.1 : 0.1;                          // zoom direction
      const newZoom = Math.min(3, Math.max(0.3, Math.round((this.zoom + step) * 100) / 100));
      if (newZoom === this.zoom) return;
      this.zoomAt(newZoom, e);
    }, { passive: false } as any);
    // Click on canvas: ctrl+click opens links, empty space deselects
    this.registerDomEvent(this.canvasEl, "click", (e: MouseEvent) => {
      if (this.suppressNextClick) {           // click right after a pan: ignore
        this.suppressNextClick = false;
        return;
      }
      if (this.isEditableTarget(e.target)) return;                     // editors keep focus
      const t = e.target as Element;
      const link = t.closest ? t.closest("a.internal-link, a.external-link, .fp-rich-link") : null;
      if (link) {
        if (e.ctrlKey || e.metaKey) {         // Ctrl+click opens the link
          e.preventDefault();
          e.stopPropagation();
          const href = link.getAttribute("data-href") || link.getAttribute("href") || "";
          if (href) this.app.workspace.openLinkText(href, this.file?.path || "", false);
        }
        return;                               // plain click on link: inert
      }
      if (t.closest && t.closest(".fp-node")) return;                  // node handles itself
      if (this.selectedId) {                  // empty space: deselect
        this.selectedId = null;
        this.renderAll();
      }
    });
    // Right-click on empty canvas: fit / center menu
    this.registerDomEvent(this.canvasEl, "contextmenu", (e: MouseEvent) => {
      const t = e.target as Element;
      if (t.closest && t.closest(".fp-node")) return;                  // node menu wins
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((item) => item.setTitle("Fit map").onClick(() => this.fitMap()));
      menu.addItem((item) => item.setTitle("Center map").onClick(() => this.centerOnContent()));
      menu.showAtMouseEvent(e);
    });
    // LMB on empty canvas starts panning
    this.registerDomEvent(this.canvasEl, "pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;                                      // left button only
      const t = e.target as Element;
      if (t.closest && (t.closest(".fp-node") || t.closest(".fp-inline-edit") || t.closest("a"))) return;
      if (this.isEditableTarget(e.target)) return;
      this.hidePreview();                     // pan cancels link preview
      this.panning = {
        startX: e.clientX,
        startY: e.clientY,
        scrollLeft: this.canvasEl.scrollLeft,                          // remember origin
        scrollTop: this.canvasEl.scrollTop,
        moved: false
      };
    });
    // Apply pan delta to scroll position once past the 4px threshold
    this.registerDomEvent(document, "pointermove", (e: PointerEvent) => {
      if (!this.panning) return;
      const dx = e.clientX - this.panning.startX;
      const dy = e.clientY - this.panning.startY;
      if (!this.panning.moved && Math.hypot(dx, dy) < 4) return;       // click tolerance
      this.panning.moved = true;
      this.canvasEl.addClass("fp-panning");                            // grabbing cursor
      this.canvasEl.scrollLeft = this.panning.scrollLeft - dx;
      this.canvasEl.scrollTop = this.panning.scrollTop - dy;
    });
    // End pan; a real pan suppresses the follow-up deselect click
    this.registerDomEvent(document, "pointerup", () => {
      if (!this.panning) return;
      if (this.panning.moved) this.suppressNextClick = true;
      this.panning = null;
      this.canvasEl.removeClass("fp-panning");
    });
    // Link hover tracking for Ctrl+hover page previews
    this.registerDomEvent(this.canvasEl, "mouseover", (e: MouseEvent) => this.onLinkHoverOver(e));
    this.registerDomEvent(this.canvasEl, "mouseout", (e: MouseEvent) => this.onLinkHoverOut(e));
    this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") this.setCtrlPreview(true);   // Ctrl down
    });
    this.registerDomEvent(document, "keyup", (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") this.setCtrlPreview(false);  // Ctrl up
    });
    console.log("Freeplane: onOpen listeners registered");

    // External file changes: reload unless we hold unsaved edits
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!(file instanceof TFile)) return;
        if (!this.file || file.path !== this.file.path) return;        // not our file
        if (this.saving) return;                                       // our own write
        if (Date.now() - this.lastSavedAt < 1000) return;              // save echo window
        if (this.dirty) {
          new Notice("Freeplane file changed on disk while you have unsaved edits.");
          return;
        }
        await this.loadFile(file);
      })
    );

    // ----- non-critical extras, isolated so they can never kill the view -----
    try {
      this.addAction("save", "Save map", () => { this.save(); });      // header buttons
      this.addAction("undo-2", "Undo", () => { this.undo(); });
      this.addAction("redo-2", "Redo", () => { this.redo(); });
      this.addAction("panel-right", "Toggle side panel", () => { this.toggleSidebar(); });
    } catch (e) { console.error("Freeplane: addAction failed", e); }
    try { this.initSaveHotkey(); } catch (e) { console.error("Freeplane: initSaveHotkey failed", e); }

    const initialFile = this.file || this.pendingFile;                 // restored/opened file
    if (initialFile) {
      try { await this.loadFile(initialFile); } catch { /* renderError already shown */ }
    }
    console.log("Freeplane: onOpen done");
  }

  /** Log + safely delegate to the base class when the leaf swaps files. */
  async onUnloadFile(file: TFile) {
    console.log("Freeplane: onUnloadFile", file?.path);
    const proto: any = Object.getPrototypeOf(Object.getPrototypeOf(this));
    try {
      if (proto && typeof proto.onUnloadFile === "function") await proto.onUnloadFile.call(this, file);
    } catch (e) {
      console.error("Freeplane: base onUnloadFile failed", e);
    }
  }

  /** Log + safely delegate to the base class on view teardown. */
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

  /**
   * Called by Obsidian when the leaf opens/switches a file. If the current
   * map is dirty, ask Save/Discard/Cancel first (modal opened outside the
   * layout transaction, with an 8s timeout fallback); cancel restores the
   * old file pointer. Any unexpected error renders an error pane instead of
   * leaving a dead leaf.
   */
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
              window.setTimeout(() => resolve("cancel"), 8000)        // watchdog
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
          if (current instanceof TFile) (this as any).file = current;  // restore pointer
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

  /** Close the leaf after a Save/Discard/Cancel prompt (palette command). */
  async closeWithPrompt() {
    if (this.dirty) {
      const action = await askUnsaved(this.app, "You have unsaved changes in this Freeplane map.");
      if (action === "save") await this.save();
      else if (action === "cancel") return;                            // stay open
    }
    this.leaf.detach();
  }

  /**
   * Try to bind Mod+S through the view scope (preempts global hotkeys);
   * some builds expose scope only after onOpen, so retry on an interval.
   */
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

  /**
   * Read + parse a file into `doc`, reset history/selection, render and
   * center. Before the UI exists the file is stashed in pendingFile.
   * Parse failures render an error pane and rethrow.
   */
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
      this.syncRichExpanded();                // preview visibility from HIDDEN
      this.loadedPath = file.path;
      this.history.clear();
      this.dirty = false;
      this.selectedId = null;
      this.renderAll();
      this.centerOnContent();                 // center now + after layout settles
      requestAnimationFrame(() => this.centerOnContent());
      window.setTimeout(() => this.centerOnContent(), 100);
    } catch (e: any) {
      this.doc = null;
      this.loadedPath = null;
      this.renderError(e?.message || String(e));
      throw e;
    }
  }

  /** Replace the whole view with a parse-error message (file untouched). */
  renderError(message: string) {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Cannot open .mm file" });
    this.contentEl.createEl("pre", { text: message });
    this.contentEl.createEl("p", { text: "The file was not modified." });
  }

  /**
   * Markdown pass: render every `.fp-md` div through MarkdownRenderer
   * (MathJax, wikilinks, Excalidraw embeds), then measure the results;
   * if any size changed, re-layout once. A delayed re-measure catches
   * late-loading embeds. `mdPass` token cancels stale passes.
   */
  async renderMarkdownPass() {
    const divs = Array.from(this.svg.querySelectorAll(".fp-md")) as HTMLElement[];
    if (divs.length === 0) return;
    const token = ++this.mdPass;
    const comp = new Component();             // lifecycle owner for embeds
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
        div.textContent = n.text;             // graceful fallback
      }
    }));
    if (token !== this.mdPass) return;        // superseded by newer pass
    const old = this.mdComponent;
    this.mdComponent = comp;
    if (old && old !== comp) { try { this.removeChild(old); } catch {} }
    if (this.measureMd(token)) this.renderAll();
    else window.setTimeout(() => {
      if (token === this.mdPass && this.measureMd(token)) this.renderAll();
    }, 700);
  }

  /** Compare measured div sizes against the cache; true if any changed. */
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

  /** +/- button zoom: anchor on the viewport center. */
  zoomStep(delta: number) {
    const newZoom = Math.min(3, Math.max(0.1, Math.round((this.zoom + delta) * 100) / 100));
    if (newZoom === this.zoom) return;
    const r = this.canvasEl.getBoundingClientRect();
    this.zoomAt(newZoom, {
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2
    } as any);
  }

  /**
   * Zoom keeping an anchor fixed: selected node center, else the mouse
   * cursor. Records the anchor's screen position, rescales, then scrolls
   * the delta away so the anchor never moves.
   */
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
        this.canvasEl.scrollLeft += after.x - before.x;   // cancel the drift
        this.canvasEl.scrollTop += after.y - before.y;
      }
    }
  }

  /** Track hovered link; show preview when Ctrl is already held. */
  onLinkHoverOver(e: MouseEvent) {
    const t = e.target as Element;
    const link = t.closest ? t.closest("a.internal-link, .fp-rich-link") : null;
    if (link === this.hoverLinkEl) return;
    this.hidePreview();
    this.hoverLinkEl = link;
    if (link && (e.ctrlKey || e.metaKey)) this.showPreview(link);
  }

  /** Clear hovered link + preview when the cursor leaves it. */
  onLinkHoverOut(e: MouseEvent) {
    const t = e.target as Element;
    const link = t.closest ? t.closest("a.internal-link, .fp-rich-link") : null;
    if (!link) return;
    const to = e.relatedTarget as Element | null;
    if (to && link.contains(to)) return;       // still inside the same link
    this.hoverLinkEl = null;
    this.hidePreview();
  }

  /** Ctrl pressed/released while hovering a link toggles the preview. */
  setCtrlPreview(on: boolean) {
    if (on && this.hoverLinkEl) this.showPreview(this.hoverLinkEl);
    else if (!on) this.hidePreview();
  }

  /**
   * Page-preview popover: resolves the link target and renders it with
   * MarkdownRenderer (full note for .md, embed syntax for other files).
   */
  async showPreview(link: Element) {
    this.hidePreview();
    const href = link.getAttribute("data-href") || link.getAttribute("href") || "";
    if (!href) return;
    const target = (this.app.metadataCache as any).getFirstLinkpathDest(
      href,
      this.file?.path || ""
    );
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
        await (MarkdownRenderer as any).render(
          this.app,
          "![[" + target.name + "]]",
          el,
          this.file?.path || "",
          comp
        );
      }
    } catch {
      el.textContent = target.path;            // fallback: show path
    }
  }

  /** Tear down the preview popover and its Component. */
  hidePreview() {
    if (!this.hoverPop) return;
    const pop = this.hoverPop;
    this.hoverPop = null;
    try { this.removeChild(pop.comp); } catch {}
    pop.el.remove();
  }

  /** Zoom + pan so the whole map fits the canvas with 40px padding. */
  fitMap() {
    if (!this.layout || !this.canvasEl) return;
    const b = this.layout.bounds as number[];
    if (!b) return;
    const bw = b[2] - b[0];
    const bh = b[3] - b[1];
    if (bw <= 0 || bh <= 0) return;
    const pad = 40;
    const z = Math.min(
      (this.canvasEl.clientWidth - 2 * pad) / bw,
      (this.canvasEl.clientHeight - 2 * pad) / bh
    );
    this.zoom = Math.min(3, Math.max(0.1, Math.round(z * 100) / 100));
    this.applyZoom();
    this.centerOnContent();
  }

  /** Pan so the content bounds center in the viewport (zoom unchanged). */
  centerOnContent() {
    if (!this.layout || !this.canvasEl) return;
    const vb = this.layout.viewBox as number[];
    const b = this.layout.bounds as number[];
    if (!vb || !b) return;
    const cx = (b[0] + b[2]) / 2;              // content center, user units
    const cy = (b[1] + b[3]) / 2;
    this.canvasEl.scrollLeft =
      (cx - vb[0]) * this.zoom - this.canvasEl.clientWidth / 2;
    this.canvasEl.scrollTop =
      (cy - vb[1]) * this.zoom - this.canvasEl.clientHeight / 2;
  }

  /** Apply the zoom factor to the svg pixel size (viewBox unchanged). */
  applyZoom() {
    if (!this.svg || !this.layout) return;
    this.svg.setAttribute("width", String(Math.round(this.layout.width * this.zoom)));
    this.svg.setAttribute("height", String(Math.round(this.layout.height * this.zoom)));
  }

  /**
   * Full re-render: layout -> svg -> zoom -> viewport anchor restore ->
   * markdown pass -> sidebar -> tab title. The anchor (user-space point at
   * viewport center) is recorded first and re-scrolled into place after, so
   * folds/edits never shift the view.
   */
  renderAll() {
    if (!this.doc || !this.svg) return;
    // user-space point currently at viewport center -> keep it fixed
    let anchor: { x: number; y: number } | null = null;
    if (this.svg.getAttribute("viewBox") && this.canvasEl.clientWidth > 0) {
      const r = this.canvasEl.getBoundingClientRect();
      anchor = clientToSvg(this.svg, r.left + r.width / 2, r.top + r.height / 2);
    }
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
    if (anchor) {
      const pt = this.svg.createSVGPoint();
      pt.x = anchor.x;
      pt.y = anchor.y;
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
    (this.leaf as any).updateHeader?.();       // refresh tab title
  }

  /**
   * Rebuild the right panel. Help mode (no selection) shows the zoom +/-
   * buttons and hotkey help; node mode shows ID, TEXT and DETAILS/NOTE
   * editors plus the single "Update node" button.
   */
  renderSidebar() {
    this.sidebarEl.empty();
    if (!this.doc) return;
    if (!this.selectedId) {
      const zoomRow = this.sidebarEl.createDiv({ cls: "fp-zoom-row" });   // touch zoom
      zoomRow.createEl("button", { text: "+" }).addEventListener("click", () => this.zoomStep(0.1));
      zoomRow.createEl("button", { text: "\u2212" }).addEventListener("click", () => this.zoomStep(-0.1));
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
    this.attachSuggest(textInput);             // [[ link autocomplete
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
    const doUpdate = () => {                   // single undoable write of all 3
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
    };
    update.addEventListener("click", doUpdate);
  }

  /** Manual double-click detection for preview lines (DOM survives re-renders). */
  richLineClicked(id: string, type: "DETAILS" | "NOTE") {
    const now = Date.now();
    const last = this.lastRichClick;
    if (last && last.id === id && last.type === type && now - last.time < 450) {
      this.lastRichClick = null;          // second click within 450ms = dblclick
      this.startRichEdit(id, type);
    } else {
      this.lastRichClick = { id, type, time: now };   // remember first click
    }
  }

  /** Move selection to previous/next sibling, cyclically. */
  selectSiblingNav(dir: -1 | 1) {
    if (!this.doc || !this.selectedId) return;
    const el = nodeById(this.doc, this.selectedId);
    if (!el || !el.parentElement) return;
    const siblings = this.nodeChildren(el.parentElement);
    if (siblings.length === 0) return;
    const idx = siblings.indexOf(el);
    const next = (idx + dir + siblings.length) % siblings.length;   // wrap around
    const id = siblings[next].getAttribute("ID");
    if (id) { this.selectedId = id; this.renderAll(); }
  }

  /** Move selection up to the parent node. */
  selectParentNav() {
    if (!this.doc || !this.selectedId) return;
    const el = nodeById(this.doc, this.selectedId);
    if (!el) return;
    const parent = el.parentElement;
    if (!parent || parent.nodeName.toLowerCase() !== "node") return;  // root has none
    const id = parent.getAttribute("ID");
    if (id) { this.selectedId = id; this.renderAll(); }
  }

  /**
   * Move selection down to the first child (unfolding both ends).
   * On a leaf: jump to first sibling; if already first - to the last one.
   */
  selectFirstChildNav() {
    if (!this.doc || !this.selectedId) return;
    const el = nodeById(this.doc, this.selectedId);
    if (!el) return;
    const before = serializeDoc(this.doc);
    let changed = false;
    // open the node we leave so children are visible
    if (el.getAttribute("FOLDED") === "true") { el.removeAttribute("FOLDED"); changed = true; }
    const first = this.nodeChildren(el)[0];
    if (!first) {
      // leaf: jump to first sibling; if already first - to the last one
      const parent = el.parentElement;
      if (parent && parent.nodeName.toLowerCase() === "node") {
        const siblings = this.nodeChildren(parent);
        const idx = siblings.indexOf(el);
        const target = idx === 0 ? siblings[siblings.length - 1] : siblings[0];
        if (target) {
          this.selectedId = target.getAttribute("ID");
          if (changed) this.commit(before);
          else this.renderAll();
        }
      }
      return;
    }
    // open the node we enter
    if (first.getAttribute("FOLDED") === "true") { first.removeAttribute("FOLDED"); changed = true; }
    this.selectedId = first.getAttribute("ID");
    if (changed) this.commit(before);
    else this.renderAll();
  }

  /** Right-click menu for a node: rename / edit / delete / fold controls. */
  openNodeMenu(id: string, e: MouseEvent) {
    if (this.selectedId !== id) {
      this.selectedId = id;               // right-click also selects
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

  /** Delete node + subtree (root protected); selection falls to parent. */
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

  /** Fold the node and every descendant. */
  collapseChildren(id: string) {
    this.setFoldRecursive(id, true);
  }

  /** Unfold the node and every descendant. */
  expandAll(id: string) {
    this.setFoldRecursive(id, false);
  }

  /** Apply FOLDED to a subtree; only nodes with children get the attribute. */
  setFoldRecursive(id: string, folded: boolean) {
    if (!this.doc || !id) return;
    const el = nodeById(this.doc, id);
    if (!el) return;
    const before = serializeDoc(this.doc);
    const targets = [el, ...Array.from(el.querySelectorAll("node"))];  // whole subtree
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

  /** Show/hide the right panel (header action). */
  toggleSidebar(forceHidden?: boolean) {
    this.sidebarHidden =
      typeof forceHidden === "boolean" ? forceHidden : !this.sidebarHidden;
    if (this.sidebarEl) {
      this.sidebarEl.style.display = this.sidebarHidden ? "none" : "";
    }
  }

  /** Re-derive preview visibility from HIDDEN attributes in the DOM. */
  syncRichExpanded() {
    this.richExpanded = new Set<string>();
    if (!this.doc) return;
    this.doc.querySelectorAll("richcontent").forEach((rc: any) => {
      const type = rc.getAttribute("TYPE");
      if (type !== "DETAILS" && type !== "NOTE") return;
      if (rc.getAttribute("HIDDEN") === "true") return;   // hidden in Freeplane
      const parent = rc.parentElement;
      if (parent && parent.nodeName.toLowerCase() === "node") {
        const id = parent.getAttribute("ID");
        if (id) this.richExpanded.add(id);                // visible preview
      }
    });
  }

  /** Toggle DETAILS/NOTE preview by writing/removing HIDDEN (undoable). */
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
      if (showing) rc.setAttribute("HIDDEN", "true");     // hide in file too
      else rc.removeAttribute("HIDDEN");
    });
    this.syncRichExpanded();
    this.selectedId = id;
    this.commit(before);
  }

  /** Sidebar "Update node": TEXT + DETAILS + NOTE in one undo step. */
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

  /** Write one richcontent type (inline editors, menu actions). */
  updateRichContent(id: string, type: "DETAILS" | "NOTE", source: string) {
    if (!this.doc) return;
    const el = nodeById(this.doc, id);
    if (!el) return;
    const before = serializeDoc(this.doc);
    setRichContent(this.doc, el, type, source);
    this.commit(before);
  }

  /**
   * Normal-phase hotkeys (view active, focus not in an editor):
   * Ctrl+Z undo/redo, Space fold, Shift+Space preview, arrows navigate,
   * Ctrl+arrows move structurally, Enter/Shift+Enter/Insert create,
   * Delete removes. Letters are handled capture-phase in onOpen.
   */
  handleKeydown(e: KeyboardEvent) {
    const key = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === "KeyZ") {         // physical Z: layout-independent
      if (this.isEditableTarget(e.target)) return;
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (this.isEditableTarget(e.target)) return;           // typing: leave keys alone
    if (!this.selectedId) return;                          // navigation needs selection
    if (key === " " && e.shiftKey) {
      e.preventDefault();
      this.toggleRichPreview(this.selectedId);
      return;
    }
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
      if (e.shiftKey) this.createSiblingBeforeSelected();  // above
      else this.createSiblingAfterSelected();             // below
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

  /** Create a detached <node> element with Freeplane-style attributes. */
  createMmNode(text = ""): Element | null {
    if (!this.doc) return null;
    const el = this.doc.createElement("node");
    const now = String(Date.now());
    if (text) el.setAttribute("TEXT", text);               // empty TEXT omitted
    el.setAttribute("ID", this.generateNodeId());
    el.setAttribute("CREATED", now);
    el.setAttribute("MODIFIED", now);
    return el;
  }

  /** Unique Freeplane-style ID_######### not present in the document. */
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

  /** Direct <node> children of an element. */
  nodeChildren(el: Element): Element[] {
    return Array.from(el.children).filter(
      (c) => c.nodeName.toLowerCase() === "node"
    );
  }

  /** Next sibling that is a <node>. */
  nextNodeSibling(el: Element): Element | null {
    let n = el.nextElementSibling;
    while (n && n.nodeName.toLowerCase() !== "node") {
      n = n.nextElementSibling;
    }
    return n;
  }

  /** Previous sibling that is a <node>. */
  prevNodeSibling(el: Element): Element | null {
    let n = el.previousElementSibling;
    while (n && n.nodeName.toLowerCase() !== "node") {
      n = n.previousElementSibling;
    }
    return n;
  }

  /** Ctrl+Up/Down: reorder among siblings, cyclically. */
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
        parent.insertBefore(el, this.nextNodeSibling(last));  // wrap to end
      } else {
        parent.insertBefore(el, siblings[idx - 1]);
      }
    } else {
      if (idx === siblings.length - 1) {
        parent.insertBefore(el, siblings[0]);                 // wrap to start
      } else {
        parent.insertBefore(el, this.nextNodeSibling(siblings[idx + 1]));
      }
    }
    this.commit(before);
  }

  /** Ctrl+Left: move node to parent's level, right after the parent. */
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
    grand.insertBefore(el, this.nextNodeSibling(parent));     // after parent
    el.removeAttribute("POSITION");                           // no longer top-level
    this.commit(before);
  }

  /** Ctrl+Right: make node the last child of its previous sibling. */
  demoteSelected() {
    if (!this.doc || !this.selectedId) return;
    const el = nodeById(this.doc, this.selectedId);
    if (!el) return;
    const prev = this.prevNodeSibling(el);
    if (!prev) return;                                        // nowhere to demote into
    const before = serializeDoc(this.doc);
    prev.appendChild(el);
    prev.removeAttribute("FOLDED");                           // show the new child
    el.removeAttribute("POSITION");
    this.commit(before);
  }

  /** Shift+Enter: empty sibling above the selection; opens the editor. */
  createSiblingBeforeSelected() {
    if (!this.doc || !this.selectedId) return;
    const current = nodeById(this.doc, this.selectedId);
    if (!current || !current.parentElement) return;
    const parent = current.parentElement;
    if (parent.nodeName.toLowerCase() === "map") return;      // root has no siblings
    const node = this.createMmNode();
    if (!node) return;
    if (parent.parentElement?.nodeName.toLowerCase() === "map") {
      node.setAttribute("POSITION", current.getAttribute("POSITION") || "right");
    }
    const before = serializeDoc(this.doc);
    parent.insertBefore(node, current);
    this.selectedId = node.getAttribute("ID");
    this.commit(before);
    window.setTimeout(() => {
      if (this.selectedId) this.startTextEdit(this.selectedId);  // type immediately
    }, 0);
  }

  /** Enter: empty sibling below the selection; opens the editor. */
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

  /** Insert: empty child of the selection; unfolds and opens the editor. */
  createChildOfSelected() {
    if (!this.doc || !this.selectedId) return;
    const current = nodeById(this.doc, this.selectedId);
    if (!current) return;
    const node = this.createMmNode();
    if (!node) return;
    if (current.parentElement?.nodeName.toLowerCase() === "map") {
      node.setAttribute("POSITION", "right");                 // new top-level side
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

  /** Rename via inline editor or sidebar; invalidates markdown size cache. */
  updateNodeText(id: string, text: string) {
    if (!this.doc) return;
    const el = nodeById(this.doc, id);
    if (!el) return;
    if ((el.getAttribute("TEXT") || "") === text) return;     // no-op guard
    const before = serializeDoc(this.doc);
    setText(el, text);
    delete this.mdSizes[id];                                  // size may change
    this.commit(before);
  }

  /** Fold/unfold one node (circle click or Space). */
  toggleFold(id: string) {
    if (!this.doc) return;
    const el = nodeById(this.doc, id);
    if (!el) return;
    const before = serializeDoc(this.doc);
    if (!toggleFolded(el)) return;                            // leaves can't fold
    this.commit(before);
  }

  /** Write DETAILS/NOTE from the sidebar (legacy single-type path). */
  applyRichContent(type: "DETAILS" | "NOTE", source: string) {
    if (!this.doc || !this.selectedId) return;
    const el = nodeById(this.doc, this.selectedId);
    if (!el) return;
    const before = serializeDoc(this.doc);
    setRichContent(this.doc, el, type, source);
    this.commit(before);
  }

  /** Single mutation entry point: snapshot, dirty, sync previews, render. */
  commit(before: string) {
    this.history.push(before);
    this.dirty = true;
    this.syncRichExpanded();
    this.renderAll();
  }

  /** Undo last mutation (snapshot swap). */
  undo() {
    if (!this.doc) return;
    const current = serializeDoc(this.doc);
    const prev = this.history.undo(current);
    if (!prev) { new Notice("Nothing to undo."); return; }
    this.restoreSnapshot(prev);
  }

  /** Redo last undone mutation. */
  redo() {
    if (!this.doc) return;
    const current = serializeDoc(this.doc);
    const next = this.history.redo(current);
    if (!next) { new Notice("Nothing to redo."); return; }
    this.restoreSnapshot(next);
  }

  /** Replace the live DOM with a snapshot and re-render. */
  restoreSnapshot(xml: string) {
    try {
      this.doc = parseMm(xml);
      this.syncRichExpanded();
      this.dirty = true;              // restored state is unsaved vs disk
      this.renderAll();
    } catch {
      new Notice("Could not restore snapshot.");
    }
  }

  /**
   * The only writer: serialize, re-parse as a safety gate (refuse invalid
   * XML), then vault.process/modify. Updates originalText + timestamps so
   * the modify watcher ignores our own write.
   */
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

  /** Pointerdown on a node: arm a potential drag (5px threshold later). */
  startDrag(id: string, e: PointerEvent) {
    if (!this.doc || e.button !== 0) return;
    e.preventDefault();               // no text selection while dragging
    console.log("FP DRAG start", id);
    const el = nodeById(this.doc, id);
    if (!el) return;
    this.dragging = { id, el, startX: e.clientX, startY: e.clientY, started: false };
  }

  /** Pointermove: start drag past threshold, hit-test, draw drop overlay. */
  onDragMove(e: PointerEvent) {
    if (!this.dragging || !this.layout) return;
    if (!this.dragging.started) {
      const dx = e.clientX - this.dragging.startX;
      const dy = e.clientY - this.dragging.startY;
      if (Math.hypot(dx, dy) < 5) return;                     // click tolerance
      this.dragging.started = true;
      console.log("FP DRAG moving");
      this.canvasEl.addClass("fp-dragging");
    }
    const pt = clientToSvg(this.svg, e.clientX, e.clientY);   // screen -> user units
    this.dropHint = this.hitTest(pt);
    if (this.dropHint) console.log("FP DRAG hint", this.dropHint.mode, this.dropHint.id);
    this.updateDropOverlay();
  }

  /** Pointerup: commit the move (or just clean up if no valid target). */
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
    if (hint.id === drag.id) return;                          // dropped on itself
    const before = serializeDoc(this.doc);
    const changed = moveNode(this.doc, drag.id, hint.id, hint.mode, hint.side);
    if (changed) this.commit(before);
    else this.renderAll();
  }

  /**
   * Find the drop target under a user-space point: nearest node box
   * (20px padding); top/bottom quarter of non-root nodes = before/after
   * sibling, middle (or root) = child. Side hint from root's midline.
   */
  hitTest(pt: { x: number; y: number }) {
    if (!this.layout || !this.dragging) return null;
    const nodes = this.layout.nodes as any[];
    for (let i = nodes.length - 1; i >= 0; i--) {             // topmost first
      const n = nodes[i];
      const pad = 20;
      const inside =
        pt.x >= n.x - pad &&
        pt.x <= n.x + n.width + pad &&
        pt.y >= n.y - pad &&
        pt.y <= n.y + n.height + pad;
      if (!inside) continue;
      if (n.id === this.dragging.id) continue;                // skip self
      if (this.dragging.el.contains(n.el)) continue;          // skip descendants
      let mode: "child" | "before" | "after" = "child";
      if (n.depth > 0) {
        const top = n.y + n.height * 0.25;
        const bottom = n.y + n.height * 0.75;
        if (pt.y < top) mode = "before";
        else if (pt.y > bottom) mode = "after";
      }
      if (n.depth === 0 && mode !== "child") continue;        // root: child only
      return { id: n.id, mode, side: this.sideFromPoint(pt) };
    }
    return null;
  }

  /** Which side of the root the point is on (for POSITION of top-level). */
  sideFromPoint(pt: { x: number; y: number }): "left" | "right" {
    const root = this.layout?.byId?.[this.layout?.rootId];
    if (!root) return "right";
    return pt.x < root.x + root.width / 2 ? "left" : "right";
  }

  /** Draw/move/remove the drop indicator (outline or sibling line). */
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
      overlay.setAttribute("x", String(n.x - 2));             // outline the box
      overlay.setAttribute("y", String(n.y - 2));
      overlay.setAttribute("width", String(n.width + 4));
      overlay.setAttribute("height", String(n.height + 4));
      overlay.setAttribute("rx", "8");
    } else {
      const lineY = this.dropHint.mode === "before" ? n.y - 2 : n.y + n.height + 2;
      overlay.setAttribute("x", String(n.x));                 // thin sibling line
      overlay.setAttribute("y", String(lineY - 1));
      overlay.setAttribute("width", String(n.width));
      overlay.setAttribute("height", "2");
      overlay.setAttribute("rx", "1");
    }
  }

  /**
   * Inline rename editor: a textarea placed over the node, font scaled to
   * the current zoom, auto-growing (width to 60 chars, then line by line).
   * Enter commits, Shift+Enter newline, Esc cancels, blur commits.
   */
  startTextEdit(id: string) {
    const n = this.layout?.byId?.[id];
    if (!n) return;
    const nodeG = this.svg.querySelector('.fp-node[data-id="' + cssEscape(id) + '"]') as SVGGElement | null;
    if (!nodeG) return;
    const box = nodeG.getBoundingClientRect();
    const canvasBox = this.canvasEl.getBoundingClientRect();
    const input = this.canvasEl.createEl("textarea", { cls: "fp-inline-edit" }) as HTMLTextAreaElement;
    this.attachSuggest(input);          // [[ autocomplete inside the editor
    input.value = n.text || "";
    input.style.left = (box.left - canvasBox.left + this.canvasEl.scrollLeft) + "px";
    input.style.top = (box.top - canvasBox.top + this.canvasEl.scrollTop) + "px";
    // match the on-screen (zoomed) text size of the node
    const scale = box.width / Math.max(n.width, 1);
    const resizeEdit = () => {
      const fs = 13 * scale;
      input.style.fontSize = fs + "px";
      const lines = input.value.split("\n");
      let longest = 0;
      let visual = 0;
      for (const ln of lines) {
        longest = Math.max(longest, ln.length);
        visual += Math.max(1, Math.ceil(ln.length / 60));     // wrapped lines
      }
      // grow horizontally to 60 chars first, then vertically line by line
      const chars = Math.min(Math.max(longest, 8), 60);
      const w = chars * fs * 0.55 + 24;
      const h = visual * fs * 1.35 + 14;
      input.style.width = Math.max(w, box.width) + "px";
      input.style.height = Math.max(h, box.height) + "px";
    };
    resizeEdit();
    input.addEventListener("input", resizeEdit);              // live growth
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
      e.stopPropagation();              // editor keys never reach view hotkeys
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", () => commit());           // click-away saves
    this.canvasEl.appendChild(input);
    input.focus();
    const tl = input.value.length;
    input.setSelectionRange(tl, tl);    // cursor at end, nothing selected
  }

  /**
   * Inline DETAILS/NOTE editor opened from the → circles or Ctrl+D:
   * textarea over the preview area; Enter/Ctrl+Enter/blur commit, Esc cancels.
   */
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
    textarea.value = richContentSource(el, type);             // plain-text UX
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
    textarea.setSelectionRange(tl2, tl2);   // cursor at end
  }

  /** Attach the [[ link autocomplete to any input/textarea. */
  attachSuggest(input: any) {
    new LinkSuggest(this, input);
  }

  /** True when the event target is a text-editing element. */
  isEditableTarget(target: EventTarget | null): boolean {
    if (!target) return false;
    const el = target as HTMLElement;
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
  }
}

/**
 * Link autocomplete for our editors: typing [[ (notes) or ![[ (any file)
 * opens a fixed-position popup filtered by the typed prefix; arrows/Enter/
 * Tab pick an entry, Esc closes. Consumes keys via stopImmediatePropagation
 * so the editors' own Enter handlers stay out of the way.
 */
class LinkSuggest {
  view: any;
  input: any;
  popup: HTMLElement | null = null;
  items: any[] = [];
  index = 0;
  open = false;
  matchStart = 0;       // index of "[" (or "!") of the active [[ token
  partialEnd = 0;       // caret position when the token was matched
  embed = false;        // ![[ form?
  query = "";           // typed prefix

  /** Bind key/input/blur listeners on the host field. */
  constructor(view: any, input: any) {
    this.view = view;
    this.input = input;
    input.addEventListener("keydown", (e: KeyboardEvent) => this.handleKey(e));
    input.addEventListener("input", () => this.update());
    input.addEventListener("blur", () => window.setTimeout(() => this.close(), 150));
  }

  /** Popup navigation keys; returns true when the key was consumed. */
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
      e.stopImmediatePropagation();     // Esc closes popup, not the editor
      this.close();
      return true;
    }
    return false;
  }

  /** Cycle the highlighted item. */
  move(d: number) {
    if (!this.items.length) return;
    this.index = (this.index + d + this.items.length) % this.items.length;
    this.refreshSel();
  }

  /** Re-apply the highlight class after move/hover. */
  refreshSel() {
    if (!this.popup) return;
    Array.from(this.popup.children).forEach((c, i) => {
      (c as HTMLElement).toggleClass("selected", i === this.index);
    });
  }

  /** Detect an unterminated [[ / ![[ token before the caret; refresh list. */
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

  /** Display name: basename for notes, full name for other files. */
  label(f: any): string {
    return f.extension === "md" ? f.basename : f.name;
  }

  /** Candidates: md files for [[, all files for ![[; prefix-ranked, top 8. */
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
      const as = a.l.toLowerCase().startsWith(q) ? 0 : 1;     // prefix first
      const bs = b.l.toLowerCase().startsWith(q) ? 0 : 1;
      if (as !== bs) return as - bs;
      return a.l.length - b.l.length;                        // then shortest
    });
    this.items = hits.slice(0, 8).map((x) => x.f);
    this.index = 0;
  }

  /** (Re)build the popup under the input field. */
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
        item.createSpan({ cls: "fp-suggest-path", text: "  " + f.parent.path });  // folder hint
      }
      item.addEventListener("mouseenter", () => { this.index = i; this.refreshSel(); });
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();             // keep focus in the field
        e.stopPropagation();
        this.accept(f);
      });
    });
    this.open = true;
  }

  /** Replace the partial [[token]] with the chosen link; caret after it. */
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

  /** Hide the popup (state kept for reopen on next input). */
  close() {
    this.open = false;
    if (this.popup) this.popup.style.display = "none";
  }
}

/** Convert client (screen) coordinates to SVG user-space coordinates. */
function clientToSvg(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const t = pt.matrixTransform(ctm.inverse());
  return { x: t.x, y: t.y };
}

/** CSS-selector escaping with a fallback for old engines. */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/["\\]/g, "\\$&");
}
