import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDiff } from "../../src/diff/parser.ts";

describe("parseDiff", () => {
  it("parses additions, removals, context, file paths, and line numbers", () => {
    const lines = parseDiff(`diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,3 @@
 const keep = true;
-const oldValue = 1;
+const newValue = 2;
 export { keep };
`);

    const hunk = lines.find((line) => line.kind === "hunk");
    const context = lines.find((line) => line.kind === "context");
    const removal = lines.find((line) => line.kind === "remove");
    const addition = lines.find((line) => line.kind === "add");

    assert.equal(hunk?.text, "@@ -1,3 +1,3 @@");
    assert.equal(context?.filePath, "src/example.ts");
    assert.equal(context?.oldLineNumber, 1);
    assert.equal(context?.newLineNumber, 1);
    assert.equal(removal?.oldLineNumber, 2);
    assert.equal(removal?.newLineNumber, undefined);
    assert.equal(addition?.oldLineNumber, undefined);
    assert.equal(addition?.newLineNumber, 2);
    assert.equal(addition?.commentable, true);
  });

  it("marks file metadata as non-commentable", () => {
    const lines = parseDiff(`diff --git a/a.txt b/a.txt
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/a.txt
@@ -0,0 +1 @@
+hello
`);

    const metadata = lines.filter((line) => line.kind === "meta");
    assert.ok(metadata.length > 0);
    assert.ok(metadata.every((line) => !line.commentable));
    assert.equal(lines.find((line) => line.kind === "add")?.filePath, "a.txt");
  });
});
