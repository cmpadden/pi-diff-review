import { streamSimple } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";

export type ExplanationScope = {
  key: string;
  kind: "hunk" | "file";
  title: string;
  filePath?: string;
  diffText: string;
};

export type ExplanationState =
  | { status: "loading"; text: string }
  | { status: "ready"; text: string }
  | { status: "error"; message: string };

export type DiffExplainer = {
  explain(
    scope: ExplanationScope,
    question?: string,
    options?: {
      signal?: AbortSignal;
      onDelta?: (delta: string) => void;
    },
  ): Promise<string>;
};

export function buildAskPrompt(
  scope: ExplanationScope,
  question: string,
): string {
  if (scope.kind === "file") {
    return `Given this code excerpt:\n\`\`\`${scope.filePath ? ` ${scope.filePath}` : ""}\n${scope.diffText}\n\`\`\`\n\n${question}`;
  }

  return `Given this git diff hunk:\n\`\`\`diff\n${scope.diffText}\n\`\`\`\n\n${question}`;
}

export function buildExplanationPrompt(scope: ExplanationScope): string {
  if (scope.kind === "file") {
    return `Explain this code excerpt for a reviewer.

Focus on:
- what this code is doing
- why it matters in context
- behavioral, API, or test implications
- notable risks or edge cases

Keep it concise and practical.

\`\`\`${scope.filePath ? ` ${scope.filePath}` : ""}
${scope.diffText}
\`\`\``;
  }

  return `Explain this git diff hunk for a code reviewer.

Focus on:
- what changed
- why it matters
- behavioral, API, or test implications
- notable risks or edge cases

Keep it concise and practical. Do not suggest code changes unless they are directly relevant to understanding the diff.

\`\`\`diff
${scope.diffText}
\`\`\``;
}

export class PiModelDiffExplainer implements DiffExplainer {
  constructor(private ctx: ExtensionCommandContext) {}

  async explain(
    scope: ExplanationScope,
    question?: string,
    options: {
      signal?: AbortSignal;
      onDelta?: (delta: string) => void;
    } = {},
  ): Promise<string> {
    const model = this.ctx.model;
    if (!model) {
      throw new Error("No model is selected.");
    }

    const auth = await this.ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      throw new Error(auth.error);
    }

    const context: Context = {
      systemPrompt:
        "You explain code clearly and concisely for review. Focus on intent, behavior, and risk. Avoid restating every line.",
      messages: [
        {
          role: "user",
          content: question
            ? buildAskPrompt(scope, question)
            : buildExplanationPrompt(scope),
          timestamp: Date.now(),
        },
      ],
    };

    let streamedText = "";
    const stream = streamSimple(model, context, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: options.signal,
      maxTokens: 800,
      reasoning: "minimal",
    });

    for await (const event of stream) {
      if (event.type === "text_delta") {
        streamedText += event.delta;
        options.onDelta?.(event.delta);
      } else if (event.type === "done") {
        return extractText(event.message) || streamedText.trim();
      } else if (event.type === "error") {
        throw new Error(event.error.errorMessage ?? "Explanation failed.");
      }
    }

    return streamedText.trim();
  }
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("")
    .trim();
}
