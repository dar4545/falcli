import assert from "node:assert/strict";
import test from "node:test";

import {
  generationIssues,
  mediaAlt,
  modelMatchesSearch,
} from "../src/workspace-ui.js";

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

test("media alt text is meaningful and bounded for long prompts", () => {
  const alt = mediaAlt({ prompt: "bright fox ".repeat(40) }, "image");
  assert.match(alt, /^Generated image: bright fox/);
  assert.ok(alt.length < 170);
});
