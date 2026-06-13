import { createHash } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getDiff, parseDiffSource } from "./diff/source.ts";
import { parseDiff } from "./diff/parser.ts";
import { PiModelDiffExplainer } from "./explanation/explainer.ts";
import {
  getCachedAsk,
  getCachedComments,
  getCachedExplanations,
  persistCachedAsk,
  persistCachedComments,
  persistCachedExplanations,
} from "./review/cache.ts";
import { ReviewComponent } from "./review/component.ts";
import { buildReviewPrompt, buildViewReviewPrompt } from "./review/prompt.ts";
import type { ReviewComment, ReviewLine, ReviewResult } from "./review/types.ts";
import { WorkspaceCommentStore } from "./review/workspace-comments.ts";
import { parseViewFiles } from "./view/parser.ts";
import { parseViewSource, resolveViewFiles } from "./view/source.ts";

function getReviewCacheKey(cwd: string, label: string, text: string): string {
  const hash = createHash("sha256").update(text).digest("hex");
  return `${cwd}\0${label}\0${hash}`;
}

export function registerDiffReviewCommand(pi: ExtensionAPI): void {
  pi.registerCommand("diff", {
    description: "Review a git diff in a custom TUI (/diff [git diff args])",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      let source;
      let diffText: string;
      try {
        source = parseDiffSource(args);
        diffText = getDiff(ctx.cwd, source);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Unable to read diff: ${message}`, "error");
        return;
      }

      if (!diffText.trim()) {
        ctx.ui.notify(`No changes to review for ${source.label}.`, "info");
        return;
      }

      const reviewLines = parseDiff(diffText);
      await openReview(pi, ctx, {
        title: source.label,
        promptLabel: source.promptLabel,
        cacheKey: getReviewCacheKey(ctx.cwd, source.label, diffText),
        reviewLines,
        buildPrompt: (comments) => buildReviewPrompt(comments, source.promptLabel),
      });
    },
  });
}

export function registerViewCommand(pi: ExtensionAPI): void {
  pi.registerCommand("view", {
    description: "Review one or more files or folders in a custom TUI (/view <paths...>)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      let source;
      let files: string[];
      try {
        source = parseViewSource(args);
        files = resolveViewFiles(ctx.cwd, source);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Unable to open view: ${message}`, "error");
        return;
      }

      if (files.length === 0) {
        ctx.ui.notify("No viewable text files matched the requested paths.", "info");
        return;
      }

      const workspaceStore = new WorkspaceCommentStore(ctx.cwd);
      const reviewLines = parseViewFiles(workspaceStore.rootPath, files);
      const contentKey = reviewLines.map((line) => line.text).join("\n");

      await openReview(pi, ctx, {
        title: source.label,
        promptLabel: source.promptLabel,
        cacheKey: getReviewCacheKey(ctx.cwd, source.label, contentKey),
        reviewLines,
        workspaceStore,
        buildPrompt: (comments) => buildViewReviewPrompt(comments, source.promptLabel),
      });
    },
  });
}

async function openReview(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  options: {
    title: string;
    promptLabel: string;
    cacheKey: string;
    reviewLines: ReviewLine[];
    buildPrompt: (comments: ReviewComment[]) => string;
    workspaceStore?: WorkspaceCommentStore;
  },
): Promise<void> {
  const workspaceStore = options.workspaceStore ?? new WorkspaceCommentStore(ctx.cwd);
  const cachedComments = getCachedComments(ctx, options.cacheKey);
  const comments = workspaceStore.getVisibleComments(options.reviewLines);
  for (const [id, comment] of cachedComments) {
    comments.set(id, comment);
  }

  const explanations = getCachedExplanations(ctx, options.cacheKey);
  const ask = getCachedAsk(ctx, options.cacheKey);
  const summary = () => workspaceStore.summarize(options.reviewLines);

  if (cachedComments.size > 0) {
    ctx.ui.notify(
      `Restored ${cachedComments.size} cached review comment${cachedComments.size === 1 ? "" : "s"}.`,
      "info",
    );
  }
  if (explanations.size > 0) {
    ctx.ui.notify(
      `Restored ${explanations.size} cached explanation${explanations.size === 1 ? "" : "s"}.`,
      "info",
    );
  }
  if (ask) {
    ctx.ui.notify("Restored cached ask answer.", "info");
  }

  const initialSummary = summary();
  if (initialSummary.hiddenInCurrentFiles > 0 || initialSummary.elsewhere > 0) {
    ctx.ui.notify(
      [
        initialSummary.hiddenInCurrentFiles > 0
          ? `${initialSummary.hiddenInCurrentFiles} comments hidden in current files`
          : undefined,
        initialSummary.elsewhere > 0
          ? `${initialSummary.elsewhere} comments elsewhere in the workspace`
          : undefined,
      ]
        .filter(Boolean)
        .join(" • "),
      "info",
    );
  }
  if (initialSummary.stale > 0 || initialSummary.orphaned > 0) {
    ctx.ui.notify(
      [
        initialSummary.stale > 0
          ? `${initialSummary.stale} stale comment${initialSummary.stale === 1 ? "" : "s"}`
          : undefined,
        initialSummary.orphaned > 0
          ? `${initialSummary.orphaned} orphaned comment${initialSummary.orphaned === 1 ? "" : "s"}`
          : undefined,
      ]
        .filter(Boolean)
        .join(" • "),
      "warning",
    );
  }

  const result = await ctx.ui.custom<ReviewResult>((tui, theme, _keybindings, done) => {
    return new ReviewComponent(
      tui,
      theme,
      options.title,
      options.reviewLines,
      comments,
      done,
      new PiModelDiffExplainer(ctx),
      (updatedComments) => {
        persistCachedComments(pi, options.cacheKey, updatedComments.values());
        workspaceStore.syncFromComments(options.reviewLines, updatedComments.values());
      },
      explanations,
      (updatedExplanations) => {
        persistCachedExplanations(pi, options.cacheKey, updatedExplanations);
      },
      ask,
      (updatedAsk) => {
        persistCachedAsk(pi, options.cacheKey, updatedAsk);
      },
      () => summary(),
    );
  });

  if (!result || result.action !== "submit") return;
  if (result.comments.length === 0) {
    ctx.ui.notify("No review comments to send.", "info");
    persistCachedComments(pi, options.cacheKey, []);
    return;
  }

  persistCachedComments(pi, options.cacheKey, []);
  pi.sendUserMessage(options.buildPrompt(result.comments));
}
