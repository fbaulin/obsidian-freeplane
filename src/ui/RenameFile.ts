import { App, Modal, Notice, TFile } from "obsidian";

export class RenameFile extends Modal {
  constructor(app: App, private file: TFile) { super(app); }
  onOpen() {
    this.contentEl.createEl("h3", { text: "Rename file" });
    const input = this.contentEl.createEl("input", { type: "text", value: this.file.name });
    const button = this.contentEl.createEl("button", { text: "Rename", cls: "mod-cta" });
    const rename = async () => {
      const name = input.value.trim();
      if (!name || /[\\/:]/.test(name)) { new Notice("Enter a filename without a folder path."); return; }
      button.disabled = true;
      try {
        const parent = this.file.parent?.path;
        await this.app.fileManager.renameFile(this.file, (parent && parent !== "/" ? parent + "/" : "") + name);
        this.close();
      } catch (err) { new Notice(String(err)); button.disabled = false; }
    };
    button.onclick = () => { void rename(); };
    input.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); void rename(); } };
    input.focus(); input.setSelectionRange(0, this.file.basename.length);
  }
}
