const mediaModes = new Set([
  "text-to-image",
  "image-to-image",
  "text-to-video",
  "image-to-video",
  "video-to-video",
  "mixed-references-to-video",
  "text-to-speech",
  "speech-to-speech",
]);

export function allowsMultipleFileSelection(mode, field) {
  return mediaModes.has(mode) || field.cardinality === "array";
}

export function mergeSelectedSources({
  cardinality,
  existing,
  staged,
  unassigned,
}) {
  if (cardinality === "array") {
    return {
      assigned: [...existing, ...staged],
      unassigned,
    };
  }

  const selected = [...existing, ...staged];
  return {
    assigned: selected.slice(0, 1),
    unassigned: [...unassigned, ...selected.slice(1)],
  };
}
