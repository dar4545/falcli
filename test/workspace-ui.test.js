import assert from "node:assert/strict";
import test from "node:test";

import {
  generationTabs,
  generationIssues,
  initialParametersForModel,
  mediaAlt,
  mediaPreviewTag,
  modelCatalogState,
  modelMatchesSearch,
  parameterValueIsValid,
  reconcileBatchResults,
  resultRefreshesAccount,
  updateParameterContainerValue,
} from "../src/workspace-ui.js";

test("workspace offers Audio as a generation tab", () => {
  assert.deepEqual(generationTabs(), ["text", "image", "video", "audio"]);
});

test("Audio results render with the native audio player", () => {
  assert.equal(mediaPreviewTag("audio"), "audio");
});

test("a result event received before its Batch is reconciled when the POST response arrives", () => {
  const queued = {
    id: "result-1",
    batchId: "batch-1",
    type: "audio",
    state: "queued",
    fileUrl: "",
  };
  const completed = {
    ...queued,
    state: "completed",
    fileUrl: "/api/results/result-1/file",
  };

  const beforeBatch = reconcileBatchResults(
    { batches: [], pendingResults: [] },
    { kind: "result", result: completed },
  );
  assert.deepEqual(beforeBatch, { batches: [], pendingResults: [completed] });

  const afterBatch = reconcileBatchResults(beforeBatch, {
    kind: "batch",
    batch: { id: "batch-1", type: "audio", results: [queued] },
  });
  assert.deepEqual(afterBatch, {
    batches: [
      {
        id: "batch-1",
        type: "audio",
        results: [completed],
      },
    ],
    pendingResults: [],
  });
});

test("a result event received after its Batch updates the visible result immediately", () => {
  const queued = {
    id: "result-2",
    batchId: "batch-2",
    type: "audio",
    state: "queued",
    fileUrl: "",
  };
  const completed = {
    ...queued,
    state: "completed",
    fileUrl: "/api/results/result-2/file",
  };

  assert.deepEqual(
    reconcileBatchResults(
      {
        batches: [{ id: "batch-2", type: "audio", results: [queued] }],
        pendingResults: [],
      },
      { kind: "result", result: completed },
    ),
    {
      batches: [{ id: "batch-2", type: "audio", results: [completed] }],
      pendingResults: [],
    },
  );
});

test("unmatched result events keep only the most recent bounded pending entries", () => {
  let state = { batches: [], pendingResults: [] };
  for (let index = 0; index < 205; index += 1) {
    state = reconcileBatchResults(state, {
      kind: "result",
      result: {
        id: `result-${index}`,
        batchId: `batch-${index}`,
        type: "audio",
        state: "completed",
      },
    });
  }

  assert.equal(state.pendingResults.length, 200);
  assert.equal(state.pendingResults[0].id, "result-5");
  assert.equal(state.pendingResults.at(-1).id, "result-204");
});

test("only a returned FAL generation refreshes the account balance", () => {
  assert.equal(resultRefreshesAccount({ state: "completed" }), true);
  for (const state of [
    "queued",
    "submitting",
    "submitted",
    "remote-queued",
    "running",
    "failed",
    "cancelled",
    "kept",
    "discarded",
  ]) {
    assert.equal(resultRefreshesAccount({ state }), false, state);
  }
});

test("model catalog state distinguishes cold loading from an empty catalog", () => {
  assert.deepEqual(
    modelCatalogState({ error: "", loading: true, models: [] }),
    {
      disabled: true,
      placeholder: "Loading models…",
      status: "Loading the FAL model catalog. This can take a moment after restarting the app.",
    },
  );
  assert.deepEqual(
    modelCatalogState({ error: "FAL unavailable", loading: false, models: [] }),
    {
      disabled: true,
      placeholder: "Models unavailable",
      status: "FAL unavailable",
    },
  );
  assert.deepEqual(
    modelCatalogState({ error: "", loading: false, models: [{ id: "fal-ai/flux" }] }),
    {
      disabled: false,
      placeholder: "Choose a model…",
      status: "",
    },
  );
});

test("model search matches label, provider, and full model id", () => {
  const model = {
    id: "acme/atlas-small",
    name: "Atlas Small",
  };

  assert.equal(modelMatchesSearch(model, "atlas small"), true);
  assert.equal(modelMatchesSearch(model, "ACME"), true);
  assert.equal(modelMatchesSearch(model, "atlas-small"), true);
  assert.equal(modelMatchesSearch(model, "unrelated"), false);
});

test("generation validation follows selected model required prompt and file fields", () => {
  const selectedModel = {
    id: "fal-ai/editor",
    prompt: { label: "Prompt", required: true },
  };
  const visibleFileFields = [
    { label: "Reference image", name: "image_url", required: true },
    { label: "Optional mask", name: "mask_url", required: false },
  ];

  assert.deepEqual(
    generationIssues({
      composer: {
        prompt: " ",
        quantity: 0,
        sourceFields: { mask_url: [{ id: "mask" }] },
      },
      selectedModel,
      selectedModelId: selectedModel.id,
      visibleFileFields,
    }),
    [
      "enter Prompt",
      "add Reference image",
      "set Results per Batch from 1 to 50",
    ],
  );

  assert.deepEqual(
    generationIssues({
      composer: {
        prompt: "Retouch this portrait",
        quantity: 2,
        sourceFields: { image_url: [{ id: "source" }] },
      },
      selectedModel,
      selectedModelId: selectedModel.id,
      visibleFileFields,
    }),
    [],
  );
});

test("generation validation follows required and bounded model parameters", () => {
  const selectedModel = {
    id: "fal-ai/video",
    parameterFields: [
      { name: "aspect_ratio", label: "Aspect ratio", required: true, type: "string" },
      {
        name: "duration",
        label: "Duration",
        required: true,
        type: "integer",
        minimum: 1,
        maximum: 30,
      },
    ],
  };

  assert.deepEqual(
    generationIssues({
      composer: { parameters: { duration: 30.5 }, prompt: "", quantity: 1, sourceFields: {} },
      selectedModel,
      selectedModelId: selectedModel.id,
      visibleFileFields: [],
    }),
    ["set Aspect ratio", "enter a valid Duration"],
  );
  assert.deepEqual(
    generationIssues({
      composer: {
        parameters: { aspect_ratio: "16:9", duration: 10 },
        prompt: "",
        quantity: 1,
        sourceFields: {},
      },
      selectedModel,
      selectedModelId: selectedModel.id,
      visibleFileFields: [],
    }),
    [],
  );
});

test("nested schema controls initialize leaf and explicit parent defaults without flattening", () => {
  const model = {
    parameterFields: [
      {
        name: "voice_setting",
        type: "object",
        control: "group",
        fields: [
          { name: "voice_id", type: "string", control: "text", default: "Wise_Woman" },
          { name: "speed", type: "number", control: "number", default: 1 },
          { name: "english_normalization", type: "boolean", control: "boolean", default: false },
        ],
      },
      {
        name: "normalization_setting",
        type: "object",
        control: "group",
        default: { enabled: true, target_loudness: -18 },
        fields: [
          { name: "enabled", type: "boolean", control: "boolean", default: false },
          { name: "target_loudness", type: "number", control: "number", default: -20 },
        ],
      },
    ],
  };

  assert.deepEqual(initialParametersForModel(model), {
    voice_setting: {
      voice_id: "Wise_Woman",
      speed: 1,
      english_normalization: false,
    },
    normalization_setting: { enabled: true, target_loudness: -18 },
  });
});

test("nested schema validation follows child requiredness, constraints, arrays, and nullability", () => {
  const voiceSetting = {
    name: "voice_setting",
    required: true,
    type: "object",
    control: "group",
    fields: [
      { name: "voice_id", required: true, type: "string", control: "text", minLength: 1 },
      { name: "speed", required: false, type: "number", control: "number", minimum: 0.5, maximum: 2 },
    ],
  };
  const speakers = {
    name: "speakers",
    required: false,
    type: "array",
    control: "list",
    minItems: 2,
    maxItems: 10,
    item: {
      name: "item",
      required: true,
      type: "object",
      control: "group",
      fields: [
        { name: "voice", required: true, type: "string", control: "text" },
        { name: "speaker_id", required: true, type: "string", control: "text" },
      ],
    },
  };
  const emotion = {
    name: "emotion",
    required: false,
    nullable: true,
    type: "string",
    control: "select",
    options: ["happy", "neutral"],
  };

  assert.equal(parameterValueIsValid(voiceSetting, { speed: 1 }), false);
  assert.equal(parameterValueIsValid(voiceSetting, { voice_id: "Wise", speed: 3 }), false);
  assert.equal(parameterValueIsValid(voiceSetting, { voice_id: "Wise", speed: 1 }), true);
  assert.equal(parameterValueIsValid(speakers, [{ voice: "Kore", speaker_id: "Host" }]), false);
  assert.equal(
    parameterValueIsValid(speakers, [
      { voice: "Kore", speaker_id: "Host" },
      { voice: "Puck" },
    ]),
    false,
  );
  assert.equal(
    parameterValueIsValid(speakers, [
      { voice: "Kore", speaker_id: "Host" },
      { voice: "Puck", speaker_id: "Guest" },
    ]),
    true,
  );
  assert.equal(parameterValueIsValid(emotion, null), true);
  assert.equal(parameterValueIsValid({ ...emotion, nullable: false }, null), false);
});

test("generation validation accepts explicit null only for nullable parameters", () => {
  const selectedModel = {
    id: "fal-ai/nullable",
    parameterFields: [
      {
        name: "normalization_setting",
        label: "Normalization setting",
        required: true,
        nullable: true,
        type: "object",
        control: "group",
        fields: [],
      },
    ],
  };
  const input = {
    composer: {
      parameters: { normalization_setting: null },
      prompt: "",
      quantity: 1,
      sourceFields: {},
    },
    selectedModel,
    selectedModelId: selectedModel.id,
    visibleFileFields: [],
  };

  assert.deepEqual(generationIssues(input), []);
  assert.deepEqual(
    generationIssues({
      ...input,
      selectedModel: {
        ...selectedModel,
        parameterFields: [
          { ...selectedModel.parameterFields[0], nullable: false },
        ],
      },
    }),
    ["enter a valid Normalization setting"],
  );
});

test("recursive parameter edits preserve typed nested objects and list items", () => {
  const speaker = updateParameterContainerValue(undefined, "name", "Narrator");
  const completedSpeaker = updateParameterContainerValue(
    speaker,
    "voice_id",
    "Wise_Woman",
  );
  const speakers = updateParameterContainerValue([], 0, completedSpeaker);
  const parameters = updateParameterContainerValue(undefined, "speakers", speakers);

  assert.deepEqual(parameters, {
    speakers: [{ name: "Narrator", voice_id: "Wise_Woman" }],
  });
  assert.deepEqual(
    updateParameterContainerValue(completedSpeaker, "name", undefined),
    { voice_id: "Wise_Woman" },
  );
  assert.deepEqual(
    updateParameterContainerValue(["first", "second"], 1, undefined),
    ["first", undefined],
  );
});

test("an explicit schema enum validates its selected value even when its union type is object", () => {
  const field = {
    name: "image_size",
    label: "ImageSize",
    type: "object",
    control: "select",
    options: [
      "square_hd",
      "square",
      "portrait_4_3",
      "portrait_16_9",
      "landscape_4_3",
      "landscape_16_9",
      "auto",
    ],
  };

  assert.equal(parameterValueIsValid(field, "square"), true);
  assert.equal(parameterValueIsValid(field, "not-a-size"), false);
});

test("media alt text is meaningful and bounded for long prompts", () => {
  const alt = mediaAlt({ prompt: "bright fox ".repeat(40) }, "image");
  assert.match(alt, /^Generated image: bright fox/);
  assert.ok(alt.length < 170);
});
