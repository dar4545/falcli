# 05 — Single media generation and review

**What to build:** Complete one-result Image and Video workflows that send prompt-only requests through FAL, download completed media for local review, and persist only the results the user explicitly keeps.

**Blocked by:** 01 — Local workspace shell and test seam; 02 — Dynamic model selection and favourites.

**Status:** resolved

**Implemented:** 2026-07-27

- [ ] The Image tab submits one prompt-only request to the selected active text-to-image endpoint.
- [ ] The Video tab submits one prompt-only request to the selected active text-to-video endpoint.
- [ ] Submission, remote queue, running, completed, failed, kept, and discarded states are distinguishable.
- [ ] Completed remote media is downloaded into centralized application temporary storage before being presented as locally reviewable.
- [ ] Image results have a thumbnail and enlarged preview.
- [ ] Video results have a playable preview.
- [ ] Keeping a result creates a durable local media file and provenance metadata before removing its temporary source.
- [ ] Discarding a result removes its temporary local content and does not create durable library data.
- [ ] Kept Image and Video results are browsable in their respective tabs after restart.
- [ ] FAL validation errors for endpoints that require more than a prompt are shown clearly without corrupting other work.
- [ ] End-to-end tests cover successful Image and Video requests, remote download, preview metadata, keep, discard, restart restoration, invalid endpoint input, and isolated failure.
