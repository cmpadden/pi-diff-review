import type { Theme } from "@earendil-works/pi-coding-agent";

export type DiffLineKind = "meta" | "hunk" | "context" | "add" | "remove";

export type ReviewComment = {
  id: string;
  filePath: string;
  text: string;
  global?: boolean;
  startLineId: string;
  endLineId: string;
  startOldLineNumber?: number;
  startNewLineNumber?: number;
  endOldLineNumber?: number;
  endNewLineNumber?: number;
  lineText: string;
};

export type ReviewLine = {
  id: string;
  kind: DiffLineKind;
  text: string;
  filePath?: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  commentable: boolean;
  hunkLabel?: string;
};

export type ReviewResult =
  | { action: "submit"; comments: ReviewComment[] }
  | { action: "cancel" };

export type SelectionBounds = {
  start: number;
  end: number;
};

export type DiffSource = {
  label: string;
  promptLabel: string;
  args: string[];
};

export type ReviewLayout = "side-by-side" | "stacked";
export type DiffRenderMode = "unified" | "split";

export type SplitDiffCell = {
  line: ReviewLine;
  index: number;
};

export type SplitDiffRow =
  | { kind: "full"; cell: SplitDiffCell }
  | { kind: "split"; left?: SplitDiffCell; right?: SplitDiffCell };

export type ReviewTui = {
  requestRender: (full?: boolean) => void;
  terminal?: { rows: number; columns: number };
};

export type ReviewTheme = Theme;

export type RightPaneMode = "comments" | "explanation";
