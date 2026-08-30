import { Plugin } from "obsidian";
import { FreeplaneView, VIEW_TYPE_FREEPLANE } from "./FreeplaneView";

export default class FreeplanePlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE_FREEPLANE, (leaf) => new FreeplaneView(leaf, this));

    // Make .mm files open in this view by default.
    this.registerExtensions(["mm"], VIEW_TYPE_FREEPLANE);

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

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_FREEPLANE);
  }
}