import assert from "node:assert/strict";
import test from "node:test";

import {
  allowsMultipleFileSelection,
  mergeSelectedSources,
} from "../src/media-file-selection.js";

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

test("sequential selections preserve a scalar field Source and keep later Sources unassigned", () => {
  const first = { id: "first", name: "first.png" };
  const second = { id: "second", name: "second.png" };

  const initial = mergeSelectedSources({
    cardinality: "single",
    existing: [],
    staged: [first],
    unassigned: [],
  });
  const next = mergeSelectedSources({
    cardinality: "single",
    existing: initial.assigned,
    staged: [second],
    unassigned: initial.unassigned,
  });

  assert.deepEqual(next, {
    assigned: [first],
    unassigned: [second],
  });
});

test("one multi-file selection assigns the first scalar Source and keeps the rest unassigned", () => {
  const first = { id: "first", name: "first.png" };
  const second = { id: "second", name: "second.png" };

  assert.deepEqual(
    mergeSelectedSources({
      cardinality: "single",
      existing: [],
      staged: [first, second],
      unassigned: [],
    }),
    {
      assigned: [first],
      unassigned: [second],
    },
  );
});

test("array fields append Sources across sequential selections", () => {
  const first = { id: "first", name: "first.png" };
  const second = { id: "second", name: "second.png" };

  assert.deepEqual(
    mergeSelectedSources({
      cardinality: "array",
      existing: [first],
      staged: [second],
      unassigned: [],
    }),
    {
      assigned: [first, second],
      unassigned: [],
    },
  );
});

test("every Image and Video mode preserves sequential selections for every Source type", () => {
  const modesByTab = {
    Image: ["text-to-image", "image-to-image"],
    Video: [
      "text-to-video",
      "image-to-video",
      "video-to-video",
      "mixed-references-to-video",
    ],
  };
  const sourceTypes = [
    ["image.png", "image/png"],
    ["video.mp4", "video/mp4"],
    ["audio.mp3", "audio/mpeg"],
    ["document.pdf", "application/pdf"],
    ["notes.txt", "text/plain"],
    ["binary.dat", "application/octet-stream"],
    ["unknown", ""],
  ];

  for (const [tab, modes] of Object.entries(modesByTab)) {
    for (const mode of modes) {
      assert.equal(
        allowsMultipleFileSelection(mode, { cardinality: "single" }),
        true,
        `${tab} ${mode}`,
      );
      for (const [name, type] of sourceTypes) {
        const first = { id: `${mode}-${type}-first`, name: `first-${name}`, type };
        const second = { id: `${mode}-${type}-second`, name: `second-${name}`, type };
        const initial = mergeSelectedSources({
          cardinality: "single",
          existing: [],
          staged: [first],
          unassigned: [],
        });

        assert.deepEqual(
          mergeSelectedSources({
            cardinality: "single",
            existing: initial.assigned,
            staged: [second],
            unassigned: initial.unassigned,
          }),
          {
            assigned: [first],
            unassigned: [second],
          },
          `${tab} ${mode} ${type || "unknown MIME"}`,
        );
      }
    }
  }
});
