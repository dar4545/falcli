# 09 — Cancellation, failure recovery, and shutdown

**What to build:** Safe controls for stopping unwanted work, manually retrying failures, preserving durable output during errors, and shutting down without intentionally leaving unfinished remote requests or temporary local data behind.

**Blocked by:** 06 — Durable multimodal Conversations; 07 — Batch generation and shared queue pool.

**Status:** resolved

**Implemented:** 2026-07-27

- [ ] The user can cancel work that is still waiting in the local queue without submitting it to FAL.
- [ ] The user can request cancellation of submitted or running FAL work and sees the resulting remote outcome.
- [ ] Failed media results remain visible with useful error information.
- [ ] Retry is manual only and creates a new attempt visibly linked to the original failed result.
- [ ] No network, server, or ambiguous completion failure triggers an automatic paid retry.
- [ ] Graceful shutdown stops local scheduling before attempting to cancel every unfinished remote request.
- [ ] Graceful shutdown removes unkept Conversations, attachments, media, queue records, and other application-owned temporary data.
- [ ] Startup removes stale temporary data left by a forced termination without affecting durable library content.
- [ ] Durable JSON updates use interruption-safe replacement semantics.
- [ ] A keep operation cannot report success until its durable file and metadata are complete.
- [ ] Cleanup or cancellation failures are reported without deleting already kept content.
- [ ] End-to-end tests cover queued cancellation, remote cancellation, ambiguous failure, linked manual retry, graceful shutdown ordering, crash recovery, and durable-write interruption.
