# 03 — Video reference Batches

**What to build:** Video reference generation using the same generic schema-driven
attachment pipeline for image, video, mixed, and supplementary file inputs.

**Blocked by:** 02 — Image-to-image attachment Batches.

**Status:** resolved

- [x] The Video composer offers Text to Video, Image to Video, Video to Video, and
  Mixed References to Video.
- [x] Compatible multipurpose models can be selected in every supported mode.
- [x] Every supported top-level generic file URL field gets its own schema-labelled
  drag/drop plus click-to-browse control.
- [x] Array fields retain explicit user ordering.
- [x] Image attachments show thumbnails; videos show filename, size, and duration
  without a video player; other files show filename and size.
- [x] Prompt templates remain shared at Video-tab scope.
- [x] Image and Video composer state is independent across tab switches.
- [x] A successful submission leaves the selected mode/model/prompt/attachments in
  the composer.
- [x] Batch previews show the generic schema field assignments and temporary image
  thumbnails while source bytes remain available.
- [x] Local HTTP tests use fake adapters to prove exact schema field mapping for
  image-to-video, video-to-video, and mixed-reference inputs.
- [x] No real FAL upload or paid generation call is made.

## Implemented

Reused the generic schema-named attachment pipeline for all four Video modes,
including ordered scalar/array image, video, mask, audio, and document assignments,
upload-once immutable Batch inputs, independent retained composers, and shared
Video prompt templates. Added local video-duration metadata for attachment and
Batch previews without adding a source video player. Covered by local HTTP
integration tests with fake storage, inference, and download adapters; no network
request, real upload, credential, or paid inference was used.
