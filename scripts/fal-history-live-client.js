(() => {
  "use strict";

  const config = window.__FAL_HISTORY_CONFIG__;
  if (!config) return;

  const byId = (id) => document.getElementById(id);
  const elements = {
    status: byId("live-status"),
    refresh: byId("refresh-live"),
    periodSpend: byId("period-spend"),
    generatedContentCount: byId("generated-content-count"),
    totalSize: byId("total-size"),
    contentMix: byId("content-mix-value"),
    dailySpend: byId("daily-spend"),
    generatedContent: byId("generated-content"),
    familySpend: byId("family-spend"),
    averageFileSpend: byId("average-file-spend"),
    models: byId("models-body"),
    gallery: byId("gallery"),
    search: byId("search"),
    empty: byId("empty"),
    pagination: byId("pagination"),
    previousPage: byId("previous-page"),
    nextPage: byId("next-page"),
    pageStatus: byId("page-status"),
    promptModal: byId("prompt-modal"),
    promptModalContent: byId("prompt-modal-content"),
    closePromptModal: byId("close-prompt-modal"),
    updateScreen: byId("update-screen"),
    updateTitle: byId("update-title"),
    updateDetail: byId("update-detail"),
    updateProgress: byId("update-progress"),
    updateProgressText: byId("update-progress-text"),
    chooseHistoryFolder: byId("choose-history-folder"),
    dropHistoryFolder: byId("drop-history-folder"),
    closeUpdate: byId("close-update"),
  };
  const filterButtons = [...document.querySelectorAll("[data-filter]")];
  const state = { cards: [], filter: "all", page: 1, pageSize: 16, updating: false };

  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]);
  const currency = (value) => `$${Number(value ?? 0).toFixed(2)}`;
  const integer = (value) => new Intl.NumberFormat("en-US").format(value ?? 0);
  const bytes = (value) => {
    if (!value) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  };
  const endpointType = (endpoint) => {
    const value = String(endpoint ?? "").toLowerCase();
    if (value.includes("video")) return "video";
    if (/speech|voice|audio|music/.test(value)) return "audio";
    if (/image|flux|banana/.test(value)) return "image";
    if (/chat|openrouter|llm|text/.test(value)) return "text";
    return "other";
  };
  const localDate = (value) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit", month: "2-digit", year: "numeric", timeZone: config.timezone,
    }).formatToParts(value);
    const part = (type) => parts.find((item) => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const addDays = (date, days) => {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  };
  const promptFor = (input) => {
    if (!input || typeof input !== "object") return "";
    for (const key of ["prompt", "text", "description"]) {
      if (typeof input[key] === "string" && input[key].trim()) return input[key].trim();
    }
    if (Array.isArray(input.messages)) {
      for (const message of [...input.messages].reverse()) {
        if (message?.role !== "user") continue;
        if (typeof message.content === "string" && message.content.trim()) return message.content.trim();
        if (Array.isArray(message.content)) {
          const text = message.content
            .filter((part) => part?.type === "text" && typeof part.text === "string")
            .map((part) => part.text.trim()).filter(Boolean).join("\n\n");
          if (text) return text;
        }
      }
    }
    return "";
  };
  const extension = (url) => {
    try {
      const name = decodeURIComponent(new URL(url).pathname).toLowerCase();
      return name.includes(".") ? `.${name.split(".").pop()}` : "";
    } catch { return ""; }
  };
  const imageExtensions = new Set([".avif", ".bmp", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
  const videoExtensions = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm"]);
  const safeName = (value, maximum = 72) => String(value).normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, maximum) || "unknown";
  const extensionFor = (type, contentType, url) => {
    const byMime = {
      "image/avif": ".avif", "image/gif": ".gif", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
      "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-matroska": ".mkv",
    }[String(contentType).split(";")[0].toLowerCase()];
    if (byMime) return byMime;
    const suffix = extension(url);
    if ((type === "image" && imageExtensions.has(suffix)) || (type === "video" && videoExtensions.has(suffix))) return suffix;
    return type === "image" ? ".jpg" : ".mp4";
  };
  const relativePathFor = (item) => {
    const directory = item.type === "image" ? "images" : "videos";
    const base = `${item.date}__${safeName(item.endpoint)}__${safeName(item.requestId, 48)}__${String(item.outputIndex).padStart(2, "0")}`;
    return `${directory}/${base}${extensionFor(item.type, item.contentType, item.url)}`;
  };
  const mediaTypeFor = ({ contentType = "", keyPath = "", type = "", url = "" }) => {
    const normalized = String(contentType).toLowerCase();
    if (normalized.startsWith("image/")) return "image";
    if (normalized.startsWith("video/")) return "video";
    if (type === "image" || type === "video") return type;
    const suffix = extension(url);
    if (imageExtensions.has(suffix)) return "image";
    if (videoExtensions.has(suffix)) return "video";
    const hint = keyPath.toLowerCase();
    if (/(^|\.|\[)(image|images|thumbnail|frame|poster)(\.|\[|$)/.test(hint)) return "image";
    if (/(^|\.|\[)(video|videos|clip|animation)(\.|\[|$)/.test(hint)) return "video";
    return "";
  };
  const collectOutputMedia = (value, keyPath = "output", results = []) => {
    if (!value) return results;
    if (Array.isArray(value)) {
      value.forEach((item, index) => collectOutputMedia(item, `${keyPath}[${index}]`, results));
      return results;
    }
    if (typeof value !== "object") return results;
    if (typeof value.url === "string" && /^https?:\/\//i.test(value.url)) {
      const type = mediaTypeFor({
        contentType: value.content_type ?? value.contentType,
        keyPath,
        type: value.type,
        url: value.url,
      });
      if (type) results.push({
        url: value.url,
        type,
        contentType: value.content_type ?? value.contentType ?? "",
      });
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "url") continue;
      collectOutputMedia(child, `${keyPath}.${key}`, results);
    }
    return results;
  };
  const safeMediaUrl = (value) => {
    const raw = String(value ?? "");
    if (/^(images|videos)\/[a-z0-9._-]+$/i.test(raw)) return raw;
    try {
      const parsed = new URL(raw);
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
    } catch { return ""; }
  };

  async function falGet(pathname, params, { optional = false } = {}) {
    const url = new URL(`${config.apiRoot}${pathname}`);
    for (const [name, raw] of Object.entries(params)) {
      if (raw === undefined || raw === null || raw === "") continue;
      for (const value of Array.isArray(raw) ? raw : [raw]) url.searchParams.append(name, String(value));
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(url, { headers: { authorization: `Key ${config.key}` } });
      const body = await response.text();
      let payload;
      try { payload = body ? JSON.parse(body) : {}; } catch { payload = { message: body }; }
      if (response.ok) return payload;
      const message = payload.error?.message ?? payload.message ?? `${response.status} ${response.statusText}`;
      if (response.status === 429 && attempt < 4) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await wait(Number.isFinite(retryAfter) ? retryAfter * 1000 : (attempt + 1) * 1000);
        continue;
      }
      if (optional) return { unavailable: true, status: response.status, message };
      throw new Error(`${pathname}: ${message} (${response.status})`);
    }
    throw new Error(`${pathname}: retry limit reached`);
  }

  async function paginate(pathname, params, itemKey, options = {}) {
    const items = [];
    const seen = new Set();
    let cursor = "";
    for (let page = 0; page < 1000; page += 1) {
      const payload = await falGet(pathname, { ...params, ...(cursor ? { cursor } : {}) }, options);
      if (payload.unavailable) return { items, metadata: payload };
      items.push(...(payload[itemKey] ?? []));
      const next = String(payload.next_cursor ?? "");
      if (!payload.has_more && !next) return { items, metadata: payload };
      if (!next || seen.has(next)) throw new Error(`${pathname}: invalid pagination cursor`);
      seen.add(next);
      cursor = next;
    }
    throw new Error(`${pathname}: exceeded 1000 pages`);
  }

  const groupSum = (items, key, value) => {
    const groups = new Map();
    for (const item of items) {
      const name = key(item);
      groups.set(name, (groups.get(name) ?? 0) + Number(value(item) ?? 0));
    }
    return [...groups].map(([name, sum]) => ({ name, value: sum })).sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
  };

  async function loadLiveData() {
    const endInclusive = localDate(new Date());
    const effectiveEnd = endInclusive < config.start ? config.snapshotEnd : endInclusive;
    const endExclusive = addDays(effectiveEnd, 1);
    const startIso = `${config.start}T00:00:00${config.offset}`;
    const endIso = `${endExclusive}T00:00:00${config.offset}`;
    const startTime = Date.parse(startIso);
    const endTime = Date.parse(endIso);

    const [discoveryResult, billingResult] = await Promise.all([
      paginate("/models/requests/search", { limit: 100 }, "results"),
      paginate("/models/billing-events", { start: startIso, end: endIso, limit: 10000, expand: "auth_method_structured" }, "billing_events"),
    ]);
    const discoveredRequests = discoveryResult.items.filter((request) => {
      const sent = Date.parse(request.sent_at);
      return sent >= startTime && sent < endTime;
    });
    const billing = billingResult.items.filter((event) => {
      const timestamp = Date.parse(event.timestamp);
      return timestamp >= startTime && timestamp < endTime;
    });
    const endpoints = [...new Set([...discoveredRequests, ...billing].map((item) => item.endpoint_id).filter(Boolean))].sort();
    const chunks = [];
    for (let index = 0; index < endpoints.length; index += 50) chunks.push(endpoints.slice(index, index + 50));
    const requestResults = await Promise.all(chunks.map((endpointIds) => paginate("/models/requests/by-endpoint", {
      start: `${addDays(config.start, -1)}T00:00:00${config.offset}`,
      end: `${addDays(endExclusive, 1)}T00:00:00${config.offset}`,
      endpoint_id: endpointIds,
      status: "success",
      expand: "payloads",
      limit: 100,
    }, "items")));
    const requests = requestResults.flatMap((result) => result.items);
    const uniqueRequests = [...new Map(requests.filter((request) => {
      const sent = Date.parse(request.sent_at);
      return sent >= startTime && sent < endTime;
    }).map((request) => [request.request_id, request])).values()];

    const costByRequest = new Map();
    for (const event of billing) {
      costByRequest.set(event.request_id, (costByRequest.get(event.request_id) ?? 0) + Number(event.cost_total ?? event.cost ?? 0));
    }
    const textRequests = uniqueRequests.filter((request) => endpointType(request.endpoint_id) === "text").map((request) => ({
      type: "text",
      requestId: request.request_id,
      endpoint: request.endpoint_id,
      endedAt: request.ended_at,
      date: localDate(new Date(request.ended_at)),
      prompt: promptFor(request.json_input),
      requestCost: costByRequest.get(request.request_id) ?? 0,
    }));
    const localMedia = new Map(config.localMedia.map((item) => [item.url, item]));
    const media = [];
    const seenUrls = new Set();
    for (const request of uniqueRequests) {
      let outputIndex = 0;
      for (const candidate of collectOutputMedia(request.json_output)) {
        if (seenUrls.has(candidate.url)) continue;
        seenUrls.add(candidate.url);
        outputIndex += 1;
        const retained = localMedia.get(candidate.url);
        const item = {
          ...candidate,
          requestId: request.request_id,
          endpoint: request.endpoint_id,
          endedAt: request.ended_at,
          date: localDate(new Date(request.ended_at)),
          prompt: promptFor(request.json_input),
          requestCost: costByRequest.get(request.request_id) ?? 0,
          outputIndex,
        };
        item.relativePath = retained?.relativePath ?? relativePathFor(item);
        item.expectedBytes = retained?.bytes ?? 0;
        item.source = retained?.relativePath ?? candidate.url;
        media.push(item);
      }
    }
    const items = [...media, ...textRequests].sort((left, right) =>
      right.endedAt.localeCompare(left.endedAt)
      || left.endpoint.localeCompare(right.endpoint)
      || String(left.url ?? "").localeCompare(String(right.url ?? "")));
    const dailyNames = [];
    for (let date = config.start; date <= effectiveEnd; date = addDays(date, 1)) dailyNames.push(date);
    const dailyCostMap = new Map(dailyNames.map((date) => [date, 0]));
    for (const event of billing) {
      const date = localDate(new Date(event.timestamp));
      if (dailyCostMap.has(date)) dailyCostMap.set(date, dailyCostMap.get(date) + Number(event.cost_total ?? event.cost ?? 0));
    }
    const endpointRows = endpoints.map((endpoint) => ({
      endpoint,
      type: endpointType(endpoint),
      events: billing.filter((event) => event.endpoint_id === endpoint).length,
      cost: billing.filter((event) => event.endpoint_id === endpoint).reduce((sum, event) => sum + Number(event.cost_total ?? event.cost ?? 0), 0),
    })).filter((row) => row.events).sort((left, right) => right.cost - left.cost || left.endpoint.localeCompare(right.endpoint));
    const contentByType = ["video", "image", "text"].map((name) => ({ name, value: items.filter((item) => item.type === name).length })).filter((row) => row.value);
    const costByType = groupSum(billing, (event) => endpointType(event.endpoint_id), (event) => event.cost_total ?? event.cost);
    const averageSpendPerFile = ["video", "image"].map((name) => {
      const files = media.filter((item) => item.type === name).length;
      const spend = costByType.find((row) => row.name === name)?.value ?? 0;
      return files ? { name, value: spend / files, files, spend } : null;
    }).filter(Boolean);

    return {
      start: config.start,
      endInclusive: effectiveEnd,
      totalCost: billing.reduce((sum, event) => sum + Number(event.cost_total ?? event.cost ?? 0), 0),
      imageCount: media.filter((item) => item.type === "image").length,
      videoCount: media.filter((item) => item.type === "video").length,
      textCount: textRequests.length,
      mediaCount: media.length,
      contentCount: items.length,
      dailyCost: [...dailyCostMap].map(([name, value]) => ({ name, value })),
      contentByType,
      costByType,
      averageSpendPerFile,
      endpointRows,
      media,
      items,
      billingEvents: billing.length,
      successfulRequests: uniqueRequests.length,
    };
  }

  const barsMarkup = (rows, formatter, className = "") => {
    const maximum = Math.max(...rows.map((row) => row.value), 0);
    if (!rows.length) return '<p class="muted">No data.</p>';
    return `<div class="bars ${className}">${rows.map((row) => `<div class="bar-row"><span class="bar-label" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span><span class="bar-track"><i style="width:${maximum ? Math.max(1.5, row.value / maximum * 100) : 0}%"></i></span><strong>${escapeHtml(formatter(row.value))}</strong></div>`).join("")}</div>`;
  };
  const cardMarkup = (item) => {
    const source = safeMediaUrl(item.source ?? item.url);
    const prompt = item.prompt || "Prompt not present in retained payload";
    const preview = item.type === "image"
      ? `<a class="preview" href="${escapeHtml(source)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(source)}" alt="${escapeHtml(item.prompt || `${item.endpoint} generated image`)}" loading="lazy"></a>`
      : item.type === "video"
        ? `<a class="preview" href="${escapeHtml(source)}" target="_blank" rel="noreferrer"><video src="${escapeHtml(source)}" controls preload="metadata" aria-label="${escapeHtml(item.prompt || `${item.endpoint} generated video`)}"></video></a>`
        : '<div class="preview text-preview" aria-label="Text generation output was not retained"><strong>Text request</strong><small>Output not retained in FAL history</small></div>';
    const searchText = `${item.endpoint} ${item.prompt ?? ""} ${item.date}`.toLowerCase();
    return `<article class="media-card" data-type="${escapeHtml(item.type)}" data-generated-at="${escapeHtml(item.endedAt)}" data-search="${escapeHtml(searchText)}">${preview}<div class="media-copy"><div class="media-meta"><span class="family-badge family-${escapeHtml(item.type)}">${escapeHtml(item.type)}</span><span class="media-date">${escapeHtml(item.date)}</span></div><div class="prompt-wrap"><div class="prompt-backdrop"><h3>${escapeHtml(item.endpoint)}</h3><p class="prompt-preview">${escapeHtml(prompt)}</p></div><button class="show-prompt" type="button" hidden>Show all</button><template class="prompt-full">${escapeHtml(prompt)}</template></div><div class="request-cost"><span class="request-cost-label">Request cost</span><strong class="request-cost-value">${currency(item.requestCost)}</strong></div></div></article>`;
  };

  function updateGallery() {
    const query = elements.search.value.trim().toLowerCase();
    const matches = state.cards.filter((card) =>
      (state.filter === "all" || card.dataset.type === state.filter)
      && (!query || card.dataset.search.includes(query)));
    const pageCount = Math.max(1, Math.ceil(matches.length / state.pageSize));
    state.page = Math.min(state.page, pageCount);
    const visible = new Set(matches.slice((state.page - 1) * state.pageSize, state.page * state.pageSize));
    for (const card of state.cards) card.hidden = !visible.has(card);
    elements.empty.hidden = matches.length !== 0;
    elements.pagination.hidden = matches.length === 0;
    elements.pageStatus.textContent = matches.length
      ? `Page ${state.page} of ${pageCount} · ${matches.length} items`
      : "No results";
    elements.previousPage.disabled = state.page <= 1;
    elements.nextPage.disabled = state.page >= pageCount;
  }
  function updatePromptButtons() {
    for (const card of state.cards) {
      const preview = card.querySelector(".prompt-preview");
      const button = card.querySelector(".show-prompt");
      if (preview && button) button.hidden = preview.scrollHeight <= preview.clientHeight + 1;
    }
  }
  function refreshGalleryElements() {
    state.cards = [...document.querySelectorAll(".media-card")];
    state.page = 1;
    updateGallery();
    requestAnimationFrame(updatePromptButtons);
  }

  const setUpdateStage = (title, detail) => {
    elements.updateTitle.textContent = title;
    elements.updateDetail.textContent = detail;
  };
  const showUpdateScreen = (title, detail) => {
    elements.updateScreen.hidden = false;
    elements.updateScreen.setAttribute("aria-busy", "true");
    elements.updateProgress.hidden = true;
    elements.updateProgressText.hidden = true;
    elements.chooseHistoryFolder.hidden = true;
    elements.dropHistoryFolder.hidden = true;
    elements.closeUpdate.hidden = true;
    setUpdateStage(title, detail);
  };
  const hideUpdateScreen = () => {
    elements.updateScreen.hidden = true;
    elements.updateScreen.setAttribute("aria-busy", "false");
  };
  const probeWithMediaElement = (entry) => new Promise((resolve) => {
    const element = document.createElement(entry.type === "video" ? "video" : "img");
    let settled = false;
    const finish = (exists) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      element.removeAttribute("src");
      element.load?.();
      resolve(exists);
    };
    const timeout = setTimeout(() => finish(false), 15_000);
    element.onload = () => finish(true);
    element.onloadedmetadata = () => finish(true);
    element.onerror = () => finish(false);
    if (entry.type === "video") element.preload = "metadata";
    element.src = entry.relativePath;
  });
  const probeLocalResource = async (entry) => {
    if (typeof window.__falHistoryResourceProbe === "function") return Boolean(await window.__falHistoryResourceProbe(entry));
    if (window.location?.protocol !== "file:") {
      try {
        const response = await fetch(entry.relativePath, { method: "HEAD", cache: "no-store" });
        if (!response.ok) return false;
        const length = Number(response.headers.get("content-length") ?? 0);
        return !entry.expectedBytes || !length || length === entry.expectedBytes;
      } catch { return false; }
    }
    return probeWithMediaElement(entry);
  };
  async function detectMissingResources(entries) {
    const missing = [];
    let next = 0;
    let checked = 0;
    const workers = Array.from({ length: Math.min(8, entries.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= entries.length) return;
        if (!(await probeLocalResource(entries[index]))) missing.push(entries[index]);
        checked += 1;
        elements.updateDetail.textContent = `Checking local media · ${integer(checked)} of ${integer(entries.length)}`;
      }
    });
    await Promise.all(workers);
    return missing.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }
  const openDirectoryDatabase = () => new Promise((resolve) => {
    if (!window.indexedDB) { resolve(null); return; }
    let request;
    try { request = window.indexedDB.open("fal-history-report", 1); } catch { resolve(null); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("handles")) request.result.createObjectStore("handles");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  const storedDirectory = async () => {
    const database = await openDirectoryDatabase();
    if (!database) return null;
    return new Promise((resolve) => {
      const request = database.transaction("handles").objectStore("handles").get("history");
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    });
  };
  const rememberDirectory = async (handle) => {
    const database = await openDirectoryDatabase();
    if (!database) return;
    await new Promise((resolve) => {
      const request = database.transaction("handles", "readwrite").objectStore("handles").put(handle, "history");
      request.onsuccess = request.onerror = () => resolve();
    });
  };
  const validateHistoryDirectory = async (handle) => {
    await handle.getFileHandle("report.html");
    await handle.getDirectoryHandle("images", { create: true });
    await handle.getDirectoryHandle("videos", { create: true });
    return handle;
  };
  async function chooseHistoryDirectory() {
    const saved = await storedDirectory();
    if (saved?.queryPermission && await saved.queryPermission({ mode: "readwrite" }) === "granted") return validateHistoryDirectory(saved);
    const canPick = typeof window.showDirectoryPicker === "function" && window.location?.origin !== "null";
    elements.chooseHistoryFolder.hidden = !canPick;
    elements.dropHistoryFolder.hidden = false;
    elements.closeUpdate.hidden = false;
    setUpdateStage("Folder permission required", canPick
      ? "Choose or drop the history folder containing report.html. The report will write only to its images and videos folders."
      : "Drop the history folder containing report.html here. The report will write only to its images and videos folders.");
    return new Promise((resolve, reject) => {
      const acceptHandle = async (handle) => {
        if (!handle || handle.kind !== "directory") throw new Error("A folder is required.");
        if (handle.requestPermission && await handle.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("Write permission was not granted.");
        await validateHistoryDirectory(handle);
        await rememberDirectory(handle);
        elements.chooseHistoryFolder.hidden = true;
        elements.dropHistoryFolder.hidden = true;
        elements.closeUpdate.hidden = true;
        resolve(handle);
      };
      elements.chooseHistoryFolder.onclick = async () => {
        elements.chooseHistoryFolder.disabled = true;
        try {
          let handle = saved;
          if (handle?.requestPermission && await handle.requestPermission({ mode: "readwrite" }) !== "granted") handle = null;
          if (!handle) handle = await window.showDirectoryPicker({ id: "fal-history-report", mode: "readwrite", ...(saved ? { startIn: saved } : {}) });
          await acceptHandle(handle);
        } catch (error) {
          setUpdateStage("Folder permission required", error?.name === "AbortError" ? "Folder selection was canceled. Choose the history folder to continue." : "Select the history folder that contains report.html.");
        } finally {
          elements.chooseHistoryFolder.disabled = false;
        }
      };
      elements.dropHistoryFolder.ondragover = (event) => { event.preventDefault(); elements.dropHistoryFolder.dataset.active = "true"; };
      elements.dropHistoryFolder.ondragleave = () => { elements.dropHistoryFolder.dataset.active = "false"; };
      elements.dropHistoryFolder.ondrop = async (event) => {
        event.preventDefault();
        elements.dropHistoryFolder.dataset.active = "false";
        try {
          const item = [...(event.dataTransfer?.items ?? [])].find((candidate) => candidate.kind === "file" && typeof candidate.getAsFileSystemHandle === "function");
          await acceptHandle(await item?.getAsFileSystemHandle());
        } catch {
          setUpdateStage("Folder permission required", "Drop the history folder that contains report.html.");
        }
      };
      elements.closeUpdate.onclick = () => reject(new Error("Update canceled."));
    });
  }
  const resourceExistsInDirectory = async (historyDirectory, entry) => {
    const [directoryName, fileName] = entry.relativePath.split("/");
    try {
      const directory = await historyDirectory.getDirectoryHandle(directoryName);
      const file = await (await directory.getFileHandle(fileName)).getFile();
      return file.size > 0 && (!entry.expectedBytes || file.size === entry.expectedBytes);
    } catch { return false; }
  };
  async function downloadMissingResources(historyDirectory, entries) {
    elements.updateProgress.hidden = false;
    elements.updateProgressText.hidden = false;
    elements.updateProgress.max = entries.length;
    elements.updateProgress.value = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const [directoryName, fileName] = entry.relativePath.split("/");
      setUpdateStage("Downloading missing media", entry.relativePath);
      elements.updateProgressText.textContent = `${integer(index)} / ${integer(entries.length)} files`;
      const response = await fetch(entry.url);
      if (!response.ok) throw new Error(`Could not download ${entry.relativePath}: ${response.status} ${response.statusText}`);
      const blob = await response.blob();
      if (entry.expectedBytes && blob.size !== entry.expectedBytes) throw new Error(`Downloaded size does not match ${entry.relativePath}`);
      const directory = await historyDirectory.getDirectoryHandle(directoryName, { create: true });
      const fileHandle = await directory.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      try {
        await writable.write(blob);
        await writable.close();
      } catch (error) {
        await writable.abort?.();
        throw error;
      }
      elements.updateProgress.value = index + 1;
      elements.updateProgressText.textContent = `${integer(index + 1)} / ${integer(entries.length)} files`;
    }
  }
  const resourceEntriesFor = (data) => {
    const entries = [...config.localMedia.map((item) => ({ ...item, expectedBytes: item.bytes ?? 0 })), ...(data?.media ?? [])];
    return [...new Map(entries.map((item) => [item.url, item])).values()].filter((item) => item.url && item.relativePath && ["image", "video"].includes(item.type));
  };
  async function repairResources(data) {
    const entries = resourceEntriesFor(data);
    setUpdateStage("Checking local resources", `Checking ${integer(entries.length)} generated files…`);
    const missing = await detectMissingResources(entries);
    if (!missing.length) return { checked: entries.length, downloaded: 0 };
    elements.updateProgress.hidden = false;
    elements.updateProgressText.hidden = false;
    elements.updateProgress.max = missing.length;
    elements.updateProgress.value = 0;
    elements.updateProgressText.textContent = `0 / ${integer(missing.length)} files`;
    const historyDirectory = await chooseHistoryDirectory();
    const stillMissing = [];
    for (const entry of missing) if (!(await resourceExistsInDirectory(historyDirectory, entry))) stillMissing.push(entry);
    await downloadMissingResources(historyDirectory, stillMissing);
    if (data) {
      for (const item of data.media) item.source = item.relativePath;
      renderLive(data);
    }
    return { checked: entries.length, downloaded: stillMissing.length };
  }

  function renderLive(data) {
    elements.periodSpend.textContent = currency(data.totalCost);
    elements.generatedContentCount.textContent = integer(data.mediaCount);
    elements.totalSize.textContent = bytes(config.snapshotBytes);
    elements.contentMix.textContent = `${integer(data.imageCount)} images · ${integer(data.videoCount)} videos · ${integer(data.textCount)} text requests`;
    elements.dailySpend.innerHTML = barsMarkup(data.dailyCost, currency);
    elements.generatedContent.innerHTML = barsMarkup(data.contentByType, integer, "content-bars");
    elements.familySpend.innerHTML = barsMarkup(data.costByType, currency);
    elements.averageFileSpend.innerHTML = barsMarkup(data.averageSpendPerFile, currency, "average-bars");
    elements.models.innerHTML = data.endpointRows.map((row) => `<tr><td>${escapeHtml(row.endpoint)}</td><td><span class="family-badge family-${escapeHtml(row.type)}">${escapeHtml(row.type)}</span></td><td class="center">${integer(row.events)}</td><td class="num">${currency(row.cost)}</td></tr>`).join("");
    elements.gallery.innerHTML = data.items.map(cardMarkup).join("");
    const counts = { all: data.contentCount, image: data.imageCount, video: data.videoCount, text: data.textCount };
    for (const button of filterButtons) {
      const label = button.dataset.filter === "all" ? "All" : `${button.dataset.filter[0].toUpperCase()}${button.dataset.filter.slice(1)}${button.dataset.filter === "text" ? "" : "s"}`;
      button.textContent = `${label} (${counts[button.dataset.filter] ?? 0})`;
    }
    document.title = `AI Generation Report · ${data.start} to ${data.endInclusive}`;
    refreshGalleryElements();
  }

  const setStatus = (stateName, message) => {
    elements.status.dataset.state = stateName;
    elements.status.textContent = message;
  };
  async function refreshLive() {
    elements.refresh.disabled = true;
    setStatus("loading", "Refreshing FAL history…");
    try {
      const data = await loadLiveData();
      renderLive(data);
      const updatedAt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: config.timezone }).format(new Date());
      setStatus("live", `Live · ${data.start} through ${data.endInclusive} · updated ${updatedAt}`);
      return data;
    } catch (error) {
      setStatus("error", `Snapshot shown · live refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      elements.refresh.disabled = false;
    }
  }
  async function updateReport() {
    if (state.updating) return null;
    state.updating = true;
    elements.refresh.disabled = true;
    showUpdateScreen("Updating report", "Fetching the latest FAL history…");
    try {
      const data = await refreshLive();
      const repaired = await repairResources(data);
      const message = repaired.downloaded
        ? `Update complete · restored ${integer(repaired.downloaded)} files`
        : `Update complete · ${integer(repaired.checked)} local files verified`;
      if (data) setStatus("live", message);
      hideUpdateScreen();
      return data;
    } catch (error) {
      setStatus("error", `Update failed: ${error instanceof Error ? error.message : String(error)}`);
      setUpdateStage("Update stopped", error instanceof Error ? error.message : String(error));
      elements.updateProgress.hidden = true;
      elements.updateProgressText.hidden = true;
      elements.chooseHistoryFolder.hidden = true;
      elements.dropHistoryFolder.hidden = true;
      elements.closeUpdate.hidden = false;
      elements.closeUpdate.textContent = "Close";
      elements.closeUpdate.onclick = hideUpdateScreen;
      return null;
    } finally {
      state.updating = false;
      elements.refresh.disabled = false;
    }
  }

  for (const button of filterButtons) button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    state.page = 1;
    for (const peer of filterButtons) peer.setAttribute("aria-pressed", String(peer === button));
    updateGallery();
  });
  elements.search.addEventListener("input", () => { state.page = 1; updateGallery(); });
  elements.previousPage.addEventListener("click", () => { if (state.page > 1) { state.page -= 1; updateGallery(); } });
  elements.nextPage.addEventListener("click", () => { state.page += 1; updateGallery(); });
  elements.gallery.addEventListener("click", (event) => {
    const button = event.target.closest?.(".show-prompt");
    if (!button) return;
    const card = button.closest(".media-card");
    elements.promptModalContent.textContent = card.querySelector(".prompt-full").content.textContent;
    elements.promptModal.showModal();
  });
  elements.closePromptModal.addEventListener("click", () => elements.promptModal.close());
  elements.promptModal.addEventListener("click", (event) => { if (event.target === elements.promptModal) elements.promptModal.close(); });
  elements.refresh.addEventListener("click", updateReport);
  window.addEventListener("resize", updatePromptButtons);
  if (document.fonts?.ready) document.fonts.ready.then(updatePromptButtons);
  refreshGalleryElements();

  window.__falHistoryLive = { loadLiveData, refresh: refreshLive, update: updateReport, detectMissingResources, downloadMissingResources, repairResources };
  window.__falHistoryReady = Promise.resolve(null);
})();
