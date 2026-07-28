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

export const defaultAdapters = {
  async cancelMedia({ endpoint, key, requestId }) {
    const client = createFalClient({ credentials: key });
    await client.queue.cancel(endpoint, { requestId });
  },

  async generateMedia({ endpoint, key, onState, prompt }) {
    const client = createFalClient({ credentials: key });
    return client.subscribe(endpoint, {
      input: { prompt },
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
        const content = JSON.parse(data).choices?.[0]?.delta?.content;
        if (content) yield content;
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

  async listFalModels({ category, key }) {
    const url = new URL("https://api.fal.ai/v1/models");
    url.searchParams.set("category", category);
    url.searchParams.set("status", "active");
    return checkedJson(
      await fetch(url, {
        headers: { authorization: `Key ${key}` },
      }),
    );
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
