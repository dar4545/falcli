import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
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

function labelFor(name, schema) {
  if (schema.title) return schema.title;
  const words = name.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function resolveSchema(document, schema) {
  if (!schema?.$ref) return schema;
  return schema.$ref
    .replace(/^#\//, "")
    .split("/")
    .reduce((value, key) => value?.[key], document);
}

function inputSchema(model) {
  const document = model.openapi ?? model.openapi_schema ?? model["openapi-3.0"];
  if (!document) return null;
  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const operation of Object.values(pathItem ?? {})) {
      const schema = operation?.requestBody?.content?.["application/json"]?.schema;
      if (schema) return resolveSchema(document, schema);
    }
  }
  return (
    document.components?.schemas?.Input ??
    Object.entries(document.components?.schemas ?? {}).find(([name]) => name.endsWith("Input"))?.[1] ??
    null
  );
}

function fileField(name, schema, required) {
  const stringField =
    schema?.type === "string" ||
    (schema?.type === "array" && schema.items?.type === "string");
  const describedAsFile = /\b(?:file input|input file|upload(?:ed)? file)\b/i.test(
    schema?.description ?? "",
  );
  if (!stringField || (!/_urls?$/.test(name) && !describedAsFile)) return null;
  const hint = `${name.replaceAll("_", " ")} ${schema.title ?? ""} ${schema.description ?? ""}`.toLowerCase();
  const mediaType = /\b(?:image|mask)\b/.test(hint)
    ? "image"
    : /\bvideo\b/.test(hint)
      ? "video"
      : /\baudio\b/.test(hint)
        ? "audio"
        : /\b(?:pdf|document)\b/.test(hint)
          ? "document"
          : "file";
  return {
    name,
    label: labelFor(name, schema),
    description: schema.description ?? "",
    cardinality: schema.type === "array" ? "array" : "single",
    required,
    mediaType,
  };
}

function modesFor(type, fields) {
  const requiredFiles = fields.some((field) => field.required);
  if (type === "image") {
    return [
      ...(!requiredFiles ? ["text-to-image"] : []),
      ...(fields.length ? ["image-to-image"] : []),
    ];
  }
  const image = fields.some((field) => field.mediaType === "image");
  const video = fields.some((field) => field.mediaType === "video");
  return [
    ...(!requiredFiles ? ["text-to-video"] : []),
    ...(image ? ["image-to-video"] : []),
    ...(video ? ["video-to-video"] : []),
    ...(image && video ? ["mixed-references-to-video"] : []),
  ];
}

function normalizeFal(payload, favorites, type) {
  return (payload.models ?? payload.data ?? []).flatMap((model) => {
    const metadata = model.metadata ?? {};
    const id = model.endpoint_id ?? model.id ?? model.model_id;
    const schema = inputSchema(model);
    if (!schema) {
      return [{
        id,
        name: metadata.display_name ?? model.name ?? id,
        description: metadata.description ?? model.description ?? "",
        thumbnail: metadata.thumbnail_url ?? model.thumbnail_url ?? model.thumbnail ?? "",
        favorite: favorites.includes(id),
        modes: [type === "image" ? "text-to-image" : "text-to-video"],
        prompt: {
          name: "prompt",
          label: "Prompt",
          description: "",
          required: false,
        },
        fileFields: [],
        schemaStatus: "unavailable",
        warning: "Model schema is unavailable. Attachment modes require a retry.",
      }];
    }
    const required = new Set(schema.required ?? []);
    const properties = schema.properties ?? {};
    const fields = Object.entries(properties).flatMap(([name, property]) => {
      const field = fileField(name, property, required.has(name));
      return field ? [field] : [];
    });
    const supported = new Set(["prompt", ...fields.map((field) => field.name)]);
    if ([...required].some((name) => !supported.has(name))) return [];
    const promptSchema = properties.prompt;
    if (required.has("prompt") && promptSchema?.type !== "string") return [];
    return [{
      id,
      name: metadata.display_name ?? model.name ?? id,
      description: metadata.description ?? model.description ?? "",
      thumbnail: metadata.thumbnail_url ?? model.thumbnail_url ?? model.thumbnail ?? "",
      favorite: favorites.includes(id),
      modes: modesFor(type, fields),
      prompt:
        promptSchema?.type === "string"
          ? {
              name: "prompt",
              label: labelFor("prompt", promptSchema),
              description: promptSchema.description ?? "",
              required: required.has("prompt"),
            }
          : null,
      fileFields: fields,
      schemaStatus: "ready",
    }];
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

function mediaFailure(error) {
  const status = Number(
    error?.status ?? error?.statusCode ?? error?.response?.status,
  );
  const message =
    (error instanceof Error && error.message) ||
    error?.message ||
    "Generation failed";
  const details =
    error?.details ??
    error?.body ??
    error?.response?.data ??
    error?.response?.body;
  return {
    ...(Number.isFinite(status) && { status }),
    message,
    ...(details !== undefined && { details }),
  };
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
  const { filePath, input, ...visible } = result;
  return visible;
}

function publicMediaSource(source) {
  const { batchIds, filePath, removed, ...visible } = source;
  return visible;
}

function sourceProvenance(source) {
  return {
    name: source.name,
    type: source.type,
    size: source.size,
    hash: source.hash,
    ...(Number.isFinite(source.duration) && { duration: source.duration }),
  };
}

function sourceFieldProvenance(sourceFields) {
  return Object.fromEntries(
    Object.entries(sourceFields ?? {}).map(([field, assigned]) => [
      field,
      Array.isArray(assigned)
        ? assigned.map(sourceProvenance)
        : sourceProvenance(assigned),
    ]),
  );
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
  const maxSourceBytes = options.sourceLimits?.fileBytes ?? 1024 ** 3;
  const maxBatchSourceBytes = options.sourceLimits?.batchBytes ?? 2 * 1024 ** 3;
  const tempDir = path.join(root, "temp");
  const mediaSourceDir = path.join(tempDir, "media-sources");
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
    modes: { image: "text-to-image", video: "text-to-video" },
    modeSelections: { image: {}, video: {} },
    concurrency: 2,
  };
  function normalizePreferences(value = {}) {
    const selections = {
      text: String(value.selections?.text ?? ""),
      image: String(value.selections?.image ?? ""),
      video: String(value.selections?.video ?? ""),
    };
    const modes = {
      image: String(value.modes?.image ?? "text-to-image"),
      video: String(value.modes?.video ?? "text-to-video"),
    };
    const selectionMap = (type) => {
      const saved = Object.fromEntries(
        Object.entries(value.modeSelections?.[type] ?? {}).map(([mode, model]) => [
          mode,
          String(model ?? ""),
        ]),
      );
      if (!Object.keys(saved).length && selections[type]) saved[modes[type]] = selections[type];
      return saved;
    };
    return {
      favorites: {
        image: Array.isArray(value.favorites?.image) ? value.favorites.image : [],
        video: Array.isArray(value.favorites?.video) ? value.favorites.video : [],
      },
      selections,
      modes,
      modeSelections: {
        image: selectionMap("image"),
        video: selectionMap("video"),
      },
      concurrency: Math.max(1, Math.min(20, Number(value.concurrency) || 2)),
    };
  }
  let lastAccount = null;
  const conversations = new Map(
    (await loadKeptConversations(libraryDir)).map((conversation) => [conversation.id, conversation]),
  );
  const results = new Map((await loadKeptResults(libraryDir)).map((result) => [result.id, result]));
  const mediaSources = new Map();
  const textCapabilities = new Map();
  const falCatalogs = new Map();
  const batches = new Map();
  const eventClients = new Set();
  const initialPreferences = normalizePreferences(
    await readJson(preferencesFile, defaultPreferences),
  );

  function notifyResult(result) {
    const event = `event: result\ndata: ${JSON.stringify(publicResult(result))}\n\n`;
    for (const client of eventClients) client.write(event);
  }

  function stopUnsentBatchResults(rejected, failure) {
    if (!rejected.batchId || ![400, 422].includes(failure.status)) return;
    const batch = batches.get(rejected.batchId);
    if (!batch) return;
    for (const id of batch.resultIds) {
      if (id === rejected.id) continue;
      const result = results.get(id);
      if (!result || !pool.cancel(id)) continue;
      result.state = "not-submitted";
      result.error = "Not submitted — same payload rejected by FAL";
      result.failure = {
        ...failure,
        message: result.error,
      };
      notifyResult(result);
    }
  }

  async function runMediaResult(result) {
    result.state = "submitting";
    notifyResult(result);
    try {
      const generated = await adapters.generateMedia({
        endpoint: result.model,
        input: result.input ?? { prompt: result.prompt },
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
        const failure = mediaFailure(error);
        result.state = "failed";
        result.error = failure.message;
        result.failure = failure;
        stopUnsentBatchResults(result, failure);
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
      ...(result.sourceFields && {
        sourceFields: sourceFieldProvenance(result.sourceFields),
      }),
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
    await cleanupBatchSources(result.batchId);
    return result;
  }

  async function discardResult(result) {
    if (result.state === "kept") throw new Error("Kept results cannot be discarded here");
    if (result.filePath) await rm(result.filePath, { force: true });
    result.filePath = "";
    result.fileUrl = "";
    result.state = "discarded";
    notifyResult(result);
    await cleanupBatchSources(result.batchId);
    return result;
  }

  function publicBatch(batch) {
    const {
      input,
      promptProvided,
      resultIds,
      sourceAssignments,
      sourceIds,
      uploads,
      ...visible
    } = batch;
    return {
      ...visible,
      results: batch.resultIds.map((id) => publicResult(results.get(id))),
    };
  }

  async function uploadMediaSource(source) {
    const stored = await adapters.uploadMediaSource({
      filePath: source.filePath,
      hash: source.hash,
      key: env.FAL_KEY,
      lifecycle: { expiresIn: "1d" },
      name: source.name,
      size: source.size,
      type: source.type,
    });
    const uploadedAt = now();
    return {
      url: typeof stored === "string" ? stored : stored.url,
      uploadedAt: uploadedAt.toISOString(),
      expiresAt: new Date(uploadedAt.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
    };
  }

  async function cleanupBatchSources(batchId) {
    if (!batchId) return;
    const batch = batches.get(batchId);
    if (
      !batch ||
      batch.sourcesCleaned ||
      batch.resultIds.some(
        (id) => !["kept", "discarded", "cancelled"].includes(results.get(id)?.state),
      )
    ) {
      return;
    }
    batch.sourcesCleaned = true;
    batch.sourceFields = sourceFieldProvenance(batch.sourceFields);
    for (const id of batch.resultIds) {
      const result = results.get(id);
      if (result?.sourceFields) result.sourceFields = sourceFieldProvenance(result.sourceFields);
    }
    for (const sourceId of batch.sourceIds) {
      const source = mediaSources.get(sourceId);
      if (!source) continue;
      source.batchIds?.delete(batch.id);
      if (source.batchIds?.size) continue;
      await rm(source.filePath, { force: true });
      mediaSources.delete(source.id);
    }
    for (const id of batch.resultIds) {
      const result = results.get(id);
      if (result) notifyResult(result);
    }
  }

  async function refreshExpiredBatchInput(batch) {
    const currentTime = now().getTime();
    if (
      ![...batch.uploads.values()].some(
        (upload) => Date.parse(upload.expiresAt) <= currentTime,
      )
    ) {
      return batch.input;
    }
    const uniqueSources = new Map();
    for (const sourceId of batch.sourceIds) {
      const source = mediaSources.get(sourceId);
      if (!source) {
        throw Object.assign(
          new Error(
            "Temporary source files are no longer available; this result cannot be retried",
          ),
          { code: "SOURCE_UNAVAILABLE" },
        );
      }
      try {
        await access(source.filePath);
      } catch {
        throw Object.assign(
          new Error(
            "Temporary source files are no longer available; this result cannot be retried",
          ),
          { code: "SOURCE_UNAVAILABLE" },
        );
      }
      uniqueSources.set(source.hash, source);
    }
    for (const [hash, source] of uniqueSources) {
      const current = batch.uploads.get(hash);
      if (current && Date.parse(current.expiresAt) > currentTime) continue;
      batch.uploads.set(hash, await uploadMediaSource(source));
    }
    const input = {};
    if (batch.promptProvided) input.prompt = batch.prompt;
    for (const [field, assigned] of Object.entries(batch.sourceAssignments)) {
      const ids = Array.isArray(assigned) ? assigned : [assigned];
      const urls = ids.map((id) => batch.uploads.get(mediaSources.get(id).hash).url);
      input[field] = Array.isArray(assigned) ? Object.freeze(urls) : urls[0];
    }
    batch.input = Object.freeze(input);
    return batch.input;
  }

  async function availableEditSourceFields(batch) {
    if (!batch || batch.sourcesCleaned) return {};
    const sourceFields = {};
    for (const [field, assigned] of Object.entries(batch.sourceAssignments)) {
      const ids = Array.isArray(assigned) ? assigned : [assigned];
      const available = [];
      for (const id of ids) {
        const source = mediaSources.get(id);
        if (!source) continue;
        try {
          await access(source.filePath);
          available.push(publicMediaSource(source));
        } catch {}
      }
      if (available.length) {
        sourceFields[field] = Array.isArray(assigned) ? available : available[0];
      }
    }
    return sourceFields;
  }

  const pool = createWorkPool({
    concurrency: initialPreferences.concurrency,
    worker: runMediaResult,
  });

  async function chatContext(conversation) {
    const context = [];
    for (const message of conversation.messages.filter((item) => !item.superseded)) {
      if (message.role !== "user" || !message.attachments?.length) {
        context.push({
          role: message.role,
          content: message.content,
          ...(message.role === "assistant" &&
            message.reasoning && { reasoning: message.reasoning }),
        });
        continue;
      }
      const content = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const attachment of message.attachments) {
        const data = await readFile(attachment.filePath, "base64");
        const dataUrl = `data:${attachment.type};base64,${data}`;
        content.push(
          attachment.type.startsWith("image/")
            ? {
                type: "image_url",
                image_url: { url: dataUrl },
              }
            : {
                type: "file",
                file: {
                  filename: attachment.name,
                  file_data: dataUrl,
                },
              },
        );
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
    let reasoning = "";
    try {
      for await (const chunk of adapters.streamChat({
        key: env.FAL_KEY,
        messages,
        model: conversation.model,
      })) {
        const event =
          typeof chunk === "string"
            ? { type: "content", content: chunk }
            : chunk;
        if (typeof event?.content !== "string" || !event.content) continue;
        if (event.type === "reasoning") {
          reasoning += event.content;
          sendEvent(response, { type: "reasoning", content: event.content });
        } else {
          content += event.content;
          sendEvent(response, { type: "delta", content: event.content });
        }
      }
      conversation.messages.push({
        id: randomUUID(),
        role: "assistant",
        content,
        ...(reasoning && { reasoning }),
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
      if (url.pathname === "/api/media-sources" && request.method === "POST") {
        const declaredSize = Number(request.headers["content-length"] ?? 0);
        if (declaredSize > maxSourceBytes) {
          return sendJson(response, 413, { error: "Source files are limited to 1 GiB each" });
        }
        const id = randomUUID();
        const name = String(url.searchParams.get("name") ?? "source");
        const type = String(request.headers["content-type"] ?? "application/octet-stream");
        const duration = url.searchParams.has("duration")
          ? Number(url.searchParams.get("duration"))
          : null;
        await mkdir(mediaSourceDir, { recursive: true });
        const filePath = path.join(mediaSourceDir, id);
        const handle = await open(filePath, "wx");
        const hash = createHash("sha256");
        let size = 0;
        let streamError = null;
        try {
          for await (const chunk of request) {
            size += chunk.length;
            if (size > maxSourceBytes) throw new Error("Source files are limited to 1 GiB each");
            hash.update(chunk);
            await handle.write(chunk);
          }
        } catch (error) {
          streamError = error;
        } finally {
          await handle.close();
        }
        if (streamError) {
          await rm(filePath, { force: true });
          if (size > maxSourceBytes) {
            return sendJson(response, 413, { error: "Source files are limited to 1 GiB each" });
          }
          throw streamError;
        }
        if (!size) {
          await rm(filePath, { force: true });
          return sendJson(response, 400, { error: "Source file must not be empty" });
        }
        const source = {
          id,
          name,
          type,
          size,
          hash: hash.digest("hex"),
          filePath,
          fileUrl: `/api/media-sources/${id}/file`,
          state: "Local",
          ...(Number.isFinite(duration) && duration >= 0 && { duration }),
        };
        mediaSources.set(id, source);
        return sendJson(response, 201, publicMediaSource(source));
      }
      const mediaSourceFileMatch = url.pathname.match(/^\/api\/media-sources\/([^/]+)\/file$/);
      if (mediaSourceFileMatch && request.method === "GET") {
        const source = mediaSources.get(mediaSourceFileMatch[1]);
        if (!source) return sendJson(response, 404, { error: "Media source not found" });
        response.writeHead(200, { "content-type": source.type });
        return createReadStream(source.filePath).pipe(response);
      }
      const mediaSourceMatch = url.pathname.match(/^\/api\/media-sources\/([^/]+)$/);
      if (mediaSourceMatch && request.method === "DELETE") {
        const source = mediaSources.get(mediaSourceMatch[1]);
        if (!source) return sendJson(response, 404, { error: "Media source not found" });
        if (source.batchIds?.size) {
          source.removed = true;
          response.writeHead(204);
          return response.end();
        }
        await rm(source.filePath, { force: true });
        mediaSources.delete(source.id);
        response.writeHead(204);
        return response.end();
      }
      if (url.pathname === "/api/batches" && request.method === "POST") {
        if (!env.FAL_KEY) return sendJson(response, 503, { error: readiness.generation.message });
        const input = await readBody(request);
        const type = input.type === "video" ? "video" : input.type === "image" ? "image" : "";
        const model = String(input.model ?? "").trim();
        const promptProvided = Object.hasOwn(input, "prompt");
        const prompt = String(input.prompt ?? "");
        const quantity = Math.max(1, Math.min(50, Math.floor(Number(input.quantity) || 0)));
        if (!type || !model || !quantity) {
          return sendJson(response, 400, { error: "Type, model, and quantity are required" });
        }
        const sourceFields = {};
        const uniqueSources = new Map();
        for (const [field, assigned] of Object.entries(input.sourceFields ?? {})) {
          const ids = Array.isArray(assigned) ? assigned : [assigned];
          const assignedSources = ids.map((id) => mediaSources.get(String(id)));
          if (assignedSources.some((source) => !source)) {
            return sendJson(response, 400, { error: `A staged source for ${field} was not found` });
          }
          sourceFields[field] = Array.isArray(assigned)
            ? assignedSources.map(publicMediaSource)
            : publicMediaSource(assignedSources[0]);
          for (const source of assignedSources) uniqueSources.set(source.hash, source);
        }
        const batchSourceBytes = [...uniqueSources.values()].reduce(
          (total, source) => total + source.size,
          0,
        );
        if (batchSourceBytes > maxBatchSourceBytes) {
          return sendJson(response, 413, {
            error: "Unique source files are limited to 2 GiB per Batch",
          });
        }
        const uploaded = new Map();
        for (const [hash, source] of uniqueSources) {
          try {
            await access(source.filePath);
            source.state = "Uploading";
            const upload = await uploadMediaSource(source);
            source.state = "Uploaded";
            uploaded.set(hash, upload);
          } catch (error) {
            source.state = "Failed";
            return sendJson(response, 502, {
              error: error instanceof Error ? error.message : "Source upload failed",
            });
          }
        }
        const generationInput = {};
        if (promptProvided) generationInput.prompt = prompt;
        for (const [field, assigned] of Object.entries(input.sourceFields ?? {})) {
          const ids = Array.isArray(assigned) ? assigned : [assigned];
          const urls = ids.map((id) => uploaded.get(mediaSources.get(String(id)).hash).url);
          generationInput[field] = Array.isArray(assigned) ? Object.freeze(urls) : urls[0];
          const assignedSources = ids.map((id) => mediaSources.get(String(id)));
          sourceFields[field] = Array.isArray(assigned)
            ? assignedSources.map(publicMediaSource)
            : publicMediaSource(assignedSources[0]);
        }
        Object.freeze(generationInput);
        const batch = {
          id: randomUUID(),
          type,
          mode: String(
            input.mode ?? (type === "image" ? "text-to-image" : "text-to-video"),
          ),
          model,
          prompt,
          promptProvided,
          quantity,
          sourceFields,
          sourceAssignments: Object.fromEntries(
            Object.entries(input.sourceFields ?? {}).map(([field, assigned]) => [
              field,
              Array.isArray(assigned) ? assigned.map(String) : String(assigned),
            ]),
          ),
          sourceIds: [...new Set(
            Object.values(input.sourceFields ?? {}).flatMap((assigned) =>
              (Array.isArray(assigned) ? assigned : [assigned]).map(String),
            ),
          )],
          input: generationInput,
          uploads: uploaded,
          createdAt: now().toISOString(),
          resultIds: [],
        };
        for (const sourceId of batch.sourceIds) {
          const source = mediaSources.get(sourceId);
          if (!source) continue;
          source.batchIds ??= new Set();
          source.batchIds.add(batch.id);
        }
        const queued = Array.from({ length: quantity }, () => ({
          id: randomUUID(),
          batchId: batch.id,
          type,
          mode: batch.mode,
          model,
          prompt,
          input: generationInput,
          sourceFields,
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
      const editInputMatch = url.pathname.match(/^\/api\/results\/([^/]+)\/edit-input$/);
      if (editInputMatch && request.method === "GET") {
        const result = results.get(editInputMatch[1]);
        if (!result) return sendJson(response, 404, { error: "Result not found" });
        return sendJson(response, 200, {
          type: result.type,
          mode:
            result.mode ??
            (result.type === "image" ? "text-to-image" : "text-to-video"),
          model: result.model,
          prompt: result.prompt,
          sourceFields: await availableEditSourceFields(batches.get(result.batchId)),
        });
      }
      const cancelMatch = url.pathname.match(/^\/api\/results\/([^/]+)\/cancel$/);
      if (cancelMatch && request.method === "POST") {
        const result = results.get(cancelMatch[1]);
        if (!result) return sendJson(response, 404, { error: "Result not found" });
        const queued = pool.cancel(result.id);
        if (queued) {
          result.state = "cancelled";
          notifyResult(result);
          await cleanupBatchSources(result.batchId);
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
          await cleanupBatchSources(result.batchId);
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
        if (!["failed", "not-submitted"].includes(original.state)) {
          return sendJson(response, 409, {
            error: "Only failed or not-submitted results can be retried",
          });
        }
        let retryInput = original.input;
        const batch = batches.get(original.batchId);
        try {
          retryInput = (batch && await refreshExpiredBatchInput(batch)) ?? retryInput;
        } catch (error) {
          return sendJson(response, error?.code === "SOURCE_UNAVAILABLE" ? 409 : 502, {
            error: error instanceof Error ? error.message : "Source upload failed",
          });
        }
        const retry = {
          id: randomUUID(),
          attemptOf: original.id,
          batchId: original.batchId ?? "",
          type: original.type,
          mode: original.mode,
          model: original.model,
          prompt: original.prompt,
          input: retryInput,
          sourceFields: original.sourceFields,
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
        const attachmentInputs = Array.isArray(input.attachments)
          ? input.attachments
          : input.attachment
            ? [input.attachment]
            : [];
        if (!content && !attachmentInputs.length) {
          return sendJson(response, 400, { error: "Message or attachment is required" });
        }
        const attachments = [];
        for (const attachmentInput of attachmentInputs) {
          const type =
            String(attachmentInput.type ?? "").trim().toLowerCase() ||
            "application/octet-stream";
          if (
            type.startsWith("image/") &&
            textCapabilities.get(conversation.model)?.supportsImages === false
          ) {
            return sendJson(response, 409, {
              error: "The selected model does not advertise image input support.",
            });
          }
          const bytes = Buffer.from(String(attachmentInput.data ?? ""), "base64");
          const validatedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
          const validImage =
            (type === "image/png" &&
              bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
            (type === "image/jpeg" &&
              bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) ||
            (type === "image/webp" &&
              bytes.subarray(0, 4).toString() === "RIFF" &&
              bytes.subarray(8, 12).toString() === "WEBP");
          if (validatedImageTypes.has(type) && !validImage) {
            return sendJson(response, 415, { error: "The attached image data is invalid." });
          }
          const attachmentId = randomUUID();
          const name = String(attachmentInput.name ?? "attachment");
          const requestedExtension = path.extname(name);
          const extension = /^\.[a-z0-9]{1,16}$/i.test(requestedExtension)
            ? requestedExtension
            : "";
          const directory = path.join(tempDir, "attachments", conversation.id);
          await mkdir(directory, { recursive: true });
          const filePath = path.join(directory, `${attachmentId}${extension}`);
          await writeFile(filePath, bytes);
          attachments.push({
            id: attachmentId,
            name,
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
          return sendJson(
            response,
            200,
            normalizePreferences(await readJson(preferencesFile, defaultPreferences)),
          );
        }
        if (request.method === "PUT") {
          const value = await readBody(request);
          await writeJson(preferencesFile, normalizePreferences(value));
          const saved = normalizePreferences(await readJson(preferencesFile, defaultPreferences));
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
        const preferences = normalizePreferences(
          await readJson(preferencesFile, defaultPreferences),
        );
        if (url.searchParams.get("refresh") === "1") falCatalogs.delete(type);
        let catalog = falCatalogs.get(type);
        if (!catalog) {
          const categories =
            type === "image"
              ? ["text-to-image", "image-to-image"]
              : ["text-to-video", "image-to-video", "video-to-video"];
          try {
            catalog = {
              payload: await adapters.listFalModels({
                categories,
                category: categories[0],
                expand: "openapi-3.0",
                key: env.FAL_KEY,
              }),
            };
          } catch (error) {
            catalog = {
              payload: await adapters.listFalModels({
                categories,
                category: categories[0],
                key: env.FAL_KEY,
              }),
              warning: error instanceof Error ? error.message : "Model schema is unavailable",
            };
          }
          falCatalogs.set(type, catalog);
        }
        const payload = catalog.payload;
        const query = (url.searchParams.get("search") ?? "").trim().toLowerCase();
        const models = normalizeFal(payload, preferences.favorites[type], type)
          .filter(
            (model) =>
              !query ||
              model.name.toLowerCase().includes(query) ||
              model.id.toLowerCase().includes(query) ||
              model.description.toLowerCase().includes(query),
          )
          .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
        const unavailable = models.some((model) => model.schemaStatus === "unavailable");
        return sendJson(response, 200, {
          models,
          ...((catalog.warning || unavailable) && {
            warning: catalog.warning ?? "Some model schemas are unavailable.",
            retry: `/api/models/${type}?refresh=1`,
          }),
        });
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
