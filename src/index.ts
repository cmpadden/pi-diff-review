import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getDiff, parseDiffSource } from "./diff-source.ts";
import { parseDiff } from "./diff-parser.ts";
import { PiModelDiffExplainer } from "./explain.ts";
import { buildReviewPrompt } from "./prompt.ts";
import { ReviewComponent } from "./review-component.ts";
import type { DiffSource, ReviewComment, ReviewResult } from "./types.ts";

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
      const result = await ctx.ui.custom<ReviewResult>(
        (tui, theme, _keybindings, done) => {
          const comments = new Map<string, ReviewComment>();
          return new ReviewComponent(
            tui,
            theme,
            source.label,
            reviewLines,
            comments,
            done,
            new PiModelDiffExplainer(ctx),
          );
        },
      );

      if (!result || result.action !== "submit") return;
      if (result.comments.length === 0) {
        ctx.ui.notify("No review comments to send.", "info");
        return;
      }

      pi.sendUserMessage(
        buildReviewPrompt(result.comments, source.promptLabel),
      );
    },
  });
}
