import { readFileSync } from "node:fs";
import type { ReviewLine } from "../review/types.ts";
import { getRelativeWorkspacePath } from "../review/workspace-comments.ts";

export function parseViewFiles(
  workspaceRoot: string,
  absolutePaths: string[],
): ReviewLine[] {
  const lines: ReviewLine[] = [];
  let lineIndex = 0;

  for (const absolutePath of absolutePaths) {
    const filePath = getRelativeWorkspacePath(workspaceRoot, absolutePath);
    lines.push({
      id: `line-${lineIndex++}`,
      kind: "meta",
      text: `# ${filePath}`,
      filePath,
      commentable: false,
    });

    const content = readFileSync(absolutePath, "utf8").replace(/\r\n/g, "\n");
    const fileLines = content.split("\n");
    const hasTrailingNewline = content.endsWith("\n");
    const visibleLines = hasTrailingNewline
      ? fileLines.slice(0, -1)
      : fileLines;

    if (visibleLines.length === 0) {
      lines.push({
        id: `line-${lineIndex++}`,
        kind: "context",
        text: " ",
        filePath,
        newLineNumber: 1,
        commentable: true,
      });
      continue;
    }

    visibleLines.forEach((text, index) => {
      lines.push({
        id: `line-${lineIndex++}`,
        kind: "context",
        text: ` ${text}`,
        filePath,
        newLineNumber: index + 1,
        commentable: true,
      });
    });
  }

  return lines;
}
