/**
 * main.ts
 * Plugin entry point. Registers the Freeplane view for `.mm` files, the
 * "New mind map" creator (navigator context menu + palette command) and the
 * palette commands for save / close / undo / redo.
 */
import { Plugin, TFolder } from "obsidian";
import { FreeplaneView, VIEW_TYPE_FREEPLANE } from "./FreeplaneView";

/** Root plugin object instantiated by Obsidian. */
export default class FreeplanePlugin extends Plugin {
  /** Wire up view type, file association, menus and commands. */
  async onload() {
    // One view instance per leaf; the view owns all rendering/editing.
    this.registerView(VIEW_TYPE_FREEPLANE, (leaf) => new FreeplaneView(leaf, this));

    // Make .mm files open in this view by default.
    this.registerExtensions(["mm"], VIEW_TYPE_FREEPLANE);

    // "New mind map" entry in the file-explorer context menu.
    this.registerEvent(
      (this.app.workspace as any).on("file-menu", (menu: any, file: any) => {
        menu.addItem((item: any) =>
          item
            .setTitle("New mind map")
            .setIcon("network")
            .onClick(() => {
              let folder: any = null;                        // destination dir
              if (file instanceof TFolder) folder = file;    // right-clicked folder
              else if (file && file.parent) folder = file.parent; // else file's parent
              this.createMindMap(folder);
            })
        );
      })
    );

    // Palette command: create a map next to the active file (or vault root).
    this.addCommand({
      id: "freeplane-new-map",
      name: "Create new mind map",
      callback: () => {
        const active = this.app.workspace.getActiveFile();
        this.createMindMap(active && active.parent ? active.parent : null);
      }
    });

    // Palette command: save the active map (same as Ctrl+S).
    this.addCommand({
      id: "freeplane-save-current",
      name: "Save current Freeplane map",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(FreeplaneView);
        if (checking) return !!view;      // only show when a map is active
        if (!view) return false;
        view.save();
        return true;
      }
    });

    // Palette command: close with Save/Discard/Cancel prompt.
    this.addCommand({
      id: "freeplane-close-current",
      name: "Close current Freeplane map",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(FreeplaneView);
        if (checking) return !!view;
        if (!view) return false;
        view.closeWithPrompt();
        return true;
      }
    });

    // Palette command: undo in the active map.
    this.addCommand({
      id: "freeplane-undo",
      name: "Undo in current Freeplane map",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(FreeplaneView);
        if (checking) return !!view;
        if (!view) return false;
        view.undo();
        return true;
      }
    });

    // Palette command: redo in the active map.
    this.addCommand({
      id: "freeplane-redo",
      name: "Redo in current Freeplane map",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(FreeplaneView);
        if (checking) return !!view;
        if (!view) return false;
        view.redo();
        return true;
      }
    });
  }

  /**
   * Create an empty Freeplane-1.9-compatible map named
   * "yyyy-mm-dd hh.mm.ss New mind map.mm" inside `folder` and open it
   * in the map view.
   */
  async createMindMap(folder: any) {
    const base = folder && folder.path ? folder.path : "";   // target dir path

    // Timestamp prefix keeps names unique without collision checks.
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");   // 2-digit fields
    const timestamp =
      d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + "." + pad(d.getMinutes()) + "." + pad(d.getSeconds());

    const path = (base ? base + "/" : "") + timestamp + " New mind map.mm";

    const now = String(Date.now());                          // CREATED/MODIFIED
    const id = "ID_" + Math.floor(Math.random() * 1000000000); // Freeplane-style id

    // Minimal skeleton Freeplane 1.9.14 opens without warnings.
    const content =
      '<map version="freeplane 1.9.0">\n' +
      '<!--To display this map, first you need to download and install Freeplane from http://www.freeplane.org-->\n' +
      '<node TEXT="New Mind Map" FOLDED="false" ID="' + id + '" CREATED="' + now + '" MODIFIED="' + now + '">\n' +
      '<edge STYLE="sharp"/>\n' +
      '</node>\n' +
      '</map>\n';

    const file = await this.app.vault.create(path, content); // write to vault
    const leaf = this.app.workspace.getLeaf(false);          // reuse active leaf
    await leaf.openFile(file);                               // opens in our view
  }

  /** Close all map leaves when the plugin is disabled/unloaded. */
  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_FREEPLANE);
  }
}
