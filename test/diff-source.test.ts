import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDiffSource } from "../src/diff-source.ts";

describe("parseDiffSource", () => {
  it("defaults to the unstaged git diff", () => {
    assert.deepEqual(parseDiffSource(""), {
      label: "unstaged git diff",
      promptLabel: "the current unstaged git diff",
      args: [],
    });
  });

  it("tokenizes git diff args with whitespace and quotes", () => {
    assert.deepEqual(
      parseDiffSource("--cached -- src/'file name.ts' \"other file.ts\""),
      {
        label: "git diff --cached -- src/'file name.ts' \"other file.ts\"",
        promptLabel:
          "`git diff --cached -- src/'file name.ts' \"other file.ts\"`",
        args: ["--cached", "--", "src/file name.ts", "other file.ts"],
      },
    );
  });

  it("supports escaped spaces outside single quotes", () => {
    assert.deepEqual(parseDiffSource("-- path\\ with\\ spaces.ts").args, [
      "--",
      "path with spaces.ts",
    ]);
  });

  it("throws for unterminated quotes", () => {
    assert.throws(
      () => parseDiffSource("-- 'unterminated"),
      /Unterminated ' quote/,
    );
  });
});
