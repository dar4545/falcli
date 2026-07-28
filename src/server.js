import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJson, writeJson } from "./store.js";
import { defaultAdapters } from "./upstreams.js";
import { createWorkPool } from "./queue.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

async function writableDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.write-${process.pid}`);
  await writeFile(probe, "");
  await rm(probe);
  return true;
}

async function cleanTemp(directory) {
  await mkdir(directory, { recursive: true });
  for (const entry of await readdir(directory)) {
    await rm(path.join(directory, entry), { recursive: true, force: true });
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function sendEvent(response, value) {
  response.write(`${JSON.stringify(value)}\n`);
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 15_000_000) throw new Error("Request body is too large");
  }
  return body ? JSON.parse(body) : {};
}

function normalizeOpenRouter(payload) {
  return (payload.data ?? payload.models ?? []).map((model) => ({
    id: model.id,
    name: model.name || model.id,
    description: model.description || "",
    supportsImages: Boolean(
      model.architecture?.input_modalities?.includes("image") ||
        model.input_modalities?.includes("image"),
    ),
  }));
}

function normalizeFal(payload, favorites) {
  return (payload.models ?? payload.data ?? []).map((model) => {
    const metadata = model.metadata ?? {};
    const id = model.endpoint_id ?? model.id ?? model.model_id;
    return {
      id,
      name: metadata.display_name ?? model.name ?? id,
      description: metadata.description ?? model.description ?? "",
      thumbnail: metadata.thumbnail_url ?? model.thumbnail_url ?? model.thumbnail ?? "",
      favorite: favorites.includes(id),
    };
  });
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function accountSummary(billing, usage, now) {
  const rows = usage.data ?? usage.time_series ?? usage.usage ?? usage.items ?? [];
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const daily = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() - offset);
    const date = dateKey(day);
    const spend = rows
      .filter((row) => String(row.date ?? row.day ?? row.timestamp ?? "").slice(0, 10) === date)
      .reduce((sum, row) => sum + Number(row.cost ?? row.spend ?? row.amount ?? 0), 0);
    daily.push({ date, spend });
  }
  return {
    username: billing.username ?? billing.user?.username ?? billing.account?.username ?? "",
    remainingCredits: Number(
      billing.credits?.balance ?? billing.current_balance ?? billing.balance ?? 0,
    ),
    monthSpend: rows
      .filter((row) => String(row.date ?? row.day ?? row.timestamp ?? "").slice(0, 10) >= monthStart)
      .reduce((sum, row) => sum + Number(row.cost ?? row.spend ?? row.amount ?? 0), 0),
    daily,
    refreshedAt: now.toISOString(),
    stale: false,
  };
}

function findMediaUrl(value) {
  if (!value || typeof value !== "object") return "";
  if (typeof value.url === "string") return value.url;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findMediaUrl(child);
    if (found) return found;
  }
  return "";
}

function extensionFor(contentType, url) {
  const known = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  }[contentType.split(";")[0].toLowerCase()];
  if (known) return known;
  const extension = path.extname(new URL(url).pathname).toLowerCase();
  return /^\.[a-z0-9]{2,5}$/.test(extension) ? extension : ".bin";
}

function publicResult(result) {
  const { filePath, ...visible } = result;
  return visible;
}

function publicConversation(conversation) {
  return {
    ...conversation,
    messages: conversation.messages.map((message) => ({
      ...message,
      ...(message.attachments && {
        attachments: message.attachments.map(({ filePath, filename, ...attachment }) => attachment),
      }),
    })),
  };
}

async function loadKeptConversations(libraryDir) {
  const directory = path.join(libraryDir, "text");
  await mkdir(directory, { recursive: true });
  const loaded = [];
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith(".json")) continue;
    const conversation = await readJson(path.join(directory, entry), null);
    if (!conversation?.id || !Array.isArray(conversation.messages)) continue;
    for (const message of conversation.messages) {
      for (const attachment of message.attachments ?? []) {
        attachment.filePath = path.join(directory, attachment.filename);
        attachment.fileUrl = `/api/conversations/${conversation.id}/attachments/${attachment.id}`;
      }
    }
    loaded.push({ ...conversation, kept: true });
  }
  return loaded;
}

async function loadKeptResults(libraryDir) {
  const loaded = [];
  for (const type of ["image", "video"]) {
    const directory = path.join(libraryDir, type);
    await mkdir(directory, { recursive: true });
    for (const entry of await readdir(directory)) {
      if (!entry.endsWith(".json")) continue;
      const metadata = await readJson(path.join(directory, entry), null);
      if (metadata?.id && metadata?.filename) {
        loaded.push({
          ...metadata,
          filePath: path.join(directory, metadata.filename),
          fileUrl: `/api/results/${metadata.id}/file`,
          state: "kept",
        });
      }
    }
  }
  return loaded;
}

function safeStaticPath(base, pathname) {
  const file = path.resolve(base, `.${pathname === "/" ? "/index.html" : pathname}`);
  return file.startsWith(`${path.resolve(base)}${path.sep}`) ? file : null;
}

export async function createWorkspaceServer(options = {}) {
  const root = path.resolve(options.root ?? projectRoot);
  const staticRoot = path.resolve(options.staticRoot ?? projectRoot);
  const env = options.env ?? process.env;
  const adapters = options.adapters ?? defaultAdapters;
  const now = options.now ?? (() => new Date());
  const tempDir = path.join(root, "temp");
  const libraryDir = path.join(root, "library");
  const preferencesFile = path.join(libraryDir, "state", "preferences.json");
  const templatesFile = path.join(libraryDir, "state", "templates.json");
  await cleanTemp(tempDir);

  let durable = false;
  let temporary = false;
  try {
    durable = await writableDirectory(libraryDir);
  } catch {}
  try {
    temporary = await writableDirectory(tempDir);
  } catch {}

  const readiness = {
    generation: {
      ready: Boolean(env.FAL_KEY),
      ...(!env.FAL_KEY && { message: "Set FAL_KEY in .env to enable generation." }),
    },
    openrouterCatalog: {
      ready: Boolean(env.OPENROUTER_API_KEY),
      ...(!env.OPENROUTER_API_KEY && {
        message: "Set OPENROUTER_API_KEY in .env to load language models.",
      }),
    },
    storage: { durable, temporary },
  };
  const defaultPreferences = {
    favorites: { image: [], video: [] },
    selections: { text: "", image: "", video: "" },
    concurrency: 2,
  };
  let lastAccount = null;
  const conversations = new Map(
    (await loadKeptConversations(libraryDir)).map((conversation) => [conversation.id, conversation]),
  );
  const results = new Map((await loadKeptResults(libraryDir)).map((result) => [result.id, result]));
  const textCapabilities = new Map();
  const batches = new Map();
  const eventClients = new Set();
  const initialPreferences = await readJson(preferencesFile, defaultPreferences);

  function notifyResult(result) {
    const event = `event: result\ndata: ${JSON.stringify(publicResult(result))}\n\n`;
    for (const client of eventClients) client.write(event);
  }

  async function runMediaResult(result) {
    result.state = "submitting";
    notifyResult(result);
    try {
      const generated = await adapters.generateMedia({
        endpoint: result.model,
        key: env.FAL_KEY,
        prompt: result.prompt,
        onState(update) {
          if (result.state !== "cancelled" && result.state !== "cancelling") {
            result.state = update.state;
          }
          if (update.requestId) result.requestId = update.requestId;
          notifyResult(result);
        },
      });
      if (result.state === "cancelled" || result.state === "cancelling") return result;
      result.requestId = generated.requestId ?? result.requestId;
      const remoteUrl = findMediaUrl(generated.data ?? generated);
      if (!remoteUrl) throw new Error("FAL response did not contain a media URL");
      const downloaded = await adapters.downloadMedia({ url: remoteUrl });
      const extension = extensionFor(downloaded.contentType, remoteUrl);
      result.filePath = path.join(tempDir, `${result.id}${extension}`);
      await writeFile(result.filePath, downloaded.bytes);
      result.fileUrl = `/api/results/${result.id}/file`;
      result.state = "completed";
    } catch (error) {
      if (result.state !== "cancelled") {
        result.state = "failed";
        result.error = error instanceof Error ? error.message : "Generation failed";
      }
    }
    notifyResult(result);
    return result;
  }

  async function keepResult(result) {
    if (result.state !== "completed" && result.state !== "kept") {
      throw new Error("Only completed results can be kept");
    }
    if (result.state === "kept") return result;
    const directory = path.join(libraryDir, result.type);
    await mkdir(directory, { recursive: true });
    const filename = `${result.id}${path.extname(result.filePath)}`;
    const durablePath = path.join(directory, filename);
    await copyFile(result.filePath, durablePath);
    const metadata = {
      ...publicResult(result),
      filename,
      state: "kept",
      keptAt: now().toISOString(),
    };
    delete metadata.fileUrl;
    await writeJson(path.join(directory, `${result.id}.json`), metadata);
    await rm(result.filePath, { force: true });
    Object.assign(result, metadata, {
      filePath: durablePath,
      fileUrl: `/api/results/${result.id}/file`,
    });
    notifyResult(result);
    return result;
  }

  async function discardResult(result) {
    if (result.state === "kept") throw new Error("Kept results cannot be discarded here");
    if (result.filePath) await rm(result.filePath, { force: true });
    result.filePath = "";
    result.fileUrl = "";
    result.state = "discarded";
    notifyResult(result);
    return result;
  }

  function publicBatch(batch) {
    return {
      ...batch,
      results: batch.resultIds.map((id) => publicResult(results.get(id))),
    };
  }

  const pool = createWorkPool({
    concurrency: initialPreferences.concurrency,
    worker: runMediaResult,
  });

  async function chatContext(conversation) {
    const context = [];
    for (const message of conversation.messages.filter((item) => !item.superseded)) {
      if (message.role !== "user" || !message.attachments?.length) {
        context.push({ role: message.role, content: message.content });
        continue;
      }
      const content = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const attachment of message.attachments) {
        const data = await readFile(attachment.filePath, "base64");
        content.push({
          type: "image_url",
          image_url: { url: `data:${attachment.type};base64,${data}` },
        });
      }
      context.push({ role: "user", content });
    }
    return context;
  }

  async function streamReply(response, conversation, messages, replaces = "") {
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "application/x-ndjson; charset=utf-8",
    });
    let content = "";
    try {
      for await (const chunk of adapters.streamChat({
        key: env.FAL_KEY,
        messages,
        model: conversation.model,
      })) {
        content += chunk;
        sendEvent(response, { type: "delta", content: chunk });
      }
      conversation.messages.push({
        id: randomUUID(),
        role: "assistant",
        content,
        createdAt: now().toISOString(),
        ...(replaces && { replaces }),
      });
      conversation.updatedAt = now().toISOString();
      sendEvent(response, { type: "done", conversation: publicConversation(conversation) });
    } catch (error) {
      sendEvent(response, {
        type: "error",
        error: error instanceof Error ? error.message : "Chat failed",
        conversation: publicConversation(conversation),
      });
    }
    response.end();
  }

  const builtRoot = path.join(staticRoot, "dist");
  const sourceRoot = staticRoot;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/api/readiness") {
        return sendJson(response, 200, readiness);
      }
      if (url.pathname === "/api/templates") {
        if (request.method === "GET") {
          const type = url.searchParams.get("type");
          const templates = await readJson(templatesFile, []);
          return sendJson(response, 200, {
            templates: templates.filter((template) => !type || template.type === type),
          });
        }
        if (request.method === "POST") {
          const input = await readBody(request);
          const type = ["text", "image", "video"].includes(input.type) ? input.type : "";
          const name = String(input.name ?? "").trim();
          const prompt = String(input.prompt ?? "");
          if (!type || !name || !prompt.trim()) {
            return sendJson(response, 400, { error: "Type, name, and prompt are required" });
          }
          const templates = await readJson(templatesFile, []);
          const template = {
            id: randomUUID(),
            type,
            name,
            prompt,
            updatedAt: now().toISOString(),
          };
          templates.push(template);
          await writeJson(templatesFile, templates);
          return sendJson(response, 201, template);
        }
      }
      const templateMatch = url.pathname.match(/^\/api\/templates\/([^/]+)$/);
      if (templateMatch) {
        const templates = await readJson(templatesFile, []);
        const index = templates.findIndex((template) => template.id === templateMatch[1]);
        if (index < 0) return sendJson(response, 404, { error: "Prompt template not found" });
        if (request.method === "PUT") {
          const input = await readBody(request);
          const name = String(input.name ?? "").trim();
          const prompt = String(input.prompt ?? "");
          if (!name || !prompt.trim()) {
            return sendJson(response, 400, { error: "Name and prompt are required" });
          }
          templates[index] = {
            ...templates[index],
            name,
            prompt,
            updatedAt: now().toISOString(),
          };
          await writeJson(templatesFile, templates);
          return sendJson(response, 200, templates[index]);
        }
        if (request.method === "DELETE") {
          templates.splice(index, 1);
          await writeJson(templatesFile, templates);
          response.writeHead(204);
          return response.end();
        }
      }
      if (url.pathname === "/api/events" && request.method === "GET") {
        response.writeHead(200, {
          "cache-control": "no-cache",
          connection: "keep-alive",
          "content-type": "text/event-stream",
        });
        response.write("event: ready\ndata: {}\n\n");
        eventClients.add(response);
        request.on("close", () => eventClients.delete(response));
        return;
      }
      if (url.pathname === "/api/batches" && request.method === "POST") {
        if (!env.FAL_KEY) return sendJson(response, 503, { error: readiness.generation.message });
        const input = await readBody(request);
        const type = input.type === "video" ? "video" : input.type === "image" ? "image" : "";
        const model = String(input.model ?? "").trim();
        const prompt = String(input.prompt ?? "").trim();
        const quantity = Math.max(1, Math.min(50, Math.floor(Number(input.quantity) || 0)));
        if (!type || !model || !prompt || !quantity) {
          return sendJson(response, 400, { error: "Type, model, prompt, and quantity are required" });
        }
        const batch = {
          id: randomUUID(),
          type,
          model,
          prompt,
          quantity,
          createdAt: now().toISOString(),
          resultIds: [],
        };
        const queued = Array.from({ length: quantity }, () => ({
          id: randomUUID(),
          batchId: batch.id,
          type,
          model,
          prompt,
          state: "queued",
          requestId: "",
          createdAt: now().toISOString(),
          fileUrl: "",
        }));
        for (const result of queued) {
          batch.resultIds.push(result.id);
          results.set(result.id, result);
        }
        batches.set(batch.id, batch);
        sendJson(response, 201, publicBatch(batch));
        pool.add(queued);
        return;
      }
      const batchMatch = url.pathname.match(/^\/api\/batches\/([^/]+)$/);
      if (batchMatch && request.method === "GET") {
        const batch = batches.get(batchMatch[1]);
        return batch
          ? sendJson(response, 200, publicBatch(batch))
          : sendJson(response, 404, { error: "Batch not found" });
      }
      if (url.pathname === "/api/results" && request.method === "GET") {
        const type = url.searchParams.get("type");
        return sendJson(response, 200, {
          results: [...results.values()]
            .filter((result) => !type || result.type === type)
            .map(publicResult),
        });
      }
      const attachmentMatch = url.pathname.match(
        /^\/api\/conversations\/([^/]+)\/attachments\/([^/]+)$/,
      );
      if (attachmentMatch && request.method === "GET") {
        const conversation = conversations.get(attachmentMatch[1]);
        const attachment = conversation?.messages
          .flatMap((message) => message.attachments ?? [])
          .find((item) => item.id === attachmentMatch[2]);
        if (!attachment?.filePath) {
          return sendJson(response, 404, { error: "Attachment not found" });
        }
        response.writeHead(200, { "content-type": attachment.type });
        return createReadStream(attachment.filePath).pipe(response);
      }
      const resultFileMatch = url.pathname.match(/^\/api\/results\/([^/]+)\/file$/);
      if (resultFileMatch && request.method === "GET") {
        const result = results.get(resultFileMatch[1]);
        if (!result?.filePath) return sendJson(response, 404, { error: "Result file not found" });
        response.writeHead(200, {
          "content-type": contentTypes[path.extname(result.filePath)] ?? "application/octet-stream",
        });
        return createReadStream(result.filePath).pipe(response);
      }
      const cancelMatch = url.pathname.match(/^\/api\/results\/([^/]+)\/cancel$/);
      if (cancelMatch && request.method === "POST") {
        const result = results.get(cancelMatch[1]);
        if (!result) return sendJson(response, 404, { error: "Result not found" });
        const queued = pool.cancel(result.id);
        if (queued) {
          result.state = "cancelled";
          notifyResult(result);
          return sendJson(response, 200, publicResult(result));
        }
        if (!["submitting", "submitted", "remote-queued", "running"].includes(result.state)) {
          return sendJson(response, 409, { error: "This result is no longer cancellable" });
        }
        if (!result.requestId) {
          return sendJson(response, 409, { error: "The remote request has not been accepted yet" });
        }
        result.state = "cancelling";
        notifyResult(result);
        try {
          await adapters.cancelMedia({
            endpoint: result.model,
            key: env.FAL_KEY,
            requestId: result.requestId,
          });
          result.state = "cancelled";
        } catch (error) {
          result.state = "failed";
          result.error = error instanceof Error ? error.message : "Cancellation failed";
        }
        notifyResult(result);
        return sendJson(response, 200, publicResult(result));
      }
      const retryMatch = url.pathname.match(/^\/api\/results\/([^/]+)\/retry$/);
      if (retryMatch && request.method === "POST") {
        const original = results.get(retryMatch[1]);
        if (!original) return sendJson(response, 404, { error: "Result not found" });
        if (original.state !== "failed") {
          return sendJson(response, 409, { error: "Only failed results can be retried" });
        }
        const retry = {
          id: randomUUID(),
          attemptOf: original.id,
          batchId: original.batchId ?? "",
          type: original.type,
          model: original.model,
          prompt: original.prompt,
          state: "queued",
          requestId: "",
          createdAt: now().toISOString(),
          fileUrl: "",
        };
        results.set(retry.id, retry);
        if (retry.batchId) batches.get(retry.batchId)?.resultIds.push(retry.id);
        pool.add([retry]);
        return sendJson(response, 202, publicResult(retry));
      }
      const keepMatch = url.pathname.match(/^\/api\/results\/([^/]+)\/keep$/);
      if (keepMatch && request.method === "POST") {
        const result = results.get(keepMatch[1]);
        if (!result) return sendJson(response, 404, { error: "Result not found" });
        try {
          return sendJson(response, 200, publicResult(await keepResult(result)));
        } catch (error) {
          return sendJson(response, 409, { error: error.message });
        }
      }
      if (url.pathname === "/api/results/bulk" && request.method === "POST") {
        const input = await readBody(request);
        const reviewed = [];
        for (const id of input.keep ?? []) {
          const result = results.get(id);
          if (result) reviewed.push(publicResult(await keepResult(result)));
        }
        for (const id of input.discard ?? []) {
          const result = results.get(id);
          if (result) reviewed.push(publicResult(await discardResult(result)));
        }
        return sendJson(response, 200, { results: reviewed });
      }
      const discardMatch = url.pathname.match(/^\/api\/results\/([^/]+)$/);
      if (discardMatch && request.method === "DELETE") {
        const result = results.get(discardMatch[1]);
        if (!result) return sendJson(response, 404, { error: "Result not found" });
        try {
          await discardResult(result);
          response.writeHead(204);
          return response.end();
        } catch (error) {
          return sendJson(response, 409, { error: error.message });
        }
      }
      if (url.pathname === "/api/media" && request.method === "POST") {
        if (!env.FAL_KEY) return sendJson(response, 503, { error: readiness.generation.message });
        const input = await readBody(request);
        const type = input.type === "video" ? "video" : input.type === "image" ? "image" : "";
        const model = String(input.model ?? "").trim();
        const prompt = String(input.prompt ?? "").trim();
        if (!type || !model || !prompt) {
          return sendJson(response, 400, { error: "Type, model, and prompt are required" });
        }
        const id = randomUUID();
        const result = {
          id,
          type,
          model,
          prompt,
          state: "submitting",
          requestId: "",
          createdAt: now().toISOString(),
          fileUrl: "",
        };
        results.set(id, result);
        await runMediaResult(result);
        return sendJson(response, result.state === "completed" ? 201 : 502, publicResult(result));
      }
      if (url.pathname === "/api/conversations") {
        if (request.method === "GET") {
          return sendJson(response, 200, {
            conversations: [...conversations.values()].map(publicConversation),
          });
        }
        if (request.method === "POST") {
          const input = await readBody(request);
          const createdAt = now().toISOString();
          const conversation = {
            id: randomUUID(),
            model: String(input.model ?? ""),
            messages: [],
            createdAt,
            updatedAt: createdAt,
            kept: false,
          };
          conversations.set(conversation.id, conversation);
          return sendJson(response, 201, publicConversation(conversation));
        }
      }
      const keepConversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/keep$/);
      if (keepConversationMatch && request.method === "POST") {
        const conversation = conversations.get(keepConversationMatch[1]);
        if (!conversation) return sendJson(response, 404, { error: "Conversation not found" });
        const directory = path.join(libraryDir, "text");
        await mkdir(directory, { recursive: true });
        const copies = [];
        for (const message of conversation.messages) {
          for (const attachment of message.attachments ?? []) {
            if (attachment.filename) continue;
            const filename = `${conversation.id}-${attachment.id}${path.extname(attachment.name)}`;
            const destination = path.join(directory, filename);
            await copyFile(attachment.filePath, destination);
            copies.push({ attachment, destination, filename, source: attachment.filePath });
          }
        }
        const durable = publicConversation({
          ...conversation,
          kept: true,
          keptAt: now().toISOString(),
        });
        for (const message of durable.messages) {
          for (const attachment of message.attachments ?? []) {
            const copy = copies.find((item) => item.attachment.id === attachment.id);
            attachment.filename = copy?.filename ?? conversation.messages
              .flatMap((item) => item.attachments ?? [])
              .find((item) => item.id === attachment.id)?.filename;
            delete attachment.fileUrl;
          }
        }
        await writeJson(path.join(directory, `${conversation.id}.json`), durable);
        for (const copy of copies) {
          await rm(copy.source, { force: true });
          Object.assign(copy.attachment, {
            filePath: copy.destination,
            filename: copy.filename,
            fileUrl: `/api/conversations/${conversation.id}/attachments/${copy.attachment.id}`,
          });
        }
        conversation.kept = true;
        conversation.keptAt = durable.keptAt;
        return sendJson(response, 200, publicConversation(conversation));
      }
      const discardConversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
      if (discardConversationMatch && request.method === "DELETE") {
        const conversation = conversations.get(discardConversationMatch[1]);
        if (!conversation) return sendJson(response, 404, { error: "Conversation not found" });
        for (const attachment of conversation.messages.flatMap((message) => message.attachments ?? [])) {
          if (attachment.filePath) await rm(attachment.filePath, { force: true });
        }
        if (conversation.kept) {
          await rm(path.join(libraryDir, "text", `${conversation.id}.json`), { force: true });
        }
        conversations.delete(conversation.id);
        response.writeHead(204);
        return response.end();
      }
      const messageMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if (messageMatch && request.method === "POST") {
        if (!env.FAL_KEY) return sendJson(response, 503, { error: readiness.generation.message });
        const conversation = conversations.get(messageMatch[1]);
        if (!conversation) return sendJson(response, 404, { error: "Conversation not found" });
        const input = await readBody(request);
        const content = String(input.content ?? "").trim();
        const attachmentInput = input.attachment;
        if (!content && !attachmentInput) {
          return sendJson(response, 400, { error: "Message or image is required" });
        }
        const attachments = [];
        if (attachmentInput) {
          const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
          const type = String(attachmentInput.type ?? "").toLowerCase();
          if (!allowed.has(type)) {
            return sendJson(response, 415, { error: "Attach a PNG, JPEG, or WebP image." });
          }
          if (textCapabilities.get(conversation.model)?.supportsImages === false) {
            return sendJson(response, 409, {
              error: "The selected model does not advertise image input support.",
            });
          }
          const bytes = Buffer.from(String(attachmentInput.data ?? ""), "base64");
          const valid =
            (type === "image/png" &&
              bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
            (type === "image/jpeg" &&
              bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) ||
            (type === "image/webp" &&
              bytes.subarray(0, 4).toString() === "RIFF" &&
              bytes.subarray(8, 12).toString() === "WEBP");
          if (!valid) return sendJson(response, 415, { error: "The attached image data is invalid." });
          const attachmentId = randomUUID();
          const extension = type === "image/jpeg" ? ".jpg" : type === "image/png" ? ".png" : ".webp";
          const directory = path.join(tempDir, "attachments", conversation.id);
          await mkdir(directory, { recursive: true });
          const filePath = path.join(directory, `${attachmentId}${extension}`);
          await writeFile(filePath, bytes);
          attachments.push({
            id: attachmentId,
            name: String(attachmentInput.name ?? `attachment${extension}`),
            type,
            filePath,
            fileUrl: `/api/conversations/${conversation.id}/attachments/${attachmentId}`,
          });
        }
        conversation.messages.push({
          id: randomUUID(),
          role: "user",
          content,
          createdAt: now().toISOString(),
          attachments,
        });
        const context = await chatContext(conversation);
        return streamReply(response, conversation, context);
      }
      const regenerateMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/regenerate$/);
      if (regenerateMatch && request.method === "POST") {
        const conversation = conversations.get(regenerateMatch[1]);
        if (!conversation) return sendJson(response, 404, { error: "Conversation not found" });
        const previous = [...conversation.messages].reverse().find((message) => message.role === "assistant" && !message.superseded);
        if (!previous) return sendJson(response, 400, { error: "There is no reply to regenerate" });
        previous.superseded = true;
        const context = await chatContext(conversation);
        return streamReply(response, conversation, context, previous.id);
      }
      if (url.pathname === "/api/preferences") {
        if (request.method === "GET") {
          return sendJson(response, 200, await readJson(preferencesFile, defaultPreferences));
        }
        if (request.method === "PUT") {
          const value = await readBody(request);
          await writeJson(preferencesFile, {
            favorites: {
              image: Array.isArray(value.favorites?.image) ? value.favorites.image : [],
              video: Array.isArray(value.favorites?.video) ? value.favorites.video : [],
            },
            selections: {
              text: String(value.selections?.text ?? ""),
              image: String(value.selections?.image ?? ""),
              video: String(value.selections?.video ?? ""),
            },
            concurrency: Math.max(1, Math.min(20, Number(value.concurrency) || 2)),
          });
          const saved = await readJson(preferencesFile, defaultPreferences);
          pool.setConcurrency(saved.concurrency);
          return sendJson(response, 200, saved);
        }
      }
      if (url.pathname === "/api/account" && request.method === "POST") {
        if (!env.FAL_KEY) {
          return sendJson(response, 503, {
            error: "Set an Admin-scoped FAL_KEY in .env to load credits and usage.",
          });
        }
        try {
          const current = now();
          const monthStart = `${current.getUTCFullYear()}-${String(current.getUTCMonth() + 1).padStart(2, "0")}-01`;
          const [billing, usage] = await Promise.all([
            adapters.getBilling({ key: env.FAL_KEY }),
            adapters.getUsage({ end: dateKey(current), key: env.FAL_KEY, start: monthStart }),
          ]);
          lastAccount = accountSummary(billing, usage, current);
          return sendJson(response, 200, lastAccount);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Account refresh failed";
          if (lastAccount) return sendJson(response, 200, { ...lastAccount, stale: true, error: message });
          return sendJson(response, 502, {
            error: `${message.replace(/[.\s]+$/, "")}. Account usage requires an Admin-scoped FAL key.`,
          });
        }
      }
      const modelMatch = url.pathname.match(/^\/api\/models\/(text|image|video)$/);
      if (modelMatch && request.method === "GET") {
        const type = modelMatch[1];
        if (type === "text") {
          if (!env.OPENROUTER_API_KEY) return sendJson(response, 503, { error: readiness.openrouterCatalog.message });
          const payload = await adapters.listOpenRouterModels({ token: env.OPENROUTER_API_KEY });
          const models = normalizeOpenRouter(payload);
          textCapabilities.clear();
          for (const model of models) textCapabilities.set(model.id, model);
          return sendJson(response, 200, {
            provider: "openrouter/router",
            models,
          });
        }
        if (!env.FAL_KEY) return sendJson(response, 503, { error: readiness.generation.message });
        const preferences = await readJson(preferencesFile, defaultPreferences);
        const payload = await adapters.listFalModels({
          category: type === "image" ? "text-to-image" : "text-to-video",
          key: env.FAL_KEY,
        });
        const query = (url.searchParams.get("search") ?? "").trim().toLowerCase();
        const models = normalizeFal(payload, preferences.favorites[type])
          .filter(
            (model) =>
              !query ||
              model.name.toLowerCase().includes(query) ||
              model.id.toLowerCase().includes(query) ||
              model.description.toLowerCase().includes(query),
          )
          .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
        return sendJson(response, 200, { models });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return sendJson(response, 405, { error: "Method not allowed" });
      }

      const base = await access(path.join(builtRoot, "index.html"))
        .then(() => builtRoot)
        .catch(() => sourceRoot);
      let file = safeStaticPath(base, url.pathname);
      if (!file) return sendJson(response, 404, { error: "Not found" });
      try {
        await access(file);
      } catch {
        file = path.join(base, "index.html");
      }
      response.writeHead(200, {
        "content-type": contentTypes[path.extname(file)] ?? "application/octet-stream",
      });
      if (request.method === "HEAD") return response.end();
      createReadStream(file).pipe(response);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Server error" });
    }
  });

  return {
    readiness,
    root,
    tempDir,
    libraryDir,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address();
          if (!address || typeof address === "string") return reject(new Error("No server address"));
          resolve(`http://${host}:${address.port}`);
        });
      });
    },
    async close() {
      const unfinished = pool.stop();
      for (const result of unfinished.queued) {
        result.state = "cancelled";
        notifyResult(result);
      }
      await Promise.all(
        unfinished.active.map(async (result) => {
          if (!result.requestId || !adapters.cancelMedia) return;
          try {
            await adapters.cancelMedia({
              endpoint: result.model,
              key: env.FAL_KEY,
              requestId: result.requestId,
            });
            result.state = "cancelled";
          } catch (error) {
            result.error = error instanceof Error ? error.message : "Shutdown cancellation failed";
          }
          notifyResult(result);
        }),
      );
      let idleTimer;
      await Promise.race([
        pool.waitForIdle(),
        new Promise((resolve) => {
          idleTimer = setTimeout(resolve, 5_000);
        }),
      ]);
      clearTimeout(idleTimer);
      const closed = new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await closed;
      await cleanTemp(tempDir);
    },
  };
}
