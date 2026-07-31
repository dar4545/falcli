import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspaceServer } from "../src/server.js";

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("listen selects another port when the requested port is occupied", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "generation-workspace-port-"));
  const blocker = http.createServer();
  await listen(blocker);
  let app;

  t.after(async () => {
    if (app) await app.close();
    await close(blocker);
    await rm(root, { recursive: true, force: true });
  });

  const blockedAddress = blocker.address();
  assert.ok(blockedAddress && typeof blockedAddress !== "string");

  app = await createWorkspaceServer({ root, env: {}, adapters: {} });

  const address = await app.listen(blockedAddress.port);
  assert.notEqual(Number(new URL(address).port), blockedAddress.port);
  assert.equal((await fetch(address)).status, 200);
});
