import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { runInNewContext, Script } from "node:vm";

const root = path.resolve(process.argv[2] ?? "history");
const dataRoot = path.join(root, "data");
const readJson = async (name) => JSON.parse(await readFile(path.join(dataRoot, name), "utf8"));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const close = (left, right) => Math.abs(left - right) < 1e-9;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const bytes = (value) => {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
};
const endpointType = (endpoint) => {
  const value = endpoint.toLowerCase();
  if (value.includes("video")) return "video";
  if (/speech|voice|audio|music/.test(value)) return "audio";
  if (/image|flux|banana/.test(value)) return "image";
  if (/chat|openrouter|llm|text/.test(value)) return "text";
  return "other";
};
const localDate = (value) => {
  const parts = new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Shanghai" }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
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
        const text = message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text.trim()).filter(Boolean).join("\n\n");
        if (text) return text;
      }
    }
  }
  return "";
};
const luminance = (hex) => {
  const channels = hex.slice(1).match(/../g).map((value) => Number.parseInt(value, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const contrast = (background, foreground) => {
  const values = [luminance(background), luminance(foreground)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
};

const [summary, manifest, billingPayload, requestsPayload, discoveryPayload, report, liveClientSource] = await Promise.all([
  readJson("summary.json"), readJson("media-manifest.json"), readJson("billing-events.json"),
  readJson("requests.json"), readJson("request-discovery.json"), readFile(path.join(root, "report.html"), "utf8"),
  readFile(new URL("./fal-history-live-client.js", import.meta.url), "utf8"),
]);
const configMatch = report.match(/<script>window\.__FAL_HISTORY_CONFIG__=(\{[\s\S]*?\});<\/script><script>/);
assert(configMatch, "Embedded live-refresh configuration is missing");
const liveConfig = JSON.parse(configMatch[1]);
const staticReport = report.slice(0, configMatch.index);
const inlineScripts = [...report.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
const textRequests = requestsPayload.items.filter((request) => endpointType(request.endpoint_id) === "text").map((request) => ({
  type: "text", requestId: request.request_id, endpoint: request.endpoint_id, endedAt: request.ended_at,
  date: localDate(new Date(request.ended_at)), prompt: promptFor(request.json_input),
}));
const galleryItems = [...manifest.media, ...textRequests].sort((left, right) =>
  right.endedAt.localeCompare(left.endedAt) || left.endpoint.localeCompare(right.endpoint) || String(left.url ?? "").localeCompare(String(right.url ?? "")));

assert(summary.dateRange.start === "2026-07-26", "Unexpected start date");
assert(summary.dateRange.endInclusive === "2026-08-02", "Unexpected inclusive end date");
assert(summary.dateRange.endExclusive === "2026-08-03", "Unexpected exclusive end date");
assert(summary.dateRange.timezone === "Asia/Shanghai", "Unexpected timezone");
assert(manifest.media.length === summary.mediaCount, "Manifest/media count mismatch");
assert(manifest.media.every((item) => item.status !== "failed"), "Manifest contains failed downloads");
assert(summary.failedDownloads === 0, "Summary reports failed downloads");
assert(summary.imageCount + summary.videoCount === summary.downloaded, "Content type totals do not reconcile");
assert(summary.downloaded === summary.mediaCount, "Not every discovered media file was downloaded");
assert(summary.textCount === textRequests.length, "Retained text request count mismatch");
assert(summary.contentCount === summary.downloaded + summary.textCount, "Generated content total does not reconcile");
assert(summary.averageSpendPerFile.length === 2, "Average spend per file does not cover image and video");
for (const row of summary.averageSpendPerFile) {
  const files = summary.mediaByType.find((item) => item.name === row.name)?.value ?? 0;
  const spend = summary.costByType.find((item) => item.name === row.name)?.value ?? 0;
  assert(files > 0 && close(row.value, spend / files), `Average spend per ${row.name} file is wrong`);
}
assert(requestsPayload.items.length === summary.requestCount, "Request count mismatch");
assert(discoveryPayload.results.length === summary.discoveredRequestCount, "Discovery count mismatch");
const start = Date.parse(summary.dateRange.startIso), end = Date.parse(summary.dateRange.endIso);
assert(billingPayload.billing_events.every((event) => Date.parse(event.timestamp) >= start && Date.parse(event.timestamp) < end), "Billing event outside requested window");
assert(requestsPayload.items.every((request) => Date.parse(request.sent_at) >= start && Date.parse(request.sent_at) < end), "Request outside requested window");
assert(close(billingPayload.billing_events.reduce((sum, event) => sum + Number(event.cost_total ?? 0), 0), summary.totalCost), "Billing cost does not reconcile");

let verifiedBytes = 0;
for (const item of manifest.media) {
  const expectedPrefix = item.type === "image" ? "images/" : "videos/";
  assert(item.relativePath.startsWith(expectedPrefix), `Wrong destination for ${item.relativePath}`);
  const filePath = path.join(root, ...item.relativePath.split("/"));
  const info = await stat(filePath);
  assert(info.isFile() && info.size === item.bytes && info.size > 0, `Missing, empty, or wrong-size media: ${item.relativePath}`);
  assert(createHash("sha256").update(await readFile(filePath)).digest("hex") === item.sha256, `SHA-256 mismatch: ${item.relativePath}`);
  verifiedBytes += info.size;
}
assert(verifiedBytes === summary.downloadBytes, "Downloaded byte total mismatch");
const [imageNames, videoNames] = await Promise.all([readdir(path.join(root, "images")), readdir(path.join(root, "videos"))]);
assert(![...imageNames, ...videoNames].some((name) => name.endsWith(".part")), "Partial download file remains");
assert(imageNames.length === summary.imageCount && videoNames.length === summary.videoCount, "Media directory counts mismatch");

assert((staticReport.match(/<article class="media-card"/g) ?? []).length === summary.contentCount, "Static gallery count mismatch");
assert((staticReport.match(/<div class="request-cost">/g) ?? []).length === summary.contentCount, "Request cost does not cover every card");
assert((staticReport.match(/<div class="prompt-backdrop">/g) ?? []).length === summary.contentCount, "Prompt backdrop does not cover every card");
assert((staticReport.match(/<div class="preview text-preview"/g) ?? []).length === summary.textCount, "Text preview count mismatch");
assert((staticReport.match(/<div class="metric(?: metric-split)?">/g) ?? []).length === 3, "Summary does not contain exactly three metrics");
assert(staticReport.includes('<header class="report-header"><h1>AI Generation Report</h1>'), "Simplified report title is missing");
assert(staticReport.includes('id="live-status"') && staticReport.includes('id="refresh-live"'), "Live refresh status or control is missing");
assert(staticReport.includes('id="refresh-live" type="button">Update</button>'), "Manual Update button is missing");
assert(staticReport.includes('class="update-screen" id="update-screen"') && staticReport.includes('aria-busy="true" hidden') && staticReport.includes('id="update-progress"') && staticReport.includes('id="choose-history-folder"') && staticReport.includes('id="drop-history-folder"'), "Update overlay is not hidden initially or repair controls are incomplete");
assert(staticReport.includes(".update-progress[hidden],.update-progress-text[hidden],.update-actions button[hidden],.folder-drop[hidden]{display:none}"), "Repair progress or folder controls are visible before missing files are detected");
assert(staticReport.includes(`id="period-spend">$${summary.totalCost.toFixed(2)}`), "Snapshot spend is wrong");
assert(staticReport.includes(`<span>Generated content</span><strong id="generated-content-count">${summary.downloaded}</strong>`), "Snapshot generated-content count is wrong");
assert(staticReport.includes(`<span>Total size</span><strong id="total-size">${bytes(summary.downloadBytes)}</strong>`), "Snapshot total size is wrong");
assert(staticReport.includes(`id="content-mix-value">${summary.imageCount} images · ${summary.videoCount} videos · ${summary.textCount} text requests`), "Snapshot content mix is wrong");
assert(staticReport.includes(`data-filter="text" aria-pressed="false">Text (${summary.textCount})</button>`), "Text filter is missing or wrong");
assert(staticReport.includes('id="daily-spend"') && staticReport.includes('id="generated-content"') && staticReport.includes('id="family-spend"') && staticReport.includes('id="average-file-spend"') && staticReport.includes('id="models-body"'), "Live chart/table targets are incomplete");
assert(staticReport.includes("their response bodies were not present in FAL request history"), "Text-history limitation is not explained");
assert(staticReport.includes("Open this HTML file directly; no local server or Node process is required") && staticReport.includes("The saved snapshot is shown immediately without contacting FAL") && staticReport.includes("Press Update to fetch live history"), "Manual-only refresh behavior is not explained");
assert(staticReport.includes("Admin-scoped FAL key is embedded in this standalone HTML report"), "Embedded-key warning is missing");
assert(!report.includes("history:serve") && !report.includes("127.0.0.1") && !report.includes("localhost"), "Report depends on a local server");
assert(!report.includes("<script src=") && !report.includes("<link rel=\"stylesheet\""), "Report has an external code or stylesheet dependency");
assert(!staticReport.includes("FAL generation audit") && !staticReport.includes("What we generated, and what it cost."), "Legacy report heading remains");
assert(!staticReport.includes("<span>Media spend</span>") && !staticReport.includes("<h2>Readout</h2>") && !staticReport.includes("<h2>Coverage</h2>"), "Removed report sections remain");
assert(staticReport.includes(".gallery{grid-template-columns:repeat(4,minmax(0,1fr))}"), "Desktop gallery is not four columns");
assert(staticReport.includes("-webkit-line-clamp:3") && staticReport.includes("text-align:right;white-space:nowrap"), "Prompt clamp or request-cost layout is missing");
assert(staticReport.includes(".media-copy{display:flex;flex-direction:column;min-width:0}"), "Card content can force its grid column wider");
assert(staticReport.includes(".prompt-wrap,.prompt-backdrop{min-width:0;max-width:100%}"), "Prompt containers are not constrained to the card width");
assert(staticReport.includes(".prompt-backdrop h3{max-width:100%;overflow-wrap:anywhere;word-break:break-word}"), "Long endpoint names cannot wrap safely");
assert(staticReport.includes(".prompt-preview{overflow-wrap:anywhere;word-break:break-word}"), "Long prompt text cannot wrap safely");
assert(staticReport.includes(".metric-split{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));padding:0}"), "Middle summary card is not split into two columns");
assert(staticReport.includes(".metric-half+.metric-half{border-left:1px solid var(--line)}"), "Split summary card divider is missing");
assert(staticReport.includes(".panel{min-width:0}"), "Narrow chart panels can force horizontal overflow");
assert(staticReport.includes(".notes{display:none}"), "Method and caveats section is visible");
assert(!staticReport.includes("<span>Downloaded</span>") && !staticReport.includes("files downloaded ·"), "Legacy downloaded metric remains");
for (const label of ["Daily spend", "Generated content", "Spend by content family", "Average spend per file", "Models", "Generated media", "Method and caveats"]) assert(staticReport.includes(label), `Report is missing section: ${label}`);
for (const type of ["video", "image", "audio", "text", "other"]) assert(staticReport.includes(`.family-${type}{background:var(--badge-${type}-bg);color:var(--badge-${type}-fg)}`), `Bright ${type} badge styling is missing`);
for (const [type, background, foreground] of [["video", "#00d7b5", "#00352d"], ["image", "#ffb000", "#382300"], ["audio", "#c4a7ff", "#251044"], ["text", "#5bc8ff", "#062a3c"], ["other", "#f472b6", "#3a0a22"]]) assert(contrast(background, foreground) >= 4.5, `${type} badge contrast is below WCAG AA`);
for (const item of galleryItems) assert(staticReport.includes(`<template class="prompt-full">${escapeHtml(item.prompt || "Prompt not present in retained payload")}</template>`), `Full prompt is missing for ${item.requestId}`);
const generatedTimes = [...staticReport.matchAll(/data-generated-at="([^"]+)"/g)].map((match) => match[1]);
assert(generatedTimes.length === summary.contentCount && generatedTimes.every((value, index) => index === 0 || generatedTimes[index - 1].localeCompare(value) >= 0), "Generated content is incomplete or not newest first");

assert(inlineScripts.length === 2 && inlineScripts[1] === liveClientSource, "Generated report does not contain the current live client");
new Script(liveClientSource);
assert(liveConfig.apiRoot === "https://api.fal.ai/v1", "Live API root is wrong");
assert(liveConfig.start === summary.dateRange.start && liveConfig.snapshotEnd === summary.dateRange.endInclusive, "Live date configuration is wrong");
assert(liveConfig.timezone === summary.dateRange.timezone && liveConfig.offset === "+08:00", "Live timezone configuration is wrong");
assert(liveConfig.snapshotDownloaded === summary.downloaded && liveConfig.snapshotBytes === summary.downloadBytes, "Live snapshot metrics are wrong");
assert(liveConfig.localMedia.length === summary.downloaded, "Live local-media lookup is incomplete");
assert(liveConfig.localMedia.every((item) => manifest.media.some((media) => media.url === item.url && media.relativePath === item.relativePath)), "Live local-media lookup does not match the manifest");
assert(liveConfig.localMedia.every((item) => ["image", "video"].includes(item.type) && item.bytes > 0), "Embedded repair manifest lacks file metadata");
assert(liveClientSource.includes("window.__falHistoryReady = Promise.resolve(null)") && !liveClientSource.includes("initialLoad"), "Startup still performs a live-history refresh");
assert(liveClientSource.includes('elements.refresh.addEventListener("click", updateReport)') && !liveClientSource.includes('elements.refresh.addEventListener("click", refreshLive)'), "Resource repair is not limited to the manual Update action");
for (const operation of ["showDirectoryPicker", "getAsFileSystemHandle", "getDirectoryHandle", "getFileHandle", "createWritable", "downloadMissingResources", "detectMissingResources"]) assert(liveClientSource.includes(operation), `Embedded resource repair is missing ${operation}`);
assert(liveClientSource.includes('paginate("/models/requests/search"') && liveClientSource.includes('paginate("/models/billing-events"') && liveClientSource.includes('paginate("/models/requests/by-endpoint"'), "Live client does not query all required FAL history endpoints");

const interactive = () => ({ dataset: {}, disabled: false, hidden: false, innerHTML: "", textContent: "", value: "", max: 1, onclick: null, listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; }, setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; } });
const cards = galleryItems.map((item) => ({ ...interactive(), dataset: { type: item.type, search: `${item.endpoint} ${item.prompt} ${item.date}`.toLowerCase() }, querySelector(selector) { if (selector === ".prompt-preview") return { clientHeight: 69, scrollHeight: 50 }; if (selector === ".show-prompt") return interactive(); if (selector === ".prompt-full") return { content: { textContent: item.prompt } }; return null; } }));
const filterButtons = ["all", "image", "video", "text"].map((filter) => ({ ...interactive(), dataset: { filter } }));
const ids = ["live-status", "refresh-live", "period-spend", "generated-content-count", "total-size", "content-mix-value", "daily-spend", "generated-content", "family-spend", "average-file-spend", "models-body", "gallery", "search", "empty", "pagination", "previous-page", "next-page", "page-status", "prompt-modal", "prompt-modal-content", "close-prompt-modal", "update-screen", "update-title", "update-detail", "update-progress", "update-progress-text", "choose-history-folder", "drop-history-folder", "close-update"];
const elements = Object.fromEntries(ids.map((id) => [id, interactive()]));
elements["update-screen"].hidden = true;
elements["live-status"].dataset.state = "snapshot";
elements["live-status"].textContent = "Offline snapshot · press Update to refresh";
elements["prompt-modal"].showModal = () => { elements["prompt-modal"].open = true; };
elements["prompt-modal"].close = () => { elements["prompt-modal"].open = false; };
const requestsAt = "2026-08-02T04:00:00.000Z";
const mockPayload = (url) => {
  if (url.pathname.endsWith("/models/requests/search")) return { results: [{ request_id: "live-image", endpoint_id: "fal-ai/test-image", sent_at: requestsAt }, { request_id: "live-text", endpoint_id: "openrouter/router/openai/v1/chat/completions", sent_at: requestsAt }], has_more: false };
  if (url.pathname.endsWith("/models/billing-events")) return { billing_events: [{ request_id: "live-image", endpoint_id: "fal-ai/test-image", timestamp: requestsAt, cost_total: 2.5 }, { request_id: "live-text", endpoint_id: "openrouter/router/openai/v1/chat/completions", timestamp: requestsAt, cost_total: 1.25 }], has_more: false };
  if (url.pathname.endsWith("/models/requests/by-endpoint")) return { items: [{ request_id: "live-image", endpoint_id: "fal-ai/test-image", sent_at: requestsAt, ended_at: requestsAt, json_input: { prompt: "Live image" }, json_output: { image: { url: "https://cdn.example/live.png", content_type: "image/png" } } }, { request_id: "live-text", endpoint_id: "openrouter/router/openai/v1/chat/completions", sent_at: requestsAt, ended_at: requestsAt, json_input: { prompt: "Live text" }, json_output: {} }], has_more: false };
  throw new Error(`Unexpected mock URL: ${url}`);
};
const authorizations = [];
let resourceProbeCalls = 0;
const browserWindow = { __FAL_HISTORY_CONFIG__: liveConfig, __falHistoryResourceProbe: async () => { resourceProbeCalls += 1; return true; }, addEventListener() {} };
const context = {
  window: browserWindow,
  document: { title: "", fonts: undefined, getElementById(id) { return elements[id]; }, querySelectorAll(selector) { return selector === "[data-filter]" ? filterButtons : cards; } },
  requestAnimationFrame(callback) { callback(); }, setTimeout, clearTimeout, URL, Blob,
  fetch: async (rawUrl, options = {}) => {
    const url = new URL(rawUrl, "https://local.example/");
    if (url.hostname === "cdn.example" && ["/missing.png", "/missing.mp4"].includes(url.pathname)) return { ok: true, status: 200, statusText: "OK", headers: { get() { return null; } }, blob: async () => new Blob(["media"]) };
    authorizations.push(options.headers.authorization);
    const payload = mockPayload(url);
    return { ok: true, status: 200, statusText: "OK", headers: { get() { return null; } }, text: async () => JSON.stringify(payload) };
  },
};
runInNewContext(liveClientSource, context);
const liveResult = await browserWindow.__falHistoryReady;
assert(liveResult === null && elements["live-status"].dataset.state === "snapshot", "Startup did not preserve the offline snapshot state");
assert(elements["update-screen"].hidden === true, "Startup displayed the update overlay");
assert(resourceProbeCalls === 0, "Startup triggered the resource-repair check without a manual Update");
assert(authorizations.length === 0, "Startup contacted FAL before a manual Update");

const initialAuthorizationCount = authorizations.length;
const manualResult = await browserWindow.__falHistoryLive.update();
assert(manualResult?.totalCost === 3.75 && authorizations.length > initialAuthorizationCount, "Manual Update did not refresh live FAL history");
assert(authorizations.every((value) => value === `Key ${liveConfig.key}`), "Manual live requests do not use the embedded FAL key");
assert(elements["period-spend"].textContent === "$3.75", "Manual Update did not render live spend");
assert(elements["generated-content-count"].textContent === "1", "Manual Update did not render generated-content count");
assert(elements["total-size"].textContent === bytes(summary.downloadBytes), "Snapshot total size changed during manual refresh");
assert(elements["content-mix-value"].textContent === "1 images · 0 videos · 1 text requests", "Manual Update did not render live content mix");
assert(elements["average-file-spend"].innerHTML.includes("$2.50"), "Manual Update did not render average spend per file");
assert(elements.gallery.innerHTML.includes("https://cdn.example/live.png") && elements.gallery.innerHTML.includes("Live text"), "Manual Update did not render live gallery");
assert(elements["models-body"].innerHTML.includes("fal-ai/test-image"), "Manual Update did not render live model table");
assert(resourceProbeCalls > 0, "Manual Update did not trigger resource checking");
assert(elements["update-screen"].hidden === true && elements["live-status"].textContent.includes("local files verified"), "Manual Update did not finish its resource check");

browserWindow.__falHistoryResourceProbe = async (entry) => !entry.url.endsWith("missing.png");
const missingEntry = { url: "https://cdn.example/missing.png", relativePath: "images/missing.png", type: "image", expectedBytes: 5 };
const detectedMissing = await browserWindow.__falHistoryLive.detectMissingResources([missingEntry, { ...missingEntry, url: "https://cdn.example/present.png", relativePath: "images/present.png" }]);
assert(detectedMissing.length === 1 && detectedMissing[0].relativePath === "images/missing.png", "Missing resource detection is wrong");
const writtenFiles = [];
const directoryFor = (directoryName) => ({ async getFileHandle(name, options) {
  assert(options.create === true, "Repair did not create the missing file");
  return { async createWritable() { return { async write(blob) { writtenFiles.push({ path: `${directoryName}/${name}`, bytes: blob.size }); }, async close() {}, async abort() {} }; } };
} });
const historyDirectory = { async getDirectoryHandle(name, options) { assert(["images", "videos"].includes(name) && options.create === true, "Repair wrote outside images/ or videos/"); return directoryFor(name); } };
const missingVideo = { url: "https://cdn.example/missing.mp4", relativePath: "videos/missing.mp4", type: "video", expectedBytes: 5 };
await browserWindow.__falHistoryLive.downloadMissingResources(historyDirectory, [missingEntry, missingVideo]);
assert(writtenFiles.some((item) => item.path === "images/missing.png" && item.bytes === 5), "Missing image was not written to images/");
assert(writtenFiles.some((item) => item.path === "videos/missing.mp4" && item.bytes === 5), "Missing video was not written to videos/");
assert(elements["update-progress"].value === 2 && elements["update-progress-text"].textContent === "2 / 2 files", "Repair progress did not reach current file 2 of total 2");

const secret = process.env.FAL_KEY;
if (secret) {
  assert(liveConfig.key === secret, "Embedded FAL key does not match the configured key");
  for (const name of ["summary.json", "media-manifest.json", "billing-events.json", "requests.json", "request-discovery.json", "assets.json", "billing-events.csv", "media-manifest.csv"]) assert(!(await readFile(path.join(dataRoot, name), "utf8")).includes(secret), `API key leaked into data/${name}`);
}

console.log(JSON.stringify({
  verified: true, liveRefresh: { automatic: false, manual: true, embeddedKey: Boolean(liveConfig.key), mockRuntime: true }, dateRange: summary.dateRange,
  billingEvents: billingPayload.billing_events.length, requestsDiscovered: summary.discoveredRequestCount, successfulRequests: summary.requestCount,
  media: { images: summary.imageCount, videos: summary.videoCount, total: summary.mediaCount, bytes: summary.downloadBytes },
  content: { images: summary.imageCount, videos: summary.videoCount, textRequests: summary.textCount, total: summary.contentCount },
  costsUsd: { all: summary.totalCost, imageVideo: summary.mediaCost }, report: path.join(root, "report.html"),
}, null, 2));
