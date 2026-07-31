import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspaceServer } from "../src/server.js";

async function start(t, adapters = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "fal-video-batches-"));
  const app = await createWorkspaceServer({
    adapters,
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
  });
  t.after(() => app.close());
  return app.listen();
}

async function stage(address, name, bytes, type, duration) {
  const query = new URLSearchParams({ name });
  if (duration !== undefined) query.set("duration", String(duration));
  const response = await fetch(`${address}/api/media-sources?${query}`, {
    body: bytes,
    headers: { "content-type": type },
    method: "POST",
  });
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

test("video-to-video keeps source duration and exact ordered video_urls", async (t) => {
  const generatedInputs = [];
  const uploads = [];
  const address = await start(t, {
    async uploadMediaSource(source) {
      uploads.push(source.name);
      return { url: `https://storage.local/${source.name}` };
    },
    async generateMedia({ input }) {
      generatedInputs.push(input);
      return { data: { video: { url: "https://result.local/video.mp4" } } };
    },
    async downloadMedia() {
      return { bytes: Buffer.from("result"), contentType: "video/mp4" };
    },
  });
  const first = (
    await stage(address, "first.mp4", Buffer.from("first"), "video/mp4", 8.25)
  ).source;
  const second = (
    await stage(address, "second.mp4", Buffer.from("second"), "video/mp4", 12.5)
  ).source;

  const response = await fetch(`${address}/api/batches`, {
    body: JSON.stringify({
      type: "video",
      mode: "video-to-video",
      model: "fal-ai/video-edit",
      prompt: "continue the motion",
      parameters: {
        resolution: "1080p",
        duration: 12,
        include_audio: true,
        aspect_ratio: "16:9",
        bitrate: 8.5,
      },
      quantity: 1,
      sourceFields: { video_urls: [second.id, first.id] },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const batch = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(
    batch.sourceFields.video_urls.map(({ name, duration }) => ({ name, duration })),
    [
      { name: "second.mp4", duration: 12.5 },
      { name: "first.mp4", duration: 8.25 },
    ],
  );
  await eventually(() => generatedInputs.length === 1);
  assert.deepEqual(generatedInputs[0], {
    resolution: "1080p",
    duration: 12,
    include_audio: true,
    aspect_ratio: "16:9",
    bitrate: 8.5,
    prompt: "continue the motion",
    video_urls: [
      "https://storage.local/second.mp4",
      "https://storage.local/first.mp4",
    ],
  });
  assert.deepEqual(uploads, ["second.mp4", "first.mp4"]);
});

test("image-to-video uploads start_image_url once and reuses it for every result", async (t) => {
  const generatedInputs = [];
  const uploads = [];
  const address = await start(t, {
    async uploadMediaSource(source) {
      uploads.push(source.name);
      return { url: `https://storage.local/${source.name}` };
    },
    async generateMedia({ input }) {
      generatedInputs.push(input);
      return { data: { video: { url: "https://result.local/video.mp4" } } };
    },
    async downloadMedia() {
      return { bytes: Buffer.from("result"), contentType: "video/mp4" };
    },
  });
  const image = (
    await stage(address, "start.png", Buffer.from("start"), "image/png")
  ).source;

  const response = await fetch(`${address}/api/batches`, {
    body: JSON.stringify({
      type: "video",
      mode: "image-to-video",
      model: "fal-ai/kling-video/v3/pro/image-to-video",
      prompt: "move the camera forward",
      quantity: 3,
      sourceFields: { start_image_url: image.id },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const batch = await response.json();

  assert.equal(response.status, 201);
  assert.equal(batch.mode, "image-to-video");
  assert.equal(batch.sourceFields.start_image_url.name, "start.png");
  await eventually(() => generatedInputs.length === 3);
  assert.deepEqual(generatedInputs[0], {
    prompt: "move the camera forward",
    start_image_url: "https://storage.local/start.png",
  });
  assert.equal(generatedInputs[0], generatedInputs[1]);
  assert.equal(generatedInputs[1], generatedInputs[2]);
  assert.deepEqual(uploads, ["start.png"]);
});

test("mixed-reference video maps ordered image and video arrays plus generic file fields", async (t) => {
  const generatedInputs = [];
  const uploads = [];
  const address = await start(t, {
    async uploadMediaSource(source) {
      uploads.push(source.name);
      return { url: `https://storage.local/${source.name}` };
    },
    async generateMedia({ input }) {
      generatedInputs.push(input);
      return { data: { video: { url: "https://result.local/video.mp4" } } };
    },
    async downloadMedia() {
      return { bytes: Buffer.from("result"), contentType: "video/mp4" };
    },
  });
  const firstImage = (
    await stage(address, "first.png", Buffer.from("first"), "image/png")
  ).source;
  const secondImage = (
    await stage(address, "second.png", Buffer.from("second"), "image/png")
  ).source;
  const video = (
    await stage(address, "motion.mp4", Buffer.from("motion"), "video/mp4", 3.5)
  ).source;
  const audio = (
    await stage(address, "score.wav", Buffer.from("score"), "audio/wav")
  ).source;
  const document = (
    await stage(address, "brief.pdf", Buffer.from("brief"), "application/pdf")
  ).source;

  const response = await fetch(`${address}/api/batches`, {
    body: JSON.stringify({
      type: "video",
      mode: "mixed-references-to-video",
      model: "bytedance/seedance-2.0/reference-to-video",
      prompt: "combine the references",
      quantity: 1,
      sourceFields: {
        image_urls: [secondImage.id, firstImage.id],
        video_urls: [video.id],
        audio_url: audio.id,
        reference_document: document.id,
        mask_url: firstImage.id,
      },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const batch = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(
    batch.sourceFields.image_urls.map((source) => source.name),
    ["second.png", "first.png"],
  );
  assert.equal(batch.sourceFields.video_urls[0].duration, 3.5);
  await eventually(() => generatedInputs.length === 1);
  assert.deepEqual(generatedInputs[0], {
    prompt: "combine the references",
    image_urls: [
      "https://storage.local/second.png",
      "https://storage.local/first.png",
    ],
    video_urls: ["https://storage.local/motion.mp4"],
    audio_url: "https://storage.local/score.wav",
    reference_document: "https://storage.local/brief.pdf",
    mask_url: "https://storage.local/first.png",
  });
  assert.deepEqual(uploads, [
    "second.png",
    "first.png",
    "motion.mp4",
    "score.wav",
    "brief.pdf",
  ]);
});
