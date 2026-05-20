import type { ReviewComment } from "./types.ts";

export function formatLocation(line: {
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

export function formatCommentLocation(comment: ReviewComment): string {
  if (comment.global) return "Overall diff";

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

export function buildReviewPrompt(
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
