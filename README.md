<img width="1400" height="225" alt="pi-diff-review" src="https://github.com/user-attachments/assets/049b2df9-ec38-4a9a-a824-8d682e77dae1" />

# pi-diff-review

Embedded code reviews directly directly within [pi](https://pi.dev/).

<img width="1986" height="1556" alt="pi-diff-review-screenshot(1)" src="https://github.com/user-attachments/assets/3fd00163-5d19-489b-94ed-3d4816c6cad3" />

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

## Features

- `/diff` reviews the current unstaged `git diff`
- `/diff <git-diff-args>` passes arguments through to `git diff` (for example `/diff main...HEAD`)
- `j/k` or arrow keys to move
- `g/G` to jump to the top or bottom of the diff
- `ctrl-u` / `ctrl-d` to move up/down by half a page
- `t` toggles the comments/explanation sidebar
- `v` toggles the diff between unified and side-by-side split rendering
- `?` toggles an AI-generated explanation for the current hunk
- `J/K` to extend a highlighted selection into a comment range
- `esc` clears the active selection, or exits review when no selection is active
- `n/p` to jump hunks
- `c` to add or edit a comment for the current line or selected range
- `C` to add or edit an overall diff comment
- `x` to delete a comment for the current line or selected range
- `Enter` to submit comments back to pi
- Comments are cached per session and restored when reopening the same diff
- `q` to exit

## Development

Install [pre-commit](https://pre-commit.com/) and enable the repository hooks to run typechecking, tests, and formatting checks before each commit:

```bash
pre-commit install
```

Run the same checks manually with either:

```bash
pre-commit run --all-files
npm run precommit
```

## Release

See [RELEASE.md](./RELEASE.md).
