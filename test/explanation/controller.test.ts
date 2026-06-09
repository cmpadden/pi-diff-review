import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ExplanationController,
  getCurrentHunkScope,
} from "../../src/explanation/controller.ts";
import type {
  DiffExplainer,
  ExplanationScope,
} from "../../src/explanation/explainer.ts";
import type { ReviewLine } from "../../src/review/types.ts";

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

describe("ExplanationController", () => {
  const scope: ExplanationScope = {
    key: "hunk:src/app.ts:@@ -1 +1 @@:0:1",
    kind: "hunk",
    title: "src/app.ts @@ -1 +1 @@",
    filePath: "src/app.ts",
    diffText: "-old\n+new",
  };

  it("restores ready explanations from cache", () => {
    const controller = new ExplanationController(
      { requestRender: () => undefined },
      undefined,
      new Map([[scope.key, "cached explanation"]]),
    );

    assert.deepEqual(controller.getState(scope), {
      status: "ready",
      text: "cached explanation",
    });
  });

  it("emits ready explanations after generation finishes", async () => {
    let changed: Map<string, string> | undefined;
    const explainer: DiffExplainer = {
      async explain(_scope, _question, options) {
        options?.onDelta?.("partial ");
        return "final explanation";
      },
    };
    const controller = new ExplanationController(
      { requestRender: () => undefined },
      explainer,
      new Map(),
      (explanations) => {
        changed = explanations;
      },
    );

    controller.ensure(scope);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(controller.getState(scope), {
      status: "ready",
      text: "final explanation",
    });
    assert.equal(changed?.get(scope.key), "final explanation");
    controller.dispose();
  });
});
