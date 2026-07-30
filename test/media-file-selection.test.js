import assert from "node:assert/strict";
import test from "node:test";

import { allowsMultipleFileSelection } from "../src/media-file-selection.js";

test("every Image and Video mode accepts multiple files for scalar schema fields", () => {
  for (const mode of [
    "text-to-image",
    "image-to-image",
    "text-to-video",
    "image-to-video",
    "video-to-video",
    "mixed-references-to-video",
  ]) {
    assert.equal(
      allowsMultipleFileSelection(mode, { cardinality: "single" }),
      true,
      mode,
    );
  }
});

test("array fields accept multiple files even for an unrecognized future mode", () => {
  assert.equal(
    allowsMultipleFileSelection("future-media-mode", { cardinality: "array" }),
    true,
  );
});

test("an unrecognized mode does not silently broaden a scalar field", () => {
  assert.equal(
    allowsMultipleFileSelection("future-media-mode", { cardinality: "single" }),
    false,
  );
});
