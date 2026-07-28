import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspaceServer } from "../src/server.js";

async function start(t, adapters = {}, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "fal-image-batches-"));
  const app = await createWorkspaceServer({
    adapters,
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
    ...options,
  });
  t.after(() => app.close());
  return { address: await app.listen(), root };
}

async function stage(address, name, bytes, type = "image/png") {
  const response = await fetch(
    `${address}/api/media-sources?name=${encodeURIComponent(name)}`,
    {
      body: bytes,
      headers: { "content-type": type },
      method: "POST",
    },
  );
  return { response, source: await response.json() };
}

async function eventually(check, timeout = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met before timeout");
}

test("a non-empty local source is staged temporarily and retrievable through HTTP", async (t) => {
  const { address } = await start(t);
  const bytes = Buffer.from("fake image bytes");

  const { response, source } = await stage(address, "reference.png", bytes);

  assert.equal(response.status, 201);
  assert.equal(source.name, "reference.png");
  assert.equal(source.type, "image/png");
  assert.equal(source.size, bytes.length);
  assert.match(source.hash, /^[a-f0-9]{64}$/);
  assert.equal(source.state, "Local");
  const retrieved = await fetch(`${address}${source.fileUrl}`).then((result) =>
    result.arrayBuffer(),
  );
  assert.deepEqual(
    Buffer.from(/** @type {ArrayBuffer} */ (retrieved)),
    bytes,
  );
});

test("an empty local source is rejected before it can enter a Batch", async (t) => {
  const { address } = await start(t);

  const { response, source } = await stage(address, "empty.png", Buffer.alloc(0));

  assert.equal(response.status, 400);
  assert.match(source.error, /must not be empty/i);
});

test("a source declared above 1 GiB is rejected before its body is read", async (t) => {
  const { address } = await start(t);
  const target = new URL("/api/media-sources?name=huge.png", address);

  const result = await new Promise((resolve, reject) => {
    const request = http.request(
      target,
      {
        headers: {
          "content-length": String(1024 ** 3 + 1),
          "content-type": "image/png",
        },
        method: "POST",
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      },
    );
    request.on("error", reject);
    request.end();
  });

  assert.equal(result.status, 413);
  assert.match(result.body.error, /1 GiB/i);
});

test("a Batch maps scalar and ordered array source ids to exact schema field URLs", async (t) => {
  const generatedInputs = [];
  const uploads = [];
  const { address } = await start(t, {
    async uploadMediaSource(source) {
      uploads.push(source);
      return { url: `https://storage.local/${source.name}` };
    },
    async generateMedia({ input }) {
      generatedInputs.push(input);
      return { data: { image: { url: "https://result.local/image.png" } } };
    },
    async downloadMedia() {
      return { bytes: Buffer.from("result"), contentType: "image/png" };
    },
  });
  const mask = (await stage(address, "mask.png", Buffer.from("mask"))).source;
  const first = (await stage(address, "first.png", Buffer.from("first"))).source;
  const second = (await stage(address, "second.png", Buffer.from("second"))).source;

  const response = await fetch(`${address}/api/batches`, {
    body: JSON.stringify({
      type: "image",
      mode: "image-to-image",
      model: "fal-ai/image-edit",
      prompt: "transform this",
      quantity: 1,
      sourceFields: {
        mask_url: mask.id,
        image_urls: [second.id, first.id],
      },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const batch = await response.json();

  assert.equal(response.status, 201);
  assert.equal(batch.mode, "image-to-image");
  assert.deepEqual(
    batch.sourceFields.image_urls.map((source) => source.name),
    ["second.png", "first.png"],
  );
  await eventually(() => generatedInputs.length === 1);
  assert.deepEqual(generatedInputs[0], {
    prompt: "transform this",
    mask_url: "https://storage.local/mask.png",
    image_urls: [
      "https://storage.local/second.png",
      "https://storage.local/first.png",
    ],
  });
  assert.deepEqual(
    uploads.map((upload) => upload.lifecycle),
    [
      { expiresIn: "1d" },
      { expiresIn: "1d" },
      { expiresIn: "1d" },
    ],
  );
});

test("identical source bytes are uploaded only once within a Batch", async (t) => {
  const uploads = [];
  const { address } = await start(t, {
    async uploadMediaSource(source) {
      uploads.push(source.hash);
      return { url: `https://storage.local/${source.hash}` };
    },
    async generateMedia() {
      return { data: { image: { url: "https://result.local/image.png" } } };
    },
    async downloadMedia() {
      return { bytes: Buffer.from("result"), contentType: "image/png" };
    },
  });
  const first = (await stage(address, "one.png", Buffer.from("same bytes"))).source;
  const duplicate = (await stage(address, "two.png", Buffer.from("same bytes"))).source;

  const response = await fetch(`${address}/api/batches`, {
    body: JSON.stringify({
      type: "image",
      mode: "image-to-image",
      model: "fal-ai/image-edit",
      quantity: 1,
      sourceFields: { image_urls: [first.id, duplicate.id] },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  assert.equal(response.status, 201);
  assert.equal(uploads.length, 1);
});

test("every result in a Batch reuses the same immutable generation input", async (t) => {
  const generatedInputs = [];
  const { address } = await start(t, {
    async uploadMediaSource({ name }) {
      return { url: `https://storage.local/${name}` };
    },
    async generateMedia({ input }) {
      generatedInputs.push(input);
      return { data: { image: { url: "https://result.local/image.png" } } };
    },
    async downloadMedia() {
      return { bytes: Buffer.from("result"), contentType: "image/png" };
    },
  });
  const source = (await stage(address, "reference.png", Buffer.from("reference"))).source;

  await fetch(`${address}/api/batches`, {
    body: JSON.stringify({
      type: "image",
      mode: "image-to-image",
      model: "fal-ai/image-edit",
      prompt: "same input",
      quantity: 3,
      sourceFields: { image_url: source.id },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  await eventually(() => generatedInputs.length === 3);

  assert.equal(generatedInputs[0], generatedInputs[1]);
  assert.equal(generatedInputs[1], generatedInputs[2]);
  assert.equal(Object.isFrozen(generatedInputs[0]), true);
});

test("a Batch rejects unique source bytes above its aggregate transport limit", async (t) => {
  let inferenceCount = 0;
  const { address } = await start(
    t,
    {
      async generateMedia() {
        inferenceCount += 1;
      },
      async uploadMediaSource() {
        return { url: "https://storage.local/source" };
      },
    },
    { sourceLimits: { fileBytes: 5, batchBytes: 6 } },
  );
  const first = (await stage(address, "first.png", Buffer.from("1234"))).source;
  const second = (await stage(address, "second.png", Buffer.from("5678"))).source;

  const response = await fetch(`${address}/api/batches`, {
    body: JSON.stringify({
      type: "image",
      mode: "image-to-image",
      model: "fal-ai/image-edit",
      quantity: 1,
      sourceFields: { image_urls: [first.id, second.id] },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.match(body.error, /2 GiB/i);
  assert.equal(inferenceCount, 0);
});

test("an upload failure returns a transport error and starts zero inference", async (t) => {
  let inferenceCount = 0;
  const { address } = await start(t, {
    async uploadMediaSource({ name }) {
      if (name === "broken.png") throw new Error("storage unavailable");
      return { url: `https://storage.local/${name}` };
    },
    async generateMedia() {
      inferenceCount += 1;
    },
  });
  const valid = (await stage(address, "valid.png", Buffer.from("valid"))).source;
  const broken = (await stage(address, "broken.png", Buffer.from("broken"))).source;

  const response = await fetch(`${address}/api/batches`, {
    body: JSON.stringify({
      type: "image",
      mode: "image-to-image",
      model: "fal-ai/image-edit",
      quantity: 2,
      sourceFields: { image_urls: [valid.id, broken.id] },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = await response.json();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(response.status, 502);
  assert.match(body.error, /storage unavailable/i);
  assert.equal(inferenceCount, 0);
});

test("a staged source can be removed before Batch creation", async (t) => {
  const { address } = await start(t);
  const source = (await stage(address, "remove.png", Buffer.from("remove me"))).source;

  const removed = await fetch(`${address}/api/media-sources/${source.id}`, {
    method: "DELETE",
  });
  const missing = await fetch(`${address}${source.fileUrl}`);

  assert.equal(removed.status, 204);
  assert.equal(missing.status, 404);
});

test("all source uploads finish before the first inference starts", async (t) => {
  const releases = [];
  const uploadStarts = [];
  let inferenceCount = 0;
  const { address } = await start(t, {
    async uploadMediaSource({ name }) {
      uploadStarts.push(name);
      await new Promise((resolve) => releases.push(resolve));
      return { url: `https://storage.local/${name}` };
    },
    async generateMedia() {
      inferenceCount += 1;
      return { data: { image: { url: "https://result.local/image.png" } } };
    },
    async downloadMedia() {
      return { bytes: Buffer.from("result"), contentType: "image/png" };
    },
  });
  const first = (await stage(address, "first.png", Buffer.from("first"))).source;
  const second = (await stage(address, "second.png", Buffer.from("second"))).source;

  const creating = fetch(`${address}/api/batches`, {
    body: JSON.stringify({
      type: "image",
      mode: "image-to-image",
      model: "fal-ai/image-edit",
      quantity: 1,
      sourceFields: { image_urls: [first.id, second.id] },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  await eventually(() => uploadStarts.length === 1);
  assert.equal(inferenceCount, 0);
  releases.shift()();
  await eventually(() => uploadStarts.length === 2);
  assert.equal(inferenceCount, 0);
  releases.shift()();
  assert.equal((await creating).status, 201);
  await eventually(() => inferenceCount === 1);
});

test("FAL receives a Batch even when schema-required prompt and file fields are absent", async (t) => {
  const generatedInputs = [];
  const { address } = await start(t, {
    async generateMedia({ input }) {
      generatedInputs.push(input);
      return { data: { image: { url: "https://result.local/image.png" } } };
    },
    async downloadMedia() {
      return { bytes: Buffer.from("result"), contentType: "image/png" };
    },
  });

  const response = await fetch(`${address}/api/batches`, {
    body: JSON.stringify({
      type: "image",
      mode: "image-to-image",
      model: "fal-ai/requires-input",
      prompt: "",
      quantity: 1,
      sourceFields: {},
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  assert.equal(response.status, 201);
  await eventually(() => generatedInputs.length === 1);
  assert.deepEqual(generatedInputs[0], { prompt: "" });
});

test("legacy prompt-only Batch callers still generate the same input", async (t) => {
  const generatedInputs = [];
  const { address } = await start(t, {
    async generateMedia({ input }) {
      generatedInputs.push(input);
      return { data: { image: { url: "https://result.local/image.png" } } };
    },
    async downloadMedia() {
      return { bytes: Buffer.from("result"), contentType: "image/png" };
    },
  });

  const response = await fetch(`${address}/api/batches`, {
    body: JSON.stringify({
      type: "image",
      model: "fal-ai/text-to-image",
      prompt: "legacy prompt",
      quantity: 1,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const batch = await response.json();

  assert.equal(response.status, 201);
  assert.equal(batch.mode, "text-to-image");
  await eventually(() => generatedInputs.length === 1);
  assert.deepEqual(generatedInputs[0], { prompt: "legacy prompt" });
});
