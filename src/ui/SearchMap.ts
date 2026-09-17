import { App, Modal } from "obsidian";
export class SearchMap extends Modal {
  constructor(app: App, private query: string, private search: (query: string) => void) { super(app); }
  onOpen() {
    this.contentEl.createEl("h3", { text: "Search map" });
    const input = this.contentEl.createEl("input", { type: "text", value: this.query, placeholder: "Text, details or notes" });
    input.style.width = "100%";
    input.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); this.close(); this.search(input.value); } };
    input.focus(); input.select();
  }
}
