import assert from "node:assert/strict";
import test from "node:test";

import {
  generationIssues,
  mediaAlt,
  modelCatalogState,
  modelMatchesSearch,
  parameterValueIsValid,
} from "../src/workspace-ui.js";

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
