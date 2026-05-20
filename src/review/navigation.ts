import type { DiffRenderMode, SelectionBounds } from "./types.ts";

export type JumpBoundaryResult = {
  changed: boolean;
  clearedSelection: boolean;
};

export class ReviewNavigationState {
  selected: number;
  scrollTop = 0;
  selectionAnchor?: number;
  diffRenderMode: DiffRenderMode = "unified";

  constructor(
    private readonly lineCount: number,
    initialSelected = 0,
  ) {
    this.selected = this.clampLineIndex(initialSelected);
  }

  move(delta: number): boolean {
    const next = this.clampLineIndex(this.selected + delta);
    if (next === this.selected) return false;
    this.selected = next;
    return true;
  }

  jumpToBoundary(boundary: "start" | "end"): JumpBoundaryResult {
    const next = boundary === "start" ? 0 : Math.max(0, this.lineCount - 1);
    const hadSelection = this.selectionAnchor != null;
    const changed = next !== this.selected || hadSelection;
    this.selected = next;
    if (hadSelection) this.selectionAnchor = undefined;
    return { changed, clearedSelection: hadSelection };
  }

  extendSelection(delta: number): boolean {
    if (this.selectionAnchor == null) {
      this.selectionAnchor = this.selected;
    }
    const next = this.clampLineIndex(this.selected + delta);
    if (next === this.selected) return false;
    this.selected = next;
    return true;
  }

  clearSelection(): boolean {
    if (this.selectionAnchor == null) return false;
    this.selectionAnchor = undefined;
    return true;
  }

  hasSelection(): boolean {
    return (
      this.selectionAnchor != null && this.selectionAnchor !== this.selected
    );
  }

  getSelectionBounds(): SelectionBounds | undefined {
    if (this.selectionAnchor == null) return undefined;
    return {
      start: Math.min(this.selectionAnchor, this.selected),
      end: Math.max(this.selectionAnchor, this.selected),
    };
  }

  toggleDiffRenderMode(): DiffRenderMode {
    this.diffRenderMode =
      this.diffRenderMode === "unified" ? "split" : "unified";
    this.scrollTop = 0;
    return this.diffRenderMode;
  }

  ensureScroll(
    viewportHeight: number,
    selectedDisplayRow: number,
    displayRowCount: number,
  ): void {
    if (selectedDisplayRow < this.scrollTop) {
      this.scrollTop = selectedDisplayRow;
    }
    if (selectedDisplayRow >= this.scrollTop + viewportHeight) {
      this.scrollTop = selectedDisplayRow - viewportHeight + 1;
    }
    this.scrollTop = Math.max(
      0,
      Math.min(this.scrollTop, Math.max(0, displayRowCount - viewportHeight)),
    );
  }

  private clampLineIndex(index: number): number {
    return Math.max(0, Math.min(Math.max(0, this.lineCount - 1), index));
  }
}
