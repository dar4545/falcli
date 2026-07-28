import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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

async function stage(address, name, bytes, type = "image/png") {
  return fetch(`${address}/api/media-sources?name=${encodeURIComponent(name)}`, {
    body: bytes,
    headers: { "content-type": type },
    method: "POST",
  }).then((response) => response.json());
}

async function createBatch(address, input) {
  return fetch(`${address}/api/batches`, {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());
}

test("Batch sources remain previewable until every result is reviewed, then kept provenance is lightweight", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-provenance-"));
  const options = {
    adapters: {
      async uploadMediaSource({ hash }) {
        return { url: `https://storage.local/${hash}` };
      },
      async generateMedia() {
        return { data: { image: { url: "https://result.local/image.png" } } };
      },
      async downloadMedia() {
        return { bytes: Buffer.from("generated"), contentType: "image/png" };
      },
    },
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
  };
  const first = await createWorkspaceServer(options);
  t.after(() => first.close());
  const address = await first.listen();
  const bytes = Buffer.from("source bytes");
  const source = await stage(address, "reference.png", bytes);
  const batch = await createBatch(address, {
    type: "image",
    mode: "image-to-image",
    model: "fal-ai/edit",
    prompt: "edit exactly",
    quantity: 2,
    sourceFields: { image_url: source.id },
  });
  const completed = await eventually(async () => {
    const current = await fetch(`${address}/api/batches/${batch.id}`).then((response) =>
      response.json(),
    );
    return current.results.every((result) => result.state === "completed") ? current : null;
  });

  const kept = await fetch(`${address}/api/results/${completed.results[0].id}/keep`, {
    method: "POST",
  }).then((response) => response.json());
  assert.equal((await fetch(`${address}${source.fileUrl}`)).status, 200);
  assert.deepEqual(kept.sourceFields, {
    image_url: {
      name: "reference.png",
      type: "image/png",
      size: bytes.length,
      hash: source.hash,
    },
  });
  assert.doesNotMatch(JSON.stringify(kept), /storage\.local|media-sources|source bytes|input/i);

  await fetch(`${address}/api/results/${completed.results[1].id}`, { method: "DELETE" });
  assert.equal((await fetch(`${address}${source.fileUrl}`)).status, 404);
  const cleanedBatch = await fetch(`${address}/api/batches/${batch.id}`).then((response) =>
    response.json(),
  );
  assert.deepEqual(cleanedBatch.sourceFields, kept.sourceFields);
  assert.equal(cleanedBatch.sourceFields.image_url.fileUrl, undefined);

  await first.close();
  const second = await createWorkspaceServer(options);
  t.after(() => second.close());
  const secondAddress = await second.listen();
  const restored = await fetch(`${secondAddress}/api/results?type=image`).then((response) =>
    response.json(),
  );
  assert.deepEqual(restored.results[0].sourceFields, kept.sourceFields);
  assert.doesNotMatch(JSON.stringify(restored), /storage\.local|media-sources|source bytes|input/i);
});

test("a 422 FAL rejection stops only unsent Batch copies and preserves structured detail", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-rejection-"));
  let starts = 0;
  /** @type {(value: unknown) => void} */
  let releaseSecond = () => {};
  /** @type {(value: unknown) => void} */
  let signalBothStarted = () => {};
  const bothStarted = new Promise((resolve) => {
    signalBothStarted = resolve;
  });
  const secondGate = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  const details = {
    detail: [
      {
        loc: ["body", "image_url"],
        msg: "Field required",
        type: "missing",
      },
    ],
  };
  const app = await createWorkspaceServer({
    adapters: {
      async generateMedia({ onState }) {
        starts += 1;
        const position = starts;
        onState({ state: "submitted", requestId: `request-${position}` });
        if (starts === 2) signalBothStarted(undefined);
        await bothStarted;
        if (position === 1) {
          throw Object.assign(new Error("FAL rejected the request"), {
            status: 422,
            details,
          });
        }
        await secondGate;
        return {
          data: { image: { url: "https://result.local/image.png" } },
          requestId: `request-${position}`,
        };
      },
      async downloadMedia() {
        return { bytes: Buffer.from("generated"), contentType: "image/png" };
      },
    },
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();
  const created = await createBatch(address, {
    type: "image",
    model: "fal-ai/rejecting-model",
    prompt: "",
    quantity: 4,
  });

  const stopped = await eventually(async () => {
    const current = await fetch(`${address}/api/batches/${created.id}`).then((response) =>
      response.json(),
    );
    return current.results.filter((result) => result.state === "not-submitted").length === 2
      ? current
      : null;
  });
  const failed = stopped.results.find((result) => result.state === "failed");
  assert.equal(starts, 2);
  assert.deepEqual(failed.failure, {
    status: 422,
    message: "FAL rejected the request",
    details,
  });
  assert.equal(failed.error, "FAL rejected the request");
  assert.deepEqual(
    stopped.results
      .filter((result) => result.state === "not-submitted")
      .map((result) => result.error),
    [
      "Not submitted — same payload rejected by FAL",
      "Not submitted — same payload rejected by FAL",
    ],
  );

  releaseSecond(undefined);
  await eventually(async () => {
    const current = await fetch(`${address}/api/batches/${created.id}`).then((response) =>
      response.json(),
    );
    return current.results.some((result) => result.state === "completed");
  });
  assert.equal(starts, 2);
});

test("a transient FAL failure does not stop or automatically retry other Batch copies", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-transient-"));
  let starts = 0;
  const app = await createWorkspaceServer({
    adapters: {
      async generateMedia() {
        starts += 1;
        if (starts === 1) {
          throw Object.assign(new Error("FAL is temporarily unavailable"), {
            status: 503,
            details: { request: "upstream-503" },
          });
        }
        return { data: { image: { url: "https://result.local/image.png" } } };
      },
      async downloadMedia() {
        return { bytes: Buffer.from("generated"), contentType: "image/png" };
      },
    },
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();
  const created = await createBatch(address, {
    type: "image",
    model: "fal-ai/transient-model",
    prompt: "same payload",
    quantity: 3,
  });

  const settled = await eventually(async () => {
    const current = await fetch(`${address}/api/batches/${created.id}`).then((response) =>
      response.json(),
    );
    return current.results.every((result) => ["completed", "failed"].includes(result.state))
      ? current
      : null;
  });

  assert.equal(starts, 3);
  assert.deepEqual(
    settled.results.map((result) => result.state).sort(),
    ["completed", "completed", "failed"],
  );
  assert.deepEqual(settled.results.find((result) => result.state === "failed").failure, {
    status: 503,
    message: "FAL is temporarily unavailable",
    details: { request: "upstream-503" },
  });
});

test("manual Retry repeats the exact immutable attachment input as a linked attempt", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-retry-"));
  const generatedInputs = [];
  const app = await createWorkspaceServer({
    adapters: {
      async uploadMediaSource({ name }) {
        return { url: `https://storage.local/${name}` };
      },
      async generateMedia({ input }) {
        generatedInputs.push(input);
        if (generatedInputs.length === 1) {
          throw Object.assign(new Error("temporary inference failure"), { status: 503 });
        }
        return { data: { image: { url: "https://result.local/image.png" } } };
      },
      async downloadMedia() {
        return { bytes: Buffer.from("generated"), contentType: "image/png" };
      },
    },
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();
  const source = await stage(address, "retry.png", Buffer.from("retry source"));
  const batch = await createBatch(address, {
    type: "image",
    mode: "image-to-image",
    model: "fal-ai/edit",
    prompt: "preserve this",
    quantity: 1,
    sourceFields: { image_url: source.id },
  });
  const failed = await eventually(async () => {
    const current = await fetch(`${address}/api/batches/${batch.id}`).then((response) =>
      response.json(),
    );
    return current.results[0].state === "failed" ? current.results[0] : null;
  });

  const retryResponse = await fetch(`${address}/api/results/${failed.id}/retry`, {
    method: "POST",
  });
  const retry = await retryResponse.json();
  assert.equal(retryResponse.status, 202);
  assert.equal(retry.attemptOf, failed.id);
  assert.equal(retry.batchId, batch.id);
  assert.equal(retry.mode, "image-to-image");
  await eventually(() => generatedInputs.length === 2);
  assert.equal(generatedInputs[1], generatedInputs[0]);
  assert.deepEqual(generatedInputs[1], {
    prompt: "preserve this",
    image_url: "https://storage.local/retry.png",
  });
});

test("manual Retry refreshes an expired upload once per unique available source", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-expired-retry-"));
  let currentTime = new Date("2026-07-01T00:00:00.000Z");
  let uploads = 0;
  const generatedInputs = [];
  const app = await createWorkspaceServer({
    adapters: {
      async uploadMediaSource() {
        uploads += 1;
        return { url: `https://storage.local/upload-${uploads}` };
      },
      async generateMedia({ input }) {
        generatedInputs.push(input);
        if (currentTime < new Date("2026-07-02T00:00:00.000Z")) {
          throw Object.assign(new Error("temporary inference failure"), { status: 503 });
        }
        return { data: { image: { url: "https://result.local/image.png" } } };
      },
      async downloadMedia() {
        return { bytes: Buffer.from("generated"), contentType: "image/png" };
      },
    },
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    now: () => currentTime,
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();
  const source = await stage(address, "shared.png", Buffer.from("shared source"));
  const batch = await createBatch(address, {
    type: "image",
    mode: "image-to-image",
    model: "fal-ai/edit",
    prompt: "reuse one source",
    quantity: 2,
    sourceFields: {
      image_url: source.id,
      mask_url: source.id,
    },
  });
  const failed = await eventually(async () => {
    const current = await fetch(`${address}/api/batches/${batch.id}`).then((response) =>
      response.json(),
    );
    return current.results.every((result) => result.state === "failed")
      ? current.results
      : null;
  });
  assert.equal(uploads, 1);

  currentTime = new Date("2026-07-02T00:00:01.000Z");
  const retryResponse = await fetch(`${address}/api/results/${failed[0].id}/retry`, {
    method: "POST",
  });
  assert.equal(retryResponse.status, 202);
  await eventually(() => generatedInputs.length === 3);

  assert.equal(uploads, 2);
  assert.deepEqual(generatedInputs[2], {
    prompt: "reuse one source",
    image_url: "https://storage.local/upload-2",
    mask_url: "https://storage.local/upload-2",
  });

  const secondRetry = await fetch(`${address}/api/results/${failed[1].id}/retry`, {
    method: "POST",
  });
  assert.equal(secondRetry.status, 202);
  await eventually(() => generatedInputs.length === 4);
  assert.equal(uploads, 2);
  assert.deepEqual(generatedInputs[3], generatedInputs[2]);
});

test("an expired Retry reports a transport conflict when temporary source bytes are unavailable", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-missing-retry-source-"));
  let currentTime = new Date("2026-07-01T00:00:00.000Z");
  let uploads = 0;
  const app = await createWorkspaceServer({
    adapters: {
      async uploadMediaSource() {
        uploads += 1;
        return { url: `https://storage.local/upload-${uploads}` };
      },
      async generateMedia() {
        throw Object.assign(new Error("temporary inference failure"), { status: 503 });
      },
    },
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    now: () => currentTime,
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();
  const source = await stage(address, "missing.png", Buffer.from("temporary source"));
  const batch = await createBatch(address, {
    type: "image",
    mode: "image-to-image",
    model: "fal-ai/edit",
    quantity: 1,
    sourceFields: { image_url: source.id },
  });
  const failed = await eventually(async () => {
    const current = await fetch(`${address}/api/batches/${batch.id}`).then((response) =>
      response.json(),
    );
    return current.results[0].state === "failed" ? current.results[0] : null;
  });
  await rm(path.join(root, "temp", "media-sources", source.id));
  currentTime = new Date("2026-07-02T00:00:01.000Z");

  const response = await fetch(`${address}/api/results/${failed.id}/retry`, {
    method: "POST",
  });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.match(body.error, /temporary source files are no longer available/i);
  assert.equal(uploads, 1);
});

test("Edit as new Batch returns exact composer fields and only still-available sources", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-edit-input-"));
  const app = await createWorkspaceServer({
    adapters: {
      async uploadMediaSource({ name }) {
        return { url: `https://storage.local/${name}` };
      },
      async generateMedia() {
        throw Object.assign(new Error("fix the request"), { status: 422 });
      },
    },
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();
  const source = await stage(address, "edit.png", Buffer.from("editable source"));
  const batch = await createBatch(address, {
    type: "image",
    mode: "image-to-image",
    model: "fal-ai/edit",
    prompt: "restore me",
    quantity: 1,
    sourceFields: { image_url: source.id },
  });
  const failed = await eventually(async () => {
    const current = await fetch(`${address}/api/batches/${batch.id}`).then((response) =>
      response.json(),
    );
    return current.results[0].state === "failed" ? current.results[0] : null;
  });

  const editable = await fetch(`${address}/api/results/${failed.id}/edit-input`).then(
    (response) => response.json(),
  );
  assert.deepEqual(editable, {
    type: "image",
    mode: "image-to-image",
    model: "fal-ai/edit",
    prompt: "restore me",
    sourceFields: {
      image_url: {
        id: source.id,
        name: "edit.png",
        type: "image/png",
        size: source.size,
        hash: source.hash,
        fileUrl: source.fileUrl,
        state: "Uploaded",
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(editable), /storage\.local/);

  await fetch(`${address}/api/results/${failed.id}`, { method: "DELETE" });
  const afterCleanup = await fetch(`${address}/api/results/${failed.id}/edit-input`).then(
    (response) => response.json(),
  );
  assert.deepEqual(afterCleanup.sourceFields, {});
});

test("cancelling the last reviewable Batch result releases its temporary sources", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-cancel-cleanup-"));
  /** @type {(value: unknown) => void} */
  let releaseBlocker = () => {};
  const blocker = new Promise((resolve) => {
    releaseBlocker = resolve;
  });
  const app = await createWorkspaceServer({
    adapters: {
      async uploadMediaSource({ name }) {
        return { url: `https://storage.local/${name}` };
      },
      async generateMedia({ prompt }) {
        if (prompt === "block") await blocker;
        return { data: { image: { url: "https://result.local/image.png" } } };
      },
      async downloadMedia() {
        return { bytes: Buffer.from("generated"), contentType: "image/png" };
      },
    },
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();
  const preferences = await fetch(`${address}/api/preferences`).then((response) =>
    response.json(),
  );
  await fetch(`${address}/api/preferences`, {
    body: JSON.stringify({ ...preferences, concurrency: 1 }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
  await createBatch(address, {
    type: "image",
    model: "fal-ai/blocker",
    prompt: "block",
    quantity: 1,
  });
  const source = await stage(address, "cancel.png", Buffer.from("cancel source"));
  const batch = await createBatch(address, {
    type: "image",
    mode: "image-to-image",
    model: "fal-ai/edit",
    prompt: "queued",
    quantity: 1,
    sourceFields: { image_url: source.id },
  });

  const cancelled = await fetch(`${address}/api/results/${batch.results[0].id}/cancel`, {
    method: "POST",
  }).then((response) => response.json());
  assert.equal(cancelled.state, "cancelled");
  assert.equal((await fetch(`${address}${source.fileUrl}`)).status, 404);
  releaseBlocker(undefined);
});

test("removing a staged source from the composer cannot delete bytes needed by a failed Batch", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-retained-source-"));
  const app = await createWorkspaceServer({
    adapters: {
      async uploadMediaSource({ name }) {
        return { url: `https://storage.local/${name}` };
      },
      async generateMedia() {
        throw Object.assign(new Error("retry later"), { status: 503 });
      },
    },
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();
  const source = await stage(address, "retained.png", Buffer.from("retain me"));
  const batch = await createBatch(address, {
    type: "image",
    mode: "image-to-image",
    model: "fal-ai/edit",
    quantity: 1,
    sourceFields: { image_url: source.id },
  });
  const failed = await eventually(async () => {
    const current = await fetch(`${address}/api/batches/${batch.id}`).then((response) =>
      response.json(),
    );
    return current.results[0].state === "failed" ? current.results[0] : null;
  });

  assert.equal(
    (await fetch(`${address}/api/media-sources/${source.id}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal((await fetch(`${address}${source.fileUrl}`)).status, 200);
  await fetch(`${address}/api/results/${failed.id}`, { method: "DELETE" });
  assert.equal((await fetch(`${address}${source.fileUrl}`)).status, 404);
});

test("graceful shutdown removes staged media source bytes before the next session", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-source-shutdown-"));
  const options = {
    adapters: {},
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
  };
  const first = await createWorkspaceServer(options);
  const address = await first.listen();
  const source = await stage(address, "shutdown.png", Buffer.from("temporary source"));
  assert.equal((await fetch(`${address}${source.fileUrl}`)).status, 200);

  await first.close();
  assert.deepEqual(await readdir(path.join(root, "temp")), []);

  const second = await createWorkspaceServer(options);
  t.after(() => second.close());
  const secondAddress = await second.listen();
  assert.equal((await fetch(`${secondAddress}${source.fileUrl}`)).status, 404);
  assert.deepEqual(await readdir(path.join(root, "temp")), []);
});
