import { spawnSync } from "node:child_process";
import type { DiffSource } from "../review/types.ts";
import { tokenizeShellArgs } from "../shared/args.ts";

export function parseDiffSource(args: string): DiffSource {
  const trimmed = args.trim();
  if (!trimmed) {
    return {
      label: "unstaged git diff",
      promptLabel: "the current unstaged git diff",
      args: [],
    };
  }

  const { gitArgs, turnBased } = parseDiffArgs(trimmed);
  if (!turnBased) {
    return {
      label: `git diff ${trimmed}`,
      promptLabel: `\`git diff ${trimmed}\``,
      args: gitArgs,
    };
  }

  const gitDiffLabel =
    gitArgs.length > 0 ? `git diff ${gitArgs.join(" ")}` : "unstaged git diff";
  const promptLabel =
    gitArgs.length > 0
      ? `\`git diff ${gitArgs.join(" ")}\``
      : "the current unstaged git diff";

  return {
    label: `${gitDiffLabel} with turn-based review overlay`,
    promptLabel,
    args: gitArgs,
    turnBased: true,
  };
}

function parseDiffArgs(input: string): {
  gitArgs: string[];
  turnBased: boolean;
} {
  try {
    const tokens = tokenizeShellArgs(input);
    const { args, turnBased } = extractDiffReviewFlags(tokens);
    return {
      gitArgs: normalizeDiffPathspecs(args),
      turnBased,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(/in arguments$/, "in git diff args"));
  }
}

function extractDiffReviewFlags(tokens: string[]): {
  args: string[];
  turnBased: boolean;
} {
  const args: string[] = [];
  let turnBased = false;
  let passthrough = false;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--") {
      passthrough = true;
      args.push(token);
      continue;
    }

    if (!passthrough && token === "--turn-based") {
      if (turnBased) {
        throw new Error("--turn-based can only be provided once");
      }
      turnBased = true;
      continue;
    }

    args.push(token);
  }

  return { args, turnBased };
}

function normalizeDiffPathspecs(args: string[]): string[] {
  const separatorIndex = args.indexOf("--");
  if (separatorIndex < 0) return args;

  return args.map((arg, index) =>
    index > separatorIndex && arg.startsWith("@") ? arg.slice(1) : arg,
  );
}

export const DIFF_MAX_BUFFER_BYTES = 128 * 1024 * 1024;

export function getDiff(cwd: string, source: DiffSource): string {
  const args = ["diff", "--no-color", "--unified=3", ...source.args];
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: DIFF_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw new Error(formatSpawnError(result.error));
  }

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(
      stderr || `git ${args.join(" ")} exited with status ${result.status}.`,
    );
  }

  return result.stdout;
}

function formatSpawnError(error: Error & { code?: string }): string {
  if (error.code === "ENOBUFS") {
    return `Diff output exceeded the ${formatBytes(DIFF_MAX_BUFFER_BYTES)} safety limit. Try reviewing a smaller diff or narrowing with git diff pathspecs.`;
  }

  return error.message;
}

function formatBytes(bytes: number): string {
  const mib = bytes / 1024 / 1024;
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}
