import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReviewNavigationState } from "../../src/review/navigation.ts";

describe("ReviewNavigationState", () => {
  it("clamps movement to available lines", () => {
    const state = new ReviewNavigationState(3, 1);

    assert.equal(state.move(5), true);
    assert.equal(state.selected, 2);
    assert.equal(state.move(1), false);
    assert.equal(state.selected, 2);
    assert.equal(state.move(-10), true);
    assert.equal(state.selected, 0);
  });

  it("tracks and clears range selections", () => {
    const state = new ReviewNavigationState(5, 2);

    assert.equal(state.extendSelection(2), true);
    assert.equal(state.hasSelection(), true);
    assert.deepEqual(state.getSelectionBounds(), { start: 2, end: 4 });
    assert.equal(state.clearSelection(), true);
    assert.equal(state.hasSelection(), false);
    assert.equal(state.getSelectionBounds(), undefined);
  });

  it("resets scroll when toggling diff render mode", () => {
    const state = new ReviewNavigationState(5, 0);
    state.scrollTop = 3;

    assert.equal(state.toggleDiffRenderMode(), "split");
    assert.equal(state.scrollTop, 0);
    assert.equal(state.toggleDiffRenderMode(), "unified");
  });

  it("resets scroll when toggling line wrap", () => {
    const state = new ReviewNavigationState(5, 0);
    state.scrollTop = 3;

    assert.equal(state.toggleLineWrap(), true);
    assert.equal(state.scrollTop, 0);
    assert.equal(state.toggleLineWrap(), false);
  });

  it("keeps the selected display row inside the viewport", () => {
    const state = new ReviewNavigationState(100, 0);

    state.ensureScroll(10, 25, 100);
    assert.equal(state.scrollTop, 16);
    state.ensureScroll(10, 4, 100);
    assert.equal(state.scrollTop, 4);
    state.ensureScroll(10, 99, 100);
    assert.equal(state.scrollTop, 90);
  });
});
