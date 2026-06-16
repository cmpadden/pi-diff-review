import {
  getLanguageFromPath,
  highlightCode,
} from "@earendil-works/pi-coding-agent";
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
} from "../explanation/explainer.ts";
import {
  GLOBAL_COMMENT_KEY,
  buildCommentFromSelection,
  buildCommentLineKeys,
  buildGlobalComment,
  getSelectionKey,
} from "./comments.ts";
import {
  ExplanationController,
  getCurrentHunkScope,
} from "../explanation/controller.ts";
import { formatCommentLocation, formatLocation } from "./prompt.ts";
import { ReviewNavigationState } from "./navigation.ts";
import { ReviewSearchState } from "./search.ts";
import { buildReviewFileIndex, type ReviewFileSection } from "./files.ts";
import { padToWidth, lineNumberCell } from "../render/utils.ts";
import { buildSplitDiffRows } from "../diff/split.ts";
import type {
  DiffRenderMode,
  PersistedAsk,
  ReviewComment,
  ReviewLine,
  ReviewResult,
  ReviewTheme,
  ReviewTui,
  SelectionBounds,
  SplitDiffCell,
  SplitDiffRow,
  WorkspaceCommentSummary,
} from "./types.ts";

type InlineBoxPart = "top" | "body" | "bottom";
type InlineBoxRowKind = "comment" | "editor" | "explanation";
type InlineBoxRow = {
  kind: InlineBoxRowKind;
  text: string;
  part: InlineBoxPart;
};

type AnnotatedDiffRow =
  | { kind: "file-header"; file: ReviewFileSection }
  | { kind: "diff"; lineIndex: number }
  | { kind: "split"; splitRowIndex: number }
  | InlineBoxRow;

const HELP_COMMANDS = [
  ["h", "show or hide this help"],
  ["j/k or arrows", "move selection"],
  ["PgUp / PgDown", "move up or down half a page"],
  ["ctrl-u / ctrl-d", "move up or down half a page"],
  ["g / G", "jump to top or bottom"],
  ["[ / ]", "jump to previous or next file"],
  ["f", "focus or unfocus the current file"],
  ["n / p", "jump to next or previous hunk"],
  ["/", "search diff lines"],
  ["n / N", "jump between search matches"],
  ["J / K", "extend highlighted selection"],
  ["c", "add or edit a line or range comment"],
  ["C", "add or edit an overall diff comment"],
  ["x", "delete the current line or range comment"],
  ["t", "toggle the file sidebar"],
  ["s", "toggle inline comments and explanations"],
  ["v", "toggle unified or split rendering"],
  ["?", "toggle AI explanation for current hunk"],
  ["a", "ask a question about the current hunk"],
  ["Enter", "submit comments, save edits, or jump to search result"],
  ["Esc", "close help, cancel search/edit, clear selection, or exit"],
  ["q", "exit review"],
] as const;

export class ReviewComponent {
  private navigation: ReviewNavigationState;
  private editMode = false;
  private editingCommentKey?: string;
  private search: ReviewSearchState;
  private helpVisible = false;
  private fileSidebarVisible = true;

  private inlineAnnotationsVisible = true;
  private visibleExplanationKeys = new Set<string>();
  private explanationAnchorByScope = new Map<string, number>();
  private askInputMode = false;
  private askScope?: ExplanationScope;
  private askAnchorIndex?: number;
  private explanationController: ExplanationController;
  private editor: Editor;
  private splitRows?: SplitDiffRow[];
  private readonly fileIndex: ReturnType<typeof buildReviewFileIndex>;
  private focusedFilePath?: string;
  private lineIndexById = new Map<string, number>();
  private commentLineKeys = new Map<number, string[]>();
  private commentsRevision = 0;
  private commentLineKeysRevision = -1;
  private highlightedLineCache = new Map<string, string>();
  private annotatedRows?: AnnotatedDiffRow[];
  private annotatedRowsWidth = 0;
  private annotatedRowsRevision = -1;
  private annotatedRowsEditMode = false;
  private annotatedRowsEditingCommentKey?: string;
  private annotatedRowsMode?: DiffRenderMode;
  private annotatedRowsInlineAnnotationsVisible = true;
  private annotatedRowsVisibleExplanationCount = 0;
  private annotatedRowByLineIndex?: number[];

  constructor(
    private tui: ReviewTui,
    private theme: ReviewTheme,
    private title: string,
    private lines: ReviewLine[],
    private comments: Map<string, ReviewComment>,
    private done: (result: ReviewResult) => void,
    private explainer?: DiffExplainer,
    private onCommentsChanged?: (comments: Map<string, ReviewComment>) => void,
    cachedExplanations?: Map<string, string>,
    private onExplanationsChanged?: (explanations: Map<string, string>) => void,
    cachedAsk?: PersistedAsk,
    private onAskChanged?: (ask?: PersistedAsk) => void,
    private getWorkspaceCommentSummary?: (
      comments: Map<string, ReviewComment>,
    ) => WorkspaceCommentSummary | undefined,
  ) {
    const firstCommentable = this.lines.findIndex((line) => line.commentable);
    this.navigation = new ReviewNavigationState(
      this.lines.length,
      firstCommentable >= 0 ? firstCommentable : 0,
    );
    this.lines.forEach((line, index) => this.lineIndexById.set(line.id, index));
    this.fileIndex = buildReviewFileIndex(this.lines);
    this.search = new ReviewSearchState(this.lines, (lineIndex) =>
      this.isLineVisible(lineIndex),
    );

    const restoredAsk = cachedAsk
      ? this.restorePersistedAsk(cachedAsk)
      : undefined;
    if (restoredAsk) {
      this.askScope = restoredAsk.scope;
      this.askAnchorIndex = restoredAsk.anchorIndex;
    }

    this.explanationController = new ExplanationController(
      tui,
      explainer,
      cachedExplanations,
      onExplanationsChanged,
      restoredAsk ? cachedAsk?.text : undefined,
      (state) => {
        if (!state) {
          this.onAskChanged?.(undefined);
          return;
        }
        if (state.status !== "ready") return;
        if (!this.askScope || this.askAnchorIndex == null) return;
        const anchorLine = this.lines[this.askAnchorIndex];
        if (!anchorLine) return;
        this.onAskChanged?.({
          scopeKey: this.askScope.key,
          anchorLineId: anchorLine.id,
          text: state.text,
        });
      },
    );

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
      if (this.askInputMode) {
        this.askInputMode = false;
        this.editor.setText("");
        const question = value.trim();
        if (question && this.askScope) {
          this.explanationController.ask(this.askScope, question);
        } else {
          this.askScope = undefined;
          this.askAnchorIndex = undefined;
        }
        this.invalidateAnnotatedRows();
        this.tui.requestRender(true);
        return;
      }
      const trimmed = value.trim();
      if (this.editingCommentKey === GLOBAL_COMMENT_KEY) {
        if (!trimmed) {
          if (this.comments.delete(GLOBAL_COMMENT_KEY))
            this.markCommentsChanged();
        } else {
          this.comments.set(GLOBAL_COMMENT_KEY, buildGlobalComment(trimmed));
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
          buildCommentFromSelection(this.lines, selection, trimmed),
        );
        this.markCommentsChanged();
      }

      this.navigation.clearSelection();
      this.exitEditMode();
    };
  }

  private get selected(): number {
    return this.navigation.selected;
  }

  private set selected(value: number) {
    this.navigation.selected = value;
  }

  private get scrollTop(): number {
    return this.navigation.scrollTop;
  }

  private set scrollTop(value: number) {
    this.navigation.scrollTop = value;
  }

  private get diffRenderMode(): DiffRenderMode {
    return this.navigation.diffRenderMode;
  }

  handleInput(data: string): void {
    if (this.helpVisible) {
      if (data === "h" || matchesKey(data, "escape")) {
        this.toggleHelp();
      }
      return;
    }

    if (this.editMode) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.exitEditMode();
        return;
      }
      this.editor.handleInput(data);
      this.invalidateAnnotatedRows();
      this.tui.requestRender();
      return;
    }

    if (this.askInputMode) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.exitAskInputMode();
        return;
      }
      this.editor.handleInput(data);
      this.invalidateAnnotatedRows();
      this.tui.requestRender();
      return;
    }

    if (this.search.mode) {
      this.handleSearchInput(data);
      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.askScope) {
        this.clearAsk();
      } else if (this.search.query) {
        this.clearSearch();
      } else if (this.hasSelection()) {
        this.clearSelection();
      } else if (this.focusedFilePath) {
        this.focusedFilePath = undefined;
        this.highlightedLineCache.clear();
        this.invalidateAnnotatedRows();
        this.tui.requestRender(true);
      } else {
        this.done({ action: "cancel" });
      }
      return;
    }
    if (data === "q") {
      if (this.hasSelection()) {
        this.clearSelection();
      } else {
        this.done({ action: "cancel" });
      }
      return;
    }
    if (data === "h") {
      this.toggleHelp();
      return;
    }
    if (data === "t") {
      this.toggleFileSidebar();
      return;
    }
    if (data === "v") {
      this.toggleDiffRenderMode();
      return;
    }
    if (data === "?") {
      this.toggleExplanationPane();
      return;
    }
    if (data === "a") {
      this.startAskMode();
      return;
    }
    if (data === "/") {
      this.startSearchMode();
      return;
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
      this.move(this.getPageMoveAmount());
      return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
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
    if (data === "[") {
      this.jumpFile(-1);
      return;
    }
    if (data === "]") {
      this.jumpFile(1);
      return;
    }
    if (data === "f") {
      this.toggleCurrentFileFocus();
      return;
    }
    if (data === "s") {
      this.toggleInlineAnnotations();
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
      if (this.search.query) {
        this.jumpSearch(1);
      } else {
        this.jumpHunk(1);
      }
      return;
    }
    if (data === "N" && this.search.query) {
      this.jumpSearch(-1);
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
    const workspaceSummary = this.getWorkspaceCommentSummary?.(this.comments);
    const output: string[] = [];

    output.push(
      this.renderStatusLine(
        this.getHeaderText(selectedLine, workspaceSummary),
        "Press h for help",
        width,
      ),
    );

    const sidebarWidth = this.getFileSidebarWidth(width);
    const contentWidth = Math.max(10, width - sidebarWidth);
    this.ensureScroll(viewportHeight, contentWidth);
    const bodyRows = this.renderAnnotatedDiffRows(contentWidth, viewportHeight);
    const sidebarRows =
      sidebarWidth > 0
        ? this.renderFileSidebar(sidebarWidth, viewportHeight)
        : undefined;

    for (let index = 0; index < viewportHeight; index++) {
      const body = bodyRows[index] ?? " ".repeat(contentWidth);
      if (!sidebarRows) {
        output.push(body);
        continue;
      }
      const sidebar = sidebarRows[index] ?? " ".repeat(sidebarWidth);
      output.push(truncateToWidth(`${sidebar}${body}`, width));
    }

    output.push(
      truncateToWidth(
        this.theme.fg(
          "muted",
          this.getFooterText(selectedLine, workspaceSummary),
        ),
        width,
      ),
    );
    return this.helpVisible ? this.renderHelpModal(output, width) : output;
  }

  private getHeaderText(
    selectedLine?: ReviewLine,
    workspaceSummary?: WorkspaceCommentSummary,
  ): string {
    const visibleLineCount = this.getVisibleLineIndexes().length;
    const summaryCount = this.explanationController.explanations.size;
    const base = `${visibleLineCount}/${this.lines.length} lines • ${this.fileIndex.sections.length} files • ${this.comments.size} comments • ${summaryCount} summaries${this.formatWorkspaceSummary(workspaceSummary)}`;

    if (this.editMode) {
      return `${base} • editing ${this.editingCommentKey === GLOBAL_COMMENT_KEY ? "overall comment" : "inline comment"}`;
    }

    if (this.hasSelection()) {
      return `${base} • selection active`;
    }

    const focusText = this.focusedFilePath
      ? ` • focus ${this.focusedFilePath}`
      : "";
    return `${base}${focusText}`;
  }

  private renderStatusLine(left: string, right: string, width: number): string {
    const styledLeft = this.theme.fg("dim", left);
    const styledRight = this.theme.fg("muted", right);
    const rightWidth = visibleWidth(styledRight);
    const leftWidth = Math.max(0, width - rightWidth - 1);
    const truncatedLeft = truncateToWidth(styledLeft, leftWidth);
    const spacer = Math.max(
      1,
      width - visibleWidth(truncatedLeft) - rightWidth,
    );
    return truncateToWidth(
      `${truncatedLeft}${" ".repeat(spacer)}${styledRight}`,
      width,
    );
  }

  private renderHelpModal(rows: string[], width: number): string[] {
    if (rows.length === 0 || width < 8) return rows;

    const modalWidth = Math.max(8, Math.min(72, width - 2));
    const contentWidth = Math.max(4, modalWidth - 4);
    const keyWidth = Math.min(16, Math.max(8, Math.floor(contentWidth * 0.35)));
    const modalRows = this.buildHelpModalRows(
      modalWidth,
      contentWidth,
      keyWidth,
    );
    const maxRows = Math.max(1, rows.length - 2);
    const visibleModalRows =
      modalRows.length > maxRows
        ? [
            ...modalRows.slice(0, maxRows - 1),
            this.renderModalRow(
              this.theme.fg("dim", "More commands available on taller screens"),
              contentWidth,
            ),
          ]
        : modalRows;
    const top = Math.max(
      1,
      Math.floor((rows.length - visibleModalRows.length) / 2),
    );
    const left = Math.max(0, Math.floor((width - modalWidth) / 2));

    const output = [...rows];
    for (let index = 0; index < visibleModalRows.length; index++) {
      const row = visibleModalRows[index]!;
      output[top + index] = padToWidth(
        truncateToWidth(`${" ".repeat(left)}${row}`, width),
        width,
      );
    }
    return output;
  }

  private buildHelpModalRows(
    modalWidth: number,
    contentWidth: number,
    keyWidth: number,
  ): string[] {
    const rows = [
      this.renderModalHorizontal(" Help ", modalWidth, "top"),
      this.renderModalRow(
        this.theme.fg("dim", "Press h or Esc to close."),
        contentWidth,
      ),
      this.renderModalRow("", contentWidth),
    ];

    for (const [keys, description] of HELP_COMMANDS) {
      const keyCell = padToWidth(
        truncateToWidth(this.theme.fg("accent", keys), keyWidth),
        keyWidth,
      );
      rows.push(
        this.renderModalRow(
          `${keyCell} ${this.theme.fg("text", description)}`,
          contentWidth,
        ),
      );
    }

    rows.push(this.renderModalHorizontal("", modalWidth, "bottom"));
    return rows;
  }

  private renderModalRow(text: string, contentWidth: number): string {
    return `${this.theme.fg("borderMuted", "│")} ${padToWidth(
      truncateToWidth(text, contentWidth),
      contentWidth,
    )} ${this.theme.fg("borderMuted", "│")}`;
  }

  private renderModalHorizontal(
    title: string,
    width: number,
    part: "top" | "bottom",
  ): string {
    const contentWidth = Math.max(0, width - 2);
    const visibleTitle = truncateToWidth(title, contentWidth);
    const remaining = Math.max(0, contentWidth - visibleWidth(visibleTitle));
    const left = part === "top" ? "╭" : "╰";
    const right = part === "top" ? "╮" : "╯";
    return `${this.theme.fg("borderMuted", left)}${visibleTitle}${this.theme.fg(
      "borderMuted",
      "─".repeat(remaining),
    )}${this.theme.fg("borderMuted", right)}`;
  }

  private renderAnnotatedDiffRows(width: number, height: number): string[] {
    const rows = this.getAnnotatedRows(width);
    const output: string[] = [];

    for (let row = 0; row < height; row++) {
      const annotated = rows[this.scrollTop + row];
      if (!annotated) {
        output.push(" ".repeat(width));
        continue;
      }

      if (annotated.kind === "file-header") {
        output.push(this.renderFileHeaderRow(annotated.file, width));
        continue;
      }

      if (annotated.kind === "diff") {
        const index = annotated.lineIndex;
        const line = this.lines[index]!;
        output.push(
          this.renderDiffLine(
            line,
            index,
            width,
            index === this.selected,
            this.getSelectionBounds(),
          ),
        );
        continue;
      }

      if (annotated.kind === "split") {
        output.push(this.renderSplitDiffRowAt(annotated.splitRowIndex, width));
        continue;
      }

      output.push(this.renderInlineAnnotationRow(annotated, width));
    }

    return output;
  }

  private getAnnotatedRows(width: number): AnnotatedDiffRow[] {
    if (
      this.annotatedRows &&
      this.annotatedRowsWidth === width &&
      this.annotatedRowsRevision === this.commentsRevision &&
      this.annotatedRowsEditMode === this.editMode &&
      this.annotatedRowsEditingCommentKey === this.editingCommentKey &&
      this.annotatedRowsMode === this.diffRenderMode &&
      this.annotatedRowsInlineAnnotationsVisible ===
        this.inlineAnnotationsVisible &&
      this.annotatedRowsVisibleExplanationCount ===
        this.visibleExplanationKeys.size &&
      this.visibleExplanationKeys.size === 0 &&
      !this.askInputMode &&
      !this.askScope &&
      this.focusedFilePath == null
    ) {
      return this.annotatedRows;
    }

    const rows: AnnotatedDiffRow[] = [];
    const rowByLineIndex: number[] = [];

    this.pushGlobalAnnotationRows(rows, width);

    if (this.diffRenderMode === "split") {
      this.pushAnnotatedSplitRows(rows, rowByLineIndex, width);
    } else {
      this.pushAnnotatedUnifiedRows(rows, rowByLineIndex, width);
    }

    this.annotatedRows = rows;
    this.annotatedRowsWidth = width;
    this.annotatedRowsRevision = this.commentsRevision;
    this.annotatedRowsEditMode = this.editMode;
    this.annotatedRowsEditingCommentKey = this.editingCommentKey;
    this.annotatedRowsMode = this.diffRenderMode;
    this.annotatedRowsInlineAnnotationsVisible = this.inlineAnnotationsVisible;
    this.annotatedRowsVisibleExplanationCount =
      this.visibleExplanationKeys.size;
    this.annotatedRowByLineIndex = rowByLineIndex;
    return rows;
  }

  private pushAnnotatedUnifiedRows(
    rows: AnnotatedDiffRow[],
    rowByLineIndex: number[],
    width: number,
  ): void {
    for (const file of this.getVisibleFileSections()) {
      rows.push({ kind: "file-header", file });
      for (
        let index = file.startLineIndex;
        index <= file.endLineIndex;
        index++
      ) {
        rowByLineIndex[index] = rows.length;
        rows.push({ kind: "diff", lineIndex: index });

        if (!this.inlineAnnotationsVisible) continue;

        this.pushInlineCommentRows(rows, index, width);
        this.pushInlineEditorRows(rows, index, width);
        this.pushInlineExplanationRows(rows, index, width);
      }
    }
  }

  private pushAnnotatedSplitRows(
    rows: AnnotatedDiffRow[],
    rowByLineIndex: number[],
    width: number,
  ): void {
    const splitRows = this.getSplitDiffRows();
    for (const file of this.getVisibleFileSections()) {
      rows.push({ kind: "file-header", file });
      for (
        let splitRowIndex = 0;
        splitRowIndex < splitRows.length;
        splitRowIndex++
      ) {
        const splitRow = splitRows[splitRowIndex]!;
        const lineIndexes = this.getLineIndexesForSplitRow(splitRow).filter(
          (lineIndex) =>
            lineIndex >= file.startLineIndex && lineIndex <= file.endLineIndex,
        );
        if (lineIndexes.length === 0) continue;
        for (const lineIndex of lineIndexes) {
          rowByLineIndex[lineIndex] = rows.length;
        }

        rows.push({ kind: "split", splitRowIndex });
        if (!this.inlineAnnotationsVisible) continue;

        for (const lineIndex of lineIndexes) {
          this.pushInlineCommentRows(rows, lineIndex, width);
          this.pushInlineEditorRows(rows, lineIndex, width);
          this.pushInlineExplanationRows(rows, lineIndex, width);
        }
      }
    }
  }

  private getLineIndexesForSplitRow(row: SplitDiffRow): number[] {
    if (row.kind === "full") return [row.cell.index];
    const indexes: number[] = [];
    if (row.left) indexes.push(row.left.index);
    if (row.right && row.right.index !== row.left?.index) {
      indexes.push(row.right.index);
    }
    return indexes;
  }

  private pushGlobalAnnotationRows(
    rows: AnnotatedDiffRow[],
    width: number,
  ): void {
    if (!this.inlineAnnotationsVisible) return;

    const globalComment = this.comments.get(GLOBAL_COMMENT_KEY);
    if (globalComment) {
      this.pushAnnotationBlock(
        rows,
        "comment",
        globalComment.text,
        width,
        "Overall diff comment",
      );
    }

    if (this.editMode && this.editingCommentKey === GLOBAL_COMMENT_KEY) {
      this.pushInlineEditorBlock(rows, "Draft overall diff note", width);
    }
  }

  private pushInlineCommentRows(
    rows: AnnotatedDiffRow[],
    lineIndex: number,
    width: number,
  ): void {
    for (const comment of this.getCommentsEndingAtLine(lineIndex)) {
      if (this.editMode && comment.id === this.editingCommentKey) continue;
      this.pushAnnotationBlock(
        rows,
        "comment",
        comment.text,
        width,
        formatCommentLocation(comment),
      );
    }
  }

  private pushInlineEditorRows(
    rows: AnnotatedDiffRow[],
    lineIndex: number,
    width: number,
  ): void {
    if (!this.editMode || this.editingCommentKey === GLOBAL_COMMENT_KEY) return;
    const selection = this.getActiveCommentSelection();
    if (!selection || selection.end !== lineIndex) return;
    this.pushInlineEditorBlock(
      rows,
      `Draft note - ${this.formatSelectionLocation(selection)}`,
      width,
    );
  }

  private pushInlineExplanationRows(
    rows: AnnotatedDiffRow[],
    lineIndex: number,
    width: number,
  ): void {
    const scope = getCurrentHunkScope(this.lines, lineIndex);
    if (!scope) return;

    if (
      this.visibleExplanationKeys.has(scope.key) &&
      this.getExplanationAnchorIndex(lineIndex, scope.key) === lineIndex
    ) {
      const explanation = this.explanationController.getState(scope);
      if (!this.explanationController.isAvailable) {
        this.pushExplanationBlock(rows, "Explanation unavailable.", width);
      } else if (!explanation) {
        this.pushExplanationBlock(rows, "No explanation generated yet.", width);
      } else if (explanation.status === "loading") {
        this.pushExplanationBlock(
          rows,
          `${this.explanationController.getLoadingFrame()} ${explanation.text || "Generating explanation..."}`,
          width,
        );
      } else if (explanation.status === "error") {
        this.pushExplanationBlock(
          rows,
          `Explanation failed: ${explanation.message}`,
          width,
        );
      } else {
        this.pushExplanationBlock(rows, explanation.text, width);
      }
    }

    if (
      this.askInputMode &&
      this.askScope?.key === scope.key &&
      this.askAnchorIndex === lineIndex
    ) {
      this.pushInlineEditorBlock(rows, "Ask about this hunk", width);
    }

    if (
      !this.askInputMode &&
      this.askScope?.key === scope.key &&
      this.askAnchorIndex === lineIndex
    ) {
      const askState = this.explanationController.getAskState();
      if (askState) this.pushAskBlock(rows, askState, width);
    }
  }

  private pushAnnotationBlock(
    rows: AnnotatedDiffRow[],
    kind: "comment",
    text: string,
    width: number,
    title?: string,
  ): void {
    this.pushCommentBlock(rows, text, width, title);
  }

  private pushCommentBlock(
    rows: AnnotatedDiffRow[],
    text: string,
    width: number,
    title?: string,
  ): void {
    rows.push({
      kind: "comment",
      text: title ? this.theme.fg("accent", ` ${title} `) : "",
      part: "top",
    });
    const wrapped = wrapTextWithAnsi(
      this.theme.fg("text", text),
      this.getInlineContentWidth(width),
    );
    for (const line of wrapped.length > 0 ? wrapped : [""]) {
      rows.push({ kind: "comment", text: line, part: "body" });
    }
    rows.push({ kind: "comment", text: "", part: "bottom" });
  }

  private pushAskBlock(
    rows: AnnotatedDiffRow[],
    state: ExplanationState,
    width: number,
  ): void {
    if (state.status === "loading") {
      this.pushExplanationBlock(
        rows,
        `${this.explanationController.getLoadingFrame()} ${state.text || "Generating answer..."}`,
        width,
        " 💬 Answer ",
      );
    } else if (state.status === "error") {
      this.pushExplanationBlock(
        rows,
        `Failed: ${state.message}`,
        width,
        " 💬 Answer ",
      );
    } else {
      this.pushExplanationBlock(rows, state.text, width, " 💬 Answer ");
    }
  }

  private pushExplanationBlock(
    rows: AnnotatedDiffRow[],
    text: string,
    width: number,
    title = " ✨ Explanation ",
  ): void {
    rows.push({
      kind: "explanation",
      text: this.theme.fg("accent", title),
      part: "top",
    });
    const wrapped = wrapTextWithAnsi(
      this.theme.fg("muted", text),
      this.getInlineContentWidth(width),
    );
    for (const line of wrapped.length > 0 ? wrapped : [""]) {
      rows.push({ kind: "explanation", text: line, part: "body" });
    }
    rows.push({ kind: "explanation", text: "", part: "bottom" });
  }

  private pushInlineEditorBlock(
    rows: AnnotatedDiffRow[],
    title: string,
    width: number,
  ): void {
    rows.push({
      kind: "editor",
      text: this.theme.fg("accent", ` ${title} `),
      part: "top",
    });
    const editorLines = this.editor.render(this.getInlineContentWidth(width));
    const bodyLines = editorLines.slice(1, -1);
    for (const line of bodyLines.length > 0 ? bodyLines : [""]) {
      rows.push({ kind: "editor", text: line, part: "body" });
    }
    rows.push({ kind: "editor", text: "", part: "bottom" });
  }

  private renderInlineAnnotationRow(
    row: Exclude<AnnotatedDiffRow, { kind: "diff" } | { kind: "split" }>,
    width: number,
  ): string {
    if (row.kind === "editor") {
      return this.renderInlineBoxRow(
        { text: row.text, part: row.part },
        width,
        "accent",
      );
    }

    if (row.kind === "comment" || row.kind === "explanation") {
      return this.renderInlineBoxRow(
        { text: row.text, part: row.part },
        width,
        "borderMuted",
      );
    }

    return " ".repeat(width);
  }

  private renderInlineBoxRow(
    row: { text: string; part: "top" | "body" | "bottom" },
    width: number,
    borderColor: "accent" | "borderMuted",
  ): string {
    const indent = "      ";
    const contentWidth = this.getInlineContentWidth(width);
    const body =
      row.part === "top" || row.part === "bottom"
        ? this.renderInlineBoxHorizontal(row.text, contentWidth, borderColor)
        : padToWidth(truncateToWidth(row.text, contentWidth), contentWidth);
    const left = row.part === "top" ? "╭" : row.part === "bottom" ? "╰" : "│";
    const right = row.part === "top" ? "╮" : row.part === "bottom" ? "╯" : "│";
    return padToWidth(
      truncateToWidth(
        `${indent}${this.theme.fg(borderColor, left)}${body}${this.theme.fg(borderColor, right)}`,
        width,
      ),
      width,
    );
  }

  private renderInlineBoxHorizontal(
    title: string,
    width: number,
    borderColor: "accent" | "borderMuted",
  ): string {
    if (!title) return this.theme.fg(borderColor, "─".repeat(width));

    const visibleTitle = truncateToWidth(title, Math.max(0, width));
    const remaining = Math.max(0, width - visibleWidth(visibleTitle));
    return `${visibleTitle}${this.theme.fg(borderColor, "─".repeat(remaining))}`;
  }

  private getInlineContentWidth(width: number): number {
    return Math.max(10, width - 8);
  }

  private renderFileHeaderRow(file: ReviewFileSection, width: number): string {
    const selected = this.getCurrentFileSection()?.filePath === file.filePath;
    const focused = this.focusedFilePath === file.filePath;
    const summary = ` ${file.filePath}  +${file.additions} -${file.deletions}${file.hunks > 0 ? `  ${file.hunks} hunk${file.hunks === 1 ? "" : "s"}` : ""}${focused ? "  [focused]" : ""}`;
    const text = padToWidth(
      truncateToWidth(this.theme.fg("accent", summary), width),
      width,
    );
    return selected ? this.theme.bg("selectedBg", text) : text;
  }

  private getFileSidebarWidth(width: number): number {
    if (!this.fileSidebarVisible || width < 60) return 0;
    return Math.max(20, Math.min(36, Math.floor(width * 0.3)));
  }

  private renderFileSidebar(width: number, height: number): string[] {
    const files = this.fileIndex.sections;
    const current = this.getCurrentFileSection()?.filePath;
    const currentIndex = Math.max(
      0,
      files.findIndex((file) => file.filePath === current),
    );
    const visibleHeight = Math.max(0, height);
    const maxScrollTop = Math.max(0, files.length - visibleHeight);
    const scrollTop = Math.max(
      0,
      Math.min(
        Math.max(0, currentIndex - Math.floor(visibleHeight / 2)),
        maxScrollTop,
      ),
    );

    const rows: string[] = [];

    for (let row = 0; row < visibleHeight; row++) {
      const file = files[scrollTop + row];
      if (!file) {
        rows.push(" ".repeat(width));
        continue;
      }
      const selected = file.filePath === current;
      const focused = file.filePath === this.focusedFilePath;
      const label = file.filePath;
      const countSuffix = focused ? " *" : "";
      const added = this.theme.fg("toolDiffAdded", `+${file.additions}`);
      const removed = this.theme.fg("toolDiffRemoved", `-${file.deletions}`);
      const counts = `${added} ${removed}${countSuffix}`;
      const rightWidth = visibleWidth(counts);
      const leftWidth = Math.max(0, width - rightWidth - 1);
      const line = `${padToWidth(truncateToWidth(label, leftWidth), leftWidth)} ${counts}`;
      const padded = padToWidth(truncateToWidth(line, width), width);
      rows.push(selected ? this.theme.bg("selectedBg", padded) : padded);
    }

    return rows.slice(0, height);
  }

  private getVisibleFileSections(): ReviewFileSection[] {
    return this.focusedFilePath
      ? this.fileIndex.sections.filter(
          (section) => section.filePath === this.focusedFilePath,
        )
      : this.fileIndex.sections;
  }

  private getVisibleLineIndexes(): number[] {
    const indexes: number[] = [];
    for (const file of this.getVisibleFileSections()) {
      for (
        let index = file.startLineIndex;
        index <= file.endLineIndex;
        index++
      ) {
        indexes.push(index);
      }
    }
    return indexes;
  }

  private isLineVisible(lineIndex: number): boolean {
    const line = this.lines[lineIndex];
    if (!line?.filePath) return this.focusedFilePath == null;
    return !this.focusedFilePath || line.filePath === this.focusedFilePath;
  }

  private getCurrentFileSection(): ReviewFileSection | undefined {
    const current = this.fileIndex.sectionIndexByLine[this.selected];
    return current == null || current < 0
      ? undefined
      : this.fileIndex.sections[current];
  }

  private ensureSelectedVisible(): void {
    if (this.isLineVisible(this.selected)) return;
    const file = this.getVisibleFileSections()[0];
    const target =
      file?.firstCommentableLineIndex ?? this.getVisibleLineIndexes()[0];
    if (target != null) this.navigation.setSelected(target);
  }

  private invalidateAnnotatedRows(): void {
    this.annotatedRows = undefined;
    this.annotatedRowByLineIndex = undefined;
  }

  private getCommentsEndingAtLine(lineIndex: number): ReviewComment[] {
    const comments: ReviewComment[] = [];
    for (const comment of this.comments.values()) {
      if (comment.global) continue;
      const start = this.lineIndexById.get(comment.startLineId);
      const end = this.lineIndexById.get(comment.endLineId);
      if (start == null || end == null) continue;
      if (Math.max(start, end) === lineIndex) comments.push(comment);
    }
    return comments.sort((a, b) => a.id.localeCompare(b.id));
  }

  private restorePersistedAsk(
    cachedAsk: PersistedAsk,
  ): { scope: ExplanationScope; anchorIndex: number } | undefined {
    const anchorIndex = this.lineIndexById.get(cachedAsk.anchorLineId);
    if (anchorIndex != null) {
      const scope = getCurrentHunkScope(this.lines, anchorIndex);
      if (scope?.key === cachedAsk.scopeKey) {
        return { scope, anchorIndex };
      }
    }

    for (let index = 0; index < this.lines.length; index++) {
      const scope = getCurrentHunkScope(this.lines, index);
      if (scope?.key === cachedAsk.scopeKey) {
        return { scope, anchorIndex: index };
      }
    }

    return undefined;
  }

  private getHunkEndIndex(selected: number): number | undefined {
    const selectedLine = this.lines[selected];
    if (!selectedLine?.filePath || !selectedLine.hunkLabel) return undefined;

    let end = selected;
    while (
      end + 1 < this.lines.length &&
      this.lines[end + 1]?.filePath === selectedLine.filePath &&
      this.lines[end + 1]?.hunkLabel === selectedLine.hunkLabel
    ) {
      end++;
    }
    return end;
  }

  private getExplanationAnchorIndex(
    lineIndex: number,
    scopeKey: string,
  ): number | undefined {
    return (
      this.explanationAnchorByScope.get(scopeKey) ??
      this.getHunkEndIndex(lineIndex)
    );
  }

  private renderSplitDiffRowAt(splitRowIndex: number, width: number): string {
    const splitRow = this.getSplitDiffRows()[splitRowIndex];
    if (!splitRow) return " ".repeat(width);

    if (splitRow.kind === "full") {
      return this.renderDiffLine(
        splitRow.cell.line,
        splitRow.cell.index,
        width,
        splitRow.cell.index === this.selected,
        this.getSelectionBounds(),
      );
    }

    const separatorWidth = 3;
    const leftWidth = Math.max(10, Math.floor((width - separatorWidth) / 2));
    const rightWidth = Math.max(10, width - leftWidth - separatorWidth);
    const left = splitRow.left
      ? this.renderSplitDiffCell(splitRow.left, leftWidth, "left")
      : " ".repeat(leftWidth);
    const right = splitRow.right
      ? this.renderSplitDiffCell(splitRow.right, rightWidth, "right")
      : " ".repeat(rightWidth);
    return truncateToWidth(
      `${padToWidth(left, leftWidth)}${this.theme.fg("borderMuted", " │ ")}${padToWidth(right, rightWidth)}`,
      width,
    );
  }

  private getContentHeight(): number {
    const terminalRows = this.tui.terminal?.rows ?? 24;
    const headerHeight = 3;
    const footerHeight = 2;
    return Math.max(6, terminalRows - headerHeight - footerHeight);
  }

  invalidate(): void {
    this.highlightedLineCache.clear();
    this.invalidateAnnotatedRows();
  }

  dispose(): void {
    this.explanationController.dispose();
    this.clearAsk();
  }

  private startAskMode(): void {
    const scope = this.getCurrentHunkScope();
    if (!scope) return;
    this.clearAsk();
    this.askScope = scope;
    this.askAnchorIndex = this.selected;
    this.askInputMode = true;
    this.inlineAnnotationsVisible = true;
    this.editor.setText("");
    this.invalidateAnnotatedRows();
    this.tui.requestRender(true);
  }

  private exitAskInputMode(): void {
    this.askInputMode = false;
    this.editor.setText("");
    if (!this.explanationController.getAskState()) {
      this.askScope = undefined;
      this.askAnchorIndex = undefined;
    }
    this.invalidateAnnotatedRows();
    this.tui.requestRender(true);
  }

  private clearAsk(): void {
    this.askInputMode = false;
    this.askScope = undefined;
    this.askAnchorIndex = undefined;
    this.explanationController.clearAsk();
    this.editor.setText("");
    this.invalidateAnnotatedRows();
    this.tui.requestRender(true);
  }

  private move(delta: number): void {
    const visible = this.getVisibleLineIndexes();
    if (visible.length === 0) return;
    this.ensureSelectedVisible();
    const currentIndex = Math.max(0, visible.indexOf(this.selected));
    const next =
      visible[Math.max(0, Math.min(visible.length - 1, currentIndex + delta))];
    if (next == null || !this.navigation.setSelected(next)) return;
    this.tui.requestRender();
  }

  private jumpToBoundary(boundary: "start" | "end"): void {
    const visible = this.getVisibleLineIndexes();
    if (visible.length === 0) return;
    const next =
      boundary === "start" ? visible[0] : visible[visible.length - 1];
    if (next == null) return;
    const result = this.navigation.jumpToIndex(next);
    if (!result.changed) return;
    this.tui.requestRender();
  }

  private jumpFile(direction: 1 | -1): void {
    const files = this.getVisibleFileSections();
    if (files.length === 0) return;
    const current = this.getCurrentFileSection();
    const currentIndex = current
      ? files.findIndex((file) => file.filePath === current.filePath)
      : -1;
    const nextIndex =
      currentIndex >= 0
        ? Math.max(0, Math.min(files.length - 1, currentIndex + direction))
        : direction === 1
          ? 0
          : files.length - 1;
    const next = files[nextIndex];
    if (!next) return;
    this.navigation.jumpToIndex(next.firstCommentableLineIndex);
    this.tui.requestRender(true);
  }

  private toggleCurrentFileFocus(): void {
    const current = this.getCurrentFileSection();
    if (!current) return;
    this.focusedFilePath =
      this.focusedFilePath === current.filePath ? undefined : current.filePath;
    this.ensureSelectedVisible();
    this.highlightedLineCache.clear();
    this.invalidateAnnotatedRows();
    this.tui.requestRender(true);
  }

  private toggleFileSidebar(): void {
    this.fileSidebarVisible = !this.fileSidebarVisible;
    this.invalidateAnnotatedRows();
    this.tui.requestRender(true);
  }

  private toggleDiffRenderMode(): void {
    this.navigation.toggleDiffRenderMode();
    this.tui.requestRender(true);
  }

  private toggleInlineAnnotations(): void {
    this.inlineAnnotationsVisible = !this.inlineAnnotationsVisible;
    this.invalidateAnnotatedRows();
    this.tui.requestRender(true);
  }

  private toggleHelp(): void {
    this.helpVisible = !this.helpVisible;
    this.tui.requestRender(true);
  }

  private hideInlineExplanation(): void {
    this.visibleExplanationKeys.clear();
    this.explanationAnchorByScope.clear();
  }

  private toggleExplanationPane(): void {
    const scope = this.getCurrentHunkScope();
    if (!scope) return;

    if (this.visibleExplanationKeys.has(scope.key)) {
      this.visibleExplanationKeys.delete(scope.key);
      this.explanationAnchorByScope.delete(scope.key);
    } else {
      this.visibleExplanationKeys.add(scope.key);
      this.explanationAnchorByScope.set(scope.key, this.selected);
      this.ensureCurrentExplanation();
    }

    this.invalidateAnnotatedRows();
    this.tui.requestRender(true);
  }

  private getPageMoveAmount(): number {
    const contentHeight = this.getContentHeight();
    return Math.max(1, Math.floor(contentHeight / 2));
  }

  private extendSelection(delta: number): void {
    const visible = this.getVisibleLineIndexes();
    if (visible.length === 0) return;
    this.ensureSelectedVisible();
    const currentIndex = Math.max(0, visible.indexOf(this.selected));
    const next =
      visible[Math.max(0, Math.min(visible.length - 1, currentIndex + delta))];
    if (next == null || !this.navigation.extendSelectionTo(next)) return;
    this.tui.requestRender();
  }

  private clearSelection(): void {
    if (!this.navigation.clearSelection()) return;
    this.tui.requestRender();
  }

  private hasSelection(): boolean {
    return this.navigation.hasSelection();
  }

  private getSelectionBounds(): SelectionBounds | undefined {
    return this.navigation.getSelectionBounds();
  }

  private getActiveCommentSelection(): SelectionBounds | undefined {
    const selection = this.getSelectionBounds();
    if (selection) return selection;
    const line = this.lines[this.selected];
    if (!line?.commentable) return undefined;
    return { start: this.selected, end: this.selected };
  }

  private getSelectionKey(start: number, end: number): string {
    return getSelectionKey(this.lines, start, end);
  }

  private formatSelectionLocation(selection: SelectionBounds): string {
    const startLine = this.lines[selection.start];
    const endLine = this.lines[selection.end];
    if (!startLine || !endLine) return "diff";

    const start = formatLocation(startLine);
    const end = formatLocation(endLine);
    return start === end ? start : `${start} -> ${end}`;
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
    this.invalidateAnnotatedRows();
    this.onCommentsChanged?.(this.comments);
  }

  private ensureCommentLineKeys(): void {
    if (this.commentLineKeysRevision === this.commentsRevision) return;

    this.commentLineKeys = buildCommentLineKeys(
      this.comments,
      this.lineIndexById,
    );
    this.commentLineKeysRevision = this.commentsRevision;
  }

  private getPositionText(selectedLine?: ReviewLine): string {
    const visible = this.getVisibleLineIndexes();
    const visiblePosition = Math.max(0, visible.indexOf(this.selected)) + 1;
    const position = `${visiblePosition}/${Math.max(visible.length, 1)}`;
    const file = this.getCurrentFileSection();
    const filePosition = file
      ? `${this.fileIndex.sections.findIndex((section) => section.filePath === file.filePath) + 1}/${this.fileIndex.sections.length}`
      : undefined;
    return selectedLine?.filePath
      ? `${position}${filePosition ? ` • file ${filePosition}` : ""} ${selectedLine.filePath}`
      : position;
  }

  private getFooterText(
    selectedLine?: ReviewLine,
    workspaceSummary?: WorkspaceCommentSummary,
  ): string {
    if (this.search.mode) {
      return `Search: /${this.search.draftQuery} • Enter jump • Esc cancel`;
    }

    const searchStatus = this.search.getStatusText(this.selected);
    if (searchStatus) return searchStatus;

    const selection = this.getSelectionBounds();
    if (selection) {
      const count = selection.end - selection.start + 1;
      const startLine = this.lines[selection.start]!;
      const endLine = this.lines[selection.end]!;
      return `Selected ${count} lines: ${formatLocation(startLine)} -> ${formatLocation(endLine)}`;
    }

    const workspaceText = this.formatWorkspaceSummary(workspaceSummary, false);
    return workspaceText ? workspaceText.slice(3) : "";
  }

  private formatWorkspaceSummary(
    summary?: WorkspaceCommentSummary,
    includeVisible = true,
  ): string {
    if (!summary) return "";

    const parts: string[] = [];
    if (includeVisible && summary.visible > 0)
      parts.push(`${summary.visible} visible persisted`);
    if (summary.hiddenInCurrentFiles > 0) {
      parts.push(`${summary.hiddenInCurrentFiles} hidden in current files`);
    }
    if (summary.elsewhere > 0) parts.push(`${summary.elsewhere} elsewhere`);
    if (summary.stale > 0) parts.push(`${summary.stale} stale`);
    if (summary.orphaned > 0) parts.push(`${summary.orphaned} orphaned`);
    return parts.length > 0 ? ` • ${parts.join(" • ")}` : "";
  }

  private jumpHunk(direction: 1 | -1): void {
    let index = this.selected + direction;
    while (index >= 0 && index < this.lines.length) {
      if (this.isLineVisible(index) && this.lines[index]?.kind === "hunk") {
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
    this.inlineAnnotationsVisible = true;
    this.hideInlineExplanation();
    this.editMode = true;
    this.editingCommentKey = GLOBAL_COMMENT_KEY;
    this.editor.setText(existing?.text ?? "");
    this.invalidateAnnotatedRows();
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
    this.inlineAnnotationsVisible = true;
    this.hideInlineExplanation();
    this.editMode = true;
    this.editingCommentKey = this.getSelectionKey(
      selection.start,
      selection.end,
    );
    this.editor.setText(existing?.text ?? "");
    this.invalidateAnnotatedRows();
    this.tui.requestRender(true);
  }

  private exitEditMode(): void {
    this.editMode = false;
    this.editingCommentKey = undefined;
    this.editor.setText("");
    this.invalidateAnnotatedRows();
    this.tui.requestRender(true);
  }

  private startSearchMode(): void {
    this.search.start();
    this.tui.requestRender();
  }

  private handleSearchInput(data: string): void {
    const result = this.search.handleInput(data, this.selected);
    if (result.selected != null) this.selected = result.selected;
    this.tui.requestRender();
  }

  private clearSearch(): void {
    this.search.clear();
    this.tui.requestRender();
  }

  private jumpSearch(direction: 1 | -1): void {
    const result = this.search.jump(direction, this.selected);
    if (result.selected != null) this.selected = result.selected;
    this.tui.requestRender();
  }

  private getSplitDiffRows(): SplitDiffRow[] {
    if (this.splitRows) return this.splitRows;

    const { rows } = buildSplitDiffRows(this.lines);
    this.splitRows = rows;
    return rows;
  }

  private getSelectedDisplayRow(width: number): number {
    this.getAnnotatedRows(width);
    return this.annotatedRowByLineIndex?.[this.selected] ?? 0;
  }

  private getDisplayRowCount(width: number): number {
    return this.getAnnotatedRows(width).length;
  }

  private renderSplitDiffCell(
    cell: SplitDiffCell,
    width: number,
    side: "left" | "right",
  ): string {
    const { line, index } = cell;
    const hasComment = this.getCommentKeysForLine(index).length > 0;
    const commentMark = hasComment ? this.theme.fg("borderAccent", "│") : " ";
    const lineNumber =
      side === "left" ? line.oldLineNumber : line.newLineNumber;
    const prefix = `${commentMark} ${lineNumberCell(lineNumber)} `;
    let styled = this.renderDiffRowContent(line, prefix, index);

    styled = truncateToWidth(styled, width);
    const selection = this.getSelectionBounds();
    const inSelection =
      selection != null && index >= selection.start && index <= selection.end;
    if (index === this.selected || inSelection) {
      return this.theme.bg("selectedBg", padToWidth(styled, width));
    }
    return this.applyDiffBackground(line, styled, width);
  }

  private ensureScroll(viewportHeight: number, width: number): void {
    this.navigation.ensureScroll(
      viewportHeight,
      this.getScrollTargetDisplayRow(width),
      this.getDisplayRowCount(width),
    );
  }

  private getScrollTargetDisplayRow(width: number): number {
    if (this.editMode || this.askInputMode) {
      const editorRow = this.getAnnotatedRows(width).findIndex(
        (row) => row.kind === "editor",
      );
      if (editorRow >= 0) return editorRow;
    }

    return this.getSelectedDisplayRow(width);
  }

  private getDisplayText(line: ReviewLine): string {
    const raw =
      line.kind === "add" || line.kind === "remove" || line.kind === "context"
        ? line.text.slice(1)
        : line.text;
    return expandTabs(raw);
  }

  private applyDiffBackground(
    line: ReviewLine,
    styled: string,
    width: number,
  ): string {
    if (line.kind === "add") {
      return this.theme.bg("toolSuccessBg", padToWidth(styled, width));
    }
    if (line.kind === "remove") {
      return this.theme.bg("toolErrorBg", padToWidth(styled, width));
    }
    return styled;
  }

  private renderDiffRowContent(
    line: ReviewLine,
    prefix: string,
    index: number,
  ): string {
    switch (line.kind) {
      case "add":
        return `${this.theme.fg("toolDiffAdded", prefix)}${this.getHighlightedDisplayText(line, index)}`;
      case "remove":
        return `${this.theme.fg("toolDiffRemoved", prefix)}${this.getHighlightedDisplayText(line, index)}`;
      case "context":
        return `${this.theme.fg("toolDiffContext", prefix)}${this.getHighlightedDisplayText(line, index)}`;
      case "hunk":
        return this.theme.fg("accent", `${prefix}${this.getDisplayText(line)}`);
      default:
        return this.theme.fg("muted", `${prefix}${this.getDisplayText(line)}`);
    }
  }

  private getHighlightedDisplayText(line: ReviewLine, index: number): string {
    const code = this.getDisplayText(line);
    if (!code) return code;

    const lang = line.filePath ? getLanguageFromPath(line.filePath) : undefined;
    const cacheKey = `${line.id}\0${lang ?? ""}\0${this.search.getHighlightCacheKey()}\0${code}`;
    const cached = this.highlightedLineCache.get(cacheKey);
    if (cached != null) return cached;

    const searchHighlighted = this.getSearchHighlightedDisplayText(code, index);
    if (searchHighlighted) {
      this.highlightedLineCache.set(cacheKey, searchHighlighted);
      return searchHighlighted;
    }

    let highlighted = code;
    try {
      highlighted = highlightCode(code, lang)[0] ?? code;
    } catch {
      highlighted = code;
    }

    this.highlightedLineCache.set(cacheKey, highlighted);
    return highlighted;
  }

  private getSearchHighlightedDisplayText(
    code: string,
    index: number,
  ): string | undefined {
    const matches = this.search.getMatchesForLine(index);
    if (matches.length === 0) return undefined;

    const activeMatch = this.search.getActiveMatch();
    let result = "";
    let cursor = 0;
    for (const match of matches) {
      result += code.slice(cursor, match.start);
      const text = code.slice(match.start, match.end);
      const isActive =
        activeMatch?.lineIndex === match.lineIndex &&
        activeMatch.start === match.start &&
        activeMatch.end === match.end;
      result += isActive
        ? this.theme.bg("selectedBg", this.theme.fg("warning", text))
        : this.theme.bg("selectedBg", this.theme.fg("accent", text));
      cursor = match.end;
    }
    result += code.slice(cursor);
    return result;
  }

  private renderDiffLine(
    line: ReviewLine,
    index: number,
    width: number,
    selected: boolean,
    selection?: SelectionBounds,
  ): string {
    const hasComment = this.getCommentKeysForLine(index).length > 0;
    const commentMark = hasComment ? this.theme.fg("borderAccent", "│") : " ";
    const numbers = `${lineNumberCell(line.oldLineNumber)} ${lineNumberCell(line.newLineNumber)}`;
    const prefix = `${commentMark} ${numbers} `;
    let styled = this.renderDiffRowContent(line, prefix, index);

    styled = truncateToWidth(styled, width);
    const inSelection =
      selection != null && index >= selection.start && index <= selection.end;
    if (selected || inSelection) {
      return this.theme.bg("selectedBg", padToWidth(styled, width));
    }
    return this.applyDiffBackground(line, styled, width);
  }

  private ensureCurrentExplanation(): void {
    this.explanationController.ensure(this.getCurrentHunkScope());
  }

  private getCurrentHunkScope() {
    return getCurrentHunkScope(this.lines, this.selected);
  }
}

function expandTabs(text: string, tabSize = 4): string {
  let result = "";
  let col = 0;
  for (const char of text) {
    if (char === "\t") {
      const spaces = tabSize - (col % tabSize);
      result += " ".repeat(spaces);
      col += spaces;
    } else {
      result += char;
      col++;
    }
  }
  return result;
}
