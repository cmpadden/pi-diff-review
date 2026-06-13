import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReviewSearchState } from "../../src/review/search.ts";
import type { ReviewLine } from "../../src/review/types.ts";

const lines: ReviewLine[] = [
  { id: "1", kind: "context", text: " unchanged", commentable: true },
  { id: "2", kind: "add", text: "+needle one needle", commentable: true },
  { id: "3", kind: "remove", text: "-other", commentable: true },
  { id: "4", kind: "add", text: "+needle two", commentable: true },
];

describe("ReviewSearchState", () => {
  it("jumps between match occurrences with wrapping", () => {
    const search = new ReviewSearchState(lines);
    search.query = "needle";

    assert.equal(search.jump(1, 0).selected, 1);
    assert.deepEqual(search.getActiveMatch(), { lineIndex: 1, start: 0, end: 6 });

    assert.equal(search.jump(1, 1).selected, 1);
    assert.deepEqual(search.getActiveMatch(), { lineIndex: 1, start: 11, end: 17 });

    assert.equal(search.jump(1, 1).selected, 3);
    assert.deepEqual(search.getActiveMatch(), { lineIndex: 3, start: 0, end: 6 });

    assert.equal(search.jump(1, 3).selected, 1);
    assert.deepEqual(search.getActiveMatch(), { lineIndex: 1, start: 0, end: 6 });

    assert.equal(search.jump(-1, 1).selected, 3);
    assert.deepEqual(search.getActiveMatch(), { lineIndex: 3, start: 0, end: 6 });
  });

  it("matches display text instead of diff prefixes", () => {
    const search = new ReviewSearchState(lines);
    search.query = "needle one";

    assert.equal(search.jump(1, 0).selected, 1);

    search.query = "+needle";
    assert.deepEqual(search.jump(1, 0), {});
    assert.equal(search.getStatusText(0), "No matches for /+needle");
  });

  it("reports and clears search status", () => {
    const search = new ReviewSearchState(lines);
    search.query = "missing";

    assert.deepEqual(search.jump(1, 0), {});
    assert.equal(search.getStatusText(0), "No matches for /missing");

    search.clear();
    assert.equal(search.query, "");
    assert.equal(search.getStatusText(0), "");
  });
});
