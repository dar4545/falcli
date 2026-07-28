# 02 — Dynamic model selection and favourites

**What to build:** Live model selectors that let the user browse OpenRouter language models for Text and active FAL prompt-only candidates for Image and Video, while remembering selections and making preferred media models easy to reach.

**Blocked by:** 01 — Local workspace shell and test seam.

**Status:** resolved

**Implemented:** 2026-07-27

- [ ] Text lists models retrieved by the backend from the OpenRouter models API while presenting `openrouter/router` as the only provider.
- [ ] Image lists active FAL models in the `text-to-image` category.
- [ ] Video lists active FAL models in the `text-to-video` category.
- [ ] Each selector shows a useful display name and endpoint/model identifier, plus description or thumbnail when available.
- [ ] Image and Video model lists support free-text search.
- [ ] Image and Video models can be favourited and unfavourited, with favourites displayed before other matches.
- [ ] Media favourites survive an application restart.
- [ ] The last Text, Image, and Video selections are remembered independently across restarts.
- [ ] OpenRouter modality metadata is normalized so later Chat work can determine whether image input is advertised.
- [ ] A catalog failure leaves stored selections and favourites intact and does not disable unrelated tabs.
- [ ] End-to-end tests verify upstream request authentication, category filtering, model normalization, search, favourites, restart persistence, and isolated failures.
