import { Plugin, TFolder } from "obsidian";
import { FreeplaneView, VIEW_TYPE_FREEPLANE } from "./FreeplaneView";
import { applySettings, DEFAULT_SETTINGS } from "./settings";
import { setHotkeys, HOTKEYS_FILE_DEFAULT } from "./hotkeys";

export default class FreeplanePlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE_FREEPLANE, (leaf) => new FreeplaneView(leaf, this));
    this.registerExtensions(["mm"], VIEW_TYPE_FREEPLANE);

    // settings.json + hotkeys.json from the plugin folder (created if missing)
    await this.loadConfigFiles();

    this.registerEvent(
      (this.app.workspace as any).on("file-menu", (menu: any, file: any) => {
        menu.addItem((item: any) =>
          item.setTitle("New mind map").setIcon("network").onClick(() => {
            let folder: any = null;
            if (file instanceof TFolder) folder = file;
            else if (file && file.parent) folder = file.parent;
            this.createMindMap(folder);
          })
        );
      })
    );

    this.addCommand({ id: "freeplane-new-map", name: "Create new mind map",
      callback: () => { const a = this.app.workspace.getActiveFile(); this.createMindMap(a && a.parent ? a.parent : null); } });
    this.addCommand({ id: "freeplane-save-current", name: "Save current Freeplane map",
      checkCallback: (c: boolean) => { const v = this.app.workspace.getActiveViewOfType(FreeplaneView); if (c) return !!v; if (!v) return false; v.save(); return true; } });
    this.addCommand({ id: "freeplane-close-current", name: "Close current Freeplane map",
      checkCallback: (c: boolean) => { const v = this.app.workspace.getActiveViewOfType(FreeplaneView); if (c) return !!v; if (!v) return false; v.closeWithPrompt(); return true; } });
    this.addCommand({ id: "freeplane-undo", name: "Undo in current Freeplane map",
      checkCallback: (c: boolean) => { const v = this.app.workspace.getActiveViewOfType(FreeplaneView); if (c) return !!v; if (!v) return false; v.undo(); return true; } });
    this.addCommand({ id: "freeplane-redo", name: "Redo in current Freeplane map",
      checkCallback: (c: boolean) => { const v = this.app.workspace.getActiveViewOfType(FreeplaneView); if (c) return !!v; if (!v) return false; v.redo(); return true; } });
  }

  async loadConfigFiles() {
    const dir = (this.manifest as any).dir || "";
    const adapter = this.app.vault.adapter;
    try {
      const sp = dir + "/settings.json";
      if (await adapter.exists(sp)) applySettings(JSON.parse(await adapter.read(sp)));
      else await adapter.write(sp, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
    } catch (e) { console.error("Freeplane: settings.json", e); }
    try {
      const hp = dir + "/hotkeys.json";
      if (await adapter.exists(hp)) {
        const json = (await adapter.read(hp)).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
        setHotkeys(JSON.parse(json));
      } else await adapter.write(hp, HOTKEYS_FILE_DEFAULT);
    } catch (e) { console.error("Freeplane: hotkeys.json", e); }
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
      '<edge STYLE="sharp"/>\n</node>\n</map>\n';
    const file = await this.app.vault.create(path, content);
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  onunload() { this.app.workspace.detachLeavesOfType(VIEW_TYPE_FREEPLANE); }
}
