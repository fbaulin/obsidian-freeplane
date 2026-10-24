import { installMapOutgoingLinks } from "./outgoingLinks";
import { installLinkIndex } from "./linkIndex";
import { Plugin, TFolder, TFile, Notice, PluginSettingTab, Setting } from "obsidian";
import { renamedLinks } from "./renameLinks";
import { installSearchIndex } from "./searchIndex";
import { serializeDoc, parseMm } from "./mm/xml";
import { FreeplaneView, VIEW_TYPE_FREEPLANE } from "./FreeplaneView";
import { applySettings, DEFAULT_SETTINGS, settings, SETTING_FIELDS, FpSettings, validIndexFolder } from "./settings";
import { setHotkeys, HOTKEYS_FILE_DEFAULT, DEFAULT_HOTKEYS, migrateHotkeys } from "./hotkeys";

export default class FreeplanePlugin extends Plugin {
  renameQueue: Promise<void> = Promise.resolve();
  changeSearchIndexFolder: (name: string) => Promise<void>;
  settingsQueue: Promise<void> = Promise.resolve();
  async onload() {
    this.registerView(VIEW_TYPE_FREEPLANE, (leaf) => new FreeplaneView(leaf, this));
    this.registerExtensions(["mm"], VIEW_TYPE_FREEPLANE);
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile)) return;
      this.renameQueue = this.renameQueue.then(async () => {
        for (const map of this.app.vault.getFiles().filter(f => f.extension === "mm")) {
          for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_FREEPLANE)) {
            const view = leaf.view as FreeplaneView;
            if (view.file?.path !== map.path || !view.doc) continue;
            const before = serializeDoc(view.doc);
            const after = renamedLinks(this.app, before, map.path, oldPath, file);
            if (after !== before) { view.doc = parseMm(after); view.commit(before); }
          }
          await this.app.vault.process(map, xml => renamedLinks(this.app, xml, map.path, oldPath, file));
        }
      }).catch(err => { console.error(err); new Notice("Could not update Freeplane links after rename."); });
    }));
    this.registerHoverLinkSource(VIEW_TYPE_FREEPLANE, { display: "Freeplane Mind Map", defaultMod: true });

    // settings.json + hotkeys.json from the plugin folder (created if missing)
    await this.loadConfigFiles();
    this.addSettingTab(new FreeplaneSettingsTab(this));
    // Never prune recovery at startup: the vault index/sync may be incomplete.
    installLinkIndex(this);
    installMapOutgoingLinks(this);
    this.changeSearchIndexFolder = installSearchIndex(this);

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
      if (await adapter.exists(sp)) {
        const loaded = JSON.parse(await adapter.read(sp));
        applySettings(loaded);
        const merged = { ...DEFAULT_SETTINGS, ...loaded };
        if (Object.keys(DEFAULT_SETTINGS).some((key) => !(key in loaded))) {
          await adapter.write(sp, JSON.stringify(merged, null, 2) + "\n");
        }
      } else await adapter.write(sp, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
    } catch (e) { console.error("Freeplane: settings.json", e); }
    try {
      const hp = dir + "/hotkeys.json";
      if (await adapter.exists(hp)) {
        const json = (await adapter.read(hp)).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
        const loaded = JSON.parse(json);
        const migrated = migrateHotkeys(loaded);
        setHotkeys(loaded);
        if (migrated || Object.keys(DEFAULT_HOTKEYS).some(key => !(key in loaded)))
          await adapter.write(hp, JSON.stringify({ ...DEFAULT_HOTKEYS, ...loaded }, null, 2) + "\n");
      } else await adapter.write(hp, HOTKEYS_FILE_DEFAULT);
    } catch (e) { console.error("Freeplane: hotkeys.json", e); }
  }

  saveSetting<K extends keyof FpSettings>(key: K, value: FpSettings[K]) {
    this.settingsQueue = this.settingsQueue.catch(() => {}).then(async () => {
      const path = `${this.manifest.dir}/settings.json`;
      const adapter = this.app.vault.adapter;
      const existing = await adapter.exists(path) ? JSON.parse(await adapter.read(path)) : {};
      const next = { ...existing, ...settings, [key]: value };
      if (key === "searchIndexFolder") {
        if (!validIndexFolder(String(value))) throw new Error("Enter a valid folder name without slashes or reserved characters.");
        await this.changeSearchIndexFolder(String(value));
      }
      try { await adapter.write(path, JSON.stringify(next, null, 2) + "\n"); }
      catch (error) {
        if (key === "searchIndexFolder") await this.changeSearchIndexFolder(settings.searchIndexFolder);
        throw error;
      }
      applySettings(next);
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_FREEPLANE)) {
        const view = leaf.view as FreeplaneView;
        view.mdSizes = {};
        view.renderAll();
        view.renderEditingPanel();
      }
    });
    return this.settingsQueue;
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

class FreeplaneSettingsTab extends PluginSettingTab {
  constructor(private owner: FreeplanePlugin) { super(owner.app, owner); }
  display() {
    this.containerEl.empty();
    this.containerEl.createEl("p", { text: "Changes apply immediately and are saved to settings.json." });
    new Setting(this.containerEl).setName("Search index folder")
      .setDesc("Vault-root folder for generated search notes. Changing this renames the existing folder; choose an unused name.")
      .addText(text => {
        text.setValue(settings.searchIndexFolder);
        text.inputEl.addEventListener("change", async () => {
          const name = text.getValue().trim();
          try { await this.owner.saveSetting("searchIndexFolder", name); text.setValue(settings.searchIndexFolder); }
          catch (e) { new Notice(e instanceof Error ? e.message : "Could not change index folder."); text.setValue(settings.searchIndexFolder); }
        });
      });
    for (const field of SETTING_FIELDS) {
      new Setting(this.containerEl).setName(field.name).setDesc(field.desc).addText(text => {
        const input = text.inputEl;
        input.type = "number"; input.min = String(field.min); input.max = String(field.max); input.step = String(field.step);
        text.setValue(String(settings[field.key]));
        input.addEventListener("change", async () => {
          const value = Number(input.value);
          if (!input.value.trim() || !Number.isFinite(value) || value < field.min || value > field.max) {
            new Notice(`Enter a number between ${field.min} and ${field.max}.`);
            text.setValue(String(settings[field.key])); return;
          }
          try { await this.owner.saveSetting(field.key, value); }
          catch (e) { console.error(e); new Notice("Could not save Freeplane settings."); text.setValue(String(settings[field.key])); }
        });
      });
    }
  }
}
