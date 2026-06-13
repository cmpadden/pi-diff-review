import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { PersistedAsk, ReviewComment } from "./types.ts";

const REVIEW_COMMENT_CACHE_ENTRY = "pi-diff-review-cache";
const REVIEW_EXPLANATION_CACHE_ENTRY = "pi-diff-review-explanation-cache";
const REVIEW_ASK_CACHE_ENTRY = "pi-diff-review-ask-cache";

type ReviewCommentCacheEntry = {
  cacheKey: string;
  comments: ReviewComment[];
  updatedAt: number;
};

type ReviewExplanationCacheEntry = {
  cacheKey: string;
  explanations: Record<string, string>;
  updatedAt: number;
};

type ReviewAskCacheEntry = {
  cacheKey: string;
  ask?: PersistedAsk;
  updatedAt: number;
};

export function getCachedComments(
  ctx: ExtensionCommandContext,
  cacheKey: string,
): Map<string, ReviewComment> {
  let latest: ReviewCommentCacheEntry | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (
      entry.type !== "custom" ||
      entry.customType !== REVIEW_COMMENT_CACHE_ENTRY
    ) {
      continue;
    }

    const data = entry.data as Partial<ReviewCommentCacheEntry> | undefined;
    if (data?.cacheKey !== cacheKey || !Array.isArray(data.comments)) continue;

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

export function persistCachedComments(
  pi: ExtensionAPI,
  cacheKey: string,
  comments: Iterable<ReviewComment>,
): void {
  pi.appendEntry(REVIEW_COMMENT_CACHE_ENTRY, {
    cacheKey,
    comments: [...comments],
    updatedAt: Date.now(),
  } satisfies ReviewCommentCacheEntry);
}

export function getCachedExplanations(
  ctx: ExtensionCommandContext,
  cacheKey: string,
): Map<string, string> {
  let latest: ReviewExplanationCacheEntry | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (
      entry.type !== "custom" ||
      entry.customType !== REVIEW_EXPLANATION_CACHE_ENTRY
    ) {
      continue;
    }

    const data = entry.data as Partial<ReviewExplanationCacheEntry> | undefined;
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

export function persistCachedExplanations(
  pi: ExtensionAPI,
  cacheKey: string,
  explanations: Map<string, string>,
): void {
  pi.appendEntry(REVIEW_EXPLANATION_CACHE_ENTRY, {
    cacheKey,
    explanations: Object.fromEntries(explanations),
    updatedAt: Date.now(),
  } satisfies ReviewExplanationCacheEntry);
}

export function getCachedAsk(
  ctx: ExtensionCommandContext,
  cacheKey: string,
): PersistedAsk | undefined {
  let latest: ReviewAskCacheEntry | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (
      entry.type !== "custom" ||
      entry.customType !== REVIEW_ASK_CACHE_ENTRY
    ) {
      continue;
    }

    const data = entry.data as Partial<ReviewAskCacheEntry> | undefined;
    if (data?.cacheKey !== cacheKey) continue;

    const ask = data.ask;
    const validAsk =
      ask &&
      typeof ask === "object" &&
      typeof ask.scopeKey === "string" &&
      typeof ask.anchorLineId === "string" &&
      typeof ask.text === "string"
        ? ask
        : undefined;

    if (!latest || (data.updatedAt ?? 0) >= latest.updatedAt) {
      latest = {
        cacheKey: data.cacheKey,
        ask: validAsk,
        updatedAt: data.updatedAt ?? 0,
      };
    }
  }

  return latest?.ask;
}

export function persistCachedAsk(
  pi: ExtensionAPI,
  cacheKey: string,
  ask?: PersistedAsk,
): void {
  pi.appendEntry(REVIEW_ASK_CACHE_ENTRY, {
    cacheKey,
    ask,
    updatedAt: Date.now(),
  } satisfies ReviewAskCacheEntry);
}
