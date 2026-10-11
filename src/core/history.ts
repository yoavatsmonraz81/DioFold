import type { LayerId } from './layers';
import type { Cell, World } from './world';

interface Change {
  layer: LayerId;
  i: number;
  before: Cell | null;
  after: Cell | null;
}

/** Undo/redo grouped into strokes: everything between begin() and commit() undoes as one step. */
export class History {
  private undoStack: Change[][] = [];
  private redoStack: Change[][] = [];
  private current: Change[] | null = null;

  constructor(private world: World, private limit = 100) {
    world.recorder = (layer, i, before, after) => this.current?.push({ layer, i, before, after });
  }

  begin() {
    this.current = [];
  }

  commit() {
    if (this.current?.length) {
      this.undoStack.push(this.current);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack = [];
    }
    this.current = null;
  }

  undo(): boolean {
    const stroke = this.undoStack.pop();
    if (!stroke) return false;
    for (let k = stroke.length - 1; k >= 0; k--) this.apply(stroke[k], stroke[k].before);
    this.redoStack.push(stroke);
    return true;
  }

  redo(): boolean {
    const stroke = this.redoStack.pop();
    if (!stroke) return false;
    for (const c of stroke) this.apply(c, c.after);
    this.undoStack.push(stroke);
    return true;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  private apply(c: Change, cell: Cell | null) {
    const { w } = this.world;
    this.world.set(c.layer, c.i % w, Math.floor(c.i / w), cell, false);
  }
}
