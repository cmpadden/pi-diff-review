import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tokenizeShellArgs } from "../shared/args.ts";

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const IGNORED_DIRS = new Set([".git", "node_modules"]);

export type ViewSource = {
  label: string;
  promptLabel: string;
  paths: string[];
};

export function parseViewSource(args: string): ViewSource {
  const trimmed = args.trim();
  if (!trimmed) {
    throw new Error("Provide one or more files or folders to /view.");
  }

  let paths: string[];
  try {
    paths = tokenizeShellArgs(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(/in arguments$/, "in /view paths"));
  }

  const normalizedPaths = paths.map(stripPiPathPrefix);

  return {
    label: `/view ${trimmed}`,
    promptLabel: `the selected code from /view ${trimmed}`,
    paths: normalizedPaths,
  };
}

export function resolveViewFiles(cwd: string, source: ViewSource): string[] {
  const gitFilesByDir = new Map<string, string[]>();
  const resolved = new Set<string>();

  for (const inputPath of source.paths) {
    const absolutePath = resolve(cwd, inputPath);
    const stats = statSync(absolutePath, { throwIfNoEntry: false });
    if (!stats) throw new Error(`Path does not exist: ${inputPath}`);

    if (stats.isDirectory()) {
      const gitFiles = getGitTrackedAndUntrackedFiles(
        cwd,
        inputPath,
        gitFilesByDir,
      );
      if (gitFiles) {
        for (const file of gitFiles) resolved.add(resolve(cwd, file));
        continue;
      }

      for (const file of walkDirectory(absolutePath)) {
        resolved.add(file);
      }
      continue;
    }

    if (stats.isFile()) {
      resolved.add(absolutePath);
    }
  }

  const files = [...resolved].filter((path) => isViewableTextFile(path));
  files.sort((left, right) => left.localeCompare(right));
  return files;
}

function getGitTrackedAndUntrackedFiles(
  cwd: string,
  dir: string,
  cache: Map<string, string[]>,
): string[] | undefined {
  const cached = cache.get(dir);
  if (cached) return cached;

  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", dir],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) return undefined;

  const files = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  cache.set(dir, files);
  return files;
}

function* walkDirectory(dir: string): Generator<string> {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDirectory(entryPath);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}

function stripPiPathPrefix(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

function isViewableTextFile(path: string): boolean {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats?.isFile()) return false;
  if (stats.size > DEFAULT_MAX_FILE_BYTES) return false;
  if (extname(path).toLowerCase() === ".png") return false;

  try {
    const sample = readFileSync(path);
    if (sample.includes(0)) return false;
  } catch {
    return false;
  }

  return true;
}
