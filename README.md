<img width="1400" height="225" alt="pi-diff-review" src="https://github.com/user-attachments/assets/049b2df9-ec38-4a9a-a824-8d682e77dae1" />

# pi-diff-review

Embedded code reviews and AI summaries directly within [pi](https://pi.dev/).

<img width="1986" height="1556" alt="pi-diff-review-screenshot" src="https://github.com/user-attachments/assets/5ddd7226-28d4-4617-8c5c-35b4b6af68dc" />

## Install

Install from npm:

```bash
pi install npm:pi-diff-review
```

Or install directly from GitHub:

```bash
pi install https://github.com/cmpadden/pi-diff-review
```

For local development, clone the repository and install from the local path:

```bash
git clone https://github.com/cmpadden/pi-diff-review
pi install ./pi-diff-review
```

## Usage

Start a review with `/diff`. By default, this reviews your current unstaged changes:

```text
/diff
```

Review staged changes with `--cached`:

```text
/diff --cached
```

Review a branch or commit range by passing any `git diff` arguments after `/diff`:

```text
/diff main...HEAD
```

Review a single file by using a git pathspec after `--`. Pi path autocomplete works here too:

```text
/diff -- @src/index.ts
/diff --cached -- @src/index.ts
/diff main...HEAD -- @src/index.ts
```

`/diff <git-diff-args>` is passed through to `git diff`, so these examples are equivalent to running `git diff`, `git diff --cached`, and `git diff main...HEAD` locally before opening the review UI.

Experimental: track reviewed turns while keeping the full overall diff visible:

```text
/diff --turn-based
/diff --cached --turn-based
/diff main...HEAD --turn-based -- @src/index.ts
```

Press `M` in a turn-based review to toggle the current hunk as reviewed. Later
runs show the requested overall diff and render reviewed changed lines with a
muted blue overlay.

Open one or more files or folders with `/view`:

```text
/view src/index.ts src/review
```

`/view` expands folders into text files, renders them in the same review UI, and lets you annotate actual code lines instead of diff hunks.

### Staged vs. unstaged changes

- `/diff` shows unstaged working-tree changes only.
- `/diff --cached` shows staged changes only.
- If you have both staged and unstaged edits, run both commands separately to review each set.
- To review everything relative to a base branch, use a range such as `/diff main...HEAD`.

## Features

- `/diff` reviews the current unstaged `git diff`
- `/view <files-or-folders>` reviews source files directly
- `/diff --cached` reviews staged changes
- `/diff main...HEAD` reviews changes on the current branch relative to `main`
- `/diff <git-diff-args>` passes arguments through to `git diff`
- `/diff --turn-based` enables experimental reviewed-turn overlays with `M`
- `h` toggles the command help modal
- `j/k` or arrow keys to move
- `g/G` to jump to the top or bottom of the diff
- `[/]` to jump to the previous or next file
- `f` to focus the current file, or clear file focus
- `t` toggles the left file sidebar
- `ctrl-u` / `ctrl-d` to move up/down by half a page
- `s` toggles inline comments/explanations
- `v` toggles the diff between unified and side-by-side split rendering
- `w` toggles line wrap for long diff lines
- `?` toggles an AI-generated explanation for the current hunk
- `/` searches visible diff text, highlights matches, and `n/N` moves between them while a search is active
- `J/K` to extend a highlighted selection into a comment range
- `esc` clears the active selection, or exits review when no selection is active
- File headers break the review into per-file sections with change counts
- Optional left sidebar lists files with `+/-` counts and tracks the current file
- `n/p` to jump hunks
- `c` to add or edit a comment for the current line or selected range
- `C` to add or edit an overall diff comment
- `x` to delete a comment for the current line or selected range
- `Enter` to submit comments back to pi
- Comments are cached per session and restored when reopening the same diff or view
- File comments are also persisted in a repo-local workspace store and shown again in `/view` or on matching lines in `/diff`
- The UI indicates persisted comments that are hidden in the current files, elsewhere in the workspace, stale, or orphaned
- `q` to exit

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development and release instructions.
