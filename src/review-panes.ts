import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Editor } from "@earendil-works/pi-tui";
import type { ExplanationController } from "./explanation-controller.ts";
import { GLOBAL_COMMENT_KEY } from "./comment-manager.ts";
import { formatLocation } from "./prompt.ts";
import type { ExplanationScope } from "./explain.ts";
import type {
  ReviewComment,
  ReviewLine,
  ReviewTheme,
  SelectionBounds,
} from "./types.ts";

export type RenderCommentsPaneOptions = {
  width: number;
  height: number;
  selectedLine?: ReviewLine;
  theme: ReviewTheme;
  lines: ReviewLine[];
  comments: Map<string, ReviewComment>;
  editor: Editor;
  editMode: boolean;
  editingCommentKey?: string;
  selection: SelectionBounds | undefined;
  currentComment: ReviewComment | undefined;
  footerText: string;
  hasSelection: boolean;
};

export function renderCommentsPane({
  width,
  height,
  selectedLine,
  theme,
  lines: diffLines,
  comments,
  editor,
  editMode,
  editingCommentKey,
  selection,
  currentComment,
  footerText,
  hasSelection,
}: RenderCommentsPaneOptions): string[] {
  const lines: string[] = [];
  const title = theme.fg("accent", theme.bold("Comments"));

  lines.push(truncateToWidth(title, width));
  lines.push(
    truncateToWidth(
      theme.fg(
        "dim",
        selection
          ? footerText
          : selectedLine
            ? formatLocation(selectedLine)
            : "No selection",
      ),
      width,
    ),
  );
  lines.push("");

  if (editMode && editingCommentKey === GLOBAL_COMMENT_KEY) {
    lines[1] = truncateToWidth(theme.fg("dim", "Overall diff comment"), width);
    lines.push(
      ...wrapTextWithAnsi(
        theme.fg(
          "dim",
          "Editing overall diff comment. Enter saves. Esc or Ctrl+C cancels.",
        ),
        width,
      ),
    );
    lines.push("");
    for (const line of editor.render(Math.max(10, width))) {
      lines.push(truncateToWidth(line, width));
    }
    return lines.slice(0, height);
  }

  const globalComment = comments.get(GLOBAL_COMMENT_KEY);
  if (globalComment) {
    lines.push(
      truncateToWidth(
        theme.fg("accent", theme.bold("Overall diff comment")),
        width,
      ),
    );
    lines.push(
      ...wrapTextWithAnsi(theme.fg("text", globalComment.text), width),
    );
    lines.push(...wrapTextWithAnsi(theme.fg("dim", "C edits"), width));
    lines.push("");
  }

  if (!selectedLine) {
    lines.push(
      ...wrapTextWithAnsi(theme.fg("muted", "No diff lines available."), width),
    );
    return lines.slice(0, height);
  }

  if (!selection) {
    lines.push(
      ...wrapTextWithAnsi(
        theme.fg(
          "muted",
          "Move to a diff line and press c to add a comment, or press C for an overall diff comment.",
        ),
        width,
      ),
    );
    return lines.slice(0, height);
  }

  if (editMode && currentComment?.id === editingCommentKey) {
    lines.push(
      ...wrapTextWithAnsi(
        theme.fg("dim", "Editing comment. Enter saves. Esc or Ctrl+C cancels."),
        width,
      ),
    );
    lines.push("");
    for (const line of editor.render(Math.max(10, width))) {
      lines.push(truncateToWidth(line, width));
    }
  } else if (editMode && editingCommentKey) {
    lines.push(
      ...wrapTextWithAnsi(
        theme.fg("dim", "Editing comment. Enter saves. Esc or Ctrl+C cancels."),
        width,
      ),
    );
    lines.push("");
    for (const line of editor.render(Math.max(10, width))) {
      lines.push(truncateToWidth(line, width));
    }
  } else if (currentComment) {
    lines.push(
      ...wrapTextWithAnsi(theme.fg("text", currentComment.text), width),
    );
    lines.push("");
    lines.push(
      ...wrapTextWithAnsi(
        theme.fg("dim", "x deletes this comment • c edits"),
        width,
      ),
    );
  } else {
    lines.push(
      ...wrapTextWithAnsi(
        theme.fg(
          "muted",
          hasSelection
            ? "No comment on this range."
            : "No comment on this line.",
        ),
        width,
      ),
    );
    lines.push("");
    lines.push(
      ...wrapTextWithAnsi(
        theme.fg(
          "dim",
          hasSelection
            ? "Press c to add a range comment, or C for an overall diff comment."
            : "Press c to add one. Use J/K to extend a range. Press C for an overall diff comment.",
        ),
        width,
      ),
    );
  }

  lines.push("");
  lines.push(truncateToWidth(theme.fg("accent", theme.bold("Excerpt")), width));
  const excerpt = diffLines
    .slice(selection.start, selection.end + 1)
    .map((line) => line.text)
    .join("\n");
  lines.push(
    ...wrapTextWithAnsi(
      theme.fg("toolDiffContext", excerpt || "(blank line)"),
      width,
    ),
  );
  return lines.slice(0, height);
}

export type RenderExplanationPaneOptions = {
  width: number;
  height: number;
  selectedLine?: ReviewLine;
  theme: ReviewTheme;
  scope: ExplanationScope | undefined;
  controller: ExplanationController;
};

export function renderExplanationPane({
  width,
  height,
  selectedLine,
  theme,
  scope,
  controller,
}: RenderExplanationPaneOptions): string[] {
  const lines: string[] = [];
  const title = theme.fg("accent", theme.bold("Explanation"));

  lines.push(truncateToWidth(title, width));
  lines.push(
    truncateToWidth(
      theme.fg(
        "dim",
        scope?.title ??
          (selectedLine ? formatLocation(selectedLine) : "No selection"),
      ),
      width,
    ),
  );
  lines.push("");

  if (!controller.isAvailable) {
    lines.push(
      ...wrapTextWithAnsi(
        theme.fg("warning", "Diff explanations are unavailable."),
        width,
      ),
    );
    return lines.slice(0, height);
  }

  if (!scope) {
    lines.push(
      ...wrapTextWithAnsi(
        theme.fg(
          "muted",
          "Move to a changed hunk and press ? to generate an explanation.",
        ),
        width,
      ),
    );
    return lines.slice(0, height);
  }

  const explanation = controller.getState(scope);
  if (!explanation) {
    lines.push(
      ...wrapTextWithAnsi(
        theme.fg(
          "muted",
          "No explanation generated yet. Press ? again after returning to comments to generate this hunk.",
        ),
        width,
      ),
    );
  } else if (explanation.status === "loading") {
    const spinner = controller.getLoadingFrame();
    lines.push(
      truncateToWidth(
        theme.fg("accent", `${spinner} Generating explanation...`),
        width,
      ),
    );
    if (explanation.text.trim()) {
      lines.push("");
      lines.push(
        ...wrapTextWithAnsi(theme.fg("text", explanation.text), width),
      );
    }
  } else if (explanation.status === "error") {
    lines.push(
      ...wrapTextWithAnsi(
        theme.fg("warning", `Unable to explain diff: ${explanation.message}`),
        width,
      ),
    );
  } else {
    lines.push(...wrapTextWithAnsi(theme.fg("text", explanation.text), width));
  }

  lines.push("");
  lines.push(...wrapTextWithAnsi(theme.fg("dim", "? comments"), width));
  return lines.slice(0, height);
}
