/**
 * history.ts
 * Snapshot-based undo/redo for the Freeplane view.
 * Each entry is a serialized XML DOM string taken BEFORE a mutation, so any
 * change (text, fold, move, richcontent) can be reverted without inventing
 * inverse operations. Restoring re-parses the XML, keeping unknown
 * attributes/tags intact.
 */

/** Bounded undo/redo stack of serialized map snapshots. */
export class SnapshotHistory {
  undoStack: string[] = [];   // past states, oldest first
  redoStack: string[] = [];   // future states; cleared on every new edit
  limit = 50;                 // memory cap for large maps

  /** Forget all history (called when a file is loaded). */
  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /** Record the pre-mutation snapshot; invalidates the redo branch. */
  push(snapshot: string) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.limit) {
      this.undoStack.shift();         // drop oldest when over the cap
    }
    this.redoStack.length = 0;        // new edit kills redo future
  }

  /** Return previous state (or null); archives `current` for redo. */
  undo(current: string): string | null {
    if (this.undoStack.length === 0) return null;
    const prev = this.undoStack.pop()!;
    this.redoStack.push(current);
    return prev;
  }

  /** Return next redo state (or null); archives `current` back on undo. */
  redo(current: string): string | null {
    if (this.redoStack.length === 0) return null;
    const next = this.redoStack.pop()!;
    this.undoStack.push(current);
    return next;
  }
}
