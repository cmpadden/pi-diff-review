import { execFileSync } from "node:child_process";
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

function getUnstagedDiff(cwd: string): string {
  return execFileSync("git", ["diff", "--no-color", "--unified=3"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseDiff(diffText: string): ReviewLine[] {
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

function buildReviewPrompt(comments: ReviewComment[]): string {
  const body = comments
    .map((comment) => {
      const location = formatCommentLocation(comment);
      const excerpt = comment.lineText.trim()
        ? `\n  Excerpt:\n\n\`\`\`diff\n${comment.lineText}\n\`\`\``
        : "";
      return `- \`${location}\` — ${comment.text}${excerpt}`;
    })
    .join("\n");

  return `Address this local code review feedback for the current unstaged git diff.\n\n## Review comments\n${body}\n\nPlease apply the feedback and summarize what changed.`;
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
  private editor: Editor;

  constructor(
    private tui: {
      requestRender: (full?: boolean) => void;
      terminal?: { rows: number; columns: number };
    },
    private theme: Theme,
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
        this.comments.set(key, this.buildCommentFromSelection(selection, trimmed));
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
    const terminalRows = this.tui.terminal?.rows ?? 24;
    const headerHeight = 3;
    const footerHeight = 2;
    const viewportHeight = Math.max(
      6,
      terminalRows - headerHeight - footerHeight,
    );
    this.ensureScroll(viewportHeight);

    const rightWidth = Math.max(28, Math.floor(width * 0.34));
    const separatorWidth = 3;
    const leftWidth = Math.max(30, width - rightWidth - separatorWidth);

    const selectedLine = this.lines[this.selected];
    const rightPane = this.renderRightPane(
      rightWidth,
      viewportHeight,
      selectedLine,
    );
    const output: string[] = [];

    output.push(
      truncateToWidth(
        this.theme.fg(
          "accent",
          this.theme.bold("Local Review: unstaged git diff"),
        ),
        width,
      ),
    );
    output.push(
      truncateToWidth(
        this.theme.fg(
          "dim",
          this.editMode
            ? `${this.lines.length} lines • ${this.comments.size} comments • editing comment • Enter save • Esc/Ctrl+C cancel`
            : this.hasSelection()
              ? `${this.lines.length} lines • ${this.comments.size} comments • J/K extend • Esc clear selection • c comment range • R submit`
              : `${this.lines.length} lines • ${this.comments.size} comments • j/k move • J/K extend • c comment • x delete • n/p hunk • R submit • q quit`,
        ),
        width,
      ),
    );
    output.push(this.theme.fg("border", "─".repeat(width)));

    const selection = this.getSelectionBounds();
    for (let row = 0; row < viewportHeight; row++) {
      const index = this.scrollTop + row;
      const line = this.lines[index];
      const left = line
        ? this.renderDiffLine(
            line,
            index,
            leftWidth,
            index === this.selected,
            selection,
          )
        : " ".repeat(leftWidth);
      const right = rightPane[row] ?? " ".repeat(rightWidth);
      const combined = `${padToWidth(left, leftWidth)}${this.theme.fg("borderMuted", " │ ")}${padToWidth(right, rightWidth)}`;
      output.push(truncateToWidth(combined, width));
    }

    output.push(this.theme.fg("border", "─".repeat(width)));
    output.push(
      truncateToWidth(
        this.theme.fg("muted", this.getFooterText(selectedLine)),
        width,
      ),
    );
    return output;
  }

  invalidate(): void {}

  private move(delta: number): void {
    this.selected = Math.max(
      0,
      Math.min(this.lines.length - 1, this.selected + delta),
    );
    this.tui.requestRender();
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
    return this.selectionAnchor != null && this.selectionAnchor !== this.selected;
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
    return this.comments.get(this.getSelectionKey(selection.start, selection.end));
  }

  private getCommentKeysForLine(index: number): string[] {
    const line = this.lines[index];
    if (!line) return [];
    return [...this.comments.entries()]
      .filter(([, comment]) => {
        const start = this.lines.findIndex((item) => item.id === comment.startLineId);
        const end = this.lines.findIndex((item) => item.id === comment.endLineId);
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
    this.editingCommentKey = this.getSelectionKey(selection.start, selection.end);
    this.editor.setText(existing?.text ?? "");
    this.tui.requestRender(true);
  }

  private exitEditMode(): void {
    this.editMode = false;
    this.editingCommentKey = undefined;
    this.editor.setText("");
    this.tui.requestRender(true);
  }

  private ensureScroll(viewportHeight: number): void {
    if (this.selected < this.scrollTop) {
      this.scrollTop = this.selected;
    }
    if (this.selected >= this.scrollTop + viewportHeight) {
      this.scrollTop = this.selected - viewportHeight + 1;
    }
    this.scrollTop = Math.max(
      0,
      Math.min(this.scrollTop, Math.max(0, this.lines.length - viewportHeight)),
    );
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
    const raw = `${commentMark} ${numbers} ${line.text}`;

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
    description: "Review the current unstaged git diff in a custom TUI",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      let diffText: string;
      try {
        diffText = getUnstagedDiff(ctx.cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Unable to read git diff: ${message}`, "error");
        return;
      }

      if (!diffText.trim()) {
        ctx.ui.notify("No unstaged git diff to review.", "info");
        return;
      }

      const reviewLines = parseDiff(diffText);
      const result = await ctx.ui.custom<ReviewResult>(
        (tui, theme, _keybindings, done) => {
          const comments = new Map<string, ReviewComment>();
          return new ReviewComponent(tui, theme, reviewLines, comments, done);
        },
      );

      if (!result || result.action !== "submit") return;
      if (result.comments.length === 0) {
        ctx.ui.notify("No review comments to send.", "info");
        return;
      }

      pi.sendUserMessage(buildReviewPrompt(result.comments));
    },
  });
}
