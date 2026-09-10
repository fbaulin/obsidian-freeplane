/**
 * ui/RecoveryPrompt.ts
 * Modal shown when a .tmp stash exists but the .mm changed on disk since
 * the stash was written. Choices: overwrite the mm with recovered content,
 * keep recovered content as a separate new mm, or lose the recovered
 * changes. Closing with Esc/X resolves "saveas" (the non-destructive option).
 */
import { Modal } from "obsidian";

export type RecoveryChoice = "overwrite" | "saveas" | "lose";

export function askRecovery(app: any, fileName: string): Promise<RecoveryChoice> {
  return new Promise((resolve) => {
    new RecoveryModal(app, fileName, resolve).open();
  });
}

class RecoveryModal extends Modal {
  fileName: string;
  resolve: (c: RecoveryChoice) => void;
  done = false;

  constructor(app: any, fileName: string, resolve: (c: RecoveryChoice) => void) {
    super(app);
    this.fileName = fileName;
    this.resolve = resolve;
  }

  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: "Recovered unsaved changes" });
    this.contentEl.createEl("p", {
      text: "Unsaved changes for \"" + this.fileName + "\" were stashed, but the .mm file changed on disk since. Choose what to do:"
    });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const ow = buttons.createEl("button", { text: "Overwrite .mm", cls: "mod-warning" });
    const sa = buttons.createEl("button", { text: "Save as new file", cls: "mod-cta" });
    const lo = buttons.createEl("button", { text: "Lose changes" });
    ow.onclick = () => this.choose("overwrite");
    sa.onclick = () => this.choose("saveas");
    lo.onclick = () => this.choose("lose");
    this.contentEl.createEl("p", { text: "Esc = Save as new file (safe)." }).style.color = "var(--text-faint)";
  }

  choose(c: RecoveryChoice) {
    if (this.done) return;
    this.done = true;
    this.close();
    this.resolve(c);
  }

  onClose() {
    if (!this.done) { this.done = true; this.resolve("saveas"); }  // safe default
    this.contentEl.empty();
  }
}

export function askConfirm(app: any, title: string, message: string, okText: string): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(app, title, message, okText, resolve).open();
  });
}

class ConfirmModal extends Modal {
  title: string; message: string; okText: string;
  resolve: (ok: boolean) => void;
  done = false;
  constructor(app: any, title: string, message: string, okText: string, resolve: (ok: boolean) => void) {
    super(app);
    this.title = title; this.message = message; this.okText = okText; this.resolve = resolve;
  }
  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: this.title });
    this.contentEl.createEl("p", { text: this.message });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const ok = buttons.createEl("button", { text: this.okText, cls: "mod-warning" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    ok.onclick = () => this.choose(true);
    cancel.onclick = () => this.choose(false);
  }
  choose(ok: boolean) {
    if (this.done) return;
    this.done = true;
    this.close();
    this.resolve(ok);
  }
  onClose() {
    if (!this.done) { this.done = true; this.resolve(false); }  // Esc = cancel
    this.contentEl.empty();
  }
}
