import type {
  DiffExplainer,
  ExplanationScope,
  ExplanationState,
} from "./explainer.ts";
import type { ReviewLine, ReviewTui } from "../review/types.ts";

const LOADING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function getCurrentHunkScope(
  lines: ReviewLine[],
  selected: number,
): ExplanationScope | undefined {
  const selectedLine = lines[selected];
  if (!selectedLine?.filePath || !selectedLine.hunkLabel) return undefined;

  let start = selected;
  while (
    start > 0 &&
    lines[start - 1]?.filePath === selectedLine.filePath &&
    lines[start - 1]?.hunkLabel === selectedLine.hunkLabel
  ) {
    start--;
  }

  let end = selected;
  while (
    end + 1 < lines.length &&
    lines[end + 1]?.filePath === selectedLine.filePath &&
    lines[end + 1]?.hunkLabel === selectedLine.hunkLabel
  ) {
    end++;
  }

  const diffText = lines
    .slice(start, end + 1)
    .map((line) => line.text)
    .join("\n");
  return {
    key: `hunk:${selectedLine.filePath}:${selectedLine.hunkLabel}:${start}:${end}`,
    kind: "hunk",
    title: `${selectedLine.filePath} ${selectedLine.hunkLabel}`,
    filePath: selectedLine.filePath,
    diffText,
  };
}

export class ExplanationController {
  readonly explanations = new Map<string, ExplanationState>();
  private abortController?: AbortController;
  private requestId = 0;
  private loadingFrame = 0;
  private loadingTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: ReviewTui,
    private readonly explainer?: DiffExplainer,
    cachedExplanations: Map<string, string> = new Map(),
    private readonly onExplanationsChanged?: (
      explanations: Map<string, string>,
    ) => void,
  ) {
    for (const [key, text] of cachedExplanations) {
      const trimmed = text.trim();
      if (trimmed)
        this.explanations.set(key, { status: "ready", text: trimmed });
    }
  }

  get isAvailable(): boolean {
    return this.explainer != null;
  }

  getState(scope: ExplanationScope | undefined): ExplanationState | undefined {
    return scope ? this.explanations.get(scope.key) : undefined;
  }

  getLoadingFrame(): string {
    return LOADING_FRAMES[this.loadingFrame % LOADING_FRAMES.length] ?? "⠋";
  }

  ensure(scope: ExplanationScope | undefined): void {
    if (!scope || !this.explainer) return;
    if (this.explanations.has(scope.key)) return;

    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    const requestId = ++this.requestId;
    let text = "";

    this.explanations.set(scope.key, { status: "loading", text });
    this.startLoadingTimer();

    void this.explainer
      .explain(scope, {
        signal: controller.signal,
        onDelta: (delta) => {
          if (requestId !== this.requestId) return;
          text += delta;
          this.explanations.set(scope.key, { status: "loading", text });
          this.tui.requestRender();
        },
      })
      .then((finalText) => {
        if (requestId !== this.requestId) return;
        this.explanations.set(scope.key, {
          status: "ready",
          text: finalText.trim() || text.trim() || "No explanation returned.",
        });
        this.emitExplanationsChanged();
      })
      .catch((error) => {
        if (requestId !== this.requestId) return;
        if (controller.signal.aborted) return;
        this.explanations.set(scope.key, {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (requestId !== this.requestId) return;
        this.stopLoadingTimerIfIdle();
        this.tui.requestRender();
      });

    this.tui.requestRender();
  }

  dispose(): void {
    this.abortController?.abort();
    this.stopLoadingTimer();
  }

  private emitExplanationsChanged(): void {
    if (!this.onExplanationsChanged) return;

    const readyExplanations = new Map<string, string>();
    for (const [key, explanation] of this.explanations) {
      if (explanation.status === "ready") {
        readyExplanations.set(key, explanation.text);
      }
    }
    this.onExplanationsChanged(readyExplanations);
  }

  private startLoadingTimer(): void {
    if (this.loadingTimer) return;
    this.loadingTimer = setInterval(() => {
      this.loadingFrame++;
      this.tui.requestRender();
    }, 120);
  }

  private stopLoadingTimerIfIdle(): void {
    const hasLoading = [...this.explanations.values()].some(
      (explanation) => explanation.status === "loading",
    );
    if (!hasLoading) this.stopLoadingTimer();
  }

  private stopLoadingTimer(): void {
    if (!this.loadingTimer) return;
    clearInterval(this.loadingTimer);
    this.loadingTimer = undefined;
  }
}
