# 04 — Attachment provenance, cleanup, and rejection recovery

**What to build:** Safe source lifecycle, lightweight kept provenance, and
FAL-owned rejection/recovery behavior for attachment Batches.

**Blocked by:** 03 — Video reference Batches.

**Status:** resolved

- [x] Source bytes remain temporary while a Batch has reviewable or retryable
  results and are deleted after every result is kept, discarded, or cancelled.
- [x] Graceful shutdown and next startup clean any remaining temporary sources.
- [x] Kept result metadata includes original filename, MIME type, size, hash, and
  schema field assignment, but contains neither source bytes nor temporary FAL
  URLs.
- [x] After source cleanup, Batch previews fall back to provenance text.
- [x] FAL failures retain concise status/message plus expandable structured
  validation details without local reinterpretation.
- [x] A deterministic request-validation rejection stops remaining unsent copies
  of the identical Batch input and marks them `Not submitted — same payload
  rejected by FAL`; already-submitted work finishes.
- [x] Transient/server failures do not stop other Batch results.
- [x] Manual Retry repeats the identical immutable input with no automatic retry.
- [x] Edit as new Batch restores mode/model/prompt and still-available temporary
  files to the matching composer.
- [x] If a one-day upload URL expires while local source exists, manual retry
  uploads the source again before inference.
- [x] Local HTTP tests use fake adapters to prove cleanup, provenance, structured
  failures, deterministic stop, transient continuation, retry, and edit payloads.
- [x] Full typecheck, full test suite, production build, and code review pass
  without any real FAL upload or paid generation.

## Implemented

Added Batch-scoped source retention and cleanup, sanitized durable provenance,
structured FAL failure preservation, deterministic 400/422 queued-copy stopping,
manual exact-input retry with one-day upload refresh, and exact Edit-as-new
composer restoration. Result cards expose concise errors with expandable upstream
details and reviewable `not-submitted` results. Verified through local HTTP tests
with fake storage, inference, and download adapters only; no credential, network,
real upload, or paid inference operation was used.
