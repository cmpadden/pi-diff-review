import { createHash } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getDiff, parseDiffSource } from "./diff/source.ts";
import { parseDiff } from "./diff/parser.ts";
import { PiModelDiffExplainer } from "./explanation/explainer.ts";
import { buildReviewPrompt } from "./review/prompt.ts";
import { ReviewComponent } from "./review/component.ts";
import type {
  DiffSource,
  ReviewComment,
  ReviewResult,
} from "./review/types.ts";

const DIFF_REVIEW_CACHE_ENTRY = "pi-diff-review-cache";
const DIFF_REVIEW_EXPLANATION_CACHE_ENTRY = "pi-diff-review-explanation-cache";

type DiffReviewCacheEntry = {
  cacheKey: string;
  comments: ReviewComment[];
  updatedAt: number;
};

type DiffExplanationCacheEntry = {
  cacheKey: string;
  explanations: Record<string, string>;
  updatedAt: number;
};

function getDiffCacheKey(
  cwd: string,
  source: DiffSource,
  diffText: string,
): string {
  const hash = createHash("sha256").update(diffText).digest("hex");
  return `${cwd}\0${source.label}\0${hash}`;
}

function getCachedComments(
  ctx: ExtensionCommandContext,
  cacheKey: string,
): Map<string, ReviewComment> {
  let latest: DiffReviewCacheEntry | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (
      entry.type !== "custom" ||
      entry.customType !== DIFF_REVIEW_CACHE_ENTRY
    ) {
      continue;
    }

    const data = entry.data as Partial<DiffReviewCacheEntry> | undefined;
    if (data?.cacheKey !== cacheKey || !Array.isArray(data.comments)) {
      continue;
    }

    if (!latest || (data.updatedAt ?? 0) >= latest.updatedAt) {
      latest = {
        cacheKey: data.cacheKey,
        comments: data.comments,
        updatedAt: data.updatedAt ?? 0,
      };
    }
  }

  return new Map(
    (latest?.comments ?? []).map((comment) => [comment.id, comment]),
  );
}

function persistCachedComments(
  pi: ExtensionAPI,
  cacheKey: string,
  comments: Iterable<ReviewComment>,
): void {
  pi.appendEntry(DIFF_REVIEW_CACHE_ENTRY, {
    cacheKey,
    comments: [...comments],
    updatedAt: Date.now(),
  } satisfies DiffReviewCacheEntry);
}

function getCachedExplanations(
  ctx: ExtensionCommandContext,
  cacheKey: string,
): Map<string, string> {
  let latest: DiffExplanationCacheEntry | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (
      entry.type !== "custom" ||
      entry.customType !== DIFF_REVIEW_EXPLANATION_CACHE_ENTRY
    ) {
      continue;
    }

    const data = entry.data as Partial<DiffExplanationCacheEntry> | undefined;
    if (
      data?.cacheKey !== cacheKey ||
      !data.explanations ||
      typeof data.explanations !== "object" ||
      Array.isArray(data.explanations)
    ) {
      continue;
    }

    if (!latest || (data.updatedAt ?? 0) >= latest.updatedAt) {
      latest = {
        cacheKey: data.cacheKey,
        explanations: Object.fromEntries(
          Object.entries(data.explanations).filter(
            (entry): entry is [string, string] =>
              typeof entry[0] === "string" && typeof entry[1] === "string",
          ),
        ),
        updatedAt: data.updatedAt ?? 0,
      };
    }
  }

  return new Map(Object.entries(latest?.explanations ?? {}));
}

function persistCachedExplanations(
  pi: ExtensionAPI,
  cacheKey: string,
  explanations: Map<string, string>,
): void {
  pi.appendEntry(DIFF_REVIEW_EXPLANATION_CACHE_ENTRY, {
    cacheKey,
    explanations: Object.fromEntries(explanations),
    updatedAt: Date.now(),
  } satisfies DiffExplanationCacheEntry);
}

export function registerDiffReviewCommand(pi: ExtensionAPI): void {
  pi.registerCommand("diff", {
    description: "Review a git diff in a custom TUI (/diff [git diff args])",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      let source: DiffSource;
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
      const cacheKey = getDiffCacheKey(ctx.cwd, source, diffText);
      const comments = getCachedComments(ctx, cacheKey);
      const explanations = getCachedExplanations(ctx, cacheKey);
      if (comments.size > 0) {
        ctx.ui.notify(
          `Restored ${comments.size} cached diff comment${comments.size === 1 ? "" : "s"}.`,
          "info",
        );
      }
      if (explanations.size > 0) {
        ctx.ui.notify(
          `Restored ${explanations.size} cached hunk explanation${explanations.size === 1 ? "" : "s"}.`,
          "info",
        );
      }

      const result = await ctx.ui.custom<ReviewResult>(
        (tui, theme, _keybindings, done) => {
          return new ReviewComponent(
            tui,
            theme,
            source.label,
            reviewLines,
            comments,
            done,
            new PiModelDiffExplainer(ctx),
            (updatedComments) => {
              persistCachedComments(pi, cacheKey, updatedComments.values());
            },
            explanations,
            (updatedExplanations) => {
              persistCachedExplanations(pi, cacheKey, updatedExplanations);
            },
          );
        },
      );

      if (!result || result.action !== "submit") return;
      if (result.comments.length === 0) {
        ctx.ui.notify("No review comments to send.", "info");
        persistCachedComments(pi, cacheKey, []);
        return;
      }

      persistCachedComments(pi, cacheKey, []);
      pi.sendUserMessage(
        buildReviewPrompt(result.comments, source.promptLabel),
      );
    },
  });
}
