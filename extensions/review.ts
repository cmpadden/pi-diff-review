import { execFileSync } from "node:child_process";
import { parsePatchFiles } from "@pierre/diffs";
import type {
  ChangeContent,
  ContextContent,
  FileDiffMetadata,
  Hunk,
} from "@pierre/diffs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import {
  Editor,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

type DiffLineKind = "meta" | "hunk" | "context" | "add" | "remove";

type ReviewComment = {
  id: string;
  filePath: string;
  text: string;
  startLineId: string;
  endLineId: string;
  startOldLineNumber?: number;
  startNewLineNumber?: number;
  endOldLineNumber?: number;
  endNewLineNumber?: number;
  lineText: string;
};

type ReviewLine = {
  id: string;
  kind: DiffLineKind;
  text: string;
  filePath?: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  commentable: boolean;
  hunkLabel?: string;
};

type ReviewResult =
  | { action: "submit"; comments: ReviewComment[] }
  | { action: "cancel" };

type SelectionBounds = {
  start: number;
  end: number;
};

type DiffSource = {
  label: string;
  promptLabel: string;
  args: string[];
};

type ReviewLayout = "side-by-side" | "stacked";
type DiffRenderMode = "unified" | "split";

type SplitDiffCell = {
  line: ReviewLine;
  index: number;
};

type SplitDiffRow =
  | { kind: "full"; cell: SplitDiffCell }
  | { kind: "split"; left?: SplitDiffCell; right?: SplitDiffCell };

function parseDiffSource(args: string): DiffSource {
  const trimmed = args.trim();
  if (!trimmed) {
    return {
      label: "unstaged git diff",
      promptLabel: "the current unstaged git diff",
      args: [],
    };
  }

  const gitArgs = trimmed.split(/\s+/).filter(Boolean);
  return {
    label: `git diff ${trimmed}`,
    promptLabel: `\`git diff ${trimmed}\``,
    args: gitArgs,
  };
}

function getDiff(cwd: string, source: DiffSource): string {
  return execFileSync(
    "git",
    ["diff", "--no-color", "--unified=3", ...source.args],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function parseDiff(diffText: string): ReviewLine[] {
  try {
    const reviewLines = parseDiffWithPierre(diffText);
    if (reviewLines.length > 0) return reviewLines;
  } catch {
    // Fall back to the local parser for any patch formats @pierre/diffs does
    // not recognize. The review UI should remain available even if the richer
    // parser fails on unusual diff output.
  }

  return parseDiffManual(diffText);
}

function parseDiffWithPierre(diffText: string): ReviewLine[] {
  const patches = parsePatchFiles(diffText);
  const parsed: ReviewLine[] = [];
  let lineIndex = 0;

  const pushLine = (line: Omit<ReviewLine, "id">) => {
    parsed.push({ id: `line-${lineIndex++}`, ...line });
  };

  for (const patch of patches) {
    if (patch.patchMetadata?.trim()) {
      for (const line of patch.patchMetadata.trimEnd().split("\n")) {
        pushLine({ kind: "meta", text: line, commentable: false });
      }
    }

    for (const file of patch.files) {
      appendPierreFileDiff(file, pushLine);
    }
  }

  return parsed;
}

function appendPierreFileDiff(
  file: FileDiffMetadata,
  pushLine: (line: Omit<ReviewLine, "id">) => void,
): void {
  const previousFile =
    file.prevName ?? (file.type === "new" ? undefined : file.name);
  const nextFile = file.type === "deleted" ? undefined : file.name;
  const displayPreviousFile = previousFile ?? file.name;
  const displayNextFile = nextFile ?? file.name;
  const currentFile = nextFile ?? previousFile ?? file.name;

  pushLine({
    kind: "meta",
    text: `diff --git a/${displayPreviousFile} b/${displayNextFile}`,
    filePath: currentFile,
    commentable: false,
  });

  if (file.type === "new" && file.mode) {
    pushLine({
      kind: "meta",
      text: `new file mode ${file.mode}`,
      filePath: currentFile,
      commentable: false,
    });
  } else if (file.type === "deleted" && file.mode) {
    pushLine({
      kind: "meta",
      text: `deleted file mode ${file.mode}`,
      filePath: currentFile,
      commentable: false,
    });
  } else if (file.prevMode && file.mode && file.prevMode !== file.mode) {
    pushLine({
      kind: "meta",
      text: `old mode ${file.prevMode}`,
      filePath: currentFile,
      commentable: false,
    });
    pushLine({
      kind: "meta",
      text: `new mode ${file.mode}`,
      filePath: currentFile,
      commentable: false,
    });
  }

  if (file.prevObjectId && file.newObjectId) {
    pushLine({
      kind: "meta",
      text: `index ${file.prevObjectId}..${file.newObjectId}${file.mode ? ` ${file.mode}` : ""}`,
      filePath: currentFile,
      commentable: false,
    });
  }

  if (file.type === "rename-pure" || file.type === "rename-changed") {
    if (file.prevName) {
      pushLine({
        kind: "meta",
        text: `rename from ${file.prevName}`,
        filePath: currentFile,
        commentable: false,
      });
    }
    pushLine({
      kind: "meta",
      text: `rename to ${file.name}`,
      filePath: currentFile,
      commentable: false,
    });
  }

  if (file.hunks.length === 0) return;

  pushLine({
    kind: "meta",
    text: previousFile ? `--- a/${previousFile}` : "--- /dev/null",
    filePath: currentFile,
    commentable: false,
  });
  pushLine({
    kind: "meta",
    text: nextFile ? `+++ b/${nextFile}` : "+++ /dev/null",
    filePath: currentFile,
    commentable: false,
  });

  for (const hunk of file.hunks) {
    appendPierreHunk(file, hunk, currentFile, pushLine);
  }
}

function appendPierreHunk(
  file: FileDiffMetadata,
  hunk: Hunk,
  currentFile: string,
  pushLine: (line: Omit<ReviewLine, "id">) => void,
): void {
  const hunkLabel = hunk.hunkSpecs?.trimEnd() ?? "@@";
  let oldLine = hunk.deletionStart;
  let newLine = hunk.additionStart;
  let deletionIndex = hunk.deletionLineIndex;
  let additionIndex = hunk.additionLineIndex;

  pushLine({
    kind: "hunk",
    text: hunkLabel,
    filePath: currentFile,
    commentable: false,
    hunkLabel,
  });

  for (const content of hunk.hunkContent) {
    if (content.type === "context") {
      ({ oldLine, newLine, deletionIndex, additionIndex } = appendPierreContext(
        file,
        content,
        currentFile,
        hunkLabel,
        oldLine,
        newLine,
        deletionIndex,
        additionIndex,
        pushLine,
      ));
    } else {
      ({ oldLine, newLine, deletionIndex, additionIndex } = appendPierreChange(
        file,
        content,
        currentFile,
        hunkLabel,
        oldLine,
        newLine,
        deletionIndex,
        additionIndex,
        pushLine,
      ));
    }
  }
}

type PierreLineState = {
  oldLine: number;
  newLine: number;
  deletionIndex: number;
  additionIndex: number;
};

function appendPierreContext(
  file: FileDiffMetadata,
  content: ContextContent,
  currentFile: string,
  hunkLabel: string,
  oldLine: number,
  newLine: number,
  deletionIndex: number,
  additionIndex: number,
  pushLine: (line: Omit<ReviewLine, "id">) => void,
): PierreLineState {
  for (let i = 0; i < content.lines; i++) {
    const lineText =
      file.deletionLines[deletionIndex] ??
      file.additionLines[additionIndex] ??
      "";
    pushLine({
      kind: "context",
      text: ` ${stripLineEnding(lineText)}`,
      filePath: currentFile,
      oldLineNumber: oldLine,
      newLineNumber: newLine,
      commentable: true,
      hunkLabel,
    });
    oldLine++;
    newLine++;
    deletionIndex++;
    additionIndex++;
  }

  return { oldLine, newLine, deletionIndex, additionIndex };
}

function appendPierreChange(
  file: FileDiffMetadata,
  content: ChangeContent,
  currentFile: string,
  hunkLabel: string,
  oldLine: number,
  newLine: number,
  deletionIndex: number,
  additionIndex: number,
  pushLine: (line: Omit<ReviewLine, "id">) => void,
): PierreLineState {
  for (let i = 0; i < content.deletions; i++) {
    const lineText = file.deletionLines[deletionIndex] ?? "";
    pushLine({
      kind: "remove",
      text: `-${stripLineEnding(lineText)}`,
      filePath: currentFile,
      oldLineNumber: oldLine,
      commentable: true,
      hunkLabel,
    });
    oldLine++;
    deletionIndex++;
  }

  for (let i = 0; i < content.additions; i++) {
    const lineText = file.additionLines[additionIndex] ?? "";
    pushLine({
      kind: "add",
      text: `+${stripLineEnding(lineText)}`,
      filePath: currentFile,
      newLineNumber: newLine,
      commentable: true,
      hunkLabel,
    });
    newLine++;
    additionIndex++;
  }

  return { oldLine, newLine, deletionIndex, additionIndex };
}

function stripLineEnding(text: string): string {
  return text.replace(/\r?\n$/, "");
}

function parseDiffManual(diffText: string): ReviewLine[] {
  const lines = diffText.split("\n");
  const parsed: ReviewLine[] = [];

  let currentFile: string | undefined;
  let previousFile: string | undefined;
  let nextFile: string | undefined;
  let currentHunk: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  let lineIndex = 0;

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      const match = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
      previousFile = match?.[1];
      nextFile = match?.[2];
      currentFile = nextFile ?? previousFile;
      currentHunk = undefined;
      parsed.push({
        id: `line-${lineIndex++}`,
        kind: "meta",
        text: raw,
        filePath: currentFile,
        commentable: false,
      });
      continue;
    }

    if (raw.startsWith("--- ")) {
      previousFile =
        raw === "--- /dev/null"
          ? undefined
          : raw.replace(/^--- a\//, "").replace(/^--- /, "");
      parsed.push({
        id: `line-${lineIndex++}`,
        kind: "meta",
        text: raw,
        filePath: currentFile,
        commentable: false,
      });
      continue;
    }

    if (raw.startsWith("+++ ")) {
      nextFile =
        raw === "+++ /dev/null"
          ? undefined
          : raw.replace(/^\+\+\+ b\//, "").replace(/^\+\+\+ /, "");
      currentFile = nextFile ?? previousFile;
      parsed.push({
        id: `line-${lineIndex++}`,
        kind: "meta",
        text: raw,
        filePath: currentFile,
        commentable: false,
      });
      continue;
    }

    if (raw.startsWith("@@")) {
      const match = raw.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/,
      );
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[3]);
      }
      currentHunk = raw;
      parsed.push({
        id: `line-${lineIndex++}`,
        kind: "hunk",
        text: raw,
        filePath: currentFile,
        commentable: false,
        hunkLabel: currentHunk,
      });
      continue;
    }

    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      parsed.push({
        id: `line-${lineIndex++}`,
        kind: "add",
        text: raw,
        filePath: currentFile,
        newLineNumber: newLine,
        commentable: Boolean(currentFile),
        hunkLabel: currentHunk,
      });
      newLine++;
      continue;
    }

    if (raw.startsWith("-") && !raw.startsWith("---")) {
      parsed.push({
        id: `line-${lineIndex++}`,
        kind: "remove",
        text: raw,
        filePath: currentFile,
        oldLineNumber: oldLine,
        commentable: Boolean(currentFile),
        hunkLabel: currentHunk,
      });
      oldLine++;
      continue;
    }

    if (raw.startsWith(" ")) {
      parsed.push({
        id: `line-${lineIndex++}`,
        kind: "context",
        text: raw,
        filePath: currentFile,
        oldLineNumber: oldLine,
        newLineNumber: newLine,
        commentable: Boolean(currentFile),
        hunkLabel: currentHunk,
      });
      oldLine++;
      newLine++;
      continue;
    }

    parsed.push({
      id: `line-${lineIndex++}`,
      kind: "meta",
      text: raw,
      filePath: currentFile,
      commentable: false,
    });
  }

  return parsed;
}

function formatLocation(line: {
  filePath?: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}): string {
  const file = line.filePath ?? "(unknown file)";
  if (line.oldLineNumber != null && line.newLineNumber != null) {
    if (line.oldLineNumber === line.newLineNumber) {
      return `${file}:${line.newLineNumber}`;
    }
    return `${file}:old:${line.oldLineNumber}/new:${line.newLineNumber}`;
  }
  if (line.newLineNumber != null) return `${file}:new:${line.newLineNumber}`;
  if (line.oldLineNumber != null) return `${file}:old:${line.oldLineNumber}`;
  return file;
}

function formatCommentLocation(comment: ReviewComment): string {
  const start = formatLocation({
    filePath: comment.filePath,
    oldLineNumber: comment.startOldLineNumber,
    newLineNumber: comment.startNewLineNumber,
  });
  const end = formatLocation({
    filePath: comment.filePath,
    oldLineNumber: comment.endOldLineNumber,
    newLineNumber: comment.endNewLineNumber,
  });
  return start === end ? start : `${start} -> ${end}`;
}

function buildReviewPrompt(
  comments: ReviewComment[],
  promptLabel: string,
): string {
  const body = comments
    .map((comment) => {
      const location = formatCommentLocation(comment);
      const excerpt = comment.lineText.trim()
        ? `\n  Excerpt:\n\n\`\`\`diff\n${comment.lineText}\n\`\`\``
        : "";
      return `- \`${location}\` — ${comment.text}${excerpt}`;
    })
    .join("\n");

  return `Address this local code review feedback for ${promptLabel}.\n\n## Review comments\n${body}\n\nPlease apply the feedback and summarize what changed.`;
}

function padToWidth(text: string, width: number): string {
  const visible = visibleWidth(text);
  if (visible >= width) return truncateToWidth(text, width);
  return text + " ".repeat(width - visible);
}

function lineNumberCell(value?: number): string {
  return value == null ? "    " : String(value).padStart(4, " ");
}

class ReviewComponent {
  private selected = 0;
  private scrollTop = 0;
  private editMode = false;
  private editingCommentKey?: string;
  private selectionAnchor?: number;
  private layout: ReviewLayout = "side-by-side";
  private diffRenderMode: DiffRenderMode = "unified";
  private editor: Editor;

  constructor(
    private tui: {
      requestRender: (full?: boolean) => void;
      terminal?: { rows: number; columns: number };
    },
    private theme: Theme,
    private title: string,
    private lines: ReviewLine[],
    private comments: Map<string, ReviewComment>,
    private done: (result: ReviewResult) => void,
  ) {
    const firstCommentable = this.lines.findIndex((line) => line.commentable);
    this.selected = firstCommentable >= 0 ? firstCommentable : 0;

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
      const selection = this.getActiveCommentSelection();
      if (!selection) {
        this.exitEditMode();
        return;
      }

      const trimmed = value.trim();
      const key = this.getSelectionKey(selection.start, selection.end);
      if (!trimmed) {
        this.comments.delete(key);
      } else {
        this.comments.set(
          key,
          this.buildCommentFromSelection(selection, trimmed),
        );
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
    if (data === "R") {
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
              ? `${this.lines.length} lines • ${this.comments.size} comments • J/K extend • Esc clear selection • c comment range • R submit`
              : `${this.lines.length} lines • ${this.comments.size} comments • j/k move • ctrl-u/d page • t unified/split • J/K extend • c comment • x delete • n/p hunk • R submit • q quit`,
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
    const rows = this.buildSplitDiffRows();
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

  private move(delta: number): void {
    this.selected = Math.max(
      0,
      Math.min(this.lines.length - 1, this.selected + delta),
    );
    this.tui.requestRender();
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
    this.selected = Math.max(
      0,
      Math.min(this.lines.length - 1, this.selected + delta),
    );
    this.tui.requestRender();
  }

  private clearSelection(): void {
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
    const line = this.lines[index];
    if (!line) return [];
    return [...this.comments.entries()]
      .filter(([, comment]) => {
        const start = this.lines.findIndex(
          (item) => item.id === comment.startLineId,
        );
        const end = this.lines.findIndex(
          (item) => item.id === comment.endLineId,
        );
        return start !== -1 && end !== -1 && index >= start && index <= end;
      })
      .map(([key]) => key);
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
    this.comments.delete(this.getSelectionKey(selection.start, selection.end));
    this.tui.requestRender();
  }

  private startEditMode(): void {
    const selection = this.getActiveCommentSelection();
    if (!selection) return;
    const startLine = this.lines[selection.start];
    const endLine = this.lines[selection.end];
    if (!startLine?.commentable || !endLine?.commentable) return;
    if (startLine.filePath !== endLine.filePath) return;

    const existing = this.getCommentForSelection(selection);
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

  private buildSplitDiffRows(): SplitDiffRow[] {
    const rows: SplitDiffRow[] = [];
    let index = 0;

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
          rows.push({
            kind: "split",
            left: removals[offset],
            right: additions[offset],
          });
        }
        continue;
      }

      if (line.kind === "context") {
        const cell = { line, index };
        rows.push({ kind: "split", left: cell, right: cell });
      } else {
        rows.push({ kind: "full", cell: { line, index } });
      }
      index++;
    }

    return rows;
  }

  private getSelectedDisplayRow(): number {
    if (this.diffRenderMode === "unified") return this.selected;
    const rows = this.buildSplitDiffRows();
    const row = rows.findIndex((item) =>
      item.kind === "full"
        ? item.cell.index === this.selected
        : item.left?.index === this.selected ||
          item.right?.index === this.selected,
    );
    return row === -1 ? 0 : row;
  }

  private getDisplayRowCount(): number {
    return this.diffRenderMode === "unified"
      ? this.lines.length
      : this.buildSplitDiffRows().length;
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
            "Move to a diff line and press c to add a comment.",
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
              ? "Press c to add a range comment."
              : "Press c to add one. Use J/K to extend a range.",
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
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("diff", {
    description: "Review a git diff in a custom TUI (/diff [git diff args])",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const source = parseDiffSource(args);
      let diffText: string;
      try {
        diffText = getDiff(ctx.cwd, source);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Unable to read ${source.label}: ${message}`, "error");
        return;
      }

      if (!diffText.trim()) {
        ctx.ui.notify(`No changes to review for ${source.label}.`, "info");
        return;
      }

      const reviewLines = parseDiff(diffText);
      const result = await ctx.ui.custom<ReviewResult>(
        (tui, theme, _keybindings, done) => {
          const comments = new Map<string, ReviewComment>();
          return new ReviewComponent(
            tui,
            theme,
            source.label,
            reviewLines,
            comments,
            done,
          );
        },
      );

      if (!result || result.action !== "submit") return;
      if (result.comments.length === 0) {
        ctx.ui.notify("No review comments to send.", "info");
        return;
      }

      pi.sendUserMessage(
        buildReviewPrompt(result.comments, source.promptLabel),
      );
    },
  });
}
