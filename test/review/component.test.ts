import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReviewComponent } from "../../src/review/component.ts";
import type { DiffExplainer } from "../../src/explanation/explainer.ts";
import type {
  PersistedAsk,
  ReviewLine,
  ReviewTheme,
  ReviewTui,
} from "../../src/review/types.ts";

function buildLines(count: number): ReviewLine[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `line-${index}`,
    kind: "context",
    text: ` line ${index}`,
    filePath: "src/example.ts",
    oldLineNumber: index + 1,
    newLineNumber: index + 1,
    commentable: true,
    hunkLabel: "@@ -1,40 +1,40 @@",
  }));
}

function buildMultiFileLines(): ReviewLine[] {
  return [
    {
      id: "a-meta",
      kind: "meta",
      text: "diff --git a/a.ts b/a.ts",
      filePath: "src/a.ts",
      commentable: false,
    },
    {
      id: "a-hunk",
      kind: "hunk",
      text: "@@ -1 +1 @@",
      filePath: "src/a.ts",
      commentable: false,
      hunkLabel: "@@ -1 +1 @@",
    },
    {
      id: "a-line",
      kind: "context",
      text: " alpha",
      filePath: "src/a.ts",
      oldLineNumber: 1,
      newLineNumber: 1,
      commentable: true,
      hunkLabel: "@@ -1 +1 @@",
    },
    {
      id: "b-meta",
      kind: "meta",
      text: "diff --git a/b.ts b/b.ts",
      filePath: "src/b.ts",
      commentable: false,
    },
    {
      id: "b-hunk",
      kind: "hunk",
      text: "@@ -1 +1 @@",
      filePath: "src/b.ts",
      commentable: false,
      hunkLabel: "@@ -1 +1 @@",
    },
    {
      id: "b-line",
      kind: "context",
      text: " beta",
      filePath: "src/b.ts",
      oldLineNumber: 1,
      newLineNumber: 1,
      commentable: true,
      hunkLabel: "@@ -1 +1 @@",
    },
  ];
}

function createComponent(
  lines: ReviewLine[],
  options: {
    explainer?: DiffExplainer;
    cachedAsk?: PersistedAsk;
    onAskChanged?: (ask?: PersistedAsk) => void;
    done?: (
      result: { action: "submit"; comments: any[] } | { action: "cancel" },
    ) => void;
    theme?: ReviewTheme;
  } = {},
): ReviewComponent {
  const tui: ReviewTui = {
    requestRender: () => undefined,
    terminal: { rows: 24, columns: 100 },
  };
  const theme: ReviewTheme =
    options.theme ??
    ({
      fg: (_token, text) => text,
      bg: (_token, text) => text,
    } as ReviewTheme);

  return new ReviewComponent(
    tui,
    theme,
    "test diff",
    lines,
    new Map(),
    options.done ?? (() => undefined),
    options.explainer,
    undefined,
    undefined,
    undefined,
    options.cachedAsk,
    options.onAskChanged,
    undefined,
  );
}

describe("ReviewComponent", () => {
  it("supports PgUp and PgDown in the diff view", () => {
    const component = createComponent(buildLines(40));

    (component as any).selected = 10;
    component.handleInput("\x1b[5~");
    assert.equal((component as any).selected, 1);

    component.handleInput("\x1b[6~");
    assert.equal((component as any).selected, 10);
  });

  it("renders the ask editor inline at the selected line", () => {
    const component = createComponent(buildLines(6));

    (component as any).selected = 1;
    component.handleInput("a");
    const output = component.render(100);

    const selectedLineRow = output.findIndex((line) =>
      line.includes(" line 1"),
    );
    const nextLineRow = output.findIndex((line) => line.includes(" line 2"));
    const askRow = output.findIndex((line) =>
      line.includes("Ask about this hunk"),
    );

    assert.ok(selectedLineRow >= 0);
    assert.ok(askRow > selectedLineRow);
    assert.ok(askRow < nextLineRow);
  });

  it("renders the explanation pane inline at the selected line", () => {
    const component = createComponent(buildLines(6));

    (component as any).selected = 1;
    component.handleInput("?");
    const output = component.render(100);

    const selectedLineRow = output.findIndex((line) =>
      line.includes(" line 1"),
    );
    const nextLineRow = output.findIndex((line) => line.includes(" line 2"));
    const explanationRow = output.findIndex((line) =>
      line.includes("✨ Explanation"),
    );

    assert.ok(selectedLineRow >= 0);
    assert.ok(explanationRow > selectedLineRow);
    assert.ok(explanationRow < nextLineRow);
  });

  it("keeps ask answers pinned to the original line", async () => {
    const component = createComponent(buildLines(6), {
      explainer: { explain: async () => "answer" },
    });

    (component as any).selected = 1;
    component.handleInput("a");
    (component as any).editor.onSubmit?.("why?");
    await new Promise((resolve) => setTimeout(resolve, 0));

    (component as any).selected = 2;
    const output = component.render(100);

    const originalLineRow = output.findIndex((line) =>
      line.includes(" line 1"),
    );
    const movedToLineRow = output.findIndex((line) => line.includes(" line 2"));
    const answerRow = output.findIndex((line) => line.includes("💬 Answer"));

    assert.ok(answerRow > originalLineRow);
    assert.ok(answerRow < movedToLineRow);
  });

  it("keeps explanations pinned to the original line", () => {
    const component = createComponent(buildLines(6));

    (component as any).selected = 1;
    component.handleInput("?");
    (component as any).selected = 2;
    const output = component.render(100);

    const originalLineRow = output.findIndex((line) =>
      line.includes(" line 1"),
    );
    const movedToLineRow = output.findIndex((line) => line.includes(" line 2"));
    const explanationRow = output.findIndex((line) =>
      line.includes("✨ Explanation"),
    );

    assert.ok(explanationRow > originalLineRow);
    assert.ok(explanationRow < movedToLineRow);
  });

  it("restores a cached ask answer inline", () => {
    const component = createComponent(buildLines(6), {
      cachedAsk: {
        scopeKey: "hunk:src/example.ts:@@ -1,40 +1,40 @@:0:5",
        anchorLineId: "line-1",
        text: "cached answer",
      },
    });

    const output = component.render(100);
    const lineRow = output.findIndex((line) => line.includes(" line 1"));
    const answerRow = output.findIndex((line) => line.includes("💬 Answer"));

    assert.ok(answerRow > lineRow);
  });

  it("persists ask answers when they complete", async () => {
    let persistedAsk: PersistedAsk | undefined;
    const component = createComponent(buildLines(6), {
      explainer: { explain: async () => "answer" },
      onAskChanged: (ask) => {
        persistedAsk = ask;
      },
    });

    (component as any).selected = 1;
    component.handleInput("a");
    (component as any).editor.onSubmit?.("why?");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(persistedAsk, {
      scopeKey: "hunk:src/example.ts:@@ -1,40 +1,40 @@:0:5",
      anchorLineId: "line-1",
      text: "answer",
    });
  });

  it("highlights the active search match within the line", () => {
    const theme: ReviewTheme = {
      fg: (token, text) => `<fg:${token}>${text}</fg:${token}>`,
      bg: (token, text) => `<bg:${token}>${text}</bg:${token}>`,
    } as ReviewTheme;

    const highlightedComponent = new ReviewComponent(
      { requestRender: () => undefined, terminal: { rows: 24, columns: 200 } },
      theme,
      "test diff",
      [
        {
          id: "match-line",
          kind: "context",
          text: " needle here needle",
          filePath: "src/example.ts",
          oldLineNumber: 1,
          newLineNumber: 1,
          commentable: true,
        },
      ],
      new Map(),
      () => undefined,
    );

    highlightedComponent.handleInput("t");
    (highlightedComponent as any).search.query = "needle";
    (highlightedComponent as any).search.jump(1, 0);
    const output = highlightedComponent.render(200).join("\n");

    assert.match(output, /<fg:warning>needle/);
    assert.match(output, /<fg:accent>needle/);
  });

  it("focuses the current file and hides other files", () => {
    const component = createComponent(buildMultiFileLines());

    (component as any).selected = 2;
    component.handleInput("f");
    component.handleInput("t");
    const output = component.render(100).join("\n");

    assert.match(output, /src\/a\.ts/);
    assert.doesNotMatch(output, /src\/b\.ts/);
    assert.match(output, /\[focused\]/);
  });

  it("jumps between files with bracket keys", () => {
    const component = createComponent(buildMultiFileLines());

    (component as any).selected = 2;
    component.handleInput("]");
    assert.equal((component as any).selected, 5);

    component.handleInput("[");
    assert.equal((component as any).selected, 2);
  });

  it("renders a toggleable file sidebar with the current file highlighted", () => {
    const component = createComponent(buildMultiFileLines(), {
      theme: {
        fg: (_token, text) => text,
        bg: (token, text) => `<bg:${token}>${text}</bg:${token}>`,
      } as ReviewTheme,
    });

    (component as any).selected = 2;
    let output = component.render(100).join("\n");
    assert.match(output, /src\/a\.ts/);
    assert.match(output, /src\/b\.ts/);
    assert.doesNotMatch(output, /Files/);
    assert.match(output, /<bg:selectedBg> src\/a\.ts  \+0 -0/);

    component.handleInput("]");
    output = component.render(100).join("\n");
    assert.match(output, /<bg:selectedBg>.*src\/b\.ts.*<\/bg:selectedBg>/);
  });

  it("q clears an active selection before exiting", () => {
    let result:
      | { action: "submit"; comments: any[] }
      | { action: "cancel" }
      | undefined;
    const component = createComponent(buildLines(6), {
      done: (next) => {
        result = next;
      },
    });

    (component as any).selected = 1;
    component.handleInput("J");
    assert.equal((component as any).hasSelection(), true);

    component.handleInput("q");
    assert.equal((component as any).hasSelection(), false);
    assert.equal(result, undefined);

    component.handleInput("q");
    assert.deepEqual(result, { action: "cancel" });
  });
});
