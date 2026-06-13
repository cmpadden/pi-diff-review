import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { ReviewComment, ReviewLine } from "./types.ts";

const STORE_VERSION = 1;
const MAX_CONTEXT_LINES = 2;

export type PersistentCommentStatus = "active" | "stale" | "orphaned";

export type WorkspaceCommentRecord = {
  id: string;
  filePath: string;
  text: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  beforeContext: string[];
  afterContext: string[];
  fileContentHash: string;
  createdAt: number;
  updatedAt: number;
};

export type ResolvedWorkspaceComment = WorkspaceCommentRecord & {
  status: PersistentCommentStatus;
  resolvedStartLine?: number;
  resolvedEndLine?: number;
};

type WorkspaceCommentStoreFile = {
  version: number;
  comments: WorkspaceCommentRecord[];
};

export type WorkspaceCommentSummary = {
  visible: number;
  hiddenInCurrentFiles: number;
  elsewhere: number;
  stale: number;
  orphaned: number;
};

export class WorkspaceCommentStore {
  private readonly storePath: string;
  private readonly root: string;

  constructor(cwd: string) {
    this.root = getWorkspaceRoot(cwd);
    this.storePath = getStorePath(cwd, this.root);
  }

  get rootPath(): string {
    return this.root;
  }

  list(): WorkspaceCommentRecord[] {
    return readStoreFile(this.storePath).comments;
  }

  resolveAll(): ResolvedWorkspaceComment[] {
    return this.list().map((comment) => this.resolveComment(comment));
  }

  getVisibleComments(lines: ReviewLine[]): Map<string, ReviewComment> {
    const visible = new Map<string, ReviewComment>();
    const lineByFileAndNumber = buildLineLookup(lines);

    for (const comment of this.resolveAll()) {
      if (comment.status === "orphaned") continue;
      const startLine = comment.resolvedStartLine ?? comment.startLine;
      const endLine = comment.resolvedEndLine ?? comment.endLine;
      const start = lineByFileAndNumber.get(
        getFileLineKey(comment.filePath, startLine),
      );
      const end = lineByFileAndNumber.get(
        getFileLineKey(comment.filePath, endLine),
      );
      if (!start || !end) continue;
      const reviewCommentId = `${start.id}:${end.id}`;
      visible.set(reviewCommentId, {
        id: reviewCommentId,
        filePath: comment.filePath,
        text: comment.text,
        startLineId: start.id,
        endLineId: end.id,
        startNewLineNumber: startLine,
        endNewLineNumber: endLine,
        lineText: comment.excerpt,
      });
    }

    return visible;
  }

  summarize(lines: ReviewLine[]): WorkspaceCommentSummary {
    const lineByFileAndNumber = buildLineLookup(lines);
    const currentFiles = new Set(
      lines.map((line) => line.filePath).filter(isPresent),
    );
    const visible = new Set<string>();
    let hiddenInCurrentFiles = 0;
    let elsewhere = 0;
    let stale = 0;
    let orphaned = 0;

    for (const comment of this.resolveAll()) {
      if (comment.status === "stale") stale++;
      if (comment.status === "orphaned") {
        orphaned++;
        continue;
      }

      const startLine = comment.resolvedStartLine ?? comment.startLine;
      const endLine = comment.resolvedEndLine ?? comment.endLine;
      const startVisible = lineByFileAndNumber.has(
        getFileLineKey(comment.filePath, startLine),
      );
      const endVisible = lineByFileAndNumber.has(
        getFileLineKey(comment.filePath, endLine),
      );

      if (startVisible && endVisible) {
        visible.add(comment.id);
        continue;
      }

      if (currentFiles.has(comment.filePath)) {
        hiddenInCurrentFiles++;
      } else {
        elsewhere++;
      }
    }

    return {
      visible: visible.size,
      hiddenInCurrentFiles,
      elsewhere,
      stale,
      orphaned,
    };
  }

  syncFromComments(
    lines: ReviewLine[],
    comments: Iterable<ReviewComment>,
  ): void {
    const store = readStoreFile(this.storePath);
    const next = new Map(
      store.comments.map((comment) => [comment.id, comment]),
    );
    const commentIdsForCurrentFiles = new Set<string>();
    const currentFiles = new Set(
      lines.map((line) => line.filePath).filter(isPresent),
    );

    for (const comment of store.comments) {
      if (currentFiles.has(comment.filePath)) {
        commentIdsForCurrentFiles.add(comment.id);
      }
    }

    for (const id of commentIdsForCurrentFiles) {
      next.delete(id);
    }

    for (const comment of comments) {
      const previous = this.getPreviousRecord(lines, comment, next);
      const record = this.buildRecord(lines, comment, previous);
      if (record) next.set(record.id, record);
    }

    writeStoreFile(this.storePath, {
      version: STORE_VERSION,
      comments: [...next.values()],
    });
  }

  private getPreviousRecord(
    lines: ReviewLine[],
    comment: ReviewComment,
    commentsById: Map<string, WorkspaceCommentRecord>,
  ): WorkspaceCommentRecord | undefined {
    if (comment.global) return undefined;
    const start = lines.find((line) => line.id === comment.startLineId);
    const end = lines.find((line) => line.id === comment.endLineId);
    const filePath = normalizePath(comment.filePath);
    const startLine = start?.newLineNumber;
    const endLine = end?.newLineNumber;
    if (!filePath || startLine == null || endLine == null) return undefined;
    return commentsById.get(
      getPersistentCommentId(
        filePath,
        Math.max(1, Math.min(startLine, endLine)),
        Math.max(startLine, endLine),
      ),
    );
  }

  private buildRecord(
    lines: ReviewLine[],
    comment: ReviewComment,
    previous?: WorkspaceCommentRecord,
  ): WorkspaceCommentRecord | undefined {
    if (comment.global) return undefined;
    const start = lines.find((line) => line.id === comment.startLineId);
    const end = lines.find((line) => line.id === comment.endLineId);
    const filePath = normalizePath(comment.filePath);
    if (!start || !end || !filePath) return undefined;
    const startLine = start.newLineNumber;
    const endLine = end.newLineNumber;
    if (startLine == null || endLine == null) return undefined;

    const absolutePath = resolve(this.root, filePath);
    const currentLines = readTextLines(absolutePath);
    if (!currentLines) return undefined;

    const from = Math.max(1, Math.min(startLine, endLine));
    const to = Math.max(startLine, endLine);
    const excerpt = currentLines.slice(from - 1, to).join("\n");
    const beforeContext = currentLines.slice(
      Math.max(0, from - 1 - MAX_CONTEXT_LINES),
      from - 1,
    );
    const afterContext = currentLines.slice(
      to,
      Math.min(currentLines.length, to + MAX_CONTEXT_LINES),
    );
    const now = Date.now();

    return {
      id: getPersistentCommentId(filePath, from, to),
      filePath,
      text: comment.text,
      startLine,
      endLine,
      excerpt,
      beforeContext,
      afterContext,
      fileContentHash: hashText(currentLines.join("\n")),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
  }

  private resolveComment(
    comment: WorkspaceCommentRecord,
  ): ResolvedWorkspaceComment {
    const absolutePath = resolve(this.root, comment.filePath);
    const currentLines = readTextLines(absolutePath);
    if (!currentLines) {
      return { ...comment, status: "orphaned" };
    }

    const currentHash = hashText(currentLines.join("\n"));
    const expectedExcerpt = currentLines
      .slice(comment.startLine - 1, comment.endLine)
      .join("\n");

    if (
      currentHash === comment.fileContentHash &&
      expectedExcerpt === comment.excerpt
    ) {
      return {
        ...comment,
        status: "active",
        resolvedStartLine: comment.startLine,
        resolvedEndLine: comment.endLine,
      };
    }

    const exactMatch = findExcerptMatch(currentLines, comment.excerpt);
    if (exactMatch) {
      return {
        ...comment,
        status: "stale",
        resolvedStartLine: exactMatch.startLine,
        resolvedEndLine: exactMatch.endLine,
      };
    }

    const contextualMatch = findContextualMatch(currentLines, comment);
    if (contextualMatch) {
      return {
        ...comment,
        status: "stale",
        resolvedStartLine: contextualMatch.startLine,
        resolvedEndLine: contextualMatch.endLine,
      };
    }

    return { ...comment, status: "orphaned" };
  }
}

function buildLineLookup(lines: ReviewLine[]): Map<string, ReviewLine> {
  const lookup = new Map<string, ReviewLine>();
  for (const line of lines) {
    const filePath = normalizePath(line.filePath);
    const lineNumber = line.newLineNumber ?? line.oldLineNumber;
    if (!filePath || lineNumber == null) continue;
    lookup.set(getFileLineKey(filePath, lineNumber), line);
  }
  return lookup;
}

function findExcerptMatch(
  lines: string[],
  excerpt: string,
): { startLine: number; endLine: number } | undefined {
  const excerptLines = excerpt.split("\n");
  if (excerptLines.length === 0 || !excerpt.trim()) return undefined;

  let match: { startLine: number; endLine: number } | undefined;
  for (let index = 0; index <= lines.length - excerptLines.length; index++) {
    const candidate = lines
      .slice(index, index + excerptLines.length)
      .join("\n");
    if (candidate !== excerpt) continue;
    if (match) return undefined;
    match = { startLine: index + 1, endLine: index + excerptLines.length };
  }
  return match;
}

function findContextualMatch(
  lines: string[],
  comment: WorkspaceCommentRecord,
): { startLine: number; endLine: number } | undefined {
  const excerptLines = comment.excerpt.split("\n");
  const before = comment.beforeContext;
  const after = comment.afterContext;
  if (excerptLines.length === 0) return undefined;

  let best: { startLine: number; endLine: number; score: number } | undefined;

  for (let index = 0; index <= lines.length - excerptLines.length; index++) {
    const candidateLines = lines.slice(index, index + excerptLines.length);
    let score = 0;
    if (candidateLines.join("\n") === comment.excerpt) score += 10;

    const beforeCandidate = lines.slice(
      Math.max(0, index - before.length),
      index,
    );
    const afterCandidate = lines.slice(
      index + excerptLines.length,
      index + excerptLines.length + after.length,
    );
    score += countSuffixMatches(beforeCandidate, before);
    score += countPrefixMatches(afterCandidate, after);
    score -= Math.abs(index + 1 - comment.startLine) * 0.01;

    if (!best || score > best.score) {
      best = {
        startLine: index + 1,
        endLine: index + excerptLines.length,
        score,
      };
    } else if (best && score === best.score) {
      best = undefined;
    }
  }

  return best && best.score > 0 ? best : undefined;
}

function countSuffixMatches(left: string[], right: string[]): number {
  let count = 0;
  for (let i = 1; i <= Math.min(left.length, right.length); i++) {
    if (left[left.length - i] !== right[right.length - i]) break;
    count++;
  }
  return count;
}

function countPrefixMatches(left: string[], right: string[]): number {
  let count = 0;
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) break;
    count++;
  }
  return count;
}

function readTextLines(path: string): string[] | undefined {
  try {
    const text = readFileSync(path, "utf8");
    return text.replace(/\r\n/g, "\n").split("\n");
  } catch {
    return undefined;
  }
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readStoreFile(path: string): WorkspaceCommentStoreFile {
  try {
    if (!existsSync(path)) return { version: STORE_VERSION, comments: [] };
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<WorkspaceCommentStoreFile>;
    const comments = Array.isArray(parsed.comments)
      ? parsed.comments.filter(isWorkspaceCommentRecord)
      : [];
    return { version: STORE_VERSION, comments };
  } catch {
    return { version: STORE_VERSION, comments: [] };
  }
}

function writeStoreFile(path: string, store: WorkspaceCommentStoreFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function isWorkspaceCommentRecord(
  value: unknown,
): value is WorkspaceCommentRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<WorkspaceCommentRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.filePath === "string" &&
    typeof record.text === "string" &&
    typeof record.startLine === "number" &&
    typeof record.endLine === "number" &&
    typeof record.excerpt === "string" &&
    Array.isArray(record.beforeContext) &&
    Array.isArray(record.afterContext) &&
    typeof record.fileContentHash === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number"
  );
}

function getWorkspaceRoot(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status === 0) {
    const root = result.stdout.trim();
    if (root) return root;
  }
  return cwd;
}

function getStorePath(cwd: string, root: string): string {
  const gitPathResult = spawnSync(
    "git",
    ["rev-parse", "--git-path", "pi-diff-review-comments.json"],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (gitPathResult.status === 0) {
    const gitPath = gitPathResult.stdout.trim();
    if (gitPath) return isAbsolute(gitPath) ? gitPath : resolve(root, gitPath);
  }
  return resolve(root, ".pi-diff-review-comments.json");
}

function normalizePath(path?: string): string | undefined {
  if (!path) return undefined;
  return path.replace(/\\/g, "/");
}

function getFileLineKey(filePath: string, lineNumber: number): string {
  return `${filePath}:${lineNumber}`;
}

function getPersistentCommentId(
  filePath: string,
  startLine: number,
  endLine: number,
): string {
  return `${filePath}:${startLine}-${endLine}`;
}

function isPresent<T>(value: T | undefined): value is T {
  return value != null;
}

export function getRelativeWorkspacePath(root: string, path: string): string {
  return normalizePath(relative(root, path)) ?? path;
}
