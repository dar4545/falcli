# 02 — Image-to-image attachment Batches

**What to build:** A complete Image-to-Image Batch path using schema-labelled
local file staging and one-time FAL storage uploads.

**Blocked by:** 01 — Schema-derived media modes.

**Status:** resolved

- [x] The Image composer offers Text to Image and Image to Image, with model-first
  selection and schema-labelled drag/drop plus click-to-browse file controls.
- [x] Staged images show thumbnail, filename, size, remove/replace, and drag
  reordering for array fields.
- [x] Model switching preserves exact matching field assignments and moves
  unmatched files to an Unassigned files tray without guessed remapping.
- [x] Creating a Batch stages local source bytes in temporary storage, uploads each
  unique file exactly once through the injected storage adapter with one-day
  expiry, then reuses the URLs for every result.
- [x] The immutable generation input uses the schema's exact field names and
  supports scalar and array values.
- [x] Every upload must succeed before any inference result is scheduled.
- [x] The app enforces only transport safeguards: selected model, readable
  non-empty file, 1 GB per file, and 2 GB per Batch source set. FAL owns all
  model/schema validation.
- [x] Batch preview includes mode, model, prompt, field assignments, and temporary
  image thumbnails.
- [x] Local HTTP tests use fake storage/inference adapters and prove upload-once,
  URL reuse, ordering, all-uploads-before-inference, and transport failures.
- [x] No real FAL upload or paid generation call is made.

## Implemented

Added raw-stream temporary source staging, one-day FAL storage uploads through an
injected adapter, immutable schema-named Batch inputs, upload gating, source-size
transport safeguards, and Image mode/file controls with ordering, unassigned-file
recovery, retained composer state, and attachment-aware Batch preview. Covered by
local HTTP integration tests with fake storage, inference, and download adapters;
no network request, real upload, credential, or paid inference was used.
