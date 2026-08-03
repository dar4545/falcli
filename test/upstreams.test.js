import assert from "node:assert/strict";
import test from "node:test";

import { defaultAdapters, listFalModels } from "../src/upstreams.js";

test("FAL billing uses the account billing endpoint", async () => {
  const payload = await defaultAdapters.getBilling({
    key: "admin-key",
    async fetchImpl(url, options) {
      assert.equal(url.origin + url.pathname, "https://api.fal.ai/v1/account/billing");
      assert.equal(url.searchParams.get("expand"), "credits");
      assert.equal(options.headers.authorization, "Key admin-key");
      return new Response(JSON.stringify({ balance: 19.5 }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    },
  });

  assert.deepEqual(payload, { balance: 19.5 });
});

test("FAL model discovery exhausts every category page and deduplicates endpoints", async () => {
  const calls = [];
  const pages = {
    "text-to-video:": {
      models: [{ endpoint_id: "bytedance/seedance-2.0/text-to-video" }],
      has_more: true,
      next_cursor: "text-2",
    },
    "text-to-video:text-2": {
      models: [{ endpoint_id: "bytedance/seedance-2.0/mini/text-to-video" }],
      has_more: false,
    },
    "image-to-video:": {
      models: [{ endpoint_id: "bytedance/seedance-2.0/reference-to-video" }],
      has_more: true,
      next_cursor: "image-2",
    },
    "image-to-video:image-2": {
      models: [
        { endpoint_id: "bytedance/seedance-2.0/mini/reference-to-video" },
        { endpoint_id: "bytedance/seedance-2.0/reference-to-video" },
      ],
      has_more: false,
    },
  };

  const catalog = await listFalModels({
    categories: ["text-to-video", "image-to-video"],
    expand: "openapi-3.0",
    key: "test-key",
    async fetchImpl(url) {
      calls.push(new URL(url));
      const key = `${url.searchParams.get("category")}:${url.searchParams.get("cursor") ?? ""}`;
      return new Response(JSON.stringify(pages[key]), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    },
  });

  assert.deepEqual(
    catalog.models.map((model) => model.endpoint_id).sort(),
    [
      "bytedance/seedance-2.0/mini/reference-to-video",
      "bytedance/seedance-2.0/mini/text-to-video",
      "bytedance/seedance-2.0/reference-to-video",
      "bytedance/seedance-2.0/text-to-video",
    ],
  );
  assert.equal(calls.length, 4);
  assert.ok(calls.every((url) => url.searchParams.get("limit") === "10"));
  assert.ok(calls.every((url) => url.searchParams.get("status") === "active"));
  assert.ok(calls.every((url) => url.searchParams.get("expand") === "openapi-3.0"));
});

test("FAL model discovery retries a rate-limited catalog page", async () => {
  let attempts = 0;
  const catalog = await listFalModels({
    category: "image-to-video",
    key: "test-key",
    async fetchImpl() {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ message: "slow down" }), {
          headers: { "retry-after": "0" },
          status: 429,
        });
      }
      return new Response(
        JSON.stringify({
          models: [{ endpoint_id: "bytedance/seedance-2.0/mini/reference-to-video" }],
          has_more: false,
        }),
        { status: 200 },
      );
    },
  });

  assert.equal(attempts, 2);
  assert.equal(catalog.models[0].endpoint_id, "bytedance/seedance-2.0/mini/reference-to-video");
});
