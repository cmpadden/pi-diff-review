import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCurrentHunkScope } from "../src/explanation-controller.ts";
import type { ReviewLine } from "../src/types.ts";

function line(
  id: string,
  text: string,
  hunkLabel?: string,
  filePath = "src/app.ts",
): ReviewLine {
  return {
    id,
    kind: text.startsWith("+")
      ? "add"
      : text.startsWith("-")
        ? "remove"
        : "context",
    text,
    filePath,
    hunkLabel,
    commentable: true,
  };
}

describe("getCurrentHunkScope", () => {
  it("returns the selected contiguous hunk scope", () => {
    const lines = [
      line("a", " before", "@@ -1 +1 @@"),
      line("b", "-old", "@@ -2 +2 @@"),
      line("c", "+new", "@@ -2 +2 @@"),
      line("d", " after", "@@ -3 +3 @@"),
    ];

    const scope = getCurrentHunkScope(lines, 1);

    assert.equal(scope?.key, "hunk:src/app.ts:@@ -2 +2 @@:1:2");
    assert.equal(scope?.title, "src/app.ts @@ -2 +2 @@");
    assert.equal(scope?.diffText, "-old\n+new");
  });

  it("returns undefined for lines without file or hunk metadata", () => {
    assert.equal(
      getCurrentHunkScope(
        [{ id: "meta", kind: "meta", text: "diff --git", commentable: false }],
        0,
      ),
      undefined,
    );
  });
});
