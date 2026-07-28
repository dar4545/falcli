# 06 — Durable multimodal Conversations

**What to build:** Chat image attachments and explicit whole-Conversation persistence, allowing useful multimodal Conversations to survive restart while experimental Conversations and attachments remain temporary.

**Blocked by:** 04 — Session Chat workflow.

**Status:** resolved

**Implemented:** 2026-07-27

- [ ] A Chat message can attach PNG, JPEG, or WebP images.
- [ ] Unsupported types and invalid image data are rejected before a paid request is submitted.
- [ ] Image attachments use the FAL OpenRouter-compatible multimodal route while the UI continues to show the single OpenRouter provider.
- [ ] The UI warns or prevents submission when the selected model does not advertise image input.
- [ ] Uploaded attachment data stays in application temporary storage while its Conversation is unkept.
- [ ] Keeping a Conversation durably stores its complete ordered message history, selected model information, timestamps, and referenced attachments.
- [ ] Discarding a Conversation removes its temporary messages and attachments.
- [ ] Only kept Conversations are restored into Chat history after restart.
- [ ] A Conversation is kept or discarded as a whole; individual assistant messages are not separate persistence units.
- [ ] A durable write must complete before the UI reports the Conversation as kept.
- [ ] End-to-end tests cover image validation, multimodal outbound messages, model capability checks, keep/discard, attachment copying, and restoration of only kept Conversations.
