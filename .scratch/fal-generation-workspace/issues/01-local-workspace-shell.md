# 01 — Local workspace shell and test seam

**What to build:** A launchable local Generation Workspace that serves a Preact and Pico CSS interface from a Node backend, keeps credentials server-side, validates its storage locations, exposes configuration readiness, and establishes the end-to-end fake-upstream test seam used by later tickets.

**Blocked by:** None — can start immediately.

**Status:** resolved

**Implemented:** 2026-07-27

- [ ] One documented command starts the local backend and opens or serves the three-tab Text, Image, and Video workspace.
- [ ] The browser never receives the FAL key or OpenRouter token.
- [ ] Startup reports whether generation, OpenRouter catalog access, durable storage, and temporary storage are ready without revealing credential values.
- [ ] Missing credentials disable only the features that require them and present an actionable local configuration message.
- [ ] Startup verifies that durable and temporary storage are writable before generation can begin.
- [ ] Startup removes stale application-owned temporary files without touching durable library content.
- [ ] The server shuts down cleanly when asked and leaves a lifecycle hook for later remote-request cancellation.
- [ ] The frontend production build succeeds and is served by the local backend.
- [ ] An end-to-end test can start the real application server with fake FAL and OpenRouter adapters and inspect observable HTTP responses and filesystem effects.
- [ ] The initial automated check exercises startup readiness, tab-shell delivery, and stale-temp cleanup through the application boundary.
