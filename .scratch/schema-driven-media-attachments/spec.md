# Schema-driven media attachments

Extend the existing local FAL Generation Workspace so Image and Video Batches can
use schema-named file inputs for image-to-image, image-to-video, video-to-video,
mixed-reference, and other top-level file-input models.

## Product rules

- The workflow is model-first: select a mode, then a model, then stage files in
  schema-labelled controls.
- Image modes are Text to Image and Image to Image.
- Video modes are Text to Video, Image to Video, Video to Video, and Mixed
  References to Video.
- FAL's expanded OpenAPI model metadata is the source of truth. Catalog/schema
  data is cached only for the running server session and can be manually
  refreshed.
- Render only `prompt` and supported top-level file URL fields. A file field is
  a top-level string or string-array property ending in `_url`/`_urls`, or one
  whose description explicitly identifies it as a file input.
- Silently hide endpoints that require unsupported top-level scalar or nested
  inputs. Multipurpose endpoints may appear in every compatible mode.
- The app does not enforce FAL schema constraints. Required markers and schema
  descriptions are guidance only; FAL decides validation and rejection.
- Local transport safeguards remain: a model must be selected, files must be
  readable and non-empty, at most 1 GB each and 2 GB per Batch, and every upload
  must succeed before inference can start.
- Each unique source file is uploaded once per immutable Batch with
  `client.storage.upload(blob, { lifecycle: { expiresIn: "1d" } })`; every result
  reuses the resulting URL.
- Source bytes are temporary only. Kept output metadata retains filenames, MIME
  types, sizes, hashes, and schema field assignments, but not source bytes or
  temporary FAL URLs.
- Image and Video composers are independent. Mode/model selections persist per
  mode across restart; staged files survive tab/model switching only during the
  browser session.
- Development and tests use fake schema, storage, inference, and download
  adapters. Real FAL uploads and paid generation are prohibited.

## Test seam

Test observable behavior through the local HTTP server. Fake only external FAL
boundaries; do not mock internal modules.

