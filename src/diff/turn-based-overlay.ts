import type { ReviewLine, ReviewSnapshotLine } from "../review/types.ts";

export function applyReviewedOverlay(
  targetLines: ReviewLine[],
  reviewedLines: ReviewSnapshotLine[],
): number {
  const reviewedKeys = new Set(
    reviewedLines.flatMap((line) => getChangedLineKeys(line)),
  );
  let marked = 0;

  for (const line of targetLines) {
    if (getChangedLineKeys(line).some((key) => reviewedKeys.has(key))) {
      line.reviewedOverlay = true;
      marked++;
    }
  }

  return marked;
}

export function markChangedLinesReviewed(lines: ReviewLine[]): number {
  let marked = 0;

  for (const line of lines) {
    if (getChangedLineKeys(line).length === 0) continue;
    if (!line.reviewedOverlay) marked++;
    line.reviewedOverlay = true;
  }

  return marked;
}

export function clearReviewedOverlay(lines: ReviewLine[]): number {
  let cleared = 0;

  for (const line of lines) {
    if (!line.reviewedOverlay) continue;
    line.reviewedOverlay = false;
    cleared++;
  }

  return cleared;
}

export function areAllChangedLinesReviewed(lines: ReviewLine[]): boolean {
  const changedLines = lines.filter(
    (line) => getChangedLineKeys(line).length > 0,
  );
  return (
    changedLines.length > 0 &&
    changedLines.every((line) => line.reviewedOverlay)
  );
}

export function getReviewedLines(lines: ReviewLine[]): ReviewLine[] {
  return lines.filter(
    (line) => line.reviewedOverlay && getChangedLineKeys(line).length > 0,
  );
}

function getChangedLineKeys(line: ReviewLine | ReviewSnapshotLine): string[] {
  if (!line.filePath) return [];
  if (line.kind === "add" && line.newLineNumber != null) {
    return [
      [
        line.filePath,
        line.kind,
        String(line.newLineNumber),
        getComparableText(line),
      ].join("\0"),
    ];
  }

  if (line.kind === "remove" && line.oldLineNumber != null) {
    return [
      [
        line.filePath,
        line.kind,
        String(line.oldLineNumber),
        getComparableText(line),
      ].join("\0"),
    ];
  }

  return [];
}

function getComparableText(line: ReviewLine | ReviewSnapshotLine): string {
  return line.kind === "add" || line.kind === "remove"
    ? line.text.slice(1)
    : line.text;
}
