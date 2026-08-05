import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspaceServer } from "../src/server.js";
import { parameterValueIsValid } from "../src/workspace-ui.js";

function recursiveSchemaModel() {
  return {
    endpoint_id: "fal-ai/schema-recursion-fixture",
    catalogCategories: ["text-to-speech"],
    metadata: { display_name: "Recursive schema fixture" },
    openapi: {
      components: {
        schemas: {
          Input: {
            type: "object",
            required: ["prompt"],
            properties: {
              prompt: { type: "string" },
              voice_setting: { $ref: "#/components/schemas/VoiceSetting" },
              audio_setting: { $ref: "#/components/schemas/AudioSetting" },
              pronunciation_dict: { $ref: "#/components/schemas/PronunciationDict" },
              speakers: {
                type: "array",
                items: { $ref: "#/components/schemas/Speaker" },
                minItems: 2,
                maxItems: 10,
              },
              normalization_setting: {
                anyOf: [
                  { $ref: "#/components/schemas/LoudnessNormalizationSetting" },
                  { type: "null" },
                ],
              },
              numeric_quality: {
                type: "integer",
                enum: [1, 2, 3],
                default: 2,
              },
              all_of_setting: {
                $ref: "#/components/schemas/AdvancedSetting",
                description: "Settings composed from the endpoint schema",
              },
              ordered_setting: { $ref: "#/components/schemas/OrderedSetting" },
              object_first_union: {
                anyOf: [
                  { $ref: "#/components/schemas/VoiceSetting" },
                  { type: "string" },
                ],
              },
              string_first_union: {
                anyOf: [
                  { type: "string" },
                  { $ref: "#/components/schemas/VoiceSetting" },
                ],
              },
            },
          },
          VoiceSetting: {
            type: "object",
            properties: {
              voice_id: { type: "string", default: "Wise_Woman" },
              speed: { type: "number", minimum: 0.5, maximum: 2, default: 1 },
              emotion: {
                type: "string",
                enum: ["happy", "sad", "neutral"],
                default: "neutral",
              },
            },
          },
          AudioSetting: {
            type: "object",
            properties: {
              sample_rate: {
                type: "string",
                enum: ["8000", "16000", "32000", "44100"],
                default: "32000",
              },
              format: {
                type: "string",
                enum: ["mp3", "pcm", "flac"],
                default: "mp3",
              },
            },
          },
          PronunciationDict: {
            type: "object",
            properties: {
              tone_list: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
          Speaker: {
            type: "object",
            required: ["name", "voice_id"],
            properties: {
              name: { type: "string", minLength: 1 },
              voice_id: { type: "string", minLength: 1 },
            },
          },
          LoudnessNormalizationSetting: {
            type: "object",
            properties: {
              enabled: { type: "boolean", default: true },
              target_loudness: { type: "number", default: -18 },
              target_range: { type: "number", default: 8 },
              target_peak: { type: "number", default: -0.5 },
            },
          },
          BaseSetting: {
            type: "object",
            required: ["mode"],
            properties: {
              mode: { type: "string", enum: ["natural", "studio"], default: "natural" },
              gain: { type: "number", minimum: 0.5, default: 1 },
            },
          },
          AdvancedSetting: {
            allOf: [
              { $ref: "#/components/schemas/BaseSetting" },
              {
                type: "object",
                required: ["gain"],
                properties: {
                  gain: {
                    type: "number",
                    maximum: 2,
                    description: "Final output gain",
                  },
                },
              },
            ],
          },
          OrderedSetting: {
            type: "object",
            "x-fal-order-properties": ["third", "first"],
            properties: {
              first: { type: "string" },
              second: { type: "string" },
              third: { type: "string" },
            },
          },
        },
      },
      paths: {
        "/fal-ai/schema-recursion-fixture": {
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

async function startCatalog(t, fixture = recursiveSchemaModel()) {
  const root = await mkdtemp(path.join(tmpdir(), "fal-recursive-schema-"));
  const app = await createWorkspaceServer({
    adapters: {
      async listFalModels() {
        return { models: [fixture] };
      },
    },
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();
  const catalog = await fetch(`${address}/api/models/audio`).then((response) => response.json());
  return catalog.models[0];
}

function selfReferentialModel() {
  const model = recursiveSchemaModel();
  model.endpoint_id = "fal-ai/self-reference-fixture";
  model.openapi.components.schemas.Input.properties.tree = {
    $ref: "#/components/schemas/TreeNode",
  };
  model.openapi.components.schemas.TreeNode = {
    type: "object",
    properties: {
      label: { type: "string" },
      child: { $ref: "#/components/schemas/TreeNode" },
    },
  };
  return model;
}

function fieldNamed(fields, name) {
  return fields.find((field) => field.name === name);
}

test("recursive object controls preserve descendant defaults", async (t) => {
  const model = await startCatalog(t);
  const voice = fieldNamed(model.parameterFields, "voice_setting");
  const audio = fieldNamed(model.parameterFields, "audio_setting");

  assert.equal(voice.control, "group");
  assert.deepEqual(voice.default, {
    voice_id: "Wise_Woman",
    speed: 1,
    emotion: "neutral",
  });
  assert.deepEqual(audio.default, { sample_rate: "32000", format: "mp3" });
  assert.deepEqual(
    voice.fields.map(({ name, default: value }) => ({ name, default: value })),
    [
      { name: "voice_id", default: "Wise_Woman" },
      { name: "speed", default: 1 },
      { name: "emotion", default: "neutral" },
    ],
  );
});

test("nested object validation enforces child required, range, and enum constraints", () => {
  const field = {
    type: "object",
    control: "group",
    required: true,
    fields: [
      { name: "voice_id", type: "string", required: true, minLength: 1 },
      { name: "speed", type: "number", required: false, minimum: 0.5, maximum: 2 },
      {
        name: "emotion",
        type: "string",
        required: false,
        options: ["happy", "sad", "neutral"],
      },
    ],
  };

  assert.equal(
    parameterValueIsValid(field, { voice_id: "Wise_Woman", speed: 1, emotion: "neutral" }),
    true,
  );
  assert.equal(parameterValueIsValid(field, { speed: 1, emotion: "neutral" }), false);
  assert.equal(parameterValueIsValid(field, { voice_id: "Wise_Woman", speed: 3 }), false);
  assert.equal(
    parameterValueIsValid(field, { voice_id: "Wise_Woman", emotion: "robotic" }),
    false,
  );
});

test("numeric enum metadata preserves numeric option and default types", async (t) => {
  const model = await startCatalog(t);
  const quality = fieldNamed(model.parameterFields, "numeric_quality");

  assert.equal(quality.type, "number");
  assert.equal(quality.control, "select");
  assert.deepEqual(quality.options, [1, 2, 3]);
  assert.equal(quality.default, 2);
  assert.equal(parameterValueIsValid(quality, 2), true);
  assert.equal(parameterValueIsValid(quality, "2"), false);
});

test("allOf composition and ref annotations preserve nested constraints and order", async (t) => {
  const model = await startCatalog(t);
  const setting = fieldNamed(model.parameterFields, "all_of_setting");

  assert.equal(setting.control, "group");
  assert.equal(setting.description, "Settings composed from the endpoint schema");
  assert.deepEqual(setting.default, { mode: "natural", gain: 1 });
  assert.deepEqual(
    setting.fields.map((field) => ({
      name: field.name,
      required: field.required,
      description: field.description,
      minimum: field.minimum,
      maximum: field.maximum,
    })),
    [
      {
        name: "mode",
        required: true,
        description: "",
        minimum: undefined,
        maximum: undefined,
      },
      {
        name: "gain",
        required: true,
        description: "Final output gain",
        minimum: 0.5,
        maximum: 2,
      },
    ],
  );
});

test("nested x-fal property order is applied before remaining schema properties", async (t) => {
  const model = await startCatalog(t);
  const setting = fieldNamed(model.parameterFields, "ordered_setting");

  assert.deepEqual(setting.fields.map((field) => field.name), ["third", "first", "second"]);
});

test("array of strings exposes an editable list item control", async (t) => {
  const model = await startCatalog(t);
  const pronunciation = fieldNamed(model.parameterFields, "pronunciation_dict");

  assert.equal(pronunciation.control, "group");
  const tones = fieldNamed(pronunciation.fields, "tone_list");
  assert.equal(tones.control, "list");
  assert.deepEqual(
    { type: tones.item.type, control: tones.item.control },
    { type: "string", control: "text" },
  );
});

test("array of strings validates every item", () => {
  const field = {
    type: "array",
    control: "list",
    required: false,
    item: { type: "string", control: "text", minLength: 1 },
  };

  assert.equal(parameterValueIsValid(field, ["hello/(he-lo)", "world/(wurld)"]), true);
  assert.equal(parameterValueIsValid(field, ["hello/(he-lo)", 42]), false);
  assert.equal(parameterValueIsValid(field, [""]), false);
});

test("array of objects exposes recursive item controls", async (t) => {
  const model = await startCatalog(t);
  const speakers = fieldNamed(model.parameterFields, "speakers");

  assert.equal(speakers.control, "list");
  assert.equal(speakers.item.control, "group");
  assert.deepEqual(
    speakers.item.fields.map(({ name, required }) => ({ name, required })),
    [
      { name: "name", required: true },
      { name: "voice_id", required: true },
    ],
  );
});

test("array of objects validates every nested item", () => {
  const speaker = {
    type: "object",
    control: "group",
    fields: [
      { name: "name", type: "string", required: true, minLength: 1 },
      { name: "voice_id", type: "string", required: true, minLength: 1 },
    ],
  };
  const field = {
    type: "array",
    control: "list",
    required: false,
    minItems: 2,
    maxItems: 10,
    item: speaker,
  };

  assert.equal(
    parameterValueIsValid(field, [
      { name: "Narrator", voice_id: "Wise_Woman" },
      { name: "Guest", voice_id: "Friendly_Person" },
    ]),
    true,
  );
  assert.equal(
    parameterValueIsValid(field, [
      { name: "Narrator", voice_id: "Wise_Woman" },
      { name: "Guest" },
    ]),
    false,
  );
});

test("array of object values reach the local generation boundary exactly", async (t) => {
  const submissions = [];
  const root = await mkdtemp(path.join(tmpdir(), "fal-recursive-payload-"));
  const app = await createWorkspaceServer({
    adapters: {
      async generateMedia({ endpoint, input, onState }) {
        submissions.push({ endpoint, input });
        onState({ state: "submitted", requestId: "mock-recursive-request" });
        return { data: { audio: { url: "https://local.test/result.wav" } } };
      },
      async downloadMedia() {
        return { bytes: Buffer.from("mock audio"), contentType: "audio/wav" };
      },
    },
    env: { FAL_KEY: "fake-key", OPENROUTER_API_KEY: "" },
    root,
  });
  t.after(() => app.close());
  const address = await app.listen();
  const speakers = [
    { name: "Narrator", voice_id: "Wise_Woman" },
    { name: "Guest", voice_id: "Friendly_Person" },
  ];

  const response = await fetch(`${address}/api/batches`, {
    body: JSON.stringify({
      type: "audio",
      mode: "text-to-speech",
      model: "fal-ai/schema-recursion-fixture",
      prompt: "Read this dialogue.",
      parameters: { speakers },
      quantity: 1,
      sourceFields: {},
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  assert.equal(response.status, 201);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submissions, [
    {
      endpoint: "fal-ai/schema-recursion-fixture",
      input: { prompt: "Read this dialogue.", speakers },
    },
  ]);
});

test("nullable anyOf object retains object controls and accepts explicit null", async (t) => {
  const model = await startCatalog(t);
  const normalization = fieldNamed(model.parameterFields, "normalization_setting");

  assert.equal(normalization.control, "group");
  assert.equal(normalization.nullable, true);
  assert.deepEqual(
    normalization.fields.map(({ name, default: value }) => ({ name, default: value })),
    [
      { name: "enabled", default: true },
      { name: "target_loudness", default: -18 },
      { name: "target_range", default: 8 },
      { name: "target_peak", default: -0.5 },
    ],
  );
  assert.equal(parameterValueIsValid({ ...normalization, required: true }, null), true);
});

test("required nullable object validation accepts null", () => {
  const field = {
    type: "object",
    control: "group",
    required: true,
    nullable: true,
    fields: [{ name: "enabled", type: "boolean", required: false }],
  };

  assert.equal(parameterValueIsValid(field, null), true);
});

test("true object-or-string unions fall back consistently without choosing a branch", async (t) => {
  const model = await startCatalog(t);
  const objectFirst = fieldNamed(model.parameterFields, "object_first_union");
  const stringFirst = fieldNamed(model.parameterFields, "string_first_union");

  assert.deepEqual(
    [objectFirst, stringFirst].map(({ type, control, fields }) => ({ type, control, fields })),
    [
      { type: "union", control: "json", fields: undefined },
      { type: "union", control: "json", fields: undefined },
    ],
  );
});

test("a self-referential object expands once and localizes its cycle as JSON", async (t) => {
  const model = await startCatalog(t, selfReferentialModel());
  const tree = fieldNamed(model.parameterFields, "tree");

  assert.equal(tree.control, "group");
  assert.deepEqual(
    tree.fields.map(({ name, control, type }) => ({ name, control, type })),
    [
      { name: "label", control: "text", type: "string" },
      { name: "child", control: "json", type: "json" },
    ],
  );
});
