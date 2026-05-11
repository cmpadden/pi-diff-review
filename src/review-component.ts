import {
  Editor,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
  DiffExplainer,
  ExplanationScope,
  ExplanationState,
} from "./explain.ts";
import { formatLocation } from "./prompt.ts";
import type {
  DiffRenderMode,
  ReviewComment,
  ReviewLayout,
  ReviewLine,
  ReviewResult,
  ReviewTheme,
  ReviewTui,
  RightPaneMode,
  SelectionBounds,
  SplitDiffCell,
  SplitDiffRow,
} from "./types.ts";

function padToWidth(text: string, width: number): string {
  const visible = visibleWidth(text);
  if (visible >= width) return truncateToWidth(text, width);
  return text + " ".repeat(width - visible);
}

function lineNumberCell(value?: number): string {
  return value == null ? "    " : String(value).padStart(4, " ");
}

const GLOBAL_COMMENT_KEY = "__global_diff_comment__";

export class ReviewComponent {
  private selected = 0;
  private scrollTop = 0;
  private editMode = false;
  private editingCommentKey?: string;
  private selectionAnchor?: number;
  private layout: ReviewLayout = "side-by-side";
  private diffRenderMode: DiffRenderMode = "unified";
  private rightPaneMode: RightPaneMode = "comments";
  private explanations = new Map<string, ExplanationState>();
  private explanationAbort?: AbortController;
  private explanationRequestId = 0;
  private loadingFrame = 0;
  private loadingTimer?: ReturnType<typeof setInterval>;
  private editor: Editor;
  private splitRows?: SplitDiffRow[];
  private splitRowByLineIndex?: number[];
  private lineIndexById = new Map<string, number>();
  private commentLineKeys = new Map<number, string[]>();
  private commentsRevision = 0;
  private commentLineKeysRevision = -1;

  constructor(
    private tui: ReviewTui,
    private theme: ReviewTheme,
    private title: string,
    private lines: ReviewLine[],
    private comments: Map<string, ReviewComment>,
    private done: (result: ReviewResult) => void,
    private explainer?: DiffExplainer,
    private onCommentsChanged?: (comments: Map<string, ReviewComment>) => void,
  ) {
    const firstCommentable = this.lines.findIndex((line) => line.commentable);
    this.selected = firstCommentable >= 0 ? firstCommentable : 0;
    this.lines.forEach((line, index) => this.lineIndexById.set(line.id, index));

    this.editor = new Editor(tui as never, {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    });

    this.editor.onSubmit = (value) => {
      const trimmed = value.trim();
      if (this.editingCommentKey === GLOBAL_COMMENT_KEY) {
        if (!trimmed) {
          if (this.comments.delete(GLOBAL_COMMENT_KEY))
            this.markCommentsChanged();
        } else {
          this.comments.set(
            GLOBAL_COMMENT_KEY,
            this.buildGlobalComment(trimmed),
          );
          this.markCommentsChanged();
        }
        this.exitEditMode();
        return;
      }

      const selection = this.getActiveCommentSelection();
      if (!selection) {
        this.exitEditMode();
        return;
      }

      const key = this.getSelectionKey(selection.start, selection.end);
      if (!trimmed) {
        if (this.comments.delete(key)) this.markCommentsChanged();
      } else {
        this.comments.set(
          key,
          this.buildCommentFromSelection(selection, trimmed),
        );
        this.markCommentsChanged();
      }

      this.exitEditMode();
    };
  }

  handleInput(data: string): void {
    if (this.editMode) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.exitEditMode();
        return;
      }
      this.editor.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.hasSelection()) {
        this.clearSelection();
      } else {
        this.done({ action: "cancel" });
      }
      return;
    }
    if (data === "q") {
      this.done({ action: "cancel" });
      return;
    }
    if (data === "t") {
      this.toggleDiffRenderMode();
      return;
    }
    if (data === "?") {
      this.toggleExplanationPane();
      return;
    }
    if (matchesKey(data, "ctrl+d")) {
      this.move(this.getPageMoveAmount());
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      this.move(-this.getPageMoveAmount());
      return;
    }
    if (data === "j" || matchesKey(data, "down")) {
      this.move(1);
      return;
    }
    if (data === "k" || matchesKey(data, "up")) {
      this.move(-1);
      return;
    }
    if (data === "g") {
      this.jumpToBoundary("start");
      return;
    }
    if (data === "G") {
      this.jumpToBoundary("end");
      return;
    }
    if (data === "J") {
      this.extendSelection(1);
      return;
    }
    if (data === "K") {
      this.extendSelection(-1);
      return;
    }
    if (data === "n") {
      this.jumpHunk(1);
      return;
    }
    if (data === "p") {
      this.jumpHunk(-1);
      return;
    }
    if (data === "x") {
      this.deleteComment();
      return;
    }
    if (data === "c") {
      this.startEditMode();
      return;
    }
    if (data === "C") {
      this.startGlobalEditMode();
      return;
    }
    if (matchesKey(data, "enter")) {
      const comments = [...this.comments.values()].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      if (comments.length === 0) return;
      this.done({ action: "submit", comments });
    }
  }

  render(width: number): string[] {
    const viewportHeight = this.getContentHeight();
    const selectedLine = this.lines[this.selected];
    const output: string[] = [];

    output.push(
      truncateToWidth(
        this.theme.fg(
          "dim",
          this.editMode
            ? `${this.lines.length} lines • ${this.comments.size} comments • editing comment • Enter save • Esc/Ctrl+C cancel`
            : this.hasSelection()
              ? `${this.lines.length} lines • ${this.comments.size} comments • J/K extend • Esc clear selection • c comment range • C overall comment • Enter submit`
              : `${this.lines.length} lines • ${this.comments.size} comments • ${this.getPositionText(selectedLine)} • j/k move • g/G top/bottom • ctrl-u/d page • t unified/split • ? explain • J/K extend • c comment • C overall • x delete • n/p hunk • Enter submit • q quit`,
        ),
        width,
      ),
    );
    if (this.layout === "side-by-side") {
      this.ensureScroll(viewportHeight);
      output.push(
        ...this.renderSideBySide(width, viewportHeight, selectedLine),
      );
    } else {
      const { diffHeight, commentsHeight } =
        this.getStackedHeights(viewportHeight);
      this.ensureScroll(diffHeight);
      output.push(
        ...this.renderStacked(width, diffHeight, commentsHeight, selectedLine),
      );
    }

    output.push(
      truncateToWidth(
        this.theme.fg("muted", this.getFooterText(selectedLine)),
        width,
      ),
    );
    return output;
  }

  private renderSideBySide(
    width: number,
    height: number,
    selectedLine?: ReviewLine,
  ): string[] {
    const rightWidth = Math.max(28, Math.floor(width * 0.34));
    const separatorWidth = 3;
    const leftWidth = Math.max(30, width - rightWidth - separatorWidth);
    const rightPane = this.renderRightPane(rightWidth, height, selectedLine);
    const output: string[] = [];
    const diffPane = this.renderDiffRows(leftWidth, height);

    for (let row = 0; row < height; row++) {
      const left = diffPane[row] ?? " ".repeat(leftWidth);
      const right = rightPane[row] ?? " ".repeat(rightWidth);
      const combined = `${padToWidth(left, leftWidth)}${this.theme.fg("borderMuted", " │ ")}${padToWidth(right, rightWidth)}`;
      output.push(truncateToWidth(combined, width));
    }

    return output;
  }

  private renderStacked(
    width: number,
    diffHeight: number,
    commentsHeight: number,
    selectedLine?: ReviewLine,
  ): string[] {
    const comments = this.renderRightPane(width, commentsHeight, selectedLine);
    return [
      ...this.renderDiffRows(width, diffHeight),
      this.theme.fg("borderMuted", "─".repeat(width)),
      ...Array.from({ length: commentsHeight }, (_, index) =>
        padToWidth(truncateToWidth(comments[index] ?? "", width), width),
      ),
    ];
  }

  private renderDiffRows(width: number, height: number): string[] {
    return this.diffRenderMode === "split"
      ? this.renderSplitDiffRows(width, height)
      : this.renderUnifiedDiffRows(width, height);
  }

  private renderUnifiedDiffRows(width: number, height: number): string[] {
    const output: string[] = [];
    const selection = this.getSelectionBounds();

    for (let row = 0; row < height; row++) {
      const index = this.scrollTop + row;
      const line = this.lines[index];
      output.push(
        line
          ? this.renderDiffLine(
              line,
              index,
              width,
              index === this.selected,
              selection,
            )
          : " ".repeat(width),
      );
    }

    return output;
  }

  private renderSplitDiffRows(width: number, height: number): string[] {
    const rows = this.getSplitDiffRows();
    const output: string[] = [];
    const separatorWidth = 3;
    const leftWidth = Math.max(10, Math.floor((width - separatorWidth) / 2));
    const rightWidth = Math.max(10, width - leftWidth - separatorWidth);

    for (let row = 0; row < height; row++) {
      const splitRow = rows[this.scrollTop + row];
      if (!splitRow) {
        output.push(" ".repeat(width));
        continue;
      }

      if (splitRow.kind === "full") {
        output.push(
          this.renderDiffLine(
            splitRow.cell.line,
            splitRow.cell.index,
            width,
            splitRow.cell.index === this.selected,
            this.getSelectionBounds(),
          ),
        );
        continue;
      }

      const left = splitRow.left
        ? this.renderSplitDiffCell(splitRow.left, leftWidth, "left")
        : " ".repeat(leftWidth);
      const right = splitRow.right
        ? this.renderSplitDiffCell(splitRow.right, rightWidth, "right")
        : " ".repeat(rightWidth);
      output.push(
        truncateToWidth(
          `${padToWidth(left, leftWidth)}${this.theme.fg("borderMuted", " │ ")}${padToWidth(right, rightWidth)}`,
          width,
        ),
      );
    }

    return output;
  }

  private getContentHeight(): number {
    const terminalRows = this.tui.terminal?.rows ?? 24;
    const headerHeight = 3;
    const footerHeight = 2;
    return Math.max(6, terminalRows - headerHeight - footerHeight);
  }

  private getStackedHeights(viewportHeight: number): {
    diffHeight: number;
    commentsHeight: number;
  } {
    const availableForPanes = Math.max(2, viewportHeight - 1);
    let diffHeight = Math.max(1, Math.floor(availableForPanes * 0.6));
    let commentsHeight = availableForPanes - diffHeight;

    if (commentsHeight < 3 && availableForPanes >= 4) {
      commentsHeight = 3;
      diffHeight = availableForPanes - commentsHeight;
    }

    return { diffHeight, commentsHeight };
  }

  invalidate(): void {}

  dispose(): void {
    this.explanationAbort?.abort();
    this.stopLoadingTimer();
  }

  private move(delta: number): void {
    const next = Math.max(
      0,
      Math.min(this.lines.length - 1, this.selected + delta),
    );
    if (next === this.selected) return;
    this.selected = next;
    this.tui.requestRender();
  }

  private jumpToBoundary(boundary: "start" | "end"): void {
    const next = boundary === "start" ? 0 : Math.max(0, this.lines.length - 1);
    const hadSelection = this.selectionAnchor != null;
    if (next === this.selected && !hadSelection) return;
    this.selected = next;
    if (hadSelection) {
      this.clearSelection();
    } else {
      this.tui.requestRender();
    }
  }

  private toggleLayout(): void {
    this.layout = this.layout === "side-by-side" ? "stacked" : "side-by-side";
    this.tui.requestRender(true);
  }

  private toggleDiffRenderMode(): void {
    this.diffRenderMode =
      this.diffRenderMode === "unified" ? "split" : "unified";
    this.scrollTop = 0;
    this.tui.requestRender(true);
  }

  private toggleExplanationPane(): void {
    this.rightPaneMode =
      this.rightPaneMode === "comments" ? "explanation" : "comments";
    if (this.rightPaneMode === "explanation") {
      this.ensureCurrentExplanation();
    }
    this.tui.requestRender(true);
  }

  private getPageMoveAmount(): number {
    const contentHeight = this.getContentHeight();
    const diffHeight =
      this.layout === "stacked"
        ? this.getStackedHeights(contentHeight).diffHeight
        : contentHeight;
    return Math.max(1, Math.floor(diffHeight / 2));
  }

  private extendSelection(delta: number): void {
    if (this.selectionAnchor == null) {
      this.selectionAnchor = this.selected;
    }
    const next = Math.max(
      0,
      Math.min(this.lines.length - 1, this.selected + delta),
    );
    if (next === this.selected) return;
    this.selected = next;
    this.tui.requestRender();
  }

  private clearSelection(): void {
    if (this.selectionAnchor == null) return;
    this.selectionAnchor = undefined;
    this.tui.requestRender();
  }

  private hasSelection(): boolean {
    return (
      this.selectionAnchor != null && this.selectionAnchor !== this.selected
    );
  }

  private getSelectionBounds(): SelectionBounds | undefined {
    if (this.selectionAnchor == null) return undefined;
    return {
      start: Math.min(this.selectionAnchor, this.selected),
      end: Math.max(this.selectionAnchor, this.selected),
    };
  }

  private getActiveCommentSelection(): SelectionBounds | undefined {
    const selection = this.getSelectionBounds();
    if (selection) return selection;
    const line = this.lines[this.selected];
    if (!line?.commentable) return undefined;
    return { start: this.selected, end: this.selected };
  }

  private getSelectionKey(start: number, end: number): string {
    return `${this.lines[start]?.id ?? start}:${this.lines[end]?.id ?? end}`;
  }

  private getCommentForSelection(
    selection: SelectionBounds | undefined,
  ): ReviewComment | undefined {
    if (!selection) return undefined;
    return this.comments.get(
      this.getSelectionKey(selection.start, selection.end),
    );
  }

  private getCommentKeysForLine(index: number): string[] {
    this.ensureCommentLineKeys();
    return this.commentLineKeys.get(index) ?? [];
  }

  private markCommentsChanged(): void {
    this.commentsRevision++;
    this.onCommentsChanged?.(this.comments);
  }

  private ensureCommentLineKeys(): void {
    if (this.commentLineKeysRevision === this.commentsRevision) return;

    this.commentLineKeys = new Map<number, string[]>();
    for (const [key, comment] of this.comments) {
      const start = this.lineIndexById.get(comment.startLineId);
      const end = this.lineIndexById.get(comment.endLineId);
      if (start == null || end == null) continue;
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      for (let index = from; index <= to; index++) {
        const keys = this.commentLineKeys.get(index);
        if (keys) {
          keys.push(key);
        } else {
          this.commentLineKeys.set(index, [key]);
        }
      }
    }

    this.commentLineKeysRevision = this.commentsRevision;
  }

  private buildGlobalComment(text: string): ReviewComment {
    return {
      id: GLOBAL_COMMENT_KEY,
      filePath: "Overall diff",
      text,
      global: true,
      startLineId: GLOBAL_COMMENT_KEY,
      endLineId: GLOBAL_COMMENT_KEY,
      lineText: "",
    };
  }

  private buildCommentFromSelection(
    selection: SelectionBounds,
    text: string,
  ): ReviewComment {
    const startLine = this.lines[selection.start]!;
    const endLine = this.lines[selection.end]!;
    const excerpt = this.lines
      .slice(selection.start, selection.end + 1)
      .map((line) => line.text)
      .join("\n");
    return {
      id: this.getSelectionKey(selection.start, selection.end),
      filePath: startLine.filePath ?? endLine.filePath ?? "(unknown file)",
      text,
      startLineId: startLine.id,
      endLineId: endLine.id,
      startOldLineNumber: startLine.oldLineNumber,
      startNewLineNumber: startLine.newLineNumber,
      endOldLineNumber: endLine.oldLineNumber,
      endNewLineNumber: endLine.newLineNumber,
      lineText: excerpt,
    };
  }

  private getPositionText(selectedLine?: ReviewLine): string {
    const position = `${Math.min(this.selected + 1, this.lines.length)}/${this.lines.length}`;
    return selectedLine?.filePath
      ? `${position} ${selectedLine.filePath}`
      : position;
  }

  private getFooterText(selectedLine?: ReviewLine): string {
    const selection = this.getSelectionBounds();
    if (selection) {
      const count = selection.end - selection.start + 1;
      const startLine = this.lines[selection.start]!;
      const endLine = this.lines[selection.end]!;
      return `Selected ${count} lines: ${formatLocation(startLine)} -> ${formatLocation(endLine)}`;
    }
    return `Selected: ${selectedLine ? formatLocation(selectedLine) : "(no selection)"}`;
  }

  private jumpHunk(direction: 1 | -1): void {
    let index = this.selected + direction;
    while (index >= 0 && index < this.lines.length) {
      if (this.lines[index]?.kind === "hunk") {
        this.selected = index;
        this.tui.requestRender();
        return;
      }
      index += direction;
    }
  }

  private deleteComment(): void {
    const selection = this.getActiveCommentSelection();
    if (!selection) return;
    if (
      this.comments.delete(this.getSelectionKey(selection.start, selection.end))
    ) {
      this.markCommentsChanged();
    }
    this.tui.requestRender();
  }

  private startGlobalEditMode(): void {
    const existing = this.comments.get(GLOBAL_COMMENT_KEY);
    this.rightPaneMode = "comments";
    this.editMode = true;
    this.editingCommentKey = GLOBAL_COMMENT_KEY;
    this.editor.setText(existing?.text ?? "");
    this.tui.requestRender(true);
  }

  private startEditMode(): void {
    const selection = this.getActiveCommentSelection();
    if (!selection) return;
    const startLine = this.lines[selection.start];
    const endLine = this.lines[selection.end];
    if (!startLine?.commentable || !endLine?.commentable) return;
    if (startLine.filePath !== endLine.filePath) return;

    const existing = this.getCommentForSelection(selection);
    this.rightPaneMode = "comments";
    this.editMode = true;
    this.editingCommentKey = this.getSelectionKey(
      selection.start,
      selection.end,
    );
    this.editor.setText(existing?.text ?? "");
    this.tui.requestRender(true);
  }

  private exitEditMode(): void {
    this.editMode = false;
    this.editingCommentKey = undefined;
    this.editor.setText("");
    this.tui.requestRender(true);
  }

  private getSplitDiffRows(): SplitDiffRow[] {
    if (this.splitRows) return this.splitRows;

    const rows: SplitDiffRow[] = [];
    const rowByLineIndex: number[] = [];
    let index = 0;

    const pushRow = (row: SplitDiffRow) => {
      const displayRow = rows.length;
      rows.push(row);
      if (row.kind === "full") {
        rowByLineIndex[row.cell.index] = displayRow;
      } else {
        if (row.left) rowByLineIndex[row.left.index] = displayRow;
        if (row.right) rowByLineIndex[row.right.index] = displayRow;
      }
    };

    while (index < this.lines.length) {
      const line = this.lines[index]!;

      if (line.kind === "remove" || line.kind === "add") {
        const removals: SplitDiffCell[] = [];
        const additions: SplitDiffCell[] = [];

        while (this.lines[index]?.kind === "remove") {
          removals.push({ line: this.lines[index]!, index });
          index++;
        }
        while (this.lines[index]?.kind === "add") {
          additions.push({ line: this.lines[index]!, index });
          index++;
        }

        const count = Math.max(removals.length, additions.length);
        for (let offset = 0; offset < count; offset++) {
          pushRow({
            kind: "split",
            left: removals[offset],
            right: additions[offset],
          });
        }
        continue;
      }

      if (line.kind === "context") {
        const cell = { line, index };
        pushRow({ kind: "split", left: cell, right: cell });
      } else {
        pushRow({ kind: "full", cell: { line, index } });
      }
      index++;
    }

    this.splitRows = rows;
    this.splitRowByLineIndex = rowByLineIndex;
    return rows;
  }

  private getSelectedDisplayRow(): number {
    if (this.diffRenderMode === "unified") return this.selected;
    this.getSplitDiffRows();
    return this.splitRowByLineIndex?.[this.selected] ?? 0;
  }

  private getDisplayRowCount(): number {
    return this.diffRenderMode === "unified"
      ? this.lines.length
      : this.getSplitDiffRows().length;
  }

  private renderSplitDiffCell(
    cell: SplitDiffCell,
    width: number,
    side: "left" | "right",
  ): string {
    const { line, index } = cell;
    const hasComment = this.getCommentKeysForLine(index).length > 0;
    const commentMark = hasComment ? this.theme.fg("warning", "●") : " ";
    const lineNumber =
      side === "left" ? line.oldLineNumber : line.newLineNumber;
    const raw = `${commentMark} ${lineNumberCell(lineNumber)} ${this.getDisplayText(line)}`;

    let styled: string;
    switch (line.kind) {
      case "add":
        styled = this.theme.fg("toolDiffAdded", raw);
        break;
      case "remove":
        styled = this.theme.fg("toolDiffRemoved", raw);
        break;
      case "context":
        styled = this.theme.fg("toolDiffContext", raw);
        break;
      default:
        styled = this.theme.fg("muted", raw);
    }

    styled = truncateToWidth(styled, width);
    const selection = this.getSelectionBounds();
    const inSelection =
      selection != null && index >= selection.start && index <= selection.end;
    if (index === this.selected || inSelection) {
      return this.theme.bg("selectedBg", padToWidth(styled, width));
    }
    return styled;
  }

  private ensureScroll(viewportHeight: number): void {
    const selectedRow = this.getSelectedDisplayRow();
    const rowCount = this.getDisplayRowCount();

    if (selectedRow < this.scrollTop) {
      this.scrollTop = selectedRow;
    }
    if (selectedRow >= this.scrollTop + viewportHeight) {
      this.scrollTop = selectedRow - viewportHeight + 1;
    }
    this.scrollTop = Math.max(
      0,
      Math.min(this.scrollTop, Math.max(0, rowCount - viewportHeight)),
    );
  }

  private getDisplayText(line: ReviewLine): string {
    return line.kind === "add" ||
      line.kind === "remove" ||
      line.kind === "context"
      ? line.text.slice(1)
      : line.text;
  }

  private renderDiffLine(
    line: ReviewLine,
    index: number,
    width: number,
    selected: boolean,
    selection?: SelectionBounds,
  ): string {
    const hasComment = this.getCommentKeysForLine(index).length > 0;
    const commentMark = hasComment ? this.theme.fg("warning", "●") : " ";
    const numbers = `${lineNumberCell(line.oldLineNumber)} ${lineNumberCell(line.newLineNumber)}`;
    const raw = `${commentMark} ${numbers} ${this.getDisplayText(line)}`;

    let styled: string;
    switch (line.kind) {
      case "add":
        styled = this.theme.fg("toolDiffAdded", raw);
        break;
      case "remove":
        styled = this.theme.fg("toolDiffRemoved", raw);
        break;
      case "context":
        styled = this.theme.fg("toolDiffContext", raw);
        break;
      case "hunk":
        styled = this.theme.fg("accent", raw);
        break;
      default:
        styled = this.theme.fg("muted", raw);
    }

    styled = truncateToWidth(styled, width);
    const inSelection =
      selection != null && index >= selection.start && index <= selection.end;
    if (selected || inSelection) {
      return this.theme.bg("selectedBg", padToWidth(styled, width));
    }
    return styled;
  }

  private renderRightPane(
    width: number,
    height: number,
    selectedLine?: ReviewLine,
  ): string[] {
    return this.rightPaneMode === "explanation"
      ? this.renderExplanationPane(width, height, selectedLine)
      : this.renderCommentsPane(width, height, selectedLine);
  }

  private renderCommentsPane(
    width: number,
    height: number,
    selectedLine?: ReviewLine,
  ): string[] {
    const lines: string[] = [];
    const title = this.theme.fg("accent", this.theme.bold("Comments"));
    const selection = this.getActiveCommentSelection();
    const currentComment = this.getCommentForSelection(selection);

    lines.push(truncateToWidth(title, width));
    lines.push(
      truncateToWidth(
        this.theme.fg(
          "dim",
          selection
            ? this.getFooterText(selectedLine)
            : selectedLine
              ? formatLocation(selectedLine)
              : "No selection",
        ),
        width,
      ),
    );
    lines.push("");

    if (this.editMode && this.editingCommentKey === GLOBAL_COMMENT_KEY) {
      lines[1] = truncateToWidth(
        this.theme.fg("dim", "Overall diff comment"),
        width,
      );
      lines.push(
        ...wrapTextWithAnsi(
          this.theme.fg(
            "dim",
            "Editing overall diff comment. Enter saves. Esc or Ctrl+C cancels.",
          ),
          width,
        ),
      );
      lines.push("");
      for (const line of this.editor.render(Math.max(10, width))) {
        lines.push(truncateToWidth(line, width));
      }
      return lines.slice(0, height);
    }

    const globalComment = this.comments.get(GLOBAL_COMMENT_KEY);
    if (globalComment) {
      lines.push(
        truncateToWidth(
          this.theme.fg("accent", this.theme.bold("Overall diff comment")),
          width,
        ),
      );
      lines.push(
        ...wrapTextWithAnsi(this.theme.fg("text", globalComment.text), width),
      );
      lines.push(...wrapTextWithAnsi(this.theme.fg("dim", "C edits"), width));
      lines.push("");
    }

    if (!selectedLine) {
      lines.push(
        ...wrapTextWithAnsi(
          this.theme.fg("muted", "No diff lines available."),
          width,
        ),
      );
      return lines.slice(0, height);
    }

    if (!selection) {
      lines.push(
        ...wrapTextWithAnsi(
          this.theme.fg(
            "muted",
            "Move to a diff line and press c to add a comment, or press C for an overall diff comment.",
          ),
          width,
        ),
      );
      return lines.slice(0, height);
    }

    if (this.editMode && currentComment?.id === this.editingCommentKey) {
      lines.push(
        ...wrapTextWithAnsi(
          this.theme.fg(
            "dim",
            "Editing comment. Enter saves. Esc or Ctrl+C cancels.",
          ),
          width,
        ),
      );
      lines.push("");
      for (const line of this.editor.render(Math.max(10, width))) {
        lines.push(truncateToWidth(line, width));
      }
    } else if (this.editMode && this.editingCommentKey) {
      lines.push(
        ...wrapTextWithAnsi(
          this.theme.fg(
            "dim",
            "Editing comment. Enter saves. Esc or Ctrl+C cancels.",
          ),
          width,
        ),
      );
      lines.push("");
      for (const line of this.editor.render(Math.max(10, width))) {
        lines.push(truncateToWidth(line, width));
      }
    } else if (currentComment) {
      lines.push(
        ...wrapTextWithAnsi(this.theme.fg("text", currentComment.text), width),
      );
      lines.push("");
      lines.push(
        ...wrapTextWithAnsi(
          this.theme.fg("dim", "x deletes this comment • c edits"),
          width,
        ),
      );
    } else {
      lines.push(
        ...wrapTextWithAnsi(
          this.theme.fg(
            "muted",
            this.hasSelection()
              ? "No comment on this range."
              : "No comment on this line.",
          ),
          width,
        ),
      );
      lines.push("");
      lines.push(
        ...wrapTextWithAnsi(
          this.theme.fg(
            "dim",
            this.hasSelection()
              ? "Press c to add a range comment, or C for an overall diff comment."
              : "Press c to add one. Use J/K to extend a range. Press C for an overall diff comment.",
          ),
          width,
        ),
      );
    }

    lines.push("");
    lines.push(
      truncateToWidth(
        this.theme.fg("accent", this.theme.bold("Excerpt")),
        width,
      ),
    );
    const excerpt = this.lines
      .slice(selection.start, selection.end + 1)
      .map((line) => line.text)
      .join("\n");
    lines.push(
      ...wrapTextWithAnsi(
        this.theme.fg("toolDiffContext", excerpt || "(blank line)"),
        width,
      ),
    );
    return lines.slice(0, height);
  }

  private renderExplanationPane(
    width: number,
    height: number,
    selectedLine?: ReviewLine,
  ): string[] {
    const lines: string[] = [];
    const title = this.theme.fg("accent", this.theme.bold("Explanation"));
    const scope = this.getCurrentHunkScope();

    lines.push(truncateToWidth(title, width));
    lines.push(
      truncateToWidth(
        this.theme.fg(
          "dim",
          scope?.title ??
            (selectedLine ? formatLocation(selectedLine) : "No selection"),
        ),
        width,
      ),
    );
    lines.push("");

    if (!this.explainer) {
      lines.push(
        ...wrapTextWithAnsi(
          this.theme.fg("warning", "Diff explanations are unavailable."),
          width,
        ),
      );
      return lines.slice(0, height);
    }

    if (!scope) {
      lines.push(
        ...wrapTextWithAnsi(
          this.theme.fg(
            "muted",
            "Move to a changed hunk and press ? to generate an explanation.",
          ),
          width,
        ),
      );
      return lines.slice(0, height);
    }

    const explanation = this.explanations.get(scope.key);
    if (!explanation) {
      lines.push(
        ...wrapTextWithAnsi(
          this.theme.fg(
            "muted",
            "No explanation generated yet. Press ? again after returning to comments to generate this hunk.",
          ),
          width,
        ),
      );
    } else if (explanation.status === "loading") {
      const spinner = this.getLoadingFrame();
      lines.push(
        truncateToWidth(
          this.theme.fg("accent", `${spinner} Generating explanation...`),
          width,
        ),
      );
      if (explanation.text.trim()) {
        lines.push("");
        lines.push(
          ...wrapTextWithAnsi(this.theme.fg("text", explanation.text), width),
        );
      }
    } else if (explanation.status === "error") {
      lines.push(
        ...wrapTextWithAnsi(
          this.theme.fg(
            "warning",
            `Unable to explain diff: ${explanation.message}`,
          ),
          width,
        ),
      );
    } else {
      lines.push(
        ...wrapTextWithAnsi(this.theme.fg("text", explanation.text), width),
      );
    }

    lines.push("");
    lines.push(...wrapTextWithAnsi(this.theme.fg("dim", "? comments"), width));
    return lines.slice(0, height);
  }

  private ensureCurrentExplanation(): void {
    const scope = this.getCurrentHunkScope();
    if (!scope || !this.explainer) return;
    if (this.explanations.has(scope.key)) return;

    this.explanationAbort?.abort();
    const controller = new AbortController();
    this.explanationAbort = controller;
    const requestId = ++this.explanationRequestId;
    let text = "";

    this.explanations.set(scope.key, { status: "loading", text });
    this.startLoadingTimer();

    void this.explainer
      .explain(scope, {
        signal: controller.signal,
        onDelta: (delta) => {
          if (requestId !== this.explanationRequestId) return;
          text += delta;
          this.explanations.set(scope.key, { status: "loading", text });
          this.tui.requestRender();
        },
      })
      .then((finalText) => {
        if (requestId !== this.explanationRequestId) return;
        this.explanations.set(scope.key, {
          status: "ready",
          text: finalText.trim() || text.trim() || "No explanation returned.",
        });
      })
      .catch((error) => {
        if (requestId !== this.explanationRequestId) return;
        if (controller.signal.aborted) return;
        this.explanations.set(scope.key, {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (requestId !== this.explanationRequestId) return;
        this.stopLoadingTimerIfIdle();
        this.tui.requestRender();
      });

    this.tui.requestRender();
  }

  private getCurrentHunkScope(): ExplanationScope | undefined {
    const selectedLine = this.lines[this.selected];
    if (!selectedLine?.filePath || !selectedLine.hunkLabel) return undefined;

    let start = this.selected;
    while (
      start > 0 &&
      this.lines[start - 1]?.filePath === selectedLine.filePath &&
      this.lines[start - 1]?.hunkLabel === selectedLine.hunkLabel
    ) {
      start--;
    }

    let end = this.selected;
    while (
      end + 1 < this.lines.length &&
      this.lines[end + 1]?.filePath === selectedLine.filePath &&
      this.lines[end + 1]?.hunkLabel === selectedLine.hunkLabel
    ) {
      end++;
    }

    const diffText = this.lines
      .slice(start, end + 1)
      .map((line) => line.text)
      .join("\n");
    return {
      key: `hunk:${selectedLine.filePath}:${selectedLine.hunkLabel}:${start}:${end}`,
      kind: "hunk",
      title: `${selectedLine.filePath} ${selectedLine.hunkLabel}`,
      filePath: selectedLine.filePath,
      diffText,
    };
  }

  private getLoadingFrame(): string {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    return frames[this.loadingFrame % frames.length] ?? "⠋";
  }

  private startLoadingTimer(): void {
    if (this.loadingTimer) return;
    this.loadingTimer = setInterval(() => {
      this.loadingFrame++;
      this.tui.requestRender();
    }, 120);
  }

  private stopLoadingTimerIfIdle(): void {
    const hasLoading = [...this.explanations.values()].some(
      (explanation) => explanation.status === "loading",
    );
    if (!hasLoading) this.stopLoadingTimer();
  }

  private stopLoadingTimer(): void {
    if (!this.loadingTimer) return;
    clearInterval(this.loadingTimer);
    this.loadingTimer = undefined;
  }
}
