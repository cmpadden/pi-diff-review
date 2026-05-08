import { execFileSync } from "node:child_process";
import type { DiffSource } from "./types.ts";

export function parseDiffSource(args: string): DiffSource {
  const trimmed = args.trim();
  if (!trimmed) {
    return {
      label: "unstaged git diff",
      promptLabel: "the current unstaged git diff",
      args: [],
    };
  }

  const gitArgs = tokenizeDiffArgs(trimmed);
  return {
    label: `git diff ${trimmed}`,
    promptLabel: `\`git diff ${trimmed}\``,
    args: gitArgs,
  };
}

function tokenizeDiffArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = undefined;
      continue;
    }

    if (/\s/.test(char) && !quote) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += "\\";
  if (quote) throw new Error(`Unterminated ${quote} quote in git diff args`);
  if (current) args.push(current);
  return args;
}

export function getDiff(cwd: string, source: DiffSource): string {
  return execFileSync(
    "git",
    ["diff", "--no-color", "--unified=3", ...source.args],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}
