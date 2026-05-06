import { execFileSync } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import {
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
  oldLineNumber?: number;
  newLineNumber?: number;
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
    if (line.oldLineNumber === line.newLineNumber)
      return `${file}:${line.newLineNumber}`;
    return `${file}:old:${line.oldLineNumber}/new:${line.newLineNumber}`;
  }
  if (line.newLineNumber != null) return `${file}:new:${line.newLineNumber}`;
  if (line.oldLineNumber != null) return `${file}:old:${line.oldLineNumber}`;
  return file;
}

function buildReviewPrompt(comments: ReviewComment[]): string {
  const body = comments
    .map((comment) => {
      const location = formatLocation(comment);
      const excerpt = comment.lineText.trim()
        ? `\n  Excerpt: \`${comment.lineText.trim()}\``
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
  private busy = false;

  constructor(
    private tui: {
      requestRender: (full?: boolean) => void;
      terminal?: { rows: number; columns: number };
    },
    private theme: Theme,
    private lines: ReviewLine[],
    private comments: Map<string, ReviewComment>,
    private onComment: (
      line: ReviewLine,
      existing?: ReviewComment,
    ) => Promise<ReviewComment | null | undefined>,
    private done: (result: ReviewResult) => void,
  ) {
    const firstCommentable = this.lines.findIndex((line) => line.commentable);
    this.selected = firstCommentable >= 0 ? firstCommentable : 0;
  }

  handleInput(data: string): void {
    if (this.busy) return;

    if (matchesKey(data, "escape") || data === "q") {
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
      void this.editComment();
      return;
    }
    if (data === "R") {
      const comments = this.lines
        .filter((line) => this.comments.has(line.id))
        .map((line) => this.comments.get(line.id)!)
        .filter(Boolean);
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
          `${this.lines.length} lines • ${this.comments.size} comments • j/k move • c comment • x delete • n/p hunk • R submit • q quit`,
        ),
        width,
      ),
    );
    output.push(this.theme.fg("border", "─".repeat(width)));

    for (let row = 0; row < viewportHeight; row++) {
      const line = this.lines[this.scrollTop + row];
      const left = line
        ? this.renderDiffLine(
            line,
            leftWidth,
            this.scrollTop + row === this.selected,
          )
        : " ".repeat(leftWidth);
      const right = rightPane[row] ?? " ".repeat(rightWidth);
      const combined = `${padToWidth(left, leftWidth)}${this.theme.fg("borderMuted", " │ ")}${padToWidth(right, rightWidth)}`;
      output.push(truncateToWidth(combined, width));
    }

    output.push(this.theme.fg("border", "─".repeat(width)));
    const selectedLocation = selectedLine
      ? formatLocation(selectedLine)
      : "(no selection)";
    output.push(
      truncateToWidth(
        this.theme.fg("muted", `Selected: ${selectedLocation}`),
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
    const line = this.lines[this.selected];
    if (!line?.commentable) return;
    this.comments.delete(line.id);
    this.tui.requestRender();
  }

  private async editComment(): Promise<void> {
    const line = this.lines[this.selected];
    if (!line?.commentable) return;

    this.busy = true;
    try {
      const existing = this.comments.get(line.id);
      const updated = await this.onComment(line, existing);
      if (updated === null) {
        this.comments.delete(line.id);
      } else if (updated) {
        this.comments.set(line.id, updated);
      }
    } finally {
      this.busy = false;
      this.tui.requestRender(true);
    }
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
    width: number,
    selected: boolean,
  ): string {
    const commentMark = this.comments.has(line.id)
      ? this.theme.fg("warning", "●")
      : " ";
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
    return selected
      ? this.theme.bg("selectedBg", padToWidth(styled, width))
      : styled;
  }

  private renderRightPane(
    width: number,
    height: number,
    selectedLine?: ReviewLine,
  ): string[] {
    const lines: string[] = [];
    const title = this.theme.fg("accent", this.theme.bold("Comments"));
    lines.push(truncateToWidth(title, width));
    lines.push(
      truncateToWidth(
        this.theme.fg(
          "dim",
          selectedLine ? formatLocation(selectedLine) : "No selection",
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

    if (!selectedLine.commentable) {
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

    const currentComment = this.comments.get(selectedLine.id);
    if (currentComment) {
      lines.push(
        ...wrapTextWithAnsi(this.theme.fg("text", currentComment.text), width),
      );
      lines.push("");
      lines.push(
        ...wrapTextWithAnsi(
          this.theme.fg("dim", "x deletes this comment"),
          width,
        ),
      );
    } else {
      lines.push(
        ...wrapTextWithAnsi(
          this.theme.fg("muted", "No comment on this line."),
          width,
        ),
      );
      lines.push("");
      lines.push(
        ...wrapTextWithAnsi(this.theme.fg("dim", "Press c to add one."), width),
      );
    }

    lines.push("");
    lines.push(
      truncateToWidth(
        this.theme.fg("accent", this.theme.bold("Excerpt")),
        width,
      ),
    );
    lines.push(
      ...wrapTextWithAnsi(
        this.theme.fg("toolDiffContext", selectedLine.text || "(blank line)"),
        width,
      ),
    );
    return lines.slice(0, height);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("review", {
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
          return new ReviewComponent(
            tui,
            theme,
            reviewLines,
            comments,
            async (line, existing) => {
              const location = formatLocation(line);
              const value = await ctx.ui.editor(
                `Comment: ${location}`,
                existing?.text ?? "",
              );
              if (value == null) return undefined;
              const trimmed = value.trim();
              if (!trimmed) return null;
              return {
                id: line.id,
                filePath: line.filePath ?? "(unknown file)",
                text: trimmed,
                oldLineNumber: line.oldLineNumber,
                newLineNumber: line.newLineNumber,
                lineText: line.text,
              };
            },
            done,
          );
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
