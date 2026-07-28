# 01 — Schema-derived media modes

**What to build:** Expanded FAL model catalogs that expose compatible generation
modes and schema-derived prompt/file controls, plus durable per-mode selection.

**Blocked by:** None.

**Status:** resolved

- [x] `/api/models/image` and `/api/models/video` request expanded OpenAPI metadata
  through the injected FAL catalog adapter and cache it for the server session.
- [x] A manual refresh invalidates the appropriate session cache and fetches fresh
  metadata.
- [x] Models expose prompt metadata and supported top-level file fields, including
  field name, label/description, scalar-vs-array cardinality, and informational
  requiredness.
- [x] File detection accepts `_url`/`_urls` string fields and descriptions that
  explicitly describe file input.
- [x] Models requiring unsupported scalar or nested inputs are silently omitted.
- [x] Compatible modes are derived for Image and Video, and multipurpose models
  appear in each compatible mode.
- [x] Schema failure permits prompt-only modes with a warning, but marks
  attachment-dependent modes unavailable with a retry action.
- [x] Favorites remain shared per media tab; mode and model selections persist per
  mode across restart.
- [x] Local HTTP integration tests use fake catalog data and prove caching,
  refreshing, filtering, compatibility, and preference persistence.
- [x] No real FAL storage or inference operation is called.

## Implemented

Added process-session expanded catalog caching with manual refresh, schema-derived
prompt/file controls and compatible media modes, prompt-only fallback with retry,
multi-category FAL discovery, and durable tab-wide favorites plus per-mode
selections. Covered entirely through local HTTP integration tests with fake catalog
adapters; no FAL upload, inference, credential, or network operation was used.
