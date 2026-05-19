# pi-diff-review Feature Checklist

## Next priorities

- [x] Add real validation with typechecking and tests
  - [x] Add `typescript` as a dev dependency
  - [x] Add `npm run typecheck`
  - [x] Add parser/tokenizer/prompt tests
  - [x] Update CI/release workflow to run typecheck and tests before packing/publishing

- [x] Fix large diff handling
  - [x] Replace `execFileSync` or configure a safe `maxBuffer`
  - [x] Return friendly errors for oversized diffs or git failures
  - [x] Consider streaming diff output for very large reviews

- [ ] Break up `src/review-component.ts`
  - [x] Extract review/navigation state
  - [ ] Extract rendering helpers/panes
  - [x] Extract comment management
  - [x] Extract split-diff row generation
  - [ ] Extract explanation pane/streaming behavior

- [ ] Improve comment range behavior
  - [ ] Validate every selected line is commentable
  - [ ] Validate every selected line is in the same file
  - [ ] Prevent ranges that include hunk/meta lines, or clamp to valid diff lines

- [ ] Improve deleting/editing range comments
  - [ ] Allow deleting a range comment when cursor is inside the range
  - [ ] Allow editing a range comment when cursor is inside the range
  - [ ] Show all comments covering the current line/range when multiple apply

## Follow-up improvements

- [ ] Expand README usage examples
  - [ ] `/diff --cached`
  - [ ] `/diff main...HEAD`
  - [ ] staged vs unstaged review notes

- [ ] Improve large-diff UX
  - [ ] Show file count/hunk count/line count before opening very large diffs
  - [ ] Add confirmation above a configurable threshold
  - [ ] Consider filtering by file or hunk

- [ ] Cache AI explanations per diff/session
  - [ ] Reuse generated hunk explanations when reopening the same diff
  - [ ] Clear explanation cache when the diff changes

- [ ] Document compatibility expectations
  - [ ] Note that the package ships raw `.ts` extension files
  - [ ] Document expected pi/pi-tui loader compatibility
  - [ ] Add minimum tested pi version if applicable

- [ ] Prune cached comment entries
  - [ ] Avoid appending unlimited session cache entries on each edit
  - [ ] Keep only the latest cache entry per diff when possible

## Suggested implementation order

- [x] Add typecheck/test infrastructure
- [x] Add unit tests for `parseDiffSource()`
- [x] Add unit tests for `parseDiff()`
- [x] Add unit tests for `buildReviewPrompt()`
- [ ] Add unit tests for range/comment key behavior
- [x] Fix large diff buffer handling
- [ ] Refactor `src/review-component.ts` with tests in place
