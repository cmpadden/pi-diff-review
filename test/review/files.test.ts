import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReviewFileIndex } from "../../src/review/files.ts";
import type { ReviewLine } from "../../src/review/types.ts";

describe("buildReviewFileIndex", () => {
  it("groups lines into file sections and tracks counts", () => {
    const lines: ReviewLine[] = [
      {
        id: "0",
        kind: "meta",
        text: "diff --git",
        filePath: "a.ts",
        commentable: false,
      },
      {
        id: "1",
        kind: "hunk",
        text: "@@",
        filePath: "a.ts",
        commentable: false,
        hunkLabel: "@@",
      },
      {
        id: "2",
        kind: "remove",
        text: "-old",
        filePath: "a.ts",
        oldLineNumber: 1,
        commentable: true,
        hunkLabel: "@@",
      },
      {
        id: "3",
        kind: "add",
        text: "+new",
        filePath: "a.ts",
        newLineNumber: 1,
        commentable: true,
        hunkLabel: "@@",
      },
      {
        id: "4",
        kind: "meta",
        text: "diff --git",
        filePath: "b.ts",
        commentable: false,
      },
      {
        id: "5",
        kind: "context",
        text: " same",
        filePath: "b.ts",
        oldLineNumber: 1,
        newLineNumber: 1,
        commentable: true,
        hunkLabel: "@@",
      },
    ];

    const index = buildReviewFileIndex(lines);

    assert.equal(index.sections.length, 2);
    assert.deepEqual(index.sections[0], {
      filePath: "a.ts",
      startLineIndex: 0,
      endLineIndex: 3,
      firstCommentableLineIndex: 2,
      additions: 1,
      deletions: 1,
      hunks: 1,
    });
    assert.deepEqual(index.sections[1], {
      filePath: "b.ts",
      startLineIndex: 4,
      endLineIndex: 5,
      firstCommentableLineIndex: 5,
      additions: 0,
      deletions: 0,
      hunks: 0,
    });
    assert.deepEqual(index.sectionIndexByLine, [0, 0, 0, 0, 1, 1]);
  });
});
