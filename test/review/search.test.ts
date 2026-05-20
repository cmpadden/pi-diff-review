import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReviewSearchState } from "../../src/review/search.ts";
import type { ReviewLine } from "../../src/review/types.ts";

const lines: ReviewLine[] = [
  { id: "1", kind: "context", text: " unchanged", commentable: true },
  { id: "2", kind: "add", text: "+needle one", commentable: true },
  { id: "3", kind: "remove", text: "-other", commentable: true },
  { id: "4", kind: "add", text: "+needle two", commentable: true },
];

describe("ReviewSearchState", () => {
  it("jumps between matches with wrapping", () => {
    const search = new ReviewSearchState(lines);
    search.query = "needle";

    assert.equal(search.jump(1, 0).selected, 1);
    assert.equal(search.jump(1, 1).selected, 3);
    assert.equal(search.jump(1, 3).selected, 1);
    assert.equal(search.jump(-1, 1).selected, 3);
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
