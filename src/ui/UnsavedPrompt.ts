import { Modal } from "obsidian";

export type UnsavedChoice = "save" | "discard" | "cancel";

export function askUnsaved(app: any, message: string): Promise<UnsavedChoice> {
  return new Promise((resolve) => {
    new UnsavedModal(app, message, resolve).open();
  });
}

class UnsavedModal extends Modal {
  message: string;
  resolve: (choice: UnsavedChoice) => void;
  done = false;

  constructor(app: any, message: string, resolve: (choice: UnsavedChoice) => void) {
    super(app);
    this.message = message;
    this.resolve = resolve;
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: "Unsaved changes" });
    this.contentEl.createEl("p", { text: this.message });

    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });

    const saveBtn = buttons.createEl("button", { text: "Save", cls: "mod-cta" });
    const discardBtn = buttons.createEl("button", { text: "Discard", cls: "mod-warning" });
    const cancelBtn = buttons.createEl("button", { text: "Cancel" });

    saveBtn.onclick = () => this.choose("save");
    discardBtn.onclick = () => this.choose("discard");
    cancelBtn.onclick = () => this.choose("cancel");
  }

  choose(choice: UnsavedChoice) {
    if (this.done) return;
    this.done = true;
    this.close();
    this.resolve(choice);
  }

  onClose() {
    if (!this.done) {
      this.done = true;
      this.resolve("cancel");
    }
    this.contentEl.empty();
  }
}