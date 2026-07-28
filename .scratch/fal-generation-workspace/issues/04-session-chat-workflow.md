# 04 — Session Chat workflow

**What to build:** A responsive Text workspace where the user can hold contextual Conversations through FAL's OpenRouter service, switch models, start new Conversations, revisit current-session history, and regenerate replies.

**Blocked by:** 01 — Local workspace shell and test seam; 02 — Dynamic model selection and favourites.

**Status:** resolved

**Implemented:** 2026-07-27

- [ ] The Text tab presents `openrouter/router` as its only provider and uses the selected underlying OpenRouter model.
- [ ] Sending a message creates or continues a Conversation with ordered user and assistant messages.
- [ ] Prior Conversation messages are sent as context for subsequent replies.
- [ ] Assistant output streams progressively when the FAL route supports streaming.
- [ ] The user can start a new Conversation without losing other Conversations from the current session.
- [ ] The user can navigate among current-session Conversations.
- [ ] The user can regenerate an assistant response while preserving the original attempt's context and making the replacement behavior clear.
- [ ] Submission, streaming, completion, cancellation, and failure states are visible and accessible.
- [ ] A failed Chat request leaves the user's message and Conversation usable for another attempt.
- [ ] Unkept Conversations are session-only at this stage and are not restored after restart.
- [ ] End-to-end tests verify contextual outbound messages, model selection, streaming events, new Conversation behavior, session navigation, regeneration, and failure recovery.
