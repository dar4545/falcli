# 07 — Batch generation and shared queue pool

**What to build:** Quantity-based Image and Video Batches that share a locally controlled queue, preview results progressively, and let the user review or persist several independently generated results efficiently.

**Blocked by:** 05 — Single media generation and review.

**Status:** resolved

**Implemented:** 2026-07-27

- [ ] A media Batch is created from one media type, one selected model, one prompt, and a positive quantity.
- [ ] Every requested result appears in the Batch preview immediately with its current state.
- [ ] Image and Video work share one local queue pool.
- [ ] The pool runs at most two generations concurrently by default.
- [ ] The user can change concurrency through the UI.
- [ ] Changing concurrency affects future scheduling without interrupting already running work.
- [ ] Completed results appear progressively without waiting for the entire Batch.
- [ ] The Batch view distinguishes locally queued, submitted, remotely queued, running, completed, failed, cancelled, kept, and discarded results.
- [ ] Each completed result can still be kept or discarded independently.
- [ ] Multi-selection supports bulk keep and bulk discard without changing the per-result persistence boundary.
- [ ] Queue state is session-only and does not resume after restart.
- [ ] End-to-end tests prove the concurrency ceiling, runtime concurrency changes, progressive completion, fair Image/Video scheduling, and bulk review actions.
