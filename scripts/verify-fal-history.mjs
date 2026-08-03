import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { runInNewContext } from "node:vm";

// Compatibility entry point; the live-aware verifier supersedes the snapshot-only checks below.
await import("./verify-fal-history-live.mjs");
process.exit(0);

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

const [summary, manifest, billingPayload, requestsPayload, discoveryPayload, report] = await Promise.all([
  readJson("summary.json"),
  readJson("media-manifest.json"),
  readJson("billing-events.json"),
  readJson("requests.json"),
  readJson("request-discovery.json"),
  readFile(path.join(root, "report.html"), "utf8"),
]);
const staticReport = report.slice(0, report.indexOf("<script>window.__FAL_HISTORY_CONFIG__="));
const textRequests = requestsPayload.items
  .filter((request) => endpointType(request.endpoint_id) === "text")
  .map((request) => ({
    type: "text",
    requestId: request.request_id,
    endpoint: request.endpoint_id,
    endedAt: request.ended_at,
    date: localDate(new Date(request.ended_at)),
    prompt: promptFor(request.json_input),
  }));
const galleryItems = [...manifest.media, ...textRequests]
  .sort((a, b) => b.endedAt.localeCompare(a.endedAt) || a.endpoint.localeCompare(b.endpoint) || String(a.url ?? "").localeCompare(String(b.url ?? "")));

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
assert(billingPayload.billing_events.length > 0, "No billing events were captured");
assert(requestsPayload.items.length === summary.requestCount, "Request count mismatch");
assert(discoveryPayload.results.length === summary.discoveredRequestCount, "Discovery count mismatch");

const start = Date.parse(summary.dateRange.startIso);
const end = Date.parse(summary.dateRange.endIso);
assert(billingPayload.billing_events.every((event) => Date.parse(event.timestamp) >= start && Date.parse(event.timestamp) < end), "Billing event outside requested window");
assert(requestsPayload.items.every((request) => Date.parse(request.sent_at) >= start && Date.parse(request.sent_at) < end), "Request outside requested window");
const billingTotal = billingPayload.billing_events.reduce((sum, event) => sum + Number(event.cost_total ?? 0), 0);
assert(close(billingTotal, summary.totalCost), "Billing cost does not reconcile to summary");

let verifiedBytes = 0;
for (const item of manifest.media) {
  const expectedPrefix = item.type === "image" ? "images/" : "videos/";
  assert(item.relativePath.startsWith(expectedPrefix), `Wrong destination for ${item.relativePath}`);
  const filePath = path.join(root, ...item.relativePath.split("/"));
  const info = await stat(filePath);
  assert(info.isFile() && info.size > 0, `Missing or empty media: ${item.relativePath}`);
  assert(info.size === item.bytes, `Size mismatch: ${item.relativePath}`);
  const contents = await readFile(filePath);
  const digest = createHash("sha256").update(contents).digest("hex");
  assert(digest === item.sha256, `SHA-256 mismatch: ${item.relativePath}`);
  const contentType = String(item.contentType).toLowerCase();
  assert(contentType.startsWith(`${item.type}/`) || contentType === "application/octet-stream", `Unexpected content type: ${item.relativePath}`);
  verifiedBytes += info.size;
}
assert(verifiedBytes === summary.downloadBytes, "Downloaded byte total mismatch");

const [imageNames, videoNames] = await Promise.all([
  readdir(path.join(root, "images")),
  readdir(path.join(root, "videos")),
]);
assert(![...imageNames, ...videoNames].some((name) => name.endsWith(".part")), "Partial download file remains");
assert(imageNames.length === summary.imageCount, "Image directory count mismatch");
assert(videoNames.length === summary.videoCount, "Video directory count mismatch");
assert((staticReport.match(/<article class="media-card"/g) ?? []).length === summary.contentCount, "Report gallery count mismatch");
assert((staticReport.match(/<div class="request-cost">/g) ?? []).length === summary.contentCount, "Request-cost footer does not cover every gallery card");
assert((staticReport.match(/<div class="prompt-backdrop">/g) ?? []).length === summary.contentCount, "Prompt backdrops do not cover every gallery card");
assert((staticReport.match(/<div class="preview text-preview"/g) ?? []).length === summary.textCount, "Text request previews do not cover every retained text request");
assert(!report.includes(">File</dt>"), "Legacy file-size metric remains on a media card");
assert(!report.includes(">Open original</a>"), "Legacy Open original link remains on a media card");
assert(report.includes(".request-cost{display:flex;align-items:baseline;justify-content:flex-end;"), "Request cost is not right aligned");
assert(report.includes("text-align:right;white-space:nowrap"), "Request cost is not kept on one right-aligned line");
assert(report.includes(".prompt-backdrop{margin-bottom:8px;padding:12px;background:"), "Endpoint and prompt backdrop styling is missing");
assert(report.includes('<header class="report-header"><h1>AI Generation Report</h1>'), "Report title was not simplified");
assert(!report.includes("FAL generation audit") && !report.includes("What we generated, and what it cost."), "Legacy report heading remains");
assert(!report.includes("A complete offline view of retained image and video outputs"), "Legacy report introduction remains");
assert(!report.includes("<span>Media spend</span>"), "Media spend metric was not removed");
assert(!report.includes("<section class=\"findings\"") && !report.includes("<h2>Readout</h2>") && !report.includes("<h2>Coverage</h2>"), "Crossed-out findings remain");
assert((staticReport.match(/<div class="metric">/g) ?? []).length === 3, "Summary does not contain exactly three metrics");
assert(report.includes(`<span>Downloaded</span><strong id="downloaded-count">${summary.downloaded}</strong><small id="downloaded-detail">files downloaded · ${bytes(summary.downloadBytes)} on disk</small>`), "Downloaded metric is not a single explained number");
assert(report.includes(`<span>Content mix</span><strong class="content-mix-value" id="content-mix-value">${summary.imageCount} images · ${summary.videoCount} videos · ${summary.textCount} text requests</strong>`), "Content mix does not label image, video, and text counts inline");
assert(report.includes(`data-filter="text" aria-pressed="false">Text (${summary.textCount})</button>`), "Text gallery filter is missing or has the wrong count");
assert(report.includes("their response bodies were not present in FAL request history"), "Text-history limitation is not explained");
for (const label of ["Daily spend", "Generated content", "Spend by content family", "Models", "Generated media", "Method and caveats"]) {
  assert(report.includes(label), `Report is missing section: ${label}`);
}
assert(report.includes("<h2>Models</h2>"), "Model table heading was not renamed");
assert(!report.includes("<h2>Endpoints</h2>"), "Legacy Endpoints heading remains");
assert(report.includes("<th>Model</th><th>Family</th><th class=\"center\">Requests</th><th class=\"num\">Spend</th>"), "Model table columns do not match the requested layout");
assert(!report.includes(">Billing events</th>"), "Legacy Billing events column remains");
assert(!report.includes(">Outputs</th>"), "Outputs column was not removed");
assert((staticReport.match(/<span class="family-badge /g) ?? []).length === summary.endpointRows.length + summary.contentCount, "Shared type badges do not cover every model and gallery row");
for (const type of ["video", "image", "audio", "text", "other"]) {
  assert(report.includes(`.family-${type}{background:var(--badge-${type}-bg);color:var(--badge-${type}-fg)}`), `Bright ${type} badge styling is missing`);
}
for (const [type, background, foreground] of [
  ["video", "#00d7b5", "#00352d"],
  ["image", "#ffb000", "#382300"],
  ["audio", "#c4a7ff", "#251044"],
  ["text", "#5bc8ff", "#062a3c"],
  ["other", "#f472b6", "#3a0a22"],
]) {
  assert(contrast(background, foreground) >= 4.5, `${type} badge contrast is below WCAG AA`);
}
assert((staticReport.match(/<p class="prompt-preview">/g) ?? []).length === summary.contentCount, "Three-line prompt previews do not cover every gallery card");
assert((staticReport.match(/<button class="show-prompt"/g) ?? []).length === summary.contentCount, "Show-all badges do not cover every gallery card");
assert((staticReport.match(/<template class="prompt-full">/g) ?? []).length === summary.contentCount, "Full prompt payloads do not cover every gallery card");
for (const item of galleryItems) {
  const prompt = escapeHtml(item.prompt || "Prompt not present in retained payload");
  assert(report.includes(`<template class="prompt-full">${prompt}</template>`), `Full prompt is missing for ${item.requestId}`);
}
assert(report.includes("-webkit-line-clamp:3"), "Prompt preview is not limited to three lines");
assert(report.includes("overflow:auto") && report.includes("prompt-modal-content"), "Full-prompt modal is not scrollable");
assert(report.includes("scrollHeight<=preview.clientHeight+1"), "Show-all badge is not conditioned on visual overflow");
assert(report.includes("promptModal.showModal()"), "Full-prompt modal is not opened by the badge");
const generatedTimes = [...staticReport.matchAll(/data-generated-at="([^"]+)"/g)].map((match) => match[1]);
assert(generatedTimes.length === summary.contentCount, "Generation timestamps do not cover every gallery card");
assert(generatedTimes.every((value, index) => index === 0 || generatedTimes[index - 1].localeCompare(value) >= 0), "Generated media is not sorted newest first");
assert(report.includes(".gallery{grid-template-columns:repeat(4,minmax(0,1fr))}"), "Desktop gallery is not a four-column grid");
assert(report.includes("pageSize=16"), "Gallery page size is not 16 items");
assert(report.includes('id="previous-page"') && report.includes('id="next-page"') && report.includes('id="page-status"'), "Gallery pagination controls are incomplete");
assert(report.includes("matches.slice((page-1)*pageSize,page*pageSize)"), "Gallery pagination does not slice filtered results");
assert(report.includes("page=1;update()"), "Gallery filtering does not reset pagination");

const inlineScripts = [...report.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
const inlineScript = inlineScripts[0];
assert(inlineScripts.length === 2, "Report pagination and prompt-modal scripts are incomplete");
const interactive = () => ({
  disabled: false,
  hidden: false,
  listeners: {},
  addEventListener(type, listener) { this.listeners[type] = listener; },
  setAttribute(name, value) { this[name] = value; },
});
const cards = galleryItems.map((item) => ({
  ...interactive(),
  dataset: { type: item.type, search: `${item.endpoint} ${item.prompt} ${item.date}`.toLowerCase() },
}));
const filterButtons = ["all", "image", "video", "text"].map((filter) => ({ ...interactive(), dataset: { filter } }));
const elements = {
  search: { ...interactive(), value: "" },
  empty: interactive(),
  pagination: interactive(),
  "previous-page": interactive(),
  "next-page": interactive(),
  "page-status": { ...interactive(), textContent: "" },
};
runInNewContext(inlineScript, {
  Set,
  document: {
    querySelectorAll(selector) { return selector === ".media-card" ? cards : filterButtons; },
    getElementById(id) { return elements[id]; },
  },
});
assert(cards.filter((card) => !card.hidden).length === 16, "Initial gallery page does not show exactly 16 cards");
assert(elements["page-status"].textContent === `Page 1 of ${Math.ceil(summary.contentCount / 16)} · ${summary.contentCount} items`, "Initial page status is incorrect");
assert(elements["previous-page"].disabled && !elements["next-page"].disabled, "Initial pagination button states are incorrect");
elements["next-page"].listeners.click();
assert(cards.filter((card) => !card.hidden).length === 16, "Second gallery page does not show exactly 16 cards");
assert(elements["page-status"].textContent === `Page 2 of ${Math.ceil(summary.contentCount / 16)} · ${summary.contentCount} items`, "Next-page navigation did not advance");
filterButtons.find((button) => button.dataset.filter === "image").listeners.click();
const visibleImages = cards.filter((card) => !card.hidden);
assert(visibleImages.length === 16 && visibleImages.every((card) => card.dataset.type === "image"), "Image filter does not produce a 16-card image page");
assert(elements["page-status"].textContent === "Page 1 of 3 · 39 items", "Image filter did not reset pagination to page 1");
filterButtons.find((button) => button.dataset.filter === "text").listeners.click();
const visibleText = cards.filter((card) => !card.hidden);
assert(visibleText.length === summary.textCount && visibleText.every((card) => card.dataset.type === "text"), "Text filter does not show every retained text request");
assert(elements["page-status"].textContent === `Page 1 of 1 · ${summary.textCount} items`, "Text filter page status is incorrect");
assert(elements.empty.hidden && !elements.pagination.hidden, "Text filter visibility state is incorrect");

const promptCards = galleryItems.map((item, index) => {
  const preview = { clientHeight: 69, scrollHeight: index === 0 ? 120 : 50 };
  const button = interactive();
  const template = { content: { textContent: item.prompt || "Prompt not present in retained payload" } };
  return {
    button,
    preview,
    template,
    querySelector(selector) {
      if (selector === ".prompt-preview") return preview;
      if (selector === ".show-prompt") return button;
      if (selector === ".prompt-full") return template;
      return null;
    },
  };
});
const modal = {
  ...interactive(),
  open: false,
  showModal() { this.open = true; },
  close() { this.open = false; },
};
const modalContent = { textContent: "" };
const closeModal = interactive();
const browserWindow = interactive();
runInNewContext(inlineScripts[1], {
  document: {
    fonts: undefined,
    querySelectorAll() { return promptCards; },
    getElementById(id) {
      return { "prompt-modal": modal, "prompt-modal-content": modalContent, "close-prompt-modal": closeModal }[id];
    },
  },
  requestAnimationFrame(callback) { callback(); },
  window: browserWindow,
});
assert(!promptCards[0].button.hidden, "Show-all badge remains hidden for an overflowing prompt");
assert(promptCards[1].button.hidden, "Show-all badge is visible for a prompt that fits within three lines");
promptCards[0].button.listeners.click();
assert(modal.open, "Show-all badge did not open the prompt modal");
assert(modalContent.textContent === promptCards[0].template.content.textContent, "Prompt modal did not receive the complete prompt");
closeModal.listeners.click();
assert(!modal.open, "Prompt modal close control did not close the dialog");

const secret = process.env.FAL_KEY;
if (secret) {
  const textFiles = [
    path.join(root, "report.html"),
    ...["summary.json", "media-manifest.json", "billing-events.json", "requests.json", "request-discovery.json", "assets.json", "billing-events.csv", "media-manifest.csv"].map((name) => path.join(dataRoot, name)),
  ];
  for (const filePath of textFiles) assert(!(await readFile(filePath, "utf8")).includes(secret), `API key leaked into ${filePath}`);
}

console.log(JSON.stringify({
  verified: true,
  dateRange: summary.dateRange,
  billingEvents: billingPayload.billing_events.length,
  requestsDiscovered: summary.discoveredRequestCount,
  successfulRequests: summary.requestCount,
  media: { images: summary.imageCount, videos: summary.videoCount, total: summary.mediaCount, bytes: summary.downloadBytes },
  content: { images: summary.imageCount, videos: summary.videoCount, textRequests: summary.textCount, total: summary.contentCount },
  costsUsd: { all: summary.totalCost, imageVideo: summary.mediaCost },
  report: path.join(root, "report.html"),
}, null, 2));
