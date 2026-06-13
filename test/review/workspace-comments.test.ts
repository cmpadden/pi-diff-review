import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ReviewComment, ReviewLine } from "../../src/review/types.ts";
import { WorkspaceCommentStore } from "../../src/review/workspace-comments.ts";

function buildLines(filePath: string, texts: string[]): ReviewLine[] {
  return texts.map((text, index) => ({
    id: `line-${index}`,
    kind: "context" as const,
    text: ` ${text}`,
    filePath,
    newLineNumber: index + 1,
    commentable: true,
  }));
}

function buildComment(
  lines: ReviewLine[],
  lineNumber: number,
  text: string,
): ReviewComment {
  const line = lines[lineNumber - 1]!;
  return {
    id: `${line.id}:${line.id}`,
    filePath: line.filePath!,
    text,
    startLineId: line.id,
    endLineId: line.id,
    startNewLineNumber: lineNumber,
    endNewLineNumber: lineNumber,
    lineText: line.text,
  };
}

describe("WorkspaceCommentStore", () => {
  it("persists file comments and marks them stale after the file changes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-diff-review-store-"));
    try {
      execFileSync("git", ["init"], { cwd, stdio: "ignore" });
      mkdirSync(join(cwd, "src"), { recursive: true });
      const filePath = join(cwd, "src", "example.ts");
      writeFileSync(filePath, "one\ntwo\nthree\n", "utf8");

      const store = new WorkspaceCommentStore(cwd);
      const lines = buildLines("src/example.ts", ["one", "two", "three"]);
      store.syncFromComments(lines, [buildComment(lines, 2, "check this")]);

      let summary = store.summarize(lines);
      assert.equal(summary.visible, 1);
      assert.equal(summary.stale, 0);

      writeFileSync(filePath, "zero\none\ntwo\nthree\n", "utf8");
      const movedLines = buildLines("src/example.ts", [
        "zero",
        "one",
        "two",
        "three",
      ]);
      summary = store.summarize(movedLines);
      assert.equal(summary.visible, 1);
      assert.equal(summary.stale, 1);

      const visible = [...store.getVisibleComments(movedLines).values()];
      assert.equal(visible[0]?.startNewLineNumber, 3);
      assert.equal(visible[0]?.text, "check this");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
