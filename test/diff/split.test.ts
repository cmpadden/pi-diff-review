import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSplitDiffRows } from "../../src/diff/split.ts";
import type { ReviewLine } from "../../src/review/types.ts";

function line(id: string, kind: ReviewLine["kind"], text = id): ReviewLine {
  return { id, kind, text, commentable: kind !== "meta" && kind !== "hunk" };
}

describe("buildSplitDiffRows", () => {
  it("pairs adjacent removals and additions into split rows", () => {
    const lines = [
      line("h", "hunk"),
      line("r1", "remove"),
      line("r2", "remove"),
      line("a1", "add"),
      line("c", "context"),
    ];

    const { rows, rowByLineIndex } = buildSplitDiffRows(lines);

    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0], {
      kind: "full",
      cell: { line: lines[0], index: 0 },
    });
    assert.equal(rows[1]?.kind, "split");
    assert.equal(
      rows[1]?.kind === "split" ? rows[1].left?.index : undefined,
      1,
    );
    assert.equal(
      rows[1]?.kind === "split" ? rows[1].right?.index : undefined,
      3,
    );
    assert.equal(
      rows[2]?.kind === "split" ? rows[2].left?.index : undefined,
      2,
    );
    assert.equal(
      rows[2]?.kind === "split" ? rows[2].right : undefined,
      undefined,
    );
    assert.equal(
      rows[3]?.kind === "split" ? rows[3].left?.index : undefined,
      4,
    );
    assert.equal(
      rows[3]?.kind === "split" ? rows[3].right?.index : undefined,
      4,
    );
    assert.equal(rowByLineIndex[0], 0);
    assert.equal(rowByLineIndex[1], 1);
    assert.equal(rowByLineIndex[2], 2);
    assert.equal(rowByLineIndex[3], 1);
    assert.equal(rowByLineIndex[4], 3);
  });

  it("keeps unpaired additions on the right side", () => {
    const lines = [line("a1", "add"), line("a2", "add")];
    const { rows } = buildSplitDiffRows(lines);

    assert.equal(rows.length, 2);
    assert.equal(
      rows[0]?.kind === "split" ? rows[0].left : undefined,
      undefined,
    );
    assert.equal(
      rows[0]?.kind === "split" ? rows[0].right?.index : undefined,
      0,
    );
    assert.equal(
      rows[1]?.kind === "split" ? rows[1].right?.index : undefined,
      1,
    );
  });
});
