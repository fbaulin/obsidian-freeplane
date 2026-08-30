export class SnapshotHistory {
  undoStack: string[] = [];
  redoStack: string[] = [];
  limit = 50;

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  push(snapshot: string) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.limit) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
  }

  undo(current: string): string | null {
    if (this.undoStack.length === 0) return null;
    const prev = this.undoStack.pop()!;
    this.redoStack.push(current);
    return prev;
  }

  redo(current: string): string | null {
    if (this.redoStack.length === 0) return null;
    const next = this.redoStack.pop()!;
    this.undoStack.push(current);
    return next;
  }
}