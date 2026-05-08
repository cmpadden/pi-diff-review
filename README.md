<img width="1400" height="225" alt="pi-diff-review" src="https://github.com/user-attachments/assets/049b2df9-ec38-4a9a-a824-8d682e77dae1" />

# pi-diff-review

Easily provide code reviews directly within [pi](https://pi.dev/).

<img width="1947" height="1103" alt="image" src="https://github.com/user-attachments/assets/3b1e1c51-4c77-4430-8915-1f7d481b64cb" />

## Install

Install from npm:

```bash
pi install npm:pi-diff-review
```

Package: https://www.npmjs.com/package/pi-diff-review

Or install directly from GitHub:

```bash
pi install https://github.com/cmpadden/pi-diff-review
```

## Features

- `/diff` reviews the current unstaged `git diff`
- `/diff <git-diff-args>` passes arguments through to `git diff` (for example `/diff main...HEAD`)
- `j/k` or arrow keys to move
- `ctrl-u` / `ctrl-d` to move up/down by half a page
- `t` toggles the diff between unified and side-by-side split rendering
- `J/K` to extend a highlighted selection into a comment range
- `esc` clears the active selection, or exits review when no selection is active
- `n/p` to jump hunks
- `c` to add or edit a comment for the current line or selected range
- `x` to delete a comment for the current line or selected range
- `Enter` to submit comments back to pi
- `q` to exit

## Release

See [RELEASE.md](./RELEASE.md).
