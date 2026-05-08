import { parsePatchFiles } from "@pierre/diffs";
import type {
  ChangeContent,
  ContextContent,
  FileDiffMetadata,
  Hunk,
} from "@pierre/diffs";
import type { ReviewLine } from "./types.ts";

export function parseDiff(diffText: string): ReviewLine[] {
  try {
    const reviewLines = parseDiffWithPierre(diffText);
    if (reviewLines.length > 0) return reviewLines;
  } catch {
    // Fall back to the local parser for any patch formats @pierre/diffs does
    // not recognize. The review UI should remain available even if the richer
    // parser fails on unusual diff output.
  }

  return parseDiffManual(diffText);
}

function parseDiffWithPierre(diffText: string): ReviewLine[] {
  const patches = parsePatchFiles(diffText);
  const parsed: ReviewLine[] = [];
  let lineIndex = 0;

  const pushLine = (line: Omit<ReviewLine, "id">) => {
    parsed.push({ id: `line-${lineIndex++}`, ...line });
  };

  for (const patch of patches) {
    if (patch.patchMetadata?.trim()) {
      for (const line of patch.patchMetadata.trimEnd().split("\n")) {
        pushLine({ kind: "meta", text: line, commentable: false });
      }
    }

    for (const file of patch.files) {
      appendPierreFileDiff(file, pushLine);
    }
  }

  return parsed;
}

function appendPierreFileDiff(
  file: FileDiffMetadata,
  pushLine: (line: Omit<ReviewLine, "id">) => void,
): void {
  const previousFile =
    file.prevName ?? (file.type === "new" ? undefined : file.name);
  const nextFile = file.type === "deleted" ? undefined : file.name;
  const displayPreviousFile = previousFile ?? file.name;
  const displayNextFile = nextFile ?? file.name;
  const currentFile = nextFile ?? previousFile ?? file.name;

  pushLine({
    kind: "meta",
    text: `diff --git a/${displayPreviousFile} b/${displayNextFile}`,
    filePath: currentFile,
    commentable: false,
  });

  if (file.type === "new" && file.mode) {
    pushLine({
      kind: "meta",
      text: `new file mode ${file.mode}`,
      filePath: currentFile,
      commentable: false,
    });
  } else if (file.type === "deleted" && file.mode) {
    pushLine({
      kind: "meta",
      text: `deleted file mode ${file.mode}`,
      filePath: currentFile,
      commentable: false,
    });
  } else if (file.prevMode && file.mode && file.prevMode !== file.mode) {
    pushLine({
      kind: "meta",
      text: `old mode ${file.prevMode}`,
      filePath: currentFile,
      commentable: false,
    });
    pushLine({
      kind: "meta",
      text: `new mode ${file.mode}`,
      filePath: currentFile,
      commentable: false,
    });
  }

  if (file.prevObjectId && file.newObjectId) {
    pushLine({
      kind: "meta",
      text: `index ${file.prevObjectId}..${file.newObjectId}${file.mode ? ` ${file.mode}` : ""}`,
      filePath: currentFile,
      commentable: false,
    });
  }

  if (file.type === "rename-pure" || file.type === "rename-changed") {
    if (file.prevName) {
      pushLine({
        kind: "meta",
        text: `rename from ${file.prevName}`,
        filePath: currentFile,
        commentable: false,
      });
    }
    pushLine({
      kind: "meta",
      text: `rename to ${file.name}`,
      filePath: currentFile,
      commentable: false,
    });
  }

  if (file.hunks.length === 0) return;

  pushLine({
    kind: "meta",
    text: previousFile ? `--- a/${previousFile}` : "--- /dev/null",
    filePath: currentFile,
    commentable: false,
  });
  pushLine({
    kind: "meta",
    text: nextFile ? `+++ b/${nextFile}` : "+++ /dev/null",
    filePath: currentFile,
    commentable: false,
  });

  for (const hunk of file.hunks) {
    appendPierreHunk(file, hunk, currentFile, pushLine);
  }
}

function appendPierreHunk(
  file: FileDiffMetadata,
  hunk: Hunk,
  currentFile: string,
  pushLine: (line: Omit<ReviewLine, "id">) => void,
): void {
  const hunkLabel = hunk.hunkSpecs?.trimEnd() ?? "@@";
  let oldLine = hunk.deletionStart;
  let newLine = hunk.additionStart;
  let deletionIndex = hunk.deletionLineIndex;
  let additionIndex = hunk.additionLineIndex;

  pushLine({
    kind: "hunk",
    text: hunkLabel,
    filePath: currentFile,
    commentable: false,
    hunkLabel,
  });

  for (const content of hunk.hunkContent) {
    if (content.type === "context") {
      ({ oldLine, newLine, deletionIndex, additionIndex } = appendPierreContext(
        file,
        content,
        currentFile,
        hunkLabel,
        oldLine,
        newLine,
        deletionIndex,
        additionIndex,
        pushLine,
      ));
    } else {
      ({ oldLine, newLine, deletionIndex, additionIndex } = appendPierreChange(
        file,
        content,
        currentFile,
        hunkLabel,
        oldLine,
        newLine,
        deletionIndex,
        additionIndex,
        pushLine,
      ));
    }
  }
}

type PierreLineState = {
  oldLine: number;
  newLine: number;
  deletionIndex: number;
  additionIndex: number;
};

function appendPierreContext(
  file: FileDiffMetadata,
  content: ContextContent,
  currentFile: string,
  hunkLabel: string,
  oldLine: number,
  newLine: number,
  deletionIndex: number,
  additionIndex: number,
  pushLine: (line: Omit<ReviewLine, "id">) => void,
): PierreLineState {
  for (let i = 0; i < content.lines; i++) {
    const lineText =
      file.deletionLines[deletionIndex] ??
      file.additionLines[additionIndex] ??
      "";
    pushLine({
      kind: "context",
      text: ` ${stripLineEnding(lineText)}`,
      filePath: currentFile,
      oldLineNumber: oldLine,
      newLineNumber: newLine,
      commentable: true,
      hunkLabel,
    });
    oldLine++;
    newLine++;
    deletionIndex++;
    additionIndex++;
  }

  return { oldLine, newLine, deletionIndex, additionIndex };
}

function appendPierreChange(
  file: FileDiffMetadata,
  content: ChangeContent,
  currentFile: string,
  hunkLabel: string,
  oldLine: number,
  newLine: number,
  deletionIndex: number,
  additionIndex: number,
  pushLine: (line: Omit<ReviewLine, "id">) => void,
): PierreLineState {
  for (let i = 0; i < content.deletions; i++) {
    const lineText = file.deletionLines[deletionIndex] ?? "";
    pushLine({
      kind: "remove",
      text: `-${stripLineEnding(lineText)}`,
      filePath: currentFile,
      oldLineNumber: oldLine,
      commentable: true,
      hunkLabel,
    });
    oldLine++;
    deletionIndex++;
  }

  for (let i = 0; i < content.additions; i++) {
    const lineText = file.additionLines[additionIndex] ?? "";
    pushLine({
      kind: "add",
      text: `+${stripLineEnding(lineText)}`,
      filePath: currentFile,
      newLineNumber: newLine,
      commentable: true,
      hunkLabel,
    });
    newLine++;
    additionIndex++;
  }

  return { oldLine, newLine, deletionIndex, additionIndex };
}

function stripLineEnding(text: string): string {
  return text.replace(/\r?\n$/, "");
}

function parseDiffManual(diffText: string): ReviewLine[] {
  const lines = diffText.split("\n");
  const parsed: ReviewLine[] = [];

  let currentFile: string | undefined;
  let previousFile: string | undefined;
  let nextFile: string | undefined;
  let currentHunk: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  let lineIndex = 0;

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      const match = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
      previousFile = match?.[1];
      nextFile = match?.[2];
      currentFile = nextFile ?? previousFile;
      currentHunk = undefined;
      parsed.push({
        id: `line-${lineIndex++}`,
        kind: "meta",
        text: raw,
        filePath: currentFile,
        commentable: false,
      });
      continue;
    }

    if (raw.startsWith("--- ")) {
      previousFile =
        raw === "--- /dev/null"
          ? undefined
          : raw.replace(/^--- a\//, "").replace(/^--- /, "");
      parsed.push({
        id: `line-${lineIndex++}`,
        kind: "meta",
        text: raw,
        filePath: currentFile,
        commentable: false,
      });
      continue;
    }

    if (raw.startsWith("+++ ")) {
      nextFile =
        raw === "+++ /dev/null"
          ? undefined
          : raw.replace(/^\+\+\+ b\//, "").replace(/^\+\+\+ /, "");
      currentFile = nextFile ?? previousFile;
      parsed.push({
        id: `line-${lineIndex++}`,
        kind: "meta",
        text: raw,
        filePath: currentFile,
        commentable: false,
      });
      continue;
    }

    if (raw.startsWith("@@")) {
      const match = raw.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/,
      );
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[3]);
      }
      currentHunk = raw;
      parsed.push({
        id: `line-${lineIndex++}`,
        kind: "hunk",
        text: raw,
        filePath: currentFile,
        commentable: false,
        hunkLabel: currentHunk,
      });
      continue;
    }

    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      parsed.push({
        id: `line-${lineIndex++}`,
        kind: "add",
        text: raw,
        filePath: currentFile,
        newLineNumber: newLine,
        commentable: Boolean(currentFile),
        hunkLabel: currentHunk,
      });
      newLine++;
      continue;
    }

    if (raw.startsWith("-") && !raw.startsWith("---")) {
      parsed.push({
        id: `line-${lineIndex++}`,
        kind: "remove",
        text: raw,
        filePath: currentFile,
        oldLineNumber: oldLine,
        commentable: Boolean(currentFile),
        hunkLabel: currentHunk,
      });
      oldLine++;
      continue;
    }

    if (raw.startsWith(" ")) {
      parsed.push({
        id: `line-${lineIndex++}`,
        kind: "context",
        text: raw,
        filePath: currentFile,
        oldLineNumber: oldLine,
        newLineNumber: newLine,
        commentable: Boolean(currentFile),
        hunkLabel: currentHunk,
      });
      oldLine++;
      newLine++;
      continue;
    }

    parsed.push({
      id: `line-${lineIndex++}`,
      kind: "meta",
      text: raw,
      filePath: currentFile,
      commentable: false,
    });
  }

  return parsed;
}
