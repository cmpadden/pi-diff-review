import type {
  ReviewLine,
  SplitDiffCell,
  SplitDiffRow,
} from "../review/types.ts";

export type SplitDiffRowsResult = {
  rows: SplitDiffRow[];
  rowByLineIndex: number[];
};

export function buildSplitDiffRows(lines: ReviewLine[]): SplitDiffRowsResult {
  const rows: SplitDiffRow[] = [];
  const rowByLineIndex: number[] = [];
  let index = 0;

  const pushRow = (row: SplitDiffRow) => {
    const displayRow = rows.length;
    rows.push(row);
    if (row.kind === "full") {
      rowByLineIndex[row.cell.index] = displayRow;
    } else {
      if (row.left) rowByLineIndex[row.left.index] = displayRow;
      if (row.right) rowByLineIndex[row.right.index] = displayRow;
    }
  };

  while (index < lines.length) {
    const line = lines[index]!;

    if (line.kind === "remove" || line.kind === "add") {
      const removals: SplitDiffCell[] = [];
      const additions: SplitDiffCell[] = [];

      while (lines[index]?.kind === "remove") {
        removals.push({ line: lines[index]!, index });
        index++;
      }
      while (lines[index]?.kind === "add") {
        additions.push({ line: lines[index]!, index });
        index++;
      }

      const count = Math.max(removals.length, additions.length);
      for (let offset = 0; offset < count; offset++) {
        pushRow({
          kind: "split",
          left: removals[offset],
          right: additions[offset],
        });
      }
      continue;
    }

    if (line.kind === "context") {
      const cell = { line, index };
      pushRow({ kind: "split", left: cell, right: cell });
    } else {
      pushRow({ kind: "full", cell: { line, index } });
    }
    index++;
  }

  return { rows, rowByLineIndex };
}
