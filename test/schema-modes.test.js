import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspaceServer } from "../src/server.js";

function schemaModel(id, name, properties, required = []) {
  return {
    endpoint_id: id,
    metadata: { display_name: name },
    openapi: {
      components: {
        schemas: {
          Input: {
            type: "object",
            properties,
            required,
          },
        },
      },
      paths: {
        [`/${id}`]: {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Input" },
                },
              },
            },
          },
        },
      },
    },
  };
}

function promptOnlyModel(name) {
  return schemaModel(
    "fal-ai/example",
    name,
    { prompt: { type: "string", description: "What to generate" } },
    ["prompt"],
  );
}

async function start(t, adapters) {
  const root = await mkdtemp(path.join(tmpdir(), "fal-schema-modes-"));
  const app = await createWorkspaceServer({
    adapters,
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
  });
  t.after(() => app.close());
  return app.listen();
}

test("media catalog stays cached for the server session until manually refreshed", async (t) => {
  let version = 0;
  const address = await start(t, {
    async listFalModels() {
      version += 1;
      return { models: [promptOnlyModel(`Version ${version}`)] };
    },
  });

  const first = await fetch(`${address}/api/models/image`).then((response) => response.json());
  const cached = await fetch(`${address}/api/models/image`).then((response) => response.json());
  const refreshed = await fetch(`${address}/api/models/image?refresh=1`).then((response) =>
    response.json(),
  );

  assert.equal(first.models[0].name, "Version 1");
  assert.equal(cached.models[0].name, "Version 1");
  assert.equal(refreshed.models[0].name, "Version 2");
});

test("image catalog exposes schema controls and compatible modes while omitting unsupported models", async (t) => {
  const address = await start(t, {
    async listFalModels() {
      return {
        models: [
          schemaModel(
            "fal-ai/multipurpose",
            "Multipurpose",
            {
              prompt: { type: "string", description: "Describe the result" },
              image_urls: {
                type: "array",
                items: { type: "string" },
                title: "Reference images",
                description: "Images to transform",
              },
            },
            ["prompt"],
          ),
          schemaModel(
            "fal-ai/file-description",
            "File description",
            {
              prompt: { type: "string" },
              reference: {
                type: "string",
                description: "File input used as the visual reference",
              },
            },
            ["reference"],
          ),
          schemaModel(
            "fal-ai/unsupported",
            "Unsupported",
            {
              prompt: { type: "string" },
              seed: { type: "integer" },
            },
            ["seed"],
          ),
        ],
      };
    },
  });

  const catalog = await fetch(`${address}/api/models/image`).then((response) => response.json());

  assert.deepEqual(
    catalog.models.map(({ id, modes, prompt, fileFields }) => ({ id, modes, prompt, fileFields })),
    [
      {
        id: "fal-ai/file-description",
        modes: ["image-to-image"],
        prompt: {
          description: "",
          label: "Prompt",
          name: "prompt",
          required: false,
        },
        fileFields: [
          {
            cardinality: "single",
            description: "File input used as the visual reference",
            label: "Reference",
            mediaType: "file",
            name: "reference",
            required: true,
          },
        ],
      },
      {
        id: "fal-ai/multipurpose",
        modes: ["text-to-image", "image-to-image"],
        prompt: {
          description: "Describe the result",
          label: "Prompt",
          name: "prompt",
          required: true,
        },
        fileFields: [
          {
            cardinality: "array",
            description: "Images to transform",
            label: "Reference images",
            mediaType: "image",
            name: "image_urls",
            required: false,
          },
        ],
      },
    ],
  );
});

test("video catalog places multipurpose models in every compatible generation mode", async (t) => {
  const address = await start(t, {
    async listFalModels({ categories }) {
      if (!categories?.includes("video-to-video")) return { models: [] };
      return {
        models: [
          schemaModel(
            "fal-ai/mixed",
            "Mixed",
            {
              prompt: { type: "string" },
              start_image_url: {
                type: "string",
                description: "Starting image",
              },
              video_urls: {
                type: "array",
                items: { type: "string" },
                description: "Reference videos",
              },
            },
          ),
          schemaModel(
            "fal-ai/image-required",
            "Image required",
            {
              prompt: { type: "string" },
              start_image_url: { type: "string" },
            },
            ["start_image_url"],
          ),
        ],
      };
    },
  });

  const catalog = await fetch(`${address}/api/models/video`).then((response) => response.json());

  assert.deepEqual(
    catalog.models.map(({ id, modes }) => ({ id, modes })),
    [
      {
        id: "fal-ai/image-required",
        modes: ["image-to-video"],
      },
      {
        id: "fal-ai/mixed",
        modes: [
          "text-to-video",
          "image-to-video",
          "video-to-video",
          "mixed-references-to-video",
        ],
      },
    ],
  );
});

test("schema failure falls back to prompt-only models and refresh retries attachment discovery", async (t) => {
  let schemaFails = true;
  const address = await start(t, {
    async listFalModels({ expand }) {
      if (expand && schemaFails) throw new Error("schema service unavailable");
      if (!expand) {
        return {
          models: [
            {
              endpoint_id: "fal-ai/edit",
              metadata: { display_name: "Edit" },
            },
          ],
        };
      }
      return {
        models: [
          schemaModel(
            "fal-ai/edit",
            "Edit",
            {
              prompt: { type: "string" },
              image_url: { type: "string" },
            },
            ["image_url"],
          ),
        ],
      };
    },
  });

  const fallbackResponse = await fetch(`${address}/api/models/image`);
  const fallback = await fallbackResponse.json();
  assert.equal(fallbackResponse.status, 200);
  assert.match(fallback.warning, /schema service unavailable/);
  assert.equal(fallback.retry, "/api/models/image?refresh=1");
  assert.deepEqual(fallback.models[0].modes, ["text-to-image"]);
  assert.equal(fallback.models[0].schemaStatus, "unavailable");

  schemaFails = false;
  const retried = await fetch(`${address}${fallback.retry}`).then((response) => response.json());
  assert.deepEqual(retried.models[0].modes, ["image-to-image"]);
  assert.equal(retried.models[0].schemaStatus, "ready");
});

test("favorites stay tab-wide while mode and model selections survive restart per mode", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-schema-preferences-"));
  const options = {
    adapters: {
      async listFalModels() {
        return {
          models: [
            schemaModel("fal-ai/multipurpose", "Multipurpose", {
              prompt: { type: "string" },
              image_url: { type: "string" },
            }),
          ],
        };
      },
    },
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
  };
  const first = await createWorkspaceServer(options);
  const firstAddress = await first.listen();

  const saved = await fetch(`${firstAddress}/api/preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      favorites: { image: ["fal-ai/multipurpose"], video: [] },
      selections: { text: "", image: "", video: "" },
      modes: { image: "image-to-image", video: "video-to-video" },
      modeSelections: {
        image: {
          "text-to-image": "fal-ai/text-model",
          "image-to-image": "fal-ai/multipurpose",
        },
        video: {
          "text-to-video": "fal-ai/text-video",
          "video-to-video": "fal-ai/video-edit",
        },
      },
      concurrency: 2,
    }),
  }).then((response) => response.json());
  await first.close();

  assert.deepEqual(saved.modes, {
    image: "image-to-image",
    video: "video-to-video",
  });
  assert.equal(saved.modeSelections.image["text-to-image"], "fal-ai/text-model");
  assert.equal(saved.modeSelections.image["image-to-image"], "fal-ai/multipurpose");

  const second = await createWorkspaceServer(options);
  t.after(() => second.close());
  const secondAddress = await second.listen();
  const restored = await fetch(`${secondAddress}/api/preferences`).then((response) =>
    response.json(),
  );
  const catalog = await fetch(`${secondAddress}/api/models/image`).then((response) =>
    response.json(),
  );

  assert.equal(restored.modes.image, "image-to-image");
  assert.equal(restored.modeSelections.video["text-to-video"], "fal-ai/text-video");
  assert.equal(restored.modeSelections.video["video-to-video"], "fal-ai/video-edit");
  assert.equal(catalog.models[0].favorite, true);
});
