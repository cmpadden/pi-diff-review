import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  buildAskPrompt,
  buildExplanationPrompt,
  PiModelDiffExplainer,
  type ExplanationScope,
} from "../../src/explanation/explainer.ts";

const model: Model<"openai-completions"> = {
  id: "review-model",
  name: "Review model",
  api: "openai-completions",
  provider: "custom-review-provider",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};

const scope: ExplanationScope = {
  key: "hunk-1",
  kind: "hunk",
  title: "example.ts",
  diffText: "-const count = 1;\n+const count = 2;",
};

function message(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createExplainer(events: AssistantMessageEvent[]) {
  const streamSimple = mock.fn<
    ExtensionCommandContext["modelRegistry"]["streamSimple"]
  >(() => {
    const stream = createAssistantMessageEventStream();
    for (const event of events) stream.push(event);
    stream.end();
    return stream;
  });
  const ctx = {
    model,
    modelRegistry: { streamSimple },
  } as unknown as ExtensionCommandContext;
  return { explainer: new PiModelDiffExplainer(ctx), streamSimple, ctx };
}

describe("PiModelDiffExplainer", () => {
  it("streams through the configured model registry with the review context and abort signal", async () => {
    const partial = message("A streamed explanation");
    const final = message("  Final explanation  ");
    final.content.unshift({ type: "thinking", thinking: "Private reasoning" });
    const { explainer, streamSimple } = createExplainer([
      { type: "start", partial },
      { type: "text_delta", contentIndex: 0, delta: "A streamed ", partial },
      { type: "text_delta", contentIndex: 0, delta: "explanation", partial },
      { type: "done", reason: "stop", message: final },
    ]);
    const controller = new AbortController();
    const deltas: string[] = [];

    const result = await explainer.explain(scope, undefined, {
      signal: controller.signal,
      onDelta: (delta) => deltas.push(delta),
    });

    assert.equal(result, "Final explanation");
    assert.deepEqual(deltas, ["A streamed ", "explanation"]);
    assert.equal(streamSimple.mock.callCount(), 1);
    const [selectedModel, context, options] =
      streamSimple.mock.calls[0].arguments;
    assert.equal(selectedModel, model);
    assert.match(context.systemPrompt ?? "", /intent, behavior, and risk/);
    assert.equal(context.messages.length, 1);
    assert.equal(context.messages[0].role, "user");
    assert.equal(context.messages[0].content, buildExplanationPrompt(scope));
    assert.deepEqual(options, {
      signal: controller.signal,
      maxTokens: 800,
      reasoning: "minimal",
    });
    controller.abort();
    assert.equal(options?.signal?.aborted, true);
  });

  it("uses the ask prompt for questions about a file", async () => {
    const fileScope: ExplanationScope = {
      ...scope,
      kind: "file",
      filePath: "src/example.ts",
      diffText: "const count = 2;",
    };
    const { explainer, streamSimple } = createExplainer([
      { type: "done", reason: "stop", message: message("It counts items.") },
    ]);

    assert.equal(
      await explainer.explain(fileScope, "What does count represent?"),
      "It counts items.",
    );
    assert.equal(
      streamSimple.mock.calls[0].arguments[1].messages[0].content,
      buildAskPrompt(fileScope, "What does count represent?"),
    );
  });

  it("falls back to streamed text when the final response has no text", async () => {
    const partial = message("  Streamed fallback  ");
    const { explainer } = createExplainer([
      {
        type: "text_delta",
        contentIndex: 0,
        delta: "  Streamed fallback  ",
        partial,
      },
      { type: "done", reason: "stop", message: message("") },
    ]);

    assert.equal(await explainer.explain(scope), "Streamed fallback");
  });

  for (const [reason, errorMessage] of [
    ["error", "No API key found for custom-review-provider"],
    ["error", "Unknown provider"],
    ["aborted", "Request aborted"],
    ["error", undefined],
  ] as const) {
    it(`reports registry errors: ${errorMessage ?? "default message"}`, async () => {
      const error = { ...message(""), stopReason: reason, errorMessage };
      const { explainer } = createExplainer([{ type: "error", reason, error }]);

      await assert.rejects(explainer.explain(scope), {
        message: errorMessage ?? "Explanation failed.",
      });
    });
  }

  it("reports when no model is selected without starting a stream", async () => {
    const { explainer, streamSimple, ctx } = createExplainer([]);
    ctx.model = undefined;

    await assert.rejects(explainer.explain(scope), {
      message: "No model is selected.",
    });
    assert.equal(streamSimple.mock.callCount(), 0);
  });
});
