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

  const gitArgs = trimmed.split(/\s+/).filter(Boolean);
  return {
    label: `git diff ${trimmed}`,
    promptLabel: `\`git diff ${trimmed}\``,
    args: gitArgs,
  };
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
