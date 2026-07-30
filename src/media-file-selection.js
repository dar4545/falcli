const mediaModes = new Set([
  "text-to-image",
  "image-to-image",
  "text-to-video",
  "image-to-video",
  "video-to-video",
  "mixed-references-to-video",
]);

export function allowsMultipleFileSelection(mode, field) {
  return mediaModes.has(mode) || field.cardinality === "array";
}
