# 10 — Integrated UX and release readiness

**What to build:** A cohesive, accessible, and maintainable release of the complete local workspace, with responsive layouts, understandable state feedback, isolated failures, production verification, and concise operating instructions.

**Blocked by:** 02 — Dynamic model selection and favourites; 03 — Account usage overview; 04 — Session Chat workflow; 05 — Single media generation and review; 06 — Durable multimodal Conversations; 07 — Batch generation and shared queue pool; 08 — Reusable Prompt templates; 09 — Cancellation, failure recovery, and shutdown.

**Status:** resolved

**Implemented:** 2026-07-27

- [ ] Text, Image, and Video workflows remain usable on a typical laptop viewport without controls being hidden by previews.
- [ ] Tabs, forms, dialogs, menus, model selectors, queue controls, previews, and review actions are keyboard accessible.
- [ ] Visible focus states, labels, status text, progress announcements, and error associations meet baseline accessibility expectations.
- [ ] Loading, empty, disabled, stale, success, failure, and destructive-action states use consistent presentation.
- [ ] Account, catalog, Chat, Image, Video, template, and library failures remain isolated from unrelated working areas.
- [ ] Destructive discard and delete actions clearly identify their scope and require suitable confirmation.
- [ ] The custom stylesheet remains a thin layout and media layer over Pico CSS rather than duplicating general component styling.
- [ ] The production frontend build and local server startup succeed from a clean dependency installation.
- [ ] One concise operator document explains environment variables, Admin-scope requirements, startup, storage locations, graceful shutdown, and known forced-crash limits.
- [ ] The complete end-to-end suite passes without live paid generation or real account mutation.
- [ ] A final smoke scenario demonstrates model discovery, account refresh, Chat, attachment handling, single media generation, a mixed media queue, Prompt template reuse, keep/discard, restart restoration, and cleanup.
