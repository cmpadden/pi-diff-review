import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseViewSource, resolveViewFiles } from "../../src/view/source.ts";

describe("parseViewSource", () => {
  it("requires at least one path", () => {
    assert.throws(
      () => parseViewSource(""),
      /Provide one or more files or folders/,
    );
  });

  it("tokenizes quoted paths", () => {
    assert.deepEqual(parseViewSource("src 'file name.ts'").paths, [
      "src",
      "file name.ts",
    ]);
  });

  it("strips pi @ path prefixes", () => {
    assert.deepEqual(parseViewSource("@src @'file name.ts'").paths, [
      "src",
      "file name.ts",
    ]);
  });
});

describe("resolveViewFiles", () => {
  it("expands folders and skips binary files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-diff-review-view-"));
    try {
      execFileSync("git", ["init"], { cwd, stdio: "ignore" });
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\n");
      writeFileSync(join(cwd, "src", "image.png"), Buffer.from([0, 1, 2]));
      writeFileSync(join(cwd, "notes.md"), "hello\n");

      const files = resolveViewFiles(cwd, parseViewSource("src notes.md"));

      assert.deepEqual(
        files.map((file) => file.replace(`${cwd}/`, "")),
        ["notes.md", "src/a.ts"],
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
