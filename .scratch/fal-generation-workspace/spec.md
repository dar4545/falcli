# FAL Generation Workspace

Status: ready-for-agent

## Problem Statement

The user needs one fast, local interface for generating text, images, and videos without repeatedly moving between FAL model pages, manually tracking concurrent requests, or losing useful prompts and outputs. The interface must keep API credentials off the browser, expose account usage, support controlled media batches, and make persistence an explicit review decision rather than silently filling the disk with every generated result.

## Solution

Build a local, single-user generation workspace with three primary tabs: Text, Image, and Video.

Text is a conversational Chat workspace backed by FAL's OpenRouter service. It supports new conversations, kept conversation history, image attachments, regeneration, reusable Prompt templates, and selection of an underlying OpenRouter model from a dynamically loaded catalog.

Image and Video are prompt-only generation workspaces. They dynamically list active FAL text-to-image and text-to-video endpoints, support model favourites, repeat one prompt/model combination as a Batch, run Batches through a UI-configurable local concurrency pool, and preview results as they complete.

All generated content begins as temporary. A Conversation is kept or discarded as a whole. Each Image or Video result is kept or discarded independently. Kept results are copied into a durable local library; temporary results are centralized in application temp storage and removed during graceful shutdown and again on startup.

The header exposes the authenticated FAL account's remaining credits, current-month spend, and seven-day usage, with manual refresh and clear credential or permission errors.

## User Stories

1. As the local user, I want one application for text, image, and video generation, so that I do not need separate tools for each medium.
2. As the local user, I want the application to run only on my machine, so that my credentials and generated work remain under my control.
3. As the local user, I want FAL credentials to remain in the backend environment, so that they are never exposed to browser code.
4. As the local user, I want the OpenRouter token to remain in the backend environment, so that model discovery does not expose it to the browser.
5. As the local user, I want a clear configuration error when a required credential is absent, so that I know how to make the affected feature work.
6. As the local user, I want Text, Image, and Video presented as three obvious tabs, so that switching generation modes is immediate.
7. As the local user, I want my active tab and common controls to remain understandable at a glance, so that the workspace feels focused rather than dashboard-heavy.
8. As the local user, I want to start a new Conversation, so that unrelated topics do not share context.
9. As the local user, I want messages in a Conversation to retain their order and roles, so that follow-up prompts have coherent context.
10. As the local user, I want assistant output to appear progressively when supported, so that Chat feels responsive.
11. As the local user, I want to regenerate an assistant reply, so that I can try another answer without retyping the prompt.
12. As the local user, I want to attach an image to a Chat message, so that I can ask a vision-capable model about it.
13. As the local user, I want accepted Chat image formats to be clear, so that unsupported files are rejected before a paid request is attempted.
14. As the local user, I want attached images to remain temporary unless their Conversation is kept, so that discarded work does not accumulate.
15. As the local user, I want to see only the FAL OpenRouter service as the Text provider, so that the generation path is unambiguous.
16. As the local user, I want to choose the underlying OpenRouter language model, so that I can balance capability, modality, speed, and cost.
17. As the local user, I want the OpenRouter model list loaded dynamically, so that newly available models do not require an application release.
18. As the local user, I want the last selected language model remembered, so that routine Chat use requires fewer clicks.
19. As the local user, I want image attachment controls limited to models that advertise image input when that metadata is available, so that I avoid predictable request failures.
20. As the local user, I want all Conversations visible in session history, so that I can move among ongoing Chats before exiting.
21. As the local user, I want to keep a useful Conversation explicitly, so that it remains available after restart.
22. As the local user, I want an unkept Conversation removed on exit, so that experimental Chats do not become durable history.
23. As the local user, I want a kept Conversation restored in Chat history after restart, so that useful context remains reusable.
24. As the local user, I want Conversation persistence to include its user messages, assistant messages, model identity, timestamps, and kept attachments, so that the restored history is coherent.
25. As the local user, I want active FAL text-to-image models listed dynamically, so that Image choices follow the current catalog.
26. As the local user, I want active FAL text-to-video models listed dynamically, so that Video choices follow the current catalog.
27. As the local user, I want model names, endpoint IDs, descriptions, and thumbnails shown when available, so that I can distinguish similar endpoints.
28. As the local user, I want to search the Image model list, so that a large catalog remains usable.
29. As the local user, I want to search the Video model list, so that a large catalog remains usable.
30. As the local user, I want to mark Image models as favourites, so that preferred endpoints stay easy to reach.
31. As the local user, I want to mark Video models as favourites, so that preferred endpoints stay easy to reach.
32. As the local user, I want favourites to survive restart, so that model organization is durable.
33. As the local user, I want favourites presented before non-favourites, so that they reduce selection time.
34. As the local user, I want the last selected Image and Video models remembered independently, so that each workspace resumes where I left it.
35. As the local user, I want the first version to send only a prompt plus endpoint defaults to media models, so that the interface remains fast and predictable.
36. As the local user, I want unsupported models or invalid prompt-only requests to show their FAL error clearly, so that I can choose another endpoint or revise the prompt.
37. As the local user, I want to create a Batch from one prompt, one selected model, and a quantity, so that I can request variations efficiently.
38. As the local user, I want each requested result represented immediately in the Batch preview, so that I can see the full amount of planned work.
39. As the local user, I want queued, submitting, running, completed, failed, cancelled, kept, and discarded states to be visually distinct, so that Batch progress is understandable.
40. As the local user, I want completed previews to appear without waiting for the entire Batch, so that I can begin reviewing early results.
41. As the local user, I want Image results shown as thumbnails with an enlarged preview, so that visual review is efficient.
42. As the local user, I want Video results shown with playable previews, so that motion output can be checked before persistence.
43. As the local user, I want to keep an individual Image or Video result, so that only useful media becomes durable.
44. As the local user, I want to keep several selected media results at once, so that reviewing a large Batch does not require repetitive actions.
45. As the local user, I want to discard an individual media result, so that unwanted output is removed from temporary storage immediately.
46. As the local user, I want to discard several selected media results at once, so that cleanup is efficient.
47. As the local user, I want kept media copied to the durable library with its prompt, model, request ID, and generation timestamp, so that provenance is preserved.
48. As the local user, I want kept Image results visible after restart, so that the Image tab also acts as a small local library.
49. As the local user, I want kept Video results visible after restart, so that the Video tab also acts as a small local library.
50. As the local user, I want all pending media work managed by one local queue pool, so that Batches share a predictable concurrency limit.
51. As the local user, I want the queue concurrency configured in the UI, so that I can adapt it to my current FAL account limit.
52. As the local user, I want the queue concurrency to default to two, so that a new account begins with a conservative setting.
53. As the local user, I want changing concurrency to affect subsequent scheduling without losing active work, so that tuning is safe.
54. As the local user, I want to cancel queued work, so that I can stop requests that are no longer useful before submission.
55. As the local user, I want to cancel submitted FAL work where FAL permits it, so that unnecessary remote work is stopped.
56. As the local user, I want failed work to remain visible with its error, so that failures do not disappear silently.
57. As the local user, I want retry to be manual, so that ambiguous network failures cannot automatically create duplicate paid output.
58. As the local user, I want a manual retry to create a clearly related attempt, so that I can distinguish the original failure from the retry.
59. As the local user, I want unfinished FAL requests cancelled during graceful shutdown, so that closing the application does not intentionally leave paid work running.
60. As the local user, I want the local queue discarded during shutdown, so that stale work does not resume unexpectedly after restart.
61. As the local user, I want temporary files centralized in one application temp area, so that cleanup is reliable.
62. As the local user, I want temporary files removed on graceful shutdown, so that rejected results do not occupy disk.
63. As the local user, I want stale temporary files removed on startup, so that a previous crash does not leave abandoned local data.
64. As the local user, I want remote media downloaded into temporary storage as soon as generation completes, so that review does not depend solely on short-lived remote URLs.
65. As the local user, I want kept files moved or copied safely before temporary cleanup, so that approval cannot cause data loss.
66. As the local user, I want to save a Prompt template with a name and media type, so that recurring prompts are easy to identify.
67. As the local user, I want saved Prompt templates to survive restart, so that prompt reuse is genuinely durable.
68. As the local user, I want to browse Prompt templates relevant to the active tab, so that unrelated templates do not clutter selection.
69. As the local user, I want selecting a Prompt template to fill the current composer without submitting, so that I can edit it before spending credits.
70. As the local user, I want to update or delete an obsolete Prompt template, so that the template library stays useful.
71. As the local user, I want Prompt templates to remain plain named text without variable syntax, so that reuse stays simple.
72. As the local user, I want my remaining FAL credit balance shown in the header, so that I can avoid an unexpected account lock.
73. As the local user, I want current-month FAL spend shown, so that I can understand recent cost.
74. As the local user, I want a compact seven-day daily usage chart, so that unusual spending is visible without opening another dashboard.
75. As the local user, I want to refresh billing and usage manually, so that the display can be current without aggressive background polling.
76. As the local user, I want the last successful account summary to remain visible when a refresh fails, so that a transient error does not erase useful context.
77. As the local user, I want the age of the displayed account data shown, so that I do not mistake stale values for live values.
78. As the local user, I want a clear message when the FAL key lacks Admin scope, so that I know why usage or credits cannot load even if generation works.
79. As the local user, I want generated output and account API failures isolated by feature, so that a billing-panel failure does not disable generation.
80. As the local user, I want keyboard-accessible tabs, forms, dialogs, and actions, so that the interface remains usable without precise pointer interaction.
81. As the local user, I want visible focus states and meaningful status text, so that queue and review actions are accessible.
82. As the local user, I want the interface to remain usable on a typical laptop viewport, so that large media previews do not crowd out controls.
83. As the local user, I want a single start command for the local application, so that reopening the workspace is quick.
84. As the local user, I want startup to validate writable storage locations, so that generation cannot begin when results would be impossible to retain safely.

## Implementation Decisions

- The product is a local, single-user application. Multi-user authentication, authorization, tenancy, and remote deployment are not part of this design.
- The frontend uses Preact for component and state organization and Pico CSS for baseline components and visual consistency. Custom CSS is limited to workspace layout, queue visualization, and media presentation.
- The backend is a lightweight Node.js service. It owns credentials, FAL calls, OpenRouter catalog calls, filesystem access, lifecycle cleanup, and queue scheduling.
- The backend serves the built frontend and exposes a small local HTTP API plus a server-to-browser event channel for generation progress. The event channel may use server-sent events because updates flow primarily from server to browser.
- `@fal-ai/client` is the generation client. Its queue submit, status/result subscription, and cancel capabilities are used for media work; streaming is used for Chat where the selected FAL route supports it.
- `FAL_KEY` is read only from the backend environment. FAL Platform APIs that expose billing and usage require an Admin-scoped key; generation and model discovery remain independently usable when the key can generate but cannot read Admin data.
- `OPENROUTER_API_KEY` is read only from the backend environment and used only to retrieve the OpenRouter model catalog. Chat inference remains routed through FAL.
- The Text UI exposes one provider identity: `openrouter/router`. The underlying OpenRouter model is a separate selector populated from the OpenRouter models API, and the last selection is stored in local settings.
- Conversation context and image content use the FAL OpenRouter service's OpenAI-compatible chat route when message-based or multimodal input is required. This is still presented as the single OpenRouter provider in the UI.
- Chat attachments are limited to PNG, JPEG, and WebP images in the first version. Files are validated before upload and stored temporarily. Model modality metadata is used to warn or prevent submission when image input is unsupported.
- A Conversation is the Text persistence boundary. Session Conversations may be navigated in history, but only explicitly kept Conversations survive restart.
- Image and Video generation discover active endpoints through FAL's Platform Model Search API. Image uses the `text-to-image` category and Video uses `text-to-video`. The UI supports free-text filtering over returned metadata.
- Media endpoints receive only the common `prompt` input and rely on endpoint defaults. If an endpoint requires additional fields despite its category, the application surfaces the FAL validation error.
- Model favourites and last selections are local application preferences, independent of any FAL dashboard favourite state.
- A Batch contains one media type, one endpoint, one prompt, and a positive quantity. Chat is never batched.
- The queue pool is shared by Image and Video work. Its concurrency defaults to two and is configurable through the UI. A concurrency change changes future scheduling and does not interrupt already running work.
- Every media result has its own lifecycle and review state even when it belongs to a Batch. Multi-select keep and discard operations are convenience actions over individual results.
- Automatic retry is prohibited. A manual retry creates a new attempt linked to the failed result and reuses the same endpoint and prompt.
- The backend records remote request IDs as soon as FAL accepts a request. Graceful shutdown attempts to cancel every unfinished remote request before cleaning local temporary state.
- A forced process termination cannot guarantee remote cancellation. Startup cleanup guarantees only local stale-temp cleanup.
- Temporary files are centralized in one application-owned temp directory. Generated remote media is downloaded there for review rather than relying only on the FAL CDN URL.
- Kept data is stored in a project-local durable library separated by Text, Image, and Video. Each kept item includes sidecar metadata sufficient to identify its prompt or Conversation, endpoint/model, request ID when available, timestamps, and source media type.
- Persistence uses ordinary files and JSON. No database is introduced because the application is local, single-user, and has modest state.
- Writes that create or replace durable JSON use write-then-rename semantics so that an interrupted write does not corrupt the only copy.
- Keeping a result completes the durable copy before marking it kept or deleting its temporary source.
- Prompt templates are durable JSON records containing an identifier, name, media type, prompt body, and update timestamp. They do not support variables or interpolation.
- Account billing calls `GET /v1/account/billing` with credit expansion. Usage calls `GET /v1/models/usage` with summary data for the current month and daily time-series data covering the latest seven days.
- Account data refreshes on explicit user action and once at startup. The UI records the time of the last successful refresh and retains the prior successful value if a later refresh fails.
- Application areas fail independently. Model-catalog, account, or OpenRouter-catalog errors do not erase durable state or prevent unrelated local browsing.
- The application provides one documented start command and validates credentials, durable-library access, and temp-directory access during startup.
- The official FAL documentation is the API source of truth:
  - JavaScript client: https://fal.ai/docs/api-reference/client-libraries/javascript
  - Queue client: https://fal.ai/docs/api-reference/client-libraries/javascript/queue
  - Storage lifecycle: https://fal.ai/docs/api-reference/client-libraries/javascript/storage
  - Model search: https://fal.ai/docs/platform-apis/v1/models
  - Account billing: https://fal.ai/docs/platform-apis/v1/account/billing
  - Usage: https://fal.ai/docs/platform-apis/v1/models/usage
  - OpenRouter service: https://fal.ai/models/openrouter/router/api

## Testing Decisions

- The primary test seam is the complete local application server boundary. Tests start the server with fake FAL and OpenRouter adapters, call the same local HTTP endpoints used by the Preact client, observe progress events, and inspect only public responses and resulting files.
- Tests assert externally observable behavior rather than private queue classes, component internals, or filesystem helper implementation.
- The high-level seam covers model discovery and filtering, OpenRouter catalog normalization, account summary aggregation, Batch scheduling, runtime concurrency changes, manual retry, cancellation, progress ordering, result downloads, per-result media persistence, per-Conversation Text persistence, Prompt template persistence, startup cleanup, and graceful shutdown cleanup.
- Fake upstream adapters must make concurrency observable and deterministic, provide controllable success/failure/cancellation outcomes, and record outbound endpoint/input calls. They must never use paid live generation in automated tests.
- Filesystem behavior is tested against an isolated temporary workspace created per test run. Tests verify durable data survives a simulated restart while unkept data does not.
- A graceful-shutdown test verifies that unfinished fake remote requests receive cancellation attempts before the temporary directory is removed.
- A crash-recovery test seeds stale temporary files, starts the application, and verifies startup cleanup without affecting durable library files.
- Account tests cover a full Admin response, a generation-capable but non-Admin permission failure, a transient refresh failure with retained stale data, and usage aggregation across month and seven-day boundaries.
- Chat tests cover new Conversation creation, contextual messages, regeneration, image validation, whole-Conversation keep/discard, and restoration of only kept history.
- Media tests cover one Batch with more results than the configured concurrency, progressive completion, per-result selection, bulk keep/discard, manual retry, and mixed Image/Video competition for the shared pool.
- Prompt template tests cover create, list by media type, apply without automatic submission, update, delete, and restart persistence.
- The Preact client receives a production-build smoke check. Detailed component-level tests are intentionally omitted unless behavior cannot be covered through the application seam.
- There is no prior application test pattern in this repository; the new seam establishes the first pattern and should remain the preferred integration boundary.

## Out of Scope

- Remote deployment, hosted access, multi-user accounts, authentication, permissions, and shared libraries.
- Direct browser access to FAL or OpenRouter credentials.
- Text providers other than FAL's OpenRouter service.
- Direct OpenRouter inference or OpenRouter billing.
- Chat attachments other than PNG, JPEG, and WebP images.
- PDF/document parsing, audio attachments, video attachments, tool calling, structured output builders, and agent workflows.
- Batch Chat generation.
- Mixed-model or mixed-prompt media Batches.
- Image-to-image, image-to-video, video-to-video, masking, inpainting, keyframes, audio tracks, reference assets, and other model-specific controls.
- A generated schema-driven form for arbitrary FAL endpoints.
- Automatic retry.
- Queue recovery after restart or guaranteed remote cancellation after forced process termination.
- Webhooks or a publicly reachable callback server.
- Full billing analytics, invoices, pricing comparison, forecasting, budgets, or pre-generation cost estimation.
- Cloud storage, synchronization, sharing, collaboration, tagging, folders, or external asset-management integration.
- Prompt template variables, interpolation, versioning, import, export, or synchronization.
- Editing generated media.
- A general-purpose database.

## Further Notes

- FAL's queue API supports submission, status, result retrieval, status streaming/subscription, and cancellation. The local pool controls how many requests are submitted concurrently; it is distinct from FAL's own remote concurrency queue.
- FAL currently documents a default account concurrency of two for new accounts, which is why the local UI begins at two while allowing user configuration.
- FAL-generated media is retained remotely for a limited period by default. The application must download completed media before treating it as locally reviewable and must not mistake a remote URL for durable local persistence.
- Account billing and model usage endpoints require an Admin-scoped FAL API key. The UI must explain this permission requirement without exposing the key.
- The model catalog and endpoint schemas can change independently of this application. Dynamic discovery reduces catalog maintenance, while prompt-only execution deliberately accepts that some endpoints will return validation errors if their required input evolves.
- “Keep” is the only action that turns temporary generated content into durable local content. Viewing, previewing, or completing a request does not imply persistence.

