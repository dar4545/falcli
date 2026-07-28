# 08 — Reusable Prompt templates

**What to build:** A small durable Prompt template library that lets the user save, revise, and reuse named prompt text in the relevant Text, Image, or Video composer without submitting it automatically.

**Blocked by:** 04 — Session Chat workflow; 05 — Single media generation and review.

**Status:** resolved

**Implemented:** 2026-07-27

- [ ] A Prompt template contains a stable identity, name, media type, prompt body, and update time.
- [ ] The user can save the current Text, Image, or Video prompt as a named Prompt template.
- [ ] Each tab lists only Prompt templates relevant to its media type.
- [ ] Selecting a Prompt template fills the active composer without starting generation.
- [ ] The user can edit a Prompt template's name or body.
- [ ] The user can delete a Prompt template after an explicit confirmation.
- [ ] Prompt templates survive restart independently of temporary generations.
- [ ] Prompt templates remain plain text and do not interpret variables or interpolation syntax.
- [ ] Invalid or corrupt template data produces a recoverable error without overwriting the durable source.
- [ ] End-to-end tests cover create, media-type filtering, apply-without-submit, update, delete, restart persistence, and safe failure.
