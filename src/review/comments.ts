import type { ReviewComment, ReviewLine, SelectionBounds } from "./types.ts";

export const GLOBAL_COMMENT_KEY = "__global_diff_comment__";

export function getSelectionKey(
  lines: ReviewLine[],
  start: number,
  end: number,
): string {
  return `${lines[start]?.id ?? start}:${lines[end]?.id ?? end}`;
}

export function buildGlobalComment(text: string): ReviewComment {
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

export function buildCommentFromSelection(
  lines: ReviewLine[],
  selection: SelectionBounds,
  text: string,
): ReviewComment {
  const startLine = lines[selection.start]!;
  const endLine = lines[selection.end]!;
  const excerpt = lines
    .slice(selection.start, selection.end + 1)
    .map((line) => line.text)
    .join("\n");
  return {
    id: getSelectionKey(lines, selection.start, selection.end),
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

export function buildCommentLineKeys(
  comments: Map<string, ReviewComment>,
  lineIndexById: Map<string, number>,
): Map<number, string[]> {
  const commentLineKeys = new Map<number, string[]>();

  for (const [key, comment] of comments) {
    const start = lineIndexById.get(comment.startLineId);
    const end = lineIndexById.get(comment.endLineId);
    if (start == null || end == null) continue;
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    for (let index = from; index <= to; index++) {
      const keys = commentLineKeys.get(index);
      if (keys) {
        keys.push(key);
      } else {
        commentLineKeys.set(index, [key]);
      }
    }
  }

  return commentLineKeys;
}
