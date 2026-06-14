import type { ReviewLine } from "./types.ts";

export type ReviewFileSection = {
  filePath: string;
  startLineIndex: number;
  endLineIndex: number;
  firstCommentableLineIndex: number;
  additions: number;
  deletions: number;
  hunks: number;
};

export type ReviewFileIndex = {
  sections: ReviewFileSection[];
  sectionIndexByLine: number[];
};

export function buildReviewFileIndex(lines: ReviewLine[]): ReviewFileIndex {
  const sections: ReviewFileSection[] = [];
  const sectionIndexByLine: number[] = Array.from(
    { length: lines.length },
    () => -1,
  );

  let current: ReviewFileSection | undefined;
  let currentIndex = -1;

  const ensureSection = (filePath: string, lineIndex: number) => {
    if (current?.filePath === filePath) return current;
    currentIndex = sections.length;
    current = {
      filePath,
      startLineIndex: lineIndex,
      endLineIndex: lineIndex,
      firstCommentableLineIndex: lineIndex,
      additions: 0,
      deletions: 0,
      hunks: 0,
    };
    sections.push(current);
    return current;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    if (!line.filePath) continue;
    const section = ensureSection(line.filePath, lineIndex);
    section.endLineIndex = lineIndex;
    sectionIndexByLine[lineIndex] = currentIndex;
    if (
      line.commentable &&
      section.firstCommentableLineIndex === section.startLineIndex
    ) {
      section.firstCommentableLineIndex = lineIndex;
    }
    if (line.kind === "add") section.additions++;
    if (line.kind === "remove") section.deletions++;
    if (line.kind === "hunk") section.hunks++;
  }

  for (const section of sections) {
    if (!lines[section.firstCommentableLineIndex]?.commentable) {
      const fallback = lines.findIndex(
        (line, index) =>
          index >= section.startLineIndex &&
          index <= section.endLineIndex &&
          line?.filePath === section.filePath &&
          line.commentable,
      );
      section.firstCommentableLineIndex =
        fallback >= 0 ? fallback : section.startLineIndex;
    }
  }

  return { sections, sectionIndexByLine };
}
