import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspaceServer } from "../src/server.js";

async function eventually(check, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for observable state");
}

test("startup exposes safe readiness, serves the tab shell, and cleans stale temp files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-workspace-"));
  const tempDir = path.join(root, "temp");
  const libraryDir = path.join(root, "library");
  await mkdir(tempDir);
  await mkdir(libraryDir);
  await writeFile(path.join(tempDir, "stale.txt"), "remove me");
  await writeFile(path.join(libraryDir, "kept.txt"), "keep me");

  const app = await createWorkspaceServer({
    env: { FAL_KEY: "fal-secret", OPENROUTER_API_KEY: "" },
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();

  const readiness = await fetch(`${address}/api/readiness`).then((response) => response.json());
  assert.deepEqual(readiness, {
    generation: { ready: true },
    openrouterCatalog: {
      ready: false,
      message: "Set OPENROUTER_API_KEY in .env to load language models.",
    },
    storage: { durable: true, temporary: true },
  });
  assert.doesNotMatch(JSON.stringify(readiness), /fal-secret/);

  const shell = await fetch(address).then((response) => response.text());
  assert.match(shell, /Text/);
  assert.match(shell, /Image/);
  assert.match(shell, /Video/);
  await assert.rejects(readFile(path.join(tempDir, "stale.txt")));
  assert.equal(await readFile(path.join(libraryDir, "kept.txt"), "utf8"), "keep me");
});

test("model catalogs are normalized and media preferences survive restart", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-models-"));
  const calls = [];
  const adapters = {
    async listOpenRouterModels({ token }) {
      calls.push(["openrouter", token]);
      return {
        data: [
          {
            id: "vendor/vision",
            name: "Vision",
            description: "Sees images",
            architecture: { input_modalities: ["text", "image"] },
          },
        ],
      };
    },
    async listFalModels({ category, key }) {
      calls.push([category, key]);
      return {
        models: [
          {
            endpoint_id: category === "text-to-image" ? "fal-ai/flux" : "fal-ai/fast-video",
            metadata: {
              display_name: category === "text-to-image" ? "Flux" : "Fast Video",
              description: "Prompt-only",
            },
          },
          {
            endpoint_id: category === "text-to-image" ? "fal-ai/other" : "fal-ai/other-video",
            metadata: { display_name: "Other" },
          },
        ],
      };
    },
  };
  const options = {
    adapters,
    env: { FAL_KEY: "fal-key", OPENROUTER_API_KEY: "or-key" },
    root,
  };
  const first = await createWorkspaceServer(options);
  t.after(() => first.close());
  const firstAddress = await first.listen();

  const textModels = await fetch(`${firstAddress}/api/models/text`).then((response) => response.json());
  assert.deepEqual(textModels, {
    provider: "openrouter/router",
    models: [
      {
        id: "vendor/vision",
        name: "Vision",
        description: "Sees images",
        supportsImages: true,
      },
    ],
  });
  const imageModels = await fetch(`${firstAddress}/api/models/image?search=flux`).then((response) =>
    response.json(),
  );
  assert.equal(imageModels.models.length, 1);
  assert.equal(imageModels.models[0].id, "fal-ai/flux");
  assert.deepEqual(calls, [
    ["openrouter", "or-key"],
    ["text-to-image", "fal-key"],
  ]);

  const saved = await fetch(`${firstAddress}/api/preferences`, {
    body: JSON.stringify({
      favorites: { image: ["fal-ai/flux"], video: [] },
      selections: { text: "vendor/vision", image: "fal-ai/flux", video: "" },
      concurrency: 2,
    }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
  assert.equal(saved.status, 200);
  await first.close();

  const second = await createWorkspaceServer(options);
  t.after(() => second.close());
  const secondAddress = await second.listen();
  const preferences = await fetch(`${secondAddress}/api/preferences`).then((response) => response.json());
  assert.equal(preferences.selections.image, "fal-ai/flux");
  const ordered = await fetch(`${secondAddress}/api/models/image`).then((response) => response.json());
  assert.equal(ordered.models[0].favorite, true);
});

test("account refresh aggregates month and seven-day usage and retains stale values", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-account-"));
  let fail = false;
  const adapters = {
    async getBilling({ key }) {
      assert.equal(key, "admin-key");
      if (fail) throw new Error("Admin scope required");
      return { username: "local-user", credits: { current_balance: 19.5, currency: "USD" } };
    },
    async getUsage() {
      return {
        data: [
          { date: "2026-07-01", cost: 2 },
          { date: "2026-07-21", cost: 1.25 },
          { date: "2026-07-26", cost: 0.75 },
        ],
      };
    },
  };
  const app = await createWorkspaceServer({
    adapters,
    env: { FAL_KEY: "admin-key", OPENROUTER_API_KEY: "" },
    now: () => new Date("2026-07-27T12:00:00.000Z"),
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();

  const account = await fetch(`${address}/api/account`, { method: "POST" }).then((response) =>
    response.json(),
  );
  assert.equal(account.username, "local-user");
  assert.equal(account.remainingCredits, 19.5);
  assert.equal(account.monthSpend, 4);
  assert.deepEqual(account.daily, [
    { date: "2026-07-21", spend: 1.25 },
    { date: "2026-07-22", spend: 0 },
    { date: "2026-07-23", spend: 0 },
    { date: "2026-07-24", spend: 0 },
    { date: "2026-07-25", spend: 0 },
    { date: "2026-07-26", spend: 0.75 },
    { date: "2026-07-27", spend: 0 },
  ]);
  assert.equal(account.stale, false);

  fail = true;
  const stale = await fetch(`${address}/api/account`, { method: "POST" }).then((response) =>
    response.json(),
  );
  assert.equal(stale.remainingCredits, 19.5);
  assert.equal(stale.stale, true);
  assert.match(stale.error, /Admin scope required/);
});

test("Chat keeps contextual session Conversations and streams regenerated replies", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-chat-"));
  const calls = [];
  const adapters = {
    async *streamChat(input) {
      calls.push(input);
      yield "Hello";
      yield " there";
    },
  };
  const app = await createWorkspaceServer({
    adapters,
    env: { FAL_KEY: "fal-key", OPENROUTER_API_KEY: "" },
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();
  const created = await fetch(`${address}/api/conversations`, {
    body: JSON.stringify({ model: "vendor/model" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());

  const send = async (content) => {
    const text = await fetch(`${address}/api/conversations/${created.id}/messages`, {
      body: JSON.stringify({ content }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }).then((response) => response.text());
    return text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };
  const first = await send("Hi");
  assert.deepEqual(
    first.filter((event) => event.type === "delta").map((event) => event.content),
    ["Hello", " there"],
  );
  await send("Remember me?");
  assert.deepEqual(
    calls[1].messages.map((message) => [message.role, message.content]),
    [
      ["user", "Hi"],
      ["assistant", "Hello there"],
      ["user", "Remember me?"],
    ],
  );

  const regenerated = await fetch(`${address}/api/conversations/${created.id}/regenerate`, {
    method: "POST",
  }).then((response) => response.text());
  const final = regenerated
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .at(-1);
  assert.equal(final.type, "done");
  assert.equal(final.conversation.messages.at(-2).superseded, true);
  assert.equal(final.conversation.messages.at(-1).replaces, final.conversation.messages.at(-2).id);

  const session = await fetch(`${address}/api/conversations`).then((response) => response.json());
  assert.equal(session.conversations.length, 1);
  assert.equal(session.conversations[0].messages.at(-1).content, "Hello there");
});

test("single Image and Video results stay temporary until kept per result", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-media-"));
  const calls = [];
  const adapters = {
    async generateMedia({ endpoint, onState, prompt }) {
      calls.push({ endpoint, prompt });
      onState({ state: "submitted", requestId: `request-${calls.length}` });
      onState({ state: "running" });
      return {
        data:
          endpoint === "fal-ai/image"
            ? { images: [{ url: "https://local/image.png" }] }
            : { video: { url: "https://local/video.mp4" } },
        requestId: `request-${calls.length}`,
      };
    },
    async downloadMedia({ url }) {
      return {
        bytes: Buffer.from(url.includes("image") ? "image-bytes" : "video-bytes"),
        contentType: url.includes("image") ? "image/png" : "video/mp4",
      };
    },
  };
  const options = {
    adapters,
    env: { FAL_KEY: "fal-key", OPENROUTER_API_KEY: "" },
    root,
  };
  const first = await createWorkspaceServer(options);
  t.after(() => first.close());
  const address = await first.listen();

  const image = await fetch(`${address}/api/media`, {
    body: JSON.stringify({ type: "image", model: "fal-ai/image", prompt: "a fox" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
  assert.equal(image.state, "completed");
  assert.equal(image.requestId, "request-1");
  assert.equal(
    await fetch(`${address}${image.fileUrl}`).then((response) => response.text()),
    "image-bytes",
  );
  const kept = await fetch(`${address}/api/results/${image.id}/keep`, { method: "POST" }).then(
    (response) => response.json(),
  );
  assert.equal(kept.state, "kept");

  const video = await fetch(`${address}/api/media`, {
    body: JSON.stringify({ type: "video", model: "fal-ai/video", prompt: "a wave" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
  assert.equal(video.state, "completed");
  const discarded = await fetch(`${address}/api/results/${video.id}`, { method: "DELETE" });
  assert.equal(discarded.status, 204);
  assert.deepEqual(calls, [
    { endpoint: "fal-ai/image", prompt: "a fox" },
    { endpoint: "fal-ai/video", prompt: "a wave" },
  ]);
  await first.close();

  const second = await createWorkspaceServer(options);
  t.after(() => second.close());
  const secondAddress = await second.listen();
  const library = await fetch(`${secondAddress}/api/results?type=image`).then((response) =>
    response.json(),
  );
  assert.equal(library.results.length, 1);
  assert.equal(library.results[0].prompt, "a fox");
  assert.equal(library.results[0].state, "kept");
  assert.equal(
    await fetch(`${secondAddress}${library.results[0].fileUrl}`).then((response) => response.text()),
    "image-bytes",
  );
});

test("validated Chat images and whole kept Conversations survive restart", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-conversation-"));
  const chatCalls = [];
  const adapters = {
    async listOpenRouterModels() {
      return {
        data: [
          {
            id: "vendor/vision",
            name: "Vision",
            architecture: { input_modalities: ["text", "image"] },
          },
        ],
      };
    },
    async *streamChat(input) {
      chatCalls.push(input);
      yield "I see it";
    },
  };
  const options = {
    adapters,
    env: { FAL_KEY: "fal-key", OPENROUTER_API_KEY: "or-key" },
    root,
  };
  const first = await createWorkspaceServer(options);
  t.after(() => first.close());
  const address = await first.listen();
  await fetch(`${address}/api/models/text`);
  const conversation = await fetch(`${address}/api/conversations`, {
    body: JSON.stringify({ model: "vendor/vision" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());

  const invalid = await fetch(`${address}/api/conversations/${conversation.id}/messages`, {
    body: JSON.stringify({
      content: "bad image",
      attachment: { name: "image.png", type: "image/png", data: "aGVsbG8=" },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(invalid.status, 415);
  assert.equal(chatCalls.length, 0);

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("fake"),
  ]);
  await fetch(`${address}/api/conversations/${conversation.id}/messages`, {
    body: JSON.stringify({
      content: "What is this?",
      attachment: { name: "image.png", type: "image/png", data: png.toString("base64") },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.text());
  assert.equal(chatCalls.length, 1);
  assert.equal(chatCalls[0].messages[0].content[0].text, "What is this?");
  assert.match(chatCalls[0].messages[0].content[1].image_url.url, /^data:image\/png;base64,/);

  const kept = await fetch(`${address}/api/conversations/${conversation.id}/keep`, {
    method: "POST",
  }).then((response) => response.json());
  assert.equal(kept.kept, true);
  await first.close();

  const second = await createWorkspaceServer(options);
  t.after(() => second.close());
  const secondAddress = await second.listen();
  const restored = await fetch(`${secondAddress}/api/conversations`).then((response) =>
    response.json(),
  );
  assert.equal(restored.conversations.length, 1);
  assert.equal(restored.conversations[0].messages[0].attachments.length, 1);
  const restoredAttachment = await fetch(
    `${secondAddress}${restored.conversations[0].messages[0].attachments[0].fileUrl}`,
  ).then((response) => response.arrayBuffer());
  assert.deepEqual(
    [...new Uint8Array(restoredAttachment)],
    [...png],
  );
});

test("a Text message sends multiple attachments to the model in selection order", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-multiple-chat-attachments-"));
  const chatCalls = [];
  const app = await createWorkspaceServer({
    adapters: {
      async listOpenRouterModels() {
        return {
          data: [
            {
              id: "vendor/vision",
              name: "Vision",
              architecture: { input_modalities: ["text", "image"] },
            },
          ],
        };
      },
      async *streamChat(input) {
        chatCalls.push(input);
        yield "Compared";
      },
    },
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "fake-key" },
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();
  await fetch(`${address}/api/models/text`);
  const conversation = await fetch(`${address}/api/conversations`, {
    body: JSON.stringify({ model: "vendor/vision" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);

  await fetch(`${address}/api/conversations/${conversation.id}/messages`, {
    body: JSON.stringify({
      content: "Compare these",
      attachments: [
        { name: "first.png", type: "image/png", data: png.toString("base64") },
        { name: "second.jpg", type: "image/jpeg", data: jpeg.toString("base64") },
      ],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.text());

  assert.deepEqual(chatCalls[0].messages[0].content, [
    { type: "text", text: "Compare these" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
  ]);
});

test("a Text message accepts a file without a local format restriction", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-unrestricted-chat-attachment-"));
  const chatCalls = [];
  const app = await createWorkspaceServer({
    adapters: {
      async listOpenRouterModels() {
        return {
          data: [
            {
              id: "vendor/text",
              name: "Text",
              architecture: { input_modalities: ["text"] },
            },
          ],
        };
      },
      async *streamChat(input) {
        chatCalls.push(input);
        yield "Summarized";
      },
    },
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "fake-key" },
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();
  await fetch(`${address}/api/models/text`);
  const conversation = await fetch(`${address}/api/conversations`, {
    body: JSON.stringify({ model: "vendor/text" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
  const notes = Buffer.from("alpha\nbeta\n");

  const response = await fetch(`${address}/api/conversations/${conversation.id}/messages`, {
    body: JSON.stringify({
      content: "Summarize this",
      attachments: [
        { name: "notes.txt", type: "text/plain", data: notes.toString("base64") },
      ],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  await response.text();

  assert.deepEqual(
    {
      status: response.status,
      content: chatCalls[0]?.messages[0].content,
    },
    {
      status: 200,
      content: [
        { type: "text", text: "Summarize this" },
        {
          type: "file",
          file: {
            filename: "notes.txt",
            file_data: `data:text/plain;base64,${notes.toString("base64")}`,
          },
        },
      ],
    },
  );
});

test("Image and Video Batches share a fair runtime-configurable queue", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-batch-"));
  const releases = [];
  const starts = [];
  let active = 0;
  let maximum = 0;
  const adapters = {
    async generateMedia({ endpoint, onState }) {
      active += 1;
      maximum = Math.max(maximum, active);
      starts.push(endpoint);
      onState({ state: "submitted", requestId: `request-${starts.length}` });
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      return {
        data: {
          media: {
            url: endpoint.includes("video")
              ? "https://local/result.mp4"
              : "https://local/result.png",
          },
        },
        requestId: `request-${starts.length}`,
      };
    },
    async downloadMedia({ url }) {
      return {
        bytes: Buffer.from(url),
        contentType: url.endsWith(".mp4") ? "video/mp4" : "image/png",
      };
    },
  };
  const app = await createWorkspaceServer({
    adapters,
    env: { FAL_KEY: "fal-key", OPENROUTER_API_KEY: "" },
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();
  const createBatch = (type, quantity) =>
    fetch(`${address}/api/batches`, {
      body: JSON.stringify({
        type,
        model: `fal-ai/${type}`,
        prompt: `${type} prompt`,
        quantity,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }).then((response) => response.json());

  const imageBatch = await createBatch("image", 4);
  assert.equal(imageBatch.results.length, 4);
  assert.equal(
    imageBatch.results.every((result) => ["queued", "submitting"].includes(result.state)),
    true,
  );
  await eventually(() => starts.length === 2);
  assert.equal(maximum, 2);

  const videoBatch = await createBatch("video", 1);
  releases.shift()();
  await eventually(() => starts.includes("fal-ai/video"));
  assert.equal(starts[2], "fal-ai/video");

  const preferences = await fetch(`${address}/api/preferences`).then((response) => response.json());
  preferences.concurrency = 3;
  await fetch(`${address}/api/preferences`, {
    body: JSON.stringify(preferences),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
  await eventually(() => maximum === 3);

  await eventually(async () => {
    while (releases.length) releases.shift()();
    const batch = await fetch(`${address}/api/batches/${imageBatch.id}`).then((response) =>
      response.json(),
    );
    return batch.results.every((result) => result.state === "completed") && batch;
  });
  await eventually(async () => {
    const batch = await fetch(`${address}/api/batches/${videoBatch.id}`).then((response) =>
      response.json(),
    );
    return batch.results.every((result) => result.state === "completed");
  });

  const completed = await fetch(`${address}/api/batches/${imageBatch.id}`).then((response) =>
    response.json(),
  );
  const reviewed = await fetch(`${address}/api/results/bulk`, {
    body: JSON.stringify({
      keep: [completed.results[0].id, completed.results[1].id],
      discard: [completed.results[2].id, completed.results[3].id],
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
  assert.deepEqual(
    reviewed.results.map((result) => result.state),
    ["kept", "kept", "discarded", "discarded"],
  );
});

test("Prompt templates are durable CRUD records filtered by media type", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-templates-"));
  const options = {
    env: { FAL_KEY: "", OPENROUTER_API_KEY: "" },
    now: () => new Date("2026-07-27T12:00:00.000Z"),
    root,
  };
  const first = await createWorkspaceServer(options);
  t.after(() => first.close());
  const address = await first.listen();
  const createTemplate = (type, name, prompt) =>
    fetch(`${address}/api/templates`, {
      body: JSON.stringify({ type, name, prompt }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }).then((response) => response.json());

  const image = await createTemplate("image", "Portrait", "A portrait of {{subject}}");
  await createTemplate("text", "Summary", "Summarize this");
  const images = await fetch(`${address}/api/templates?type=image`).then((response) =>
    response.json(),
  );
  assert.equal(images.templates.length, 1);
  assert.equal(images.templates[0].prompt, "A portrait of {{subject}}");

  const updated = await fetch(`${address}/api/templates/${image.id}`, {
    body: JSON.stringify({ name: "Portrait close-up", prompt: "A close portrait" }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  }).then((response) => response.json());
  assert.equal(updated.name, "Portrait close-up");
  assert.equal(updated.updatedAt, "2026-07-27T12:00:00.000Z");
  await first.close();

  const second = await createWorkspaceServer(options);
  t.after(() => second.close());
  const secondAddress = await second.listen();
  const restored = await fetch(`${secondAddress}/api/templates?type=image`).then((response) =>
    response.json(),
  );
  assert.equal(restored.templates[0].prompt, "A close portrait");
  const deleted = await fetch(`${secondAddress}/api/templates/${image.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 204);
  const empty = await fetch(`${secondAddress}/api/templates?type=image`).then((response) =>
    response.json(),
  );
  assert.equal(empty.templates.length, 0);
});

test("cancellation, linked manual retry, and shutdown do not resubmit paid work", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-cancel-"));
  const pending = new Map();
  const cancelled = [];
  let requestNumber = 0;
  const failedPrompts = new Set();
  const adapters = {
    async generateMedia({ onState, prompt }) {
      requestNumber += 1;
      const requestId = `remote-${requestNumber}`;
      onState({ state: "submitted", requestId });
      onState({ state: "running" });
      if (prompt === "fail once" && !failedPrompts.has(prompt)) {
        failedPrompts.add(prompt);
        throw new Error("upstream failed");
      }
      await new Promise((resolve) => pending.set(requestId, resolve));
      return {
        data: { image: { url: "https://local/result.png" } },
        requestId,
      };
    },
    async cancelMedia({ requestId }) {
      cancelled.push(requestId);
      pending.get(requestId)?.();
    },
    async downloadMedia({ url }) {
      return { bytes: Buffer.from(url), contentType: "image/png" };
    },
  };
  const app = await createWorkspaceServer({
    adapters,
    env: { FAL_KEY: "fal-key", OPENROUTER_API_KEY: "" },
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();
  const batch = await fetch(`${address}/api/batches`, {
    body: JSON.stringify({
      type: "image",
      model: "fal-ai/image",
      prompt: "wait",
      quantity: 3,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
  await eventually(() => pending.size === 2);

  const queuedCancel = await fetch(`${address}/api/results/${batch.results[2].id}/cancel`, {
    method: "POST",
  }).then((response) => response.json());
  assert.equal(queuedCancel.state, "cancelled");
  assert.equal(requestNumber, 2);

  const runningCancel = await fetch(`${address}/api/results/${batch.results[0].id}/cancel`, {
    method: "POST",
  }).then((response) => response.json());
  assert.equal(runningCancel.state, "cancelled");
  assert.deepEqual(cancelled, ["remote-1"]);
  pending.get("remote-2")();
  await eventually(async () => {
    const current = await fetch(`${address}/api/batches/${batch.id}`).then((response) =>
      response.json(),
    );
    return current.results[1].state === "completed";
  });

  const failed = await fetch(`${address}/api/media`, {
    body: JSON.stringify({
      type: "image",
      model: "fal-ai/image",
      prompt: "fail once",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
  assert.equal(failed.state, "failed");
  const retried = await fetch(`${address}/api/results/${failed.id}/retry`, {
    method: "POST",
  }).then((response) => response.json());
  assert.equal(retried.attemptOf, failed.id);
  const runningRetry = await eventually(async () => {
    const current = await fetch(`${address}/api/results?type=image`).then((response) =>
      response.json(),
    );
    const attempt = current.results.find((result) => result.id === retried.id);
    return attempt?.requestId && pending.has(attempt.requestId) ? attempt : null;
  });
  pending.get(runningRetry.requestId)();
  await eventually(async () => {
    const current = await fetch(`${address}/api/results?type=image`).then((response) =>
      response.json(),
    );
    return current.results.find((result) => result.id === retried.id)?.state === "completed";
  });

  await fetch(`${address}/api/batches`, {
    body: JSON.stringify({
      type: "image",
      model: "fal-ai/image",
      prompt: "shutdown",
      quantity: 2,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
  await eventually(() => pending.has("remote-5") && pending.has("remote-6"));
  await app.close();
  assert.equal(cancelled.includes("remote-5"), true);
  assert.equal(cancelled.includes("remote-6"), true);
  assert.deepEqual(await readdir(path.join(root, "temp")), []);
});
