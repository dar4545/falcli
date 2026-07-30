import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspaceServer } from "../src/server.js";
import { defaultAdapters } from "../src/upstreams.js";

test("OpenRouter reasoning is yielded before the upstream stream completes", async (t) => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const controllerRef = {
    /** @type {ReadableStreamDefaultController<Uint8Array> | null} */
    current: null,
  };
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(value) {
          controllerRef.current = value;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const stream = defaultAdapters.streamChat({
    key: "fake-key",
    messages: [{ role: "user", content: "Hi" }],
    model: "vendor/reasoner",
  });
  const firstResult = stream.next();
  assert(controllerRef.current);
  controllerRef.current.enqueue(
    encoder.encode(
      `data: ${JSON.stringify({
        choices: [{ delta: { reasoning: "Consider the request.\n" } }],
      })}\n\n`,
    ),
  );

  const first = await Promise.race([
    firstResult,
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 50)),
  ]);
  assert(controllerRef.current);
  controllerRef.current.enqueue(
    encoder.encode(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "First line\n" } }],
      })}\n\ndata: [DONE]\n\n`,
    ),
  );
  controllerRef.current.close();
  await firstResult;

  assert.deepEqual(first, {
    value: { type: "reasoning", content: "Consider the request.\n" },
    done: false,
  });
});

test("OpenRouter reasoning details expose their visible streamed text", async (t) => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      reasoning_details: [
                        { type: "reasoning.summary", summary: "Summary.\n" },
                        { type: "reasoning.text", text: "Detailed thought.\n" },
                        { type: "reasoning.encrypted", data: "opaque" },
                      ],
                    },
                  },
                ],
              })}\n\ndata: [DONE]\n\n`,
            ),
          );
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const chunks = [];
  for await (const chunk of defaultAdapters.streamChat({
    key: "fake-key",
    messages: [{ role: "user", content: "Hi" }],
    model: "vendor/reasoner",
  })) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    { type: "reasoning", content: "Summary.\n" },
    { type: "reasoning", content: "Detailed thought.\n" },
  ]);
});

test("the saved real FAL stream reference replays its incremental answer", async (t) => {
  const reference = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/chat-streaming/deepseek-v4-flash-2026-07-29.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(`${reference.response.rawSseFrames.join("\n\n")}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const chunks = [];
  for await (const chunk of defaultAdapters.streamChat({
    key: "fake-key",
    messages: reference.request.messages,
    model: reference.request.model,
  })) {
    chunks.push(chunk);
  }

  assert.deepEqual(
    {
      content: chunks
        .filter((chunk) => chunk.type === "content")
        .map((chunk) => chunk.content)
        .join(""),
      reasoning: chunks
        .filter((chunk) => chunk.type === "reasoning")
        .map((chunk) => chunk.content)
        .join(""),
    },
    {
      content: reference.response.parsed.content,
      reasoning: "",
    },
  );
});

test("the Conversation HTTP stream preserves reasoning before answer content", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-chat-reasoning-stream-"));
  let releaseAnswer = () => {};
  /** @type {Promise<void>} */
  const answerGate = new Promise((resolve) => {
    releaseAnswer = resolve;
  });
  const app = await createWorkspaceServer({
    adapters: {
      async *streamChat() {
        yield { type: "reasoning", content: "Consider the request.\n" };
        await answerGate;
        yield { type: "content", content: "First line\n" };
        yield { type: "content", content: "Second line" };
      },
    },
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();
  const conversation = await fetch(`${address}/api/conversations`, {
    body: JSON.stringify({ model: "vendor/reasoner" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
  const response = await fetch(`${address}/api/conversations/${conversation.id}/messages`, {
    body: JSON.stringify({ content: "Hi" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const firstRead = await reader.read();
  const firstEvent = JSON.parse(decoder.decode(firstRead.value).trim());
  releaseAnswer();
  let remainder = "";
  while (true) {
    const { done, value } = await reader.read();
    remainder += decoder.decode(value, { stream: !done });
    if (done) break;
  }
  const events = remainder
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const assistant = events.at(-1).conversation.messages.at(-1);

  assert.deepEqual(
    {
      firstEvent,
      remainingTypes: events.map((event) => event.type),
      assistant: {
        content: assistant.content,
        reasoning: assistant.reasoning,
      },
    },
    {
      firstEvent: { type: "reasoning", content: "Consider the request.\n" },
      remainingTypes: ["delta", "delta", "done"],
      assistant: {
        content: "First line\nSecond line",
        reasoning: "Consider the request.\n",
      },
    },
  );
});
