import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getDiff, parseDiffSource } from "../src/diff-source.ts";

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

describe("getDiff", () => {
  it("returns git diff output", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-diff-review-"));
    try {
      execFileSync("git", ["init"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd,
      });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd });
      writeFileSync(join(cwd, "example.txt"), "before\n");
      execFileSync("git", ["add", "example.txt"], { cwd });
      execFileSync("git", ["commit", "-m", "initial"], {
        cwd,
        stdio: "ignore",
      });
      writeFileSync(join(cwd, "example.txt"), "after\n");

      const diff = getDiff(cwd, parseDiffSource(""));

      assert.match(diff, /diff --git a\/example\.txt b\/example\.txt/);
      assert.match(diff, /-before/);
      assert.match(diff, /\+after/);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("throws a friendly git error", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-diff-review-"));
    try {
      assert.throws(
        () => getDiff(cwd, parseDiffSource("")),
        /not a git repository/i,
      );
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});
