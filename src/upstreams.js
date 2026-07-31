import { openAsBlob } from "node:fs";

import { createFalClient } from "@fal-ai/client";

async function checkedJson(response) {
  if (!response.ok) {
    const detail = await response.text();
    let message = detail;
    try {
      const parsed = JSON.parse(detail);
      message = parsed.error?.message ?? parsed.message ?? detail;
    } catch {}
    throw new Error(message || `${response.status} ${response.statusText}`);
  }
  return response.json();
}

const falCatalogWaiters = [];
let activeFalCatalogRequests = 0;

async function withFalCatalogSlot(task) {
  if (activeFalCatalogRequests >= 3) {
    await new Promise((resolve) => falCatalogWaiters.push(resolve));
  }
  activeFalCatalogRequests += 1;
  try {
    return await task();
  } finally {
    activeFalCatalogRequests -= 1;
    falCatalogWaiters.shift()?.();
  }
}

async function fetchFalCatalogPage(url, key, fetchImpl) {
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await withFalCatalogSlot(() =>
      fetchImpl(url, {
        headers: { authorization: `Key ${key}` },
      }),
    );
    if (response.status !== 429 || attempt === 3) return checkedJson(response);
    const retryAfter = Number(response.headers.get("retry-after"));
    await new Promise((resolve) =>
      setTimeout(resolve, Number.isFinite(retryAfter) ? retryAfter * 1_000 : 1_000 * (attempt + 1)),
    );
  }
  return checkedJson(response);
}

export async function listFalModels({
  categories = undefined,
  category = undefined,
  expand = undefined,
  key,
  fetchImpl = fetch,
}) {
  const payloads = await Promise.all(
    (categories ?? [category]).map(async (value) => {
      const models = [];
      const seenCursors = new Set();
      let cursor = "";
      do {
        const url = new URL("https://api.fal.ai/v1/models");
        url.searchParams.set("category", value);
        url.searchParams.set("status", "active");
        // FAL caps expanded OpenAPI responses at 10, while metadata-only pages allow 50.
        url.searchParams.set("limit", expand ? "10" : "50");
        if (expand) url.searchParams.set("expand", expand);
        if (cursor) url.searchParams.set("cursor", cursor);
        const payload = await fetchFalCatalogPage(url, key, fetchImpl);
        models.push(...(payload.models ?? payload.data ?? []));
        if (!payload.has_more) break;
        const nextCursor = String(payload.next_cursor ?? "");
        if (!nextCursor || seenCursors.has(nextCursor)) {
          throw new Error("FAL model catalog returned an invalid pagination cursor");
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor);
      return { category: value, models };
    }),
  );
  const models = new Map();
  for (const payload of payloads) {
    for (const model of payload.models) {
      const id = model.endpoint_id ?? model.id ?? model.model_id;
      const previous = models.get(id);
      models.set(id, {
        ...previous,
        ...model,
        catalogCategories: [
          ...new Set([
            ...(previous?.catalogCategories ?? []),
            payload.category,
            ...(model.metadata?.category ? [model.metadata.category] : []),
          ]),
        ],
      });
    }
  }
  return { models: [...models.values()] };
}

export const defaultAdapters = {
  async cancelMedia({ endpoint, key, requestId }) {
    const client = createFalClient({ credentials: key });
    await client.queue.cancel(endpoint, { requestId });
  },

  async generateMedia({ endpoint, input, key, onState }) {
    const client = createFalClient({ credentials: key });
    return client.subscribe(endpoint, {
      input,
      logs: true,
      onEnqueue(requestId) {
        onState({ state: "submitted", requestId });
      },
      onQueueUpdate(update) {
        onState({
          state: update.status === "IN_PROGRESS" ? "running" : "remote-queued",
        });
      },
    });
  },

  async uploadMediaSource({ filePath, key, lifecycle, type }) {
    const client = createFalClient({ credentials: key });
    const blob = await openAsBlob(filePath, { type });
    return client.storage.upload(blob, { lifecycle });
  },

  async downloadMedia({ url }) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download generated media (${response.status})`);
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") || "application/octet-stream",
    };
  },

  async *streamChat({ key, messages, model }) {
    const response = await fetch(
      "https://fal.run/openrouter/router/openai/v1/chat/completions",
      {
        body: JSON.stringify({ messages, model, stream: true }),
        headers: {
          authorization: `Key ${key}`,
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    if (!response.ok || !response.body) {
      throw new Error((await response.text()) || `${response.status} ${response.statusText}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const delta = JSON.parse(data).choices?.[0]?.delta;
        const reasoning = delta?.reasoning ?? delta?.reasoning_content;
        if (typeof reasoning === "string" && reasoning) {
          yield { type: "reasoning", content: reasoning };
        } else {
          for (const detail of delta?.reasoning_details ?? []) {
            const content = detail?.text ?? detail?.summary;
            if (typeof content === "string" && content) {
              yield { type: "reasoning", content };
            }
          }
        }
        if (typeof delta?.content === "string" && delta.content) {
          yield { type: "content", content: delta.content };
        }
      }
      if (done) break;
    }
  },

  async listOpenRouterModels({ token }) {
    return checkedJson(
      await fetch("https://openrouter.ai/api/v1/models?limit=500", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  },

  async listFalModels({ categories, category, expand, key }) {
    return listFalModels({ categories, category, expand, key });
  },

  async getBilling({ key }) {
    return checkedJson(
      await fetch("https://api.fal.ai/v1/account/billing?expand=credits", {
        headers: { authorization: `Key ${key}` },
      }),
    );
  },

  async getUsage({ end, key, start }) {
    const url = new URL("https://api.fal.ai/v1/models/usage");
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);
    url.searchParams.set("aggregate", "day");
    return checkedJson(
      await fetch(url, {
        headers: { authorization: `Key ${key}` },
      }),
    );
  },
};
