import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDiff } from "../../src/diff/parser.ts";
import {
  applyReviewedOverlay,
  markChangedLinesReviewed,
} from "../../src/diff/turn-based-overlay.ts";

describe("turn-based overlay", () => {
  it("marks changed lines that are present in the reviewed baseline", () => {
    const target = parseDiff(`diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,4 +1,4 @@
 keep
-before
+after
+new turn
 done
`);
    const reviewed = parseDiff(`diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,3 @@
 keep
-before
+after
 done
`);

    assert.equal(applyReviewedOverlay(target, reviewed), 2);
    assert.equal(
      target.find((line) => line.text === "-before")?.reviewedOverlay,
      true,
    );
    assert.equal(
      target.find((line) => line.text === "+after")?.reviewedOverlay,
      true,
    );
    assert.equal(
      target.find((line) => line.text === "+new turn")?.reviewedOverlay,
      undefined,
    );
  });

  it("marks the current diff changed lines as reviewed", () => {
    const lines = parseDiff(`diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,3 @@
 keep
-before
+after
 done
`);

    assert.equal(markChangedLinesReviewed(lines), 2);
    assert.equal(
      lines.find((line) => line.text === "-before")?.reviewedOverlay,
      true,
    );
    assert.equal(
      lines.find((line) => line.text === "+after")?.reviewedOverlay,
      true,
    );
    assert.equal(
      lines.find((line) => line.text === " keep")?.reviewedOverlay,
      undefined,
    );
  });
});
