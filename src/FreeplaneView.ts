import { FileView, TFile, Notice, WorkspaceLeaf } from "obsidian";
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

    // ----- critical input listeners first -----
    this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
      if (this.app.workspace.activeLeaf !== this.leaf) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() !== "z") return;
      if (this.isEditableTarget(e.target)) return;
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    });

    // capture-phase Mod+S: runs before Obsidian's global hotkey dispatcher
    this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
      if (this.app.workspace.activeLeaf !== this.leaf) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        this.save();
      }
    }, true);

    this.registerDomEvent(document, "pointermove", (e: PointerEvent) => this.onDragMove(e));
    this.registerDomEvent(document, "pointerup", (e: PointerEvent) => this.onDragEnd(e));
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

  renderAll() {
    if (!this.doc || !this.svg) return;
    this.layout = layoutMap(this.doc);
    renderMap(this.svg, this.layout, this.selectedId, {
      select: (id: string) => { this.selectedId = id; this.renderAll(); },
      toggleFold: (id: string) => this.toggleFold(id),
      startDrag: (id: string, e: PointerEvent) => this.startDrag(id, e),
      editText: (id: string) => this.startTextEdit(id)
    });
    this.renderSidebar();
    (this.leaf as any).updateHeader?.();
  }

  renderSidebar() {
    this.sidebarEl.empty();
    if (!this.doc) return;

    if (!this.selectedId) {
      this.sidebarEl.createEl("p", { text: "Select a node. Double-click to edit its text. Drag nodes to move them." });
      this.sidebarEl.createEl("p", { text: "Ctrl+S saves. Ctrl+Z / Ctrl+Shift+Z undo/redo." });
      return;
    }

    const el = nodeById(this.doc, this.selectedId);
    if (!el) { this.selectedId = null; this.renderSidebar(); return; }

    this.sidebarEl.createEl("h3", { text: "Node" });
    const idEl = this.sidebarEl.createEl("code");
    idEl.textContent = "ID: " + (el.getAttribute("ID") || "(none)");

    this.sidebarEl.createEl("label", { text: "Text" });
    const textInput = this.sidebarEl.createEl("input", { type: "text" });
    textInput.value = el.getAttribute("TEXT") || "";
    textInput.addEventListener("change", () => {
      if (this.selectedId) this.updateNodeText(this.selectedId, textInput.value);
    });

    this.sidebarEl.createEl("label", { text: "DETAILS richcontent (plain lines or XHTML)" });
    const details = this.sidebarEl.createEl("textarea");
    details.value = richContentSource(el, "DETAILS");
    const applyDetails = this.sidebarEl.createEl("button", { text: "Apply details" });
    applyDetails.addEventListener("click", () => {
      try { this.applyRichContent("DETAILS", details.value); new Notice("Details updated."); }
      catch (e: any) { new Notice("Details not applied: " + (e?.message || String(e))); }
    });

    this.sidebarEl.createEl("label", { text: "NOTE richcontent (plain lines or XHTML)" });
    const note = this.sidebarEl.createEl("textarea");
    note.value = richContentSource(el, "NOTE");
    const applyNote = this.sidebarEl.createEl("button", { text: "Apply note" });
    applyNote.addEventListener("click", () => {
      try { this.applyRichContent("NOTE", note.value); new Notice("Note updated."); }
      catch (e: any) { new Notice("Note not applied: " + (e?.message || String(e))); }
    });
  }

  updateNodeText(id: string, text: string) {
    if (!this.doc) return;
    const el = nodeById(this.doc, id);
    if (!el) return;
    if ((el.getAttribute("TEXT") || "") === text) return;
    const before = serializeDoc(this.doc);
    setText(el, text);
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

    const input = this.canvasEl.createEl("input", { cls: "fp-inline-edit" }) as HTMLInputElement;
    input.value = n.text || "";
    input.style.left = (box.left - canvasBox.left + this.canvasEl.scrollLeft) + "px";
    input.style.top = (box.top - canvasBox.top + this.canvasEl.scrollTop) + "px";
    input.style.width = Math.max(box.width, 80) + "px";
    input.style.height = Math.max(box.height, 26) + "px";

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
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", () => commit());

    this.canvasEl.appendChild(input);
    input.focus();
    input.select();
  }

  isEditableTarget(target: EventTarget | null): boolean {
    if (!target) return false;
    const el = target as HTMLElement;
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
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
