import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspaceServer } from "../src/server.js";

test("video result files support byte ranges so preview players can seek", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-media-range-"));
  const bytes = Buffer.from("0123456789abcdef");
  const options = {
    adapters: {
      async generateMedia() {
        return { data: { video: { url: "https://result.local/video.mp4" } } };
      },
      async downloadMedia() {
        return { bytes, contentType: "video/mp4" };
      },
    },
    env: { FAL_KEY: "fal-key", OPENROUTER_API_KEY: "" },
    root,
  };
  const app = await createWorkspaceServer(options);
  t.after(() => app.close());
  const address = await app.listen();

  const result = await fetch(`${address}/api/media`, {
    body: JSON.stringify({
      type: "video",
      model: "fal-ai/video",
      prompt: "seekable preview",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => response.json());

  const response = await fetch(`${address}${result.fileUrl}`, {
    headers: { range: "bytes=4-7" },
  });

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-range"), `bytes 4-7/${bytes.length}`);
  assert.equal(response.headers.get("content-length"), "4");
  assert.equal(await response.text(), "4567");

  const invalid = await fetch(`${address}${result.fileUrl}`, {
    headers: { range: `bytes=${bytes.length}-` },
  });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), `bytes */${bytes.length}`);

  await fetch(`${address}/api/results/${result.id}/keep`, { method: "POST" });
  await app.close();

  const restoredApp = await createWorkspaceServer(options);
  t.after(() => restoredApp.close());
  const restoredAddress = await restoredApp.listen();
  const library = await fetch(`${restoredAddress}/api/results?type=video`).then((item) =>
    item.json(),
  );
  const restored = await fetch(`${restoredAddress}${library.results[0].fileUrl}`, {
    headers: { range: "bytes=-3" },
  });
  assert.equal(restored.status, 206);
  assert.equal(restored.headers.get("content-range"), `bytes 13-15/${bytes.length}`);
  assert.equal(await restored.text(), "def");
});
