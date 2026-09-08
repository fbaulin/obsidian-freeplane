/**
 * ui/UnsavedPrompt.ts
 * Save / Discard / Cancel modal shown when leaving a dirty map
 * (switching files in the same leaf, or the explicit close command).
 * askUnsaved() returns a promise resolved with the user's choice;
 * closing the modal any other way (Esc, X) counts as "cancel".
 */
import { Modal } from "obsidian";

/** The three possible outcomes of the prompt. */
export type UnsavedChoice = "save" | "discard" | "cancel";

/** Open the modal; resolves with the user's choice exactly once. */
export function askUnsaved(app: any, message: string): Promise<UnsavedChoice> {
  return new Promise((resolve) => {
    new UnsavedModal(app, message, resolve).open();   // fire-and-forget modal
  });
}

/** Modal implementation with a one-shot resolution guard. */
class UnsavedModal extends Modal {
  message: string;                                   // body text
  resolve: (choice: UnsavedChoice) => void;          // promise resolver
  done = false;                                      // resolve exactly once

  constructor(app: any, message: string, resolve: (choice: UnsavedChoice) => void) {
    super(app);
    this.message = message;
    this.resolve = resolve;
  }

  /** Build the three-button dialog. */
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

  /** Record choice, close the modal, resolve the promise. */
  choose(choice: UnsavedChoice) {
    if (this.done) return;                           // ignore double clicks
    this.done = true;
    this.close();
    this.resolve(choice);
  }

  /** Any non-button close (Esc / X) is treated as cancel. */
  onClose() {
    if (!this.done) {
      this.done = true;
      this.resolve("cancel");
    }
    this.contentEl.empty();
  }
}
