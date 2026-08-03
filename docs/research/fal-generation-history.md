# Retrieving fal generation history and cost data

Research date: 2026-08-02. Scope: fal Model APIs (marketplace/pre-trained model calls), with a short Serverless distinction at the end. Sources are limited to fal's first-party documentation and its canonical OpenAPI schema.

## Recommended retrieval plan

Use three datasets and join them by `request_id`:

1. **All request metadata:** paginate `GET /models/requests/search` with no semantic or endpoint filter, then client-filter the desired date window. This is the only endpoint-agnostic request-history operation currently exposed by fal's canonical [OpenAPI 3.1 schema](https://api.fal.ai/v1/openapi.json) (path `/models/requests/search`).
2. **Payloads:** after collecting the endpoint IDs from step 1, call `GET /models/requests/by-endpoint` in batches of at most 50 endpoint IDs with `expand=payloads`. This endpoint has server-side date filters and returns `json_input` and `json_output`. Its `endpoint_id` parameter is mandatory. [Official request-list reference](https://fal.ai/docs/platform-apis/v1/models/requests/by-endpoint)
3. **Per-request charges:** paginate `GET /models/billing-events` for the same window and join its rows to the requests by `request_id`. Use `cost_total` as the charged, post-discount USD amount. [Official billing-events reference](https://fal.ai/docs/platform-apis/v1/models/billing-events)

Optionally, use `GET /assets?section=generated` to obtain a model-independent media field, `assets[].url`, and join assets to requests by `request_id`. Assets are not a substitute for request history: failed requests have no generated asset, and indexing depends on the workspace's Assets source settings. [Assets overview](https://fal.ai/docs/api-reference/platform-apis/for-assets)

For a reconciliation total, query `GET /models/usage`; it is aggregated rather than request-level. [Official usage reference](https://fal.ai/docs/platform-apis/v1/models/usage)

## Authentication

The base URL is `https://api.fal.ai/v1`. Send the key only in the header:

```http
Authorization: Key YOUR_ADMIN_API_KEY
```

fal explicitly requires an Admin key for usage and billing-sensitive Platform APIs. An Admin key includes API-scope access, so the same Admin key also works for request and Assets operations. Do not put the secret in a query string or client-side code. [Platform API authentication](https://fal.ai/docs/api-reference/platform-apis/authentication), [key scopes](https://fal.ai/docs/documentation/setting-up/authentication)

## Exact date window

fal's `end` filters are exclusive. Therefore "2026-07-26 through 2026-08-02 inclusive" must be represented as a half-open interval ending at the start of 2026-08-03. fal accepts ISO 8601 timestamps for `start` and `end`. [Request filters](https://fal.ai/docs/platform-apis/v1/models/requests/by-endpoint), [billing-event filters](https://fal.ai/docs/platform-apis/v1/models/billing-events), [usage filters](https://fal.ai/docs/platform-apis/v1/models/usage)

Choose and record the intended calendar timezone:

| Calendar interpretation | `start` | exclusive `end` |
|---|---|---|
| UTC | `2026-07-26T00:00:00Z` | `2026-08-03T00:00:00Z` |
| Asia/Shanghai (UTC+08:00) | `2026-07-25T16:00:00Z` | `2026-08-02T16:00:00Z` |

The examples below use Asia/Shanghai calendar dates. On 2026-08-02, the inclusive window is not complete until `2026-08-03T00:00:00+08:00` (`2026-08-02T16:00:00Z`). A pull taken earlier is necessarily a partial snapshot of August 2 and should be rerun after that boundary.

## 1. Workspace-wide request discovery

### Endpoint

```http
GET https://api.fal.ai/v1/models/requests/search
```

This operation is present in fal's canonical [OpenAPI schema](https://api.fal.ai/v1/openapi.json) as `operationId: searchRequests`. With none of `query`, `image_url`, or `video_url`, it performs a filtered browse of request history ordered newest first. Leave `endpoint_id`, `exclude_api_requests`, and `only_api_requests` unset to browse across endpoints and include both UI/playground and API-key requests.

Relevant query parameters from the schema:

- `limit`: integer >= 1; fal does not publish a fixed default or maximum here (the actual maximum depends on query type).
- `cursor`: opaque cursor returned by the preceding page.
- `endpoint_id`: optional, one to 50 IDs, repeated or comma-separated.
- `exclude_api_requests` and `only_api_requests`: mutually exclusive source filters; omit both for all sources.
- `query`, `image_url`, `video_url`, `min_similarity`: semantic-search controls; omit them for a complete browse.

Response shape:

```json
{
  "results": [
    {
      "request_id": "uuid",
      "endpoint_id": "fal-ai/flux/dev",
      "started_at": "2026-07-26T00:00:05Z",
      "sent_at": "2026-07-26T00:00:01Z",
      "ended_at": "2026-07-26T00:00:08Z",
      "status_code": 200,
      "duration": 7.8,
      "json_input": {},
      "json_output": {},
      "similarity": 0.87
    }
  ],
  "next_cursor": "opaque-or-null",
  "has_more": true
}
```

Only `request_id`, `endpoint_id`, `started_at`, and `sent_at` are required by the schema; `ended_at`, `status_code`, `duration`, payloads, and `similarity` may be absent/null.

### Pagination and client-side date filtering

The search operation has **no `start` or `end` parameter**. For a completeness-first pull:

1. Call it without filters.
2. Append every `results` row.
3. Reuse all parameters and pass `cursor=<next_cursor>`.
4. Continue until `next_cursor` is `null` / `has_more` is false.
5. Client-filter using an explicitly chosen timestamp. For "requests submitted during the calendar window," use `sent_at >= start && sent_at < end`. If the business definition is "completed during the window," use non-null `ended_at` instead.

Although fal says browse results are ordered by creation date, the response has no `created_at` field and does not equate creation time to `sent_at`. Do not stop early solely because one page's `sent_at` values are older than the lower bound; exhausting the cursor is the documented-safe approach.

## 2. Dated request listing and payload retrieval

### Endpoint and call

```http
GET https://api.fal.ai/v1/models/requests/by-endpoint
```

Example for Asia/Shanghai dates:

```bash
curl --get 'https://api.fal.ai/v1/models/requests/by-endpoint' \
  --header "Authorization: Key $FAL_KEY" \
  --data-urlencode 'endpoint_id=fal-ai/flux/dev' \
  --data-urlencode 'start=2026-07-25T16:00:00Z' \
  --data-urlencode 'end=2026-08-02T16:00:00Z' \
  --data-urlencode 'expand=payloads' \
  --data-urlencode 'limit=100'
```

Exact parameters:

- `endpoint_id` (required): one to 50 endpoint IDs; repeat the parameter or use comma-separated values.
- `start`, `end`: ISO 8601; `start` defaults to 24 hours ago and `end` defaults to now. `end` is exclusive.
- `status`: optional `success`, `error`, or `user_error`; omit it to include every status.
- `request_id`: optional UUID.
- `expand=payloads`: includes input/output payloads.
- `sort_by`: `ended_at` (default) or `duration`.
- `limit`: default 50, maximum 100.
- `cursor`: opaque pagination token.

Response:

```json
{
  "items": [
    {
      "request_id": "uuid",
      "endpoint_id": "fal-ai/flux/dev",
      "started_at": "...",
      "sent_at": "...",
      "ended_at": "...",
      "status_code": 200,
      "duration": 7.8,
      "json_input": {},
      "json_output": {}
    }
  ],
  "next_cursor": "opaque-or-null",
  "has_more": true
}
```

Follow `next_cursor` until null. Keep every filter identical on subsequent calls.

The reference calls `start`/`end` a time range but does not state whether the server applies it to `sent_at`, `started_at`, or `ended_at`. If boundary semantics matter, use the workspace-wide search result as the membership authority, or widen this server-side interval and client-filter the returned rows on the chosen timestamp.

## 3. Media URLs

There is no universal URL path in a request's `json_output`: it is an arbitrary model-specific response object in the Platform API schema. For each encountered endpoint, retrieve its response schema with:

```http
GET https://api.fal.ai/v1/models?endpoint_id=ENDPOINT_ID&expand=openapi-3.0
```

fal returns the full endpoint schema in `models[].openapi`; use that schema to locate the endpoint-specific URL-bearing output fields rather than assuming `images[].url`, `video.url`, or another path across all models. [Official Model Search reference](https://fal.ai/docs/platform-apis/v1/models)

For a normalized media record, use:

```http
GET https://api.fal.ai/v1/assets?section=generated
```

The response's stable fields include:

```json
{
  "assets": [
    {
      "vector_id": "...",
      "request_id": "...",
      "url": "https://v3b.fal.media/files/...",
      "type": "image",
      "endpoint": "fal-ai/flux/dev",
      "created_at": "2026-07-26T00:00:00.000Z",
      "source": "response",
      "prompt": "...",
      "width": 1024,
      "height": 1024,
      "content_type": "image/png"
    }
  ],
  "next_cursor": null,
  "has_more": false,
  "total_count": 1,
  "scope_truncated": false
}
```

`assets[].url` is the media URL; `type` is one of `image`, `video`, `audio`, or `3d`. One request can yield more than one asset, so model the join as one-to-many. The Assets endpoint has cursor/limit pagination but **no date parameters**; exhaust all pages and client-filter `created_at`. Ordering is not documented, so do not stop early. [Official Assets reference](https://fal.ai/docs/platform-apis/v1/assets)

Assets can be incomplete if the relevant request sources are not enabled in Dashboard Assets settings. The request payload remains the primary history record; Assets is a normalized convenience surface. [Assets source-setting note](https://fal.ai/docs/api-reference/platform-apis/for-assets)

## 4. Per-request cost ledger

### Endpoint and call

```http
GET https://api.fal.ai/v1/models/billing-events
```

Example for Asia/Shanghai dates:

```bash
curl --get 'https://api.fal.ai/v1/models/billing-events' \
  --header "Authorization: Key $FAL_KEY" \
  --data-urlencode 'start=2026-07-25T16:00:00Z' \
  --data-urlencode 'end=2026-08-02T16:00:00Z' \
  --data-urlencode 'limit=10000'
```

Exact filters include `start`, exclusive `end`, `endpoint_id` (one to 50), `request_id` (one to 50), `api_key_id` (one to 50), `login_username` (one to 50), and optional `expand=auth_method` / `expand=auth_method_structured`. The documented date span is capped at 90 days and the narrative documents up to 10,000 records per page. Pagination is `cursor` -> `next_cursor`; exhaust it. [Billing Events](https://fal.ai/docs/platform-apis/v1/models/billing-events)

Response:

```json
{
  "billing_events": [
    {
      "request_id": "uuid",
      "endpoint_id": "fal-ai/flux/dev",
      "timestamp": "2026-07-26T00:00:08Z",
      "output_units": 2,
      "unit_price": 0.025,
      "percent_discount": 10,
      "cost_subtotal": 0.05,
      "cost_discount": 0.005,
      "cost_total": 0.045,
      "cost_estimate_nano_usd": 45000000
    }
  ],
  "next_cursor": null,
  "has_more": false
}
```

Cost interpretation:

- `output_units`: billed output quantity.
- `unit_price`: pre-discount price per unit.
- `cost_subtotal = output_units * unit_price` in USD.
- `cost_discount`: discount amount in USD.
- `cost_total = cost_subtotal - cost_discount`: actual post-discount charge in USD; use this for totals.
- `cost_estimate_nano_usd`: the same charge in nano-USD (`1 USD = 1,000,000,000 nano-USD`).

Join on `request_id`. Do not use billing events alone as request history: fal bills successful outputs and does not charge server errors, so a request may have no billing-event row. Preserve such requests and represent their billing match as absent rather than silently dropping them. [fal Model API pricing](https://fal.ai/docs/documentation/model-apis/pricing)

If the desired cost is "cost of requests submitted in the window" rather than "billing events timestamped in the window," first select request IDs by `sent_at`, then query billing events in request-ID batches (maximum 50) over a sufficiently broad date interval and join. This avoids losing a request submitted near midnight whose billing timestamp lands just outside the calendar window.

## 5. Aggregate usage and reconciliation

### Endpoint and call

```http
GET https://api.fal.ai/v1/models/usage
```

Example using exact Asia/Shanghai boundaries without bucket realignment:

```bash
curl --get 'https://api.fal.ai/v1/models/usage' \
  --header "Authorization: Key $FAL_KEY" \
  --data-urlencode 'start=2026-07-25T16:00:00Z' \
  --data-urlencode 'end=2026-08-02T16:00:00Z' \
  --data-urlencode 'timezone=UTC' \
  --data-urlencode 'bound_to_timeframe=false' \
  --data-urlencode 'timeframe=day' \
  --data-urlencode 'expand=time_series' \
  --data-urlencode 'expand=summary'
```

Relevant parameters:

- `start`, exclusive `end`; defaults are the preceding 24 hours and current time.
- `timezone`: default UTC; controls date aggregation/boundaries.
- `timeframe`: `minute`, `hour`, `day`, `week`, or `month` (auto-selected if omitted).
- `bound_to_timeframe`: default true; set false to retain exact supplied instants.
- `endpoint_id`, `api_key_id`, `login_username`: optional filters, each accepting one to 50 values.
- `expand`: `time_series`, `summary`, `auth_method`, `auth_method_structured`; at least one of `time_series` or `summary` is required.
- `limit`, `cursor`, with `next_cursor` / `has_more` in the response.

`time_series[].results[]` and `summary[]` contain `endpoint_id`, `unit`, `quantity`, `unit_price`, `percent_discount`, `cost_subtotal`, `cost_discount`, `cost_total`, deprecated `cost`, and `currency`. `cost` is the same value as `cost_total`; new code should use `cost_total`. Usage is grouped/aggregated and has no `request_id`, so use it to reconcile sums and discover paid endpoint IDs, not to attach cost to a particular request. [Usage API](https://fal.ai/docs/platform-apis/v1/models/usage)

## Completeness and retention caveats

- Request JSON inputs/outputs are retained for 30 days by default, but a caller can prevent storage with `X-Fal-Store-IO: 0`, and payloads can be deleted later. A missing payload does not prove the request did not occur. [Data retention](https://fal.ai/docs/documentation/model-apis/media-expiration)
- CDN media expiration is configurable; expired files are permanently deleted. A stored URL may therefore no longer resolve. Download media before expiry if it must be preserved. [Generated-media retention](https://fal.ai/docs/documentation/model-apis/media-expiration)
- Assets indexing is opt-in/configurable by request source; use request history plus model-specific response schemas as the authoritative path when normalized Assets rows are missing. [Assets overview](https://fal.ai/docs/api-reference/platform-apis/for-assets)
- Keep cursors opaque, keep original query filters unchanged between pages, and stop only when `next_cursor` is null / `has_more` is false.
- Store raw request, billing-event, and asset rows before joining. This preserves failures, multi-asset outputs, and any unmatched billing records for audit.

## Serverless apps are a separate ledger

If the generations came from self-deployed fal Serverless apps rather than Model APIs, use the Serverless variants:

- `GET /serverless/requests/by-endpoint` for dated request history. It supports the same status/payload pagination pattern; `expand=billing` adds per-request `billable_units` and `runner_id`. [Serverless request reference](https://fal.ai/docs/platform-apis/v1/serverless/requests/by-endpoint)
- `GET /serverless/usage` for aggregate compute usage/spend. Rows include app, environment, machine type, `unit=second`, quantity, unit price, discount fields, `cost_total`, deprecated `cost`, currency, and surge state. [Serverless usage reference](https://fal.ai/docs/platform-apis/v1/serverless/usage)

Do not mix Model API output-unit charges with Serverless compute-second charges without retaining their ledger/source type.
