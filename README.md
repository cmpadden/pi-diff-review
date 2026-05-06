<img width="1400" height="225" alt="pi-diff-review" src="https://github.com/user-attachments/assets/049b2df9-ec38-4a9a-a824-8d682e77dae1" />

# pi-diff-review

Easily provide code reviews directly within [pi](https://pi.dev/).

<img width="1232" height="742" alt="image" src="https://github.com/user-attachments/assets/ab6dca6a-2c49-4148-9523-8fa397fad743" />

## Install

```bash
pi install https://github.com/cmpadden/pi-diff-review
```

## Features

- `/diff` reviews the current unstaged `git diff`
- `j/k` or arrow keys to move
- `J/K` to extend a highlighted selection into a comment range
- `esc` clears the active selection, or exits review when no selection is active
- `n/p` to jump hunks
- `c` to add or edit a comment for the current line or selected range
- `x` to delete a comment for the current line or selected range
- `R` to submit comments back to pi
- `q` to exit
