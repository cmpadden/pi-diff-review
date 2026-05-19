import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReviewPrompt, formatLocation } from "../src/prompt.ts";
import type { ReviewComment } from "../src/types.ts";

describe("formatLocation", () => {
  it("formats new, old, and unchanged line locations", () => {
    assert.equal(
      formatLocation({ filePath: "a.ts", newLineNumber: 10 }),
      "a.ts:new:10",
    );
    assert.equal(
      formatLocation({ filePath: "a.ts", oldLineNumber: 9 }),
      "a.ts:old:9",
    );
    assert.equal(
      formatLocation({ filePath: "a.ts", oldLineNumber: 5, newLineNumber: 5 }),
      "a.ts:5",
    );
    assert.equal(
      formatLocation({ filePath: "a.ts", oldLineNumber: 4, newLineNumber: 5 }),
      "a.ts:old:4/new:5",
    );
  });
});

describe("buildReviewPrompt", () => {
  it("builds a review prompt with location, feedback, and diff excerpt", () => {
    const comments: ReviewComment[] = [
      {
        id: "line-1:line-1",
        filePath: "src/example.ts",
        text: "Please cover this branch with a test.",
        startLineId: "line-1",
        endLineId: "line-1",
        startNewLineNumber: 42,
        endNewLineNumber: 42,
        lineText: "+if (enabled) return value;",
      },
    ];

    const prompt = buildReviewPrompt(comments, "`git diff main...HEAD`");

    assert.match(
      prompt,
      /Address this local code review feedback for `git diff main\.\.\.HEAD`\./,
    );
    assert.match(
      prompt,
      /`src\/example\.ts:new:42` — Please cover this branch with a test\./,
    );
    assert.match(prompt, /```diff\n\+if \(enabled\) return value;\n```/);
    assert.match(
      prompt,
      /Please apply the feedback and summarize what changed\./,
    );
  });

  it("formats overall diff comments", () => {
    const prompt = buildReviewPrompt(
      [
        {
          id: "__global_diff_comment__",
          filePath: "Overall diff",
          text: "Please add a changelog note.",
          global: true,
          startLineId: "__global_diff_comment__",
          endLineId: "__global_diff_comment__",
          lineText: "",
        },
      ],
      "the current unstaged git diff",
    );

    assert.match(prompt, /`Overall diff` — Please add a changelog note\./);
  });
});
