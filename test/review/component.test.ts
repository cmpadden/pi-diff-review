import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReviewComponent } from "../../src/review/component.ts";
import type { ReviewLine, ReviewTheme, ReviewTui } from "../../src/review/types.ts";

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

function createComponent(lines: ReviewLine[]): ReviewComponent {
  const tui: ReviewTui = {
    requestRender: () => undefined,
    terminal: { rows: 24, columns: 100 },
  };
  const theme: ReviewTheme = {
    fg: (_token, text) => text,
    bg: (_token, text) => text,
  } as ReviewTheme;

  return new ReviewComponent(
    tui,
    theme,
    "test diff",
    lines,
    new Map(),
    () => undefined,
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
});
