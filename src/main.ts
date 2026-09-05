import { Plugin, TFolder } from "obsidian";
import { FreeplaneView, VIEW_TYPE_FREEPLANE } from "./FreeplaneView";

export default class FreeplanePlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE_FREEPLANE, (leaf) => new FreeplaneView(leaf, this));

    // Make .mm files open in this view by default.
    this.registerExtensions(["mm"], VIEW_TYPE_FREEPLANE);

    this.registerEvent(
      (this.app.workspace as any).on("file-menu", (menu: any, file: any) => {
        menu.addItem((item: any) =>
          item
            .setTitle("New mind map")
            .setIcon("network")
            .onClick(() => {
              let folder: any = null;
              if (file instanceof TFolder) folder = file;
              else if (file && file.parent) folder = file.parent;
              this.createMindMap(folder);
            })
        );
      })
    );

    this.addCommand({
      id: "freeplane-new-map",
      name: "Create new mind map",
      callback: () => {
        const active = this.app.workspace.getActiveFile();
        this.createMindMap(active && active.parent ? active.parent : null);
      }
    });

    this.addCommand({
      id: "freeplane-save-current",
      name: "Save current Freeplane map",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(FreeplaneView);
        if (checking) return !!view;
        if (!view) return false;
        view.save();
        return true;
      }
    });

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

  async createMindMap(folder: any) {
    const base = folder && folder.path ? folder.path : "";
    
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const timestamp = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + "." + pad(d.getMinutes()) + "." + pad(d.getSeconds());
    
    const path = (base ? base + "/" : "") + timestamp + " New mind map.mm";

    const now = String(Date.now());
    const id = "ID_" + Math.floor(Math.random() * 1000000000);

    const content =
      '<map version="freeplane 1.9.0">\n' +
      '<!--To display this map, first you need to download and install Freeplane from http://www.freeplane.org-->\n' +
      '<node TEXT="New Mind Map" FOLDED="false" ID="' + id + '" CREATED="' + now + '" MODIFIED="' + now + '">\n' +
      '<edge STYLE="sharp"/>\n' +
      '</node>\n' +
      '</map>\n';

    const file = await this.app.vault.create(path, content);
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_FREEPLANE);
  }
}