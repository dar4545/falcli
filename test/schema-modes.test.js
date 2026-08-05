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

test("one media catalog fetch is shared by every tab and cached until restart", async (t) => {
  let version = 0;
  const address = await start(t, {
    async listFalModels() {
      version += 1;
      return { models: [promptOnlyModel(`Version ${version}`)] };
    },
  });

  const [first, video] = await Promise.all([
    fetch(`${address}/api/models/image`).then((response) => response.json()),
    fetch(`${address}/api/models/video`).then((response) => response.json()),
  ]);
  const cached = await fetch(`${address}/api/models/image`).then((response) => response.json());
  const refreshed = await fetch(`${address}/api/models/image?refresh=1`).then((response) =>
    response.json(),
  );

  assert.equal(first.models[0].name, "Version 1");
  assert.equal(video.models[0].name, "Version 1");
  assert.equal(cached.models[0].name, "Version 1");
  assert.equal(refreshed.models[0].name, "Version 1");
  assert.equal(version, 1);
});

test("image catalog exposes schema controls and compatible modes", async (t) => {
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
      {
        id: "fal-ai/unsupported",
        modes: ["text-to-image"],
        prompt: {
          description: "",
          label: "Prompt",
          name: "prompt",
          required: false,
        },
        fileFields: [],
      },
    ],
  );
  assert.deepEqual(
    catalog.models.find((model) => model.id === "fal-ai/unsupported").parameterFields,
    [
      {
        name: "seed",
        label: "Seed",
        description: "",
        required: true,
        type: "integer",
        control: "number",
      },
    ],
  );
});

test("an object-plus-preset enum union keeps every schema branch via JSON fallback", async (t) => {
  const address = await start(t, {
    async listFalModels() {
      return {
        models: [
          schemaModel("openai/gpt-image-2/edit", "GPT Image 2 Edit", {
            image_size: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    width: { type: "integer" },
                    height: { type: "integer" },
                  },
                },
                {
                  type: "string",
                  enum: ["square_hd", "square", "portrait_4_3", "auto"],
                },
              ],
              default: "auto",
            },
            reversed_image_size: {
              anyOf: [
                {
                  type: "string",
                  enum: ["square_hd", "square", "portrait_4_3", "auto"],
                },
                {
                  type: "object",
                  properties: {
                    width: { type: "integer" },
                    height: { type: "integer" },
                  },
                },
              ],
              default: "auto",
            },
          }),
        ],
      };
    },
  });

  const catalog = await fetch(`${address}/api/models/image`).then((response) => response.json());

  assert.deepEqual(catalog.models[0].parameterFields, [
    {
      name: "image_size",
      label: "Image size",
      description: "",
      required: false,
      type: "union",
      control: "json",
      default: "auto",
    },
    {
      name: "reversed_image_size",
      label: "Reversed image size",
      description: "",
      required: false,
      type: "union",
      control: "json",
      default: "auto",
    },
  ]);
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

test("video catalog exposes schema-derived controls for essential generation parameters", async (t) => {
  const address = await start(t, {
    async listFalModels() {
      return {
        models: [
          schemaModel(
            "fal-ai/configurable-video",
            "Configurable video",
            {
              prompt: { type: "string" },
              resolution: {
                type: "string",
                enum: ["720p", "1080p"],
                default: "1080p",
              },
              duration: {
                type: "integer",
                minimum: 1,
                maximum: 30,
                default: 5,
              },
              include_audio: {
                type: "boolean",
                default: true,
              },
              aspect_ratio: {
                type: "string",
                enum: ["16:9", "9:16", "1:1"],
              },
              bitrate: {
                type: "number",
                minimum: 0.5,
                maximum: 50,
                multipleOf: 0.5,
              },
            },
            ["prompt", "duration", "aspect_ratio"],
          ),
        ],
      };
    },
  });

  const catalog = await fetch(`${address}/api/models/video`).then((response) => response.json());

  assert.deepEqual(catalog.models[0].parameterFields, [
    {
      name: "resolution",
      label: "Resolution",
      description: "",
      required: false,
      type: "string",
      control: "select",
      options: ["720p", "1080p"],
      default: "1080p",
    },
    {
      name: "duration",
      label: "Duration",
      description: "",
      required: true,
      type: "integer",
      control: "number",
      default: 5,
      minimum: 1,
      maximum: 30,
    },
    {
      name: "include_audio",
      label: "Include audio",
      description: "",
      required: false,
      type: "boolean",
      control: "boolean",
      default: true,
    },
    {
      name: "aspect_ratio",
      label: "Aspect ratio",
      description: "",
      required: true,
      type: "string",
      control: "select",
      options: ["16:9", "9:16", "1:1"],
    },
    {
      name: "bitrate",
      label: "Bitrate",
      description: "",
      required: false,
      type: "number",
      control: "number",
      minimum: 0.5,
      maximum: 50,
      step: 0.5,
    },
  ]);
});

test("media models are alphabetized by display name regardless of favorite status", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fal-schema-sort-"));
  const app = await createWorkspaceServer({
    adapters: {
      async listFalModels() {
        return {
          models: [
            schemaModel("fal-ai/zulu", "Zulu 10", { prompt: { type: "string" } }),
            schemaModel("fal-ai/alpha", "alpha", { prompt: { type: "string" } }),
            schemaModel("fal-ai/zulu-two", "Zulu 2", { prompt: { type: "string" } }),
          ],
        };
      },
    },
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();
  await fetch(`${address}/api/preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      favorites: { image: ["fal-ai/zulu"], video: [] },
      selections: { text: "", image: "", video: "" },
      modes: { image: "text-to-image", video: "text-to-video" },
      concurrency: 2,
    }),
  });

  const catalog = await fetch(`${address}/api/models/image`).then((response) => response.json());

  assert.deepEqual(catalog.models.map((model) => model.name), ["alpha", "Zulu 2", "Zulu 10"]);
  assert.equal(catalog.models.find((model) => model.id === "fal-ai/zulu").favorite, true);
});

test("models with required structured parameters remain available", async (t) => {
  const address = await start(t, {
    async listFalModels() {
      return {
        models: [
          schemaModel(
            "fal-ai/structured",
            "Structured",
            {
              prompt: { type: "string" },
              camera_path: {
                type: "array",
                items: { type: "object" },
                minItems: 1,
              },
            },
            ["camera_path"],
          ),
        ],
      };
    },
  });

  const catalog = await fetch(`${address}/api/models/video`).then((response) => response.json());

  assert.equal(catalog.models[0].id, "fal-ai/structured");
  assert.deepEqual(catalog.models[0].parameterFields, [
    {
      name: "camera_path",
      label: "Camera path",
      description: "",
      required: true,
      type: "array",
      control: "list",
      minItems: 1,
      item: {
        name: "item",
        label: "Item",
        description: "",
        required: true,
        type: "object",
        control: "json",
      },
    },
  ]);
});

test("schema failure fallback is cached for the session", async (t) => {
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
  assert.equal(fallback.retry, undefined);
  assert.deepEqual(fallback.models[0].modes, ["text-to-image"]);
  assert.equal(fallback.models[0].schemaStatus, "unavailable");

  schemaFails = false;
  const cached = await fetch(`${address}/api/models/image?refresh=1`).then((response) =>
    response.json(),
  );
  assert.deepEqual(cached.models[0].modes, ["text-to-image"]);
  assert.equal(cached.models[0].schemaStatus, "unavailable");
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
    audio: "text-to-speech",
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
