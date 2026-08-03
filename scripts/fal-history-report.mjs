import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const API_ROOT = "https://api.fal.ai/v1";
const LIVE_CLIENT_SOURCE = await readFile(new URL("./fal-history-live-client.js", import.meta.url), "utf8");
const DEFAULT_START = "2026-07-26";
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_OFFSET = "+08:00";
const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm"]);

function parseArgs(argv) {
  const args = { start: DEFAULT_START, end: localDate(new Date(), DEFAULT_TIMEZONE), timezone: DEFAULT_TIMEZONE, output: "history" };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--start") args.start = argv[++index];
    else if (name === "--end") args.end = argv[++index];
    else if (name === "--timezone") args.timezone = argv[++index];
    else if (name === "--output") args.output = argv[++index];
    else if (name === "--help") args.help = true;
    else throw new Error(`Unknown argument: ${name}`);
  }
  return args;
}

function localDate(value, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit", month: "2-digit", year: "numeric", timeZone: timezone,
  }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function assertDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeFileRetry(filePath, contents) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await writeFile(filePath, contents);
      return;
    } catch (error) {
      if (!["EBUSY", "EPERM"].includes(error?.code) || attempt === 5) throw error;
      await sleep((attempt + 1) * 250);
    }
  }
}

async function falGet(pathname, params, { optional = false } = {}) {
  const url = new URL(`${API_ROOT}${pathname}`);
  for (const [name, raw] of Object.entries(params)) {
    if (raw === undefined || raw === null || raw === "") continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) url.searchParams.append(name, String(value));
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, { headers: { authorization: `Key ${process.env.FAL_KEY}` } });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text }; }
    if (response.ok) return payload;
    const message = payload.error?.message ?? payload.message ?? `${response.status} ${response.statusText}`;
    if (response.status === 429 && attempt < 4) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) ? retryAfter * 1_000 : (attempt + 1) * 1_000);
      continue;
    }
    if (optional) return { unavailable: true, status: response.status, message };
    throw new Error(`${pathname}: ${message} (${response.status})`);
  }
  throw new Error(`${pathname}: retry limit reached`);
}

async function paginate(pathname, params, itemKey, { optional = false, maxPages = 1_000 } = {}) {
  const items = [];
  const seen = new Set();
  let cursor = "";
  let metadata = {};
  for (let page = 0; page < maxPages; page += 1) {
    const payload = await falGet(pathname, { ...params, ...(cursor ? { cursor } : {}) }, { optional });
    if (payload.unavailable) return { items, metadata: payload };
    items.push(...(payload[itemKey] ?? []));
    metadata = {
      hasMore: Boolean(payload.has_more),
      scopeTruncated: Boolean(payload.scope_truncated),
      totalCount: payload.total_count ?? null,
    };
    const next = String(payload.next_cursor ?? "");
    if (!payload.has_more && !next) return { items, metadata };
    if (!next || seen.has(next)) throw new Error(`${pathname}: invalid pagination cursor`);
    seen.add(next);
    cursor = next;
  }
  throw new Error(`${pathname}: exceeded ${maxPages} pages`);
}

function endpointType(endpoint) {
  const value = endpoint.toLowerCase();
  if (value.includes("video")) return "video";
  if (/speech|voice|audio|music/.test(value)) return "audio";
  if (/image|flux|banana/.test(value)) return "image";
  if (/chat|openrouter|llm|text/.test(value)) return "text";
  return "other";
}

function urlExtension(url) {
  try { return path.extname(decodeURIComponent(new URL(url).pathname)).toLowerCase(); } catch { return ""; }
}

function mediaTypeFor({ contentType = "", keyPath = "", type = "", url = "" }) {
  const normalized = String(contentType).toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (type === "image" || type === "video") return type;
  const extension = urlExtension(url);
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  const hint = keyPath.toLowerCase();
  if (/(^|\.|\[)(image|images|thumbnail|frame|poster)(\.|\[|$)/.test(hint)) return "image";
  if (/(^|\.|\[)(video|videos|clip|animation)(\.|\[|$)/.test(hint)) return "video";
  return "";
}

function collectOutputMedia(value, keyPath = "output", results = []) {
  if (!value || typeof value !== "object") return results;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectOutputMedia(item, `${keyPath}[${index}]`, results));
    return results;
  }
  if (typeof value.url === "string" && /^https?:\/\//i.test(value.url)) {
    const type = mediaTypeFor({
      contentType: value.content_type ?? value.contentType ?? value.mime_type ?? value.mimeType,
      keyPath,
      type: value.type,
      url: value.url,
    });
    if (type) results.push({
      url: value.url,
      type,
      sourcePath: keyPath,
      contentType: value.content_type ?? value.contentType ?? value.mime_type ?? value.mimeType ?? "",
      width: Number(value.width ?? 0) || null,
      height: Number(value.height ?? 0) || null,
    });
  }
  for (const [name, child] of Object.entries(value)) {
    if (name !== "url") collectOutputMedia(child, `${keyPath}.${name}`, results);
  }
  return results;
}

function promptFor(input) {
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
          .map((part) => part.text.trim())
          .filter(Boolean)
          .join("\n\n");
        if (text) return text;
      }
    }
  }
  return "";
}

function safeName(value, maximum = 72) {
  return String(value).normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, maximum) || "unknown";
}

function extensionFor(type, contentType, url) {
  const byMime = {
    "image/avif": ".avif", "image/gif": ".gif", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
    "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-matroska": ".mkv",
  }[String(contentType).split(";")[0].toLowerCase()];
  if (byMime) return byMime;
  const extension = urlExtension(url);
  if ((type === "image" && IMAGE_EXTENSIONS.has(extension)) || (type === "video" && VIDEO_EXTENSIONS.has(extension))) return extension;
  return type === "image" ? ".jpg" : ".mp4";
}

async function existingSize(filePath) {
  try { return (await stat(filePath)).size; } catch { return 0; }
}

async function downloadOne(media, root) {
  const directory = media.type === "image" ? "images" : "videos";
  const base = `${media.date}__${safeName(media.endpoint)}__${safeName(media.requestId, 48)}__${String(media.outputIndex).padStart(2, "0")}`;
  const knownExtension = extensionFor(media.type, media.contentType, media.url);
  const knownRelativePath = `${directory}/${base}${knownExtension}`;
  const knownFilePath = path.join(root, ...knownRelativePath.split("/"));
  const knownSize = await existingSize(knownFilePath);
  if (knownSize > 0) {
    const bytes = await readFile(knownFilePath);
    return { ...media, relativePath: knownRelativePath, bytes: knownSize, status: "reused", sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      response = await fetch(media.url);
      if (response.ok) break;
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await sleep((attempt + 1) * 1_000);
        continue;
      }
      throw new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep((attempt + 1) * 1_000);
    }
  }
  const contentType = response.headers.get("content-type") ?? media.contentType ?? "";
  const extension = extensionFor(media.type, contentType, media.url);
  const relativePath = `${directory}/${base}${extension}`;
  const filePath = path.join(root, ...relativePath.split("/"));
  const currentSize = await existingSize(filePath);
  if (currentSize > 0) {
    try { await response.body?.cancel(); } catch {}
    const bytes = await readFile(filePath);
    return { ...media, contentType, relativePath, bytes: currentSize, status: "reused", sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const temporary = `${filePath}.part`;
  await writeFile(temporary, bytes);
  await rename(temporary, filePath);
  return {
    ...media,
    contentType,
    relativePath,
    bytes: bytes.length,
    status: "downloaded",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function mapConcurrent(items, concurrency, task) {
  const output = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { output[index] = await task(items[index], index); }
      catch (error) { output[index] = { ...items[index], status: "failed", error: error instanceof Error ? error.message : String(error), bytes: 0, relativePath: "", sha256: "" }; }
      process.stdout.write(`\rDownloaded ${output.filter(Boolean).length}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (items.length) process.stdout.write("\n");
  return output;
}

function groupSum(items, key, value) {
  const groups = new Map();
  for (const item of items) groups.set(key(item), (groups.get(key(item)) ?? 0) + Number(value(item) ?? 0));
  return [...groups].map(([name, amount]) => ({ name, value: amount })).sort((a, b) => b.value - a.value);
}

function currency(value) { return `$${Number(value).toFixed(2)}`; }
function integer(value) { return new Intl.NumberFormat("en-US").format(value); }
function bytes(value) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function jsonForScript(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}
function csvCell(value) {
  const text = typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function toCsv(rows, columns) { return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\n")}\n`; }

function bars(rows, formatter, className = "") {
  const maximum = Math.max(...rows.map((row) => row.value), 0);
  if (!rows.length) return '<p class="muted">No data.</p>';
  return `<div class="bars ${className}">${rows.map((row) => `<div class="bar-row"><span class="bar-label" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span><span class="bar-track"><i style="width:${maximum ? Math.max(1.5, row.value / maximum * 100) : 0}%"></i></span><strong>${escapeHtml(formatter(row.value))}</strong></div>`).join("")}</div>`;
}

function buildReport({ args, generatedAt, falKey, media, summary, textRequests }) {
  const completeMedia = media
    .filter((item) => item.status !== "failed")
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt) || a.endpoint.localeCompare(b.endpoint) || a.url.localeCompare(b.url));
  const complete = [...completeMedia, ...textRequests]
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt) || a.endpoint.localeCompare(b.endpoint) || String(a.url ?? "").localeCompare(String(b.url ?? "")));
  const gallery = complete.map((item) => {
    const source = escapeHtml(item.relativePath ?? "");
    const preview = item.type === "image"
      ? `<a class="preview" href="${source}"><img src="${source}" alt="${escapeHtml(item.prompt || `${item.endpoint} generated image`)}" loading="lazy"></a>`
      : item.type === "video"
        ? `<a class="preview" href="${source}"><video src="${source}" controls preload="metadata" aria-label="${escapeHtml(item.prompt || `${item.endpoint} generated video`)}"></video></a>`
        : `<div class="preview text-preview" aria-label="Text generation output was not retained"><strong>Text request</strong><small>Output not retained in FAL history</small></div>`;
    const prompt = item.prompt || "Prompt not present in retained payload";
    return `<article class="media-card" data-type="${item.type}" data-generated-at="${escapeHtml(item.endedAt)}" data-search="${escapeHtml(`${item.endpoint} ${item.prompt} ${item.date}`.toLowerCase())}">${preview}<div class="media-copy"><div class="media-meta"><span class="family-badge family-${escapeHtml(item.type)}">${escapeHtml(item.type)}</span><span class="media-date">${escapeHtml(item.date)}</span></div><div class="prompt-wrap"><div class="prompt-backdrop"><h3>${escapeHtml(item.endpoint)}</h3><p class="prompt-preview">${escapeHtml(prompt)}</p></div><button class="show-prompt" type="button" hidden>Show all</button><template class="prompt-full">${escapeHtml(prompt)}</template></div><div class="request-cost"><span class="request-cost-label">Request cost</span><strong class="request-cost-value">${currency(item.requestCost)}</strong></div></div></article>`;
  }).join("");
  const liveConfig = jsonForScript({
    apiRoot: API_ROOT,
    key: falKey,
    start: args.start,
    snapshotEnd: args.end,
    timezone: args.timezone,
    offset: DEFAULT_OFFSET,
    snapshotDownloaded: summary.downloaded,
    snapshotBytes: summary.downloadBytes,
    localMedia: completeMedia.map((item) => ({
      url: item.url,
      relativePath: item.relativePath,
      type: item.type,
      bytes: item.bytes,
      contentType: item.contentType,
    })),
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Generation Report · ${args.start} to ${args.end}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f1eb;--panel:#fffdf8;--text:#1c2730;--muted:#68737a;--line:#d8d2c6;--ink:#173f4f;--accent:#e36947;--video:#257f76;--image:#d77a2c;--shadow:0 12px 34px #1c273015}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:1280px;margin:auto;padding:42px 24px 80px}h1,h2,h3,p{margin-top:0}h1{font:500 clamp(36px,6vw,74px)/.98 Georgia,serif;max-width:850px;letter-spacing:-.035em}h2{font:500 28px/1.2 Georgia,serif;margin-bottom:18px}h3{font-size:15px;line-height:1.35;margin-bottom:8px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:34px 0}.metric,.panel{background:var(--panel);border:1px solid var(--line);box-shadow:var(--shadow)}.metric{padding:22px}.metric span{display:block;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}.metric strong{display:block;color:var(--ink);font:500 34px/1.1 Georgia,serif;margin:5px 0}.metric small{color:var(--muted}.panel{padding:26px}.chart-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:42px}.chart-wide{grid-column:1/-1}.bars{display:grid;gap:11px}.bar-row{display:grid;grid-template-columns:minmax(120px,1fr) 2.4fr 90px;align-items:center;gap:12px}.bar-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bar-track{height:13px;background:color-mix(in srgb,var(--line) 50%,transparent);overflow:hidden}.bar-track i{display:block;height:100%;background:var(--accent)}.content-bars .bar-row:nth-child(1) i{background:var(--video)}.content-bars .bar-row:nth-child(2) i{background:var(--image)}.content-bars .bar-row:nth-child(3) i{background:var(--badge-text-bg)}.bar-row strong{text-align:right;font-variant-numeric:tabular-nums}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}td.num{text-align:right;font-variant-numeric:tabular-nums}.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px}.controls button,.controls input{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--text);padding:9px 13px}.controls button[aria-pressed=true]{background:var(--ink);color:#fff}.controls input{min-width:240px;flex:1}.gallery{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.media-card{background:var(--panel);border:1px solid var(--line);min-width:0}.media-card[hidden]{display:none}.preview{display:grid;place-items:center;aspect-ratio:16/10;background:#101519;overflow:hidden}.preview img,.preview video{width:100%;height:100%;object-fit:contain}.media-copy{padding:16px}.media-copy p{color:var(--muted);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;min-height:69px}.media-copy dl{display:flex;gap:18px;margin:14px 0}.media-copy dl div{min-width:0}.media-copy dt{color:var(--muted);font-size:11px;text-transform:uppercase}.media-copy dd{margin:0}.notes{margin-top:42px}.notes p,.notes li{color:var(--muted)}a{color:var(--ink);text-underline-offset:3px}.muted{color:var(--muted)}@media(max-width:850px){.metrics{grid-template-columns:1fr 1fr}.chart-grid{grid-template-columns:1fr}.chart-wide{grid-column:auto}.gallery{grid-template-columns:1fr 1fr}}@media(max-width:560px){main{padding:26px 14px 50px}.metrics,.gallery{grid-template-columns:1fr}.bar-row{grid-template-columns:100px 1fr 72px}.panel{padding:18px}}@media(prefers-color-scheme:dark){:root{--bg:#11181c;--panel:#182228;--text:#edf1f0;--muted:#aab5b8;--line:#334148;--ink:#98d6d0;--accent:#ff8d6c;--shadow:none}.controls button[aria-pressed=true]{background:#98d6d0;color:#101719}}
.metric small{color:var(--muted)}
.family-badge{display:inline-block;padding:3px 9px;border:1px solid var(--line);border-radius:999px;background:color-mix(in srgb,var(--ink) 10%,transparent);font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}.family-video{background:color-mix(in srgb,var(--video) 20%,transparent)}.family-image{background:color-mix(in srgb,var(--image) 20%,transparent)}th.center,td.center{text-align:center}.gallery{grid-template-columns:repeat(4,minmax(0,1fr))}.pagination{display:flex;align-items:center;justify-content:center;gap:14px;margin:22px 0 0}.pagination button{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--text);padding:9px 14px}.pagination button:disabled{cursor:not-allowed;opacity:.45}.page-status{min-width:170px;text-align:center;color:var(--muted);font-variant-numeric:tabular-nums}@media(max-width:1100px){.gallery{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:850px){.gallery{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:560px){.gallery{grid-template-columns:1fr}.pagination{flex-wrap:wrap}.page-status{order:-1;width:100%}}
:root{--badge-video-bg:#00d7b5;--badge-video-fg:#00352d;--badge-image-bg:#ffb000;--badge-image-fg:#382300;--badge-audio-bg:#c4a7ff;--badge-audio-fg:#251044;--badge-text-bg:#5bc8ff;--badge-text-fg:#062a3c;--badge-other-bg:#f472b6;--badge-other-fg:#3a0a22}.family-badge{border:1px solid #ffffff80;box-shadow:0 0 0 1px #00000018;font-weight:800}.family-video{background:var(--badge-video-bg);color:var(--badge-video-fg)}.family-image{background:var(--badge-image-bg);color:var(--badge-image-fg)}.family-audio{background:var(--badge-audio-bg);color:var(--badge-audio-fg)}.family-text{background:var(--badge-text-bg);color:var(--badge-text-fg)}.family-other{background:var(--badge-other-bg);color:var(--badge-other-fg)}.media-meta{display:flex;align-items:center;gap:9px;margin-bottom:10px}.media-date{color:var(--muted);font-size:12px;font-weight:700;letter-spacing:.08em}.prompt-wrap{margin-bottom:14px}.prompt-backdrop{margin-bottom:8px;padding:12px;background:color-mix(in srgb,var(--ink) 9%,var(--panel));border:1px solid color-mix(in srgb,var(--ink) 22%,var(--line))}.prompt-backdrop h3{margin-bottom:8px}.prompt-preview{margin:0;color:var(--muted);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;min-height:69px;white-space:pre-wrap}.show-prompt{padding:3px 9px;border:0;border-radius:999px;background:var(--accent);color:#fff;font:700 11px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}.show-prompt:hover{filter:brightness(1.12)}.prompt-modal{width:min(760px,calc(100% - 32px));max-height:min(82vh,760px);padding:0;border:1px solid var(--line);background:var(--panel);color:var(--text);box-shadow:0 22px 80px #0008}.prompt-modal::backdrop{background:#071218cc;backdrop-filter:blur(3px)}.prompt-modal-shell{display:grid;grid-template-rows:auto minmax(0,1fr);max-height:min(82vh,760px)}.prompt-modal-header{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 22px;border-bottom:1px solid var(--line)}.prompt-modal-header h2{margin:0}.close-prompt-modal{padding:7px 12px;border:1px solid var(--line);background:transparent;color:var(--text);font:inherit;cursor:pointer}.prompt-modal-content{max-height:calc(min(82vh,760px) - 78px);overflow:auto;padding:22px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65}body:has(.prompt-modal[open]){overflow:hidden}
.media-card{display:grid;grid-template-rows:auto 1fr}.media-copy{display:flex;flex-direction:column;min-width:0}.prompt-wrap,.prompt-backdrop{min-width:0;max-width:100%}.prompt-backdrop h3{max-width:100%;overflow-wrap:anywhere;word-break:break-word}.prompt-preview{overflow-wrap:anywhere;word-break:break-word}.metric-split{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));padding:0}.metric-half{display:flex;min-width:0;padding:22px;flex-direction:column;justify-content:center}.metric-half+.metric-half{border-left:1px solid var(--line)}.metric-half strong{font-size:clamp(22px,2.8vw,34px)}.metric .content-mix-value{font-size:clamp(22px,2.4vw,30px)}.text-preview{align-content:center;gap:7px;padding:20px;background:var(--badge-text-bg);color:var(--badge-text-fg);text-align:center}.text-preview strong{font:500 24px/1.1 Georgia,serif}.text-preview small{color:inherit}.request-cost{display:flex;align-items:baseline;justify-content:flex-end;gap:8px;margin-top:auto;padding-top:14px;text-align:right;white-space:nowrap}.request-cost-label{color:var(--muted);font-size:11px;letter-spacing:.04em;text-transform:uppercase}.request-cost-value{font-weight:500;font-variant-numeric:tabular-nums}.report-header{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap}.report-header h1{margin-bottom:0}.live-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.live-status{color:var(--muted);font-size:13px}.live-status[data-state=live]{color:var(--video)}.live-status[data-state=error]{color:var(--accent)}.refresh-live{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--text);padding:9px 13px;cursor:pointer}.refresh-live:disabled{cursor:wait;opacity:.55}@media(max-width:560px){.report-header{align-items:flex-start;flex-direction:column}.live-controls{align-items:flex-start;flex-direction:column}.metric-half{padding:18px 14px}}
.panel{min-width:0}
.notes{display:none}
.update-screen{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:24px;background:var(--bg)}.update-screen[hidden]{display:none}.update-shell{width:min(560px,100%);padding:30px;background:var(--panel);border:1px solid var(--line);box-shadow:var(--shadow)}.update-kicker{display:block;margin-bottom:8px;color:var(--accent);font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}.update-shell h2{margin-bottom:10px}.update-detail{margin-bottom:20px;color:var(--muted)}.update-progress{display:block;width:100%;height:12px;margin-bottom:8px;accent-color:var(--accent)}.update-progress-text{display:block;margin-bottom:18px;text-align:right;font-variant-numeric:tabular-nums}.update-actions{display:flex;gap:10px;flex-wrap:wrap}.update-actions button{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--text);padding:9px 13px;cursor:pointer}.update-actions button:first-child{background:var(--ink);color:var(--bg)}
.average-bars .bar-row:nth-child(1) i{background:var(--video)}.average-bars .bar-row:nth-child(2) i{background:var(--image)}
.update-progress[hidden],.update-progress-text[hidden],.update-actions button[hidden],.folder-drop[hidden]{display:none}.folder-drop{margin:0 0 18px;padding:20px;border:1px dashed var(--line);background:color-mix(in srgb,var(--ink) 7%,var(--panel));text-align:center}.folder-drop[data-active=true]{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,var(--panel))}.folder-drop strong,.folder-drop span{display:block}.folder-drop span{margin-top:4px;color:var(--muted);font-size:13px}
</style></head><body><div class="update-screen" id="update-screen" role="dialog" aria-modal="true" aria-labelledby="update-title" aria-busy="true" hidden><div class="update-shell"><span class="update-kicker">FAL generation report</span><h2 id="update-title">Updating report</h2><p class="update-detail" id="update-detail">Fetching the latest FAL history…</p><progress class="update-progress" id="update-progress" max="1" value="0" aria-label="Media repair progress" hidden></progress><strong class="update-progress-text" id="update-progress-text" hidden>0 / 0 files</strong><div class="folder-drop" id="drop-history-folder" hidden><strong>Drop history folder here</strong><span>The folder containing report.html</span></div><div class="update-actions"><button id="choose-history-folder" type="button" hidden>Choose history folder</button><button id="close-update" type="button" hidden>Cancel update</button></div></div></div><main>
<header class="report-header"><h1>AI Generation Report</h1><div class="live-controls"><span class="live-status" id="live-status" data-state="snapshot" role="status" aria-live="polite">Offline snapshot · ${escapeHtml(args.start)} through ${escapeHtml(args.end)} · press Update to refresh</span><button class="refresh-live" id="refresh-live" type="button">Update</button></div></header>
<section class="metrics" aria-label="Key metrics"><div class="metric"><span>Period spend</span><strong id="period-spend">${currency(summary.totalCost)}</strong><small>All model API billing events</small></div><div class="metric metric-split"><div class="metric-half"><span>Generated content</span><strong id="generated-content-count">${integer(summary.downloaded)}</strong></div><div class="metric-half"><span>Total size</span><strong id="total-size">${bytes(summary.downloadBytes)}</strong></div></div><div class="metric"><span>Content mix</span><strong class="content-mix-value" id="content-mix-value">${integer(summary.imageCount)} images · ${integer(summary.videoCount)} videos · ${integer(summary.textCount)} text requests</strong><small>Downloaded media plus retained text requests</small></div></section>
<section class="chart-grid"><div class="panel chart-wide"><h2>Daily spend</h2><div id="daily-spend">${bars(summary.dailyCost, currency)}</div></div><div class="panel"><h2>Generated content</h2><div id="generated-content">${bars(summary.contentByType, integer, "content-bars")}</div></div><div class="panel"><h2>Spend by content family</h2><div id="family-spend">${bars(summary.costByType, currency)}</div></div><div class="panel chart-wide"><h2>Average spend per file</h2><p class="muted">Period spend in each media family divided by generated files.</p><div id="average-file-spend">${bars(summary.averageSpendPerFile, currency, "average-bars")}</div></div><div class="panel chart-wide"><h2>Models</h2><div class="table-wrap"><table><thead><tr><th>Model</th><th>Family</th><th class="center">Requests</th><th class="num">Spend</th></tr></thead><tbody id="models-body">${summary.endpointRows.map((row) => `<tr><td>${escapeHtml(row.endpoint)}</td><td><span class="family-badge family-${escapeHtml(row.type)}">${escapeHtml(row.type)}</span></td><td class="center">${integer(row.events)}</td><td class="num">${currency(row.cost)}</td></tr>`).join("")}</tbody></table></div></div></section>
<section><h2>Generated media</h2><div class="controls" aria-label="Gallery filters"><button type="button" data-filter="all" aria-pressed="true">All (${complete.length})</button><button type="button" data-filter="image" aria-pressed="false">Images (${summary.imageCount})</button><button type="button" data-filter="video" aria-pressed="false">Videos (${summary.videoCount})</button><button type="button" data-filter="text" aria-pressed="false">Text (${summary.textCount})</button><input id="search" type="search" placeholder="Search endpoint, prompt, or date" aria-label="Search generated media"></div><div class="gallery" id="gallery">${gallery}</div><p id="empty" class="muted" hidden>No generated media matches this filter.</p><nav class="pagination" id="pagination" aria-label="Generated media pages"><button type="button" id="previous-page">Previous</button><span class="page-status" id="page-status" aria-live="polite"></span><button type="button" id="next-page">Next</button></nav></section>
<section class="notes panel"><h2>Method and caveats</h2><ul><li>Costs come from <a href="https://fal.ai/docs/platform-apis/v1/models/billing-events">FAL Billing Events</a>; <code>cost_total</code> is summed after discounts.</li><li>A workspace-wide <code>/models/requests/search</code> browse establishes request membership and endpoint coverage. <a href="https://fal.ai/docs/platform-apis/v1/models/requests/by-endpoint">Request History</a> is then queried with <code>expand=payloads</code>. Only image/video URLs in retained JSON outputs are downloaded.</li><li>Open this HTML file directly; no local server or Node process is required. The saved snapshot is shown immediately without contacting FAL. Press Update to fetch live history from ${escapeHtml(args.start)} through today's ${escapeHtml(args.timezone)} date and repair missing local media.</li><li>Retained text requests appear in the gallery, but their response bodies were not present in FAL request history; those cards show the input prompt and request cost.</li><li>The API end timestamp is exclusive, so this snapshot used ${addDays(args.end, 1)} 00:00 at UTC+08:00. Because the report was generated during the final calendar day, that day is a partial snapshot through ${escapeHtml(generatedAt)}.</li><li>A media request's full cost is shown once in aggregate; gallery cards display the request cost, which can repeat when one request returns multiple files.</li><li>Raw API responses, normalized CSV files, the media manifest, and verification summary are in <code>data/</code>. The Admin-scoped FAL key is embedded in this standalone HTML report to enable manual live refresh; keep the file private.</li></ul></section>
</main><dialog class="prompt-modal" id="prompt-modal" aria-labelledby="prompt-modal-title"><div class="prompt-modal-shell"><header class="prompt-modal-header"><h2 id="prompt-modal-title">Full prompt</h2><button class="close-prompt-modal" id="close-prompt-modal" type="button">Close</button></header><div class="prompt-modal-content" id="prompt-modal-content"></div></div></dialog><script>window.__FAL_HISTORY_CONFIG__=${liveConfig};</script><script>${LIVE_CLIENT_SOURCE}</script></body></html>`.replace(".metric small{color:var(--muted}", ".metric small{color:var(--muted)}");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: pnpm history:report -- [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--timezone Asia/Shanghai] [--output history]");
    return;
  }
  if (!process.env.FAL_KEY) throw new Error("FAL_KEY is not configured");
  assertDate(args.start, "--start"); assertDate(args.end, "--end");
  if (args.end < args.start) throw new Error("--end must be on or after --start");
  if (args.timezone !== DEFAULT_TIMEZONE) throw new Error(`This report currently supports ${DEFAULT_TIMEZONE} so its UTC offset is unambiguous`);
  const root = path.resolve(args.output);
  const dataRoot = path.join(root, "data");
  await Promise.all([mkdir(path.join(root, "images"), { recursive: true }), mkdir(path.join(root, "videos"), { recursive: true }), mkdir(dataRoot, { recursive: true })]);
  const startIso = `${args.start}T00:00:00${DEFAULT_OFFSET}`;
  const endExclusiveDate = addDays(args.end, 1);
  const endIso = `${endExclusiveDate}T00:00:00${DEFAULT_OFFSET}`;
  const common = { start: startIso, end: endIso };

  console.log("Browsing workspace-wide request history for complete endpoint discovery…");
  const discoveryResult = await paginate("/models/requests/search", { limit: 100 }, "results");
  const discoveredRequests = discoveryResult.items.filter((request) => {
    const sent = Date.parse(request.sent_at);
    return sent >= Date.parse(startIso) && sent < Date.parse(endIso);
  });

  console.log(`Retrieving billing events ${args.start} through ${args.end} (${args.timezone})…`);
  const billingResult = await paginate("/models/billing-events", { ...common, limit: 10_000, expand: "auth_method_structured" }, "billing_events");
  const billing = billingResult.items.filter((event) => event.timestamp >= new Date(startIso).toISOString() && event.timestamp < new Date(endIso).toISOString());
  const endpoints = [...new Set([...discoveredRequests, ...billing].map((item) => item.endpoint_id).filter(Boolean))].sort();
  console.log(`Found ${discoveredRequests.length} requests and ${billing.length} billing events across ${endpoints.length} endpoints.`);

  const requests = [];
  for (let index = 0; index < endpoints.length; index += 50) {
    const chunk = endpoints.slice(index, index + 50);
    const result = await paginate("/models/requests/by-endpoint", {
      start: `${addDays(args.start, -1)}T00:00:00${DEFAULT_OFFSET}`,
      end: `${addDays(endExclusiveDate, 1)}T00:00:00${DEFAULT_OFFSET}`,
      endpoint_id: chunk, status: "success", expand: "payloads", limit: 100,
    }, "items");
    requests.push(...result.items);
  }
  const uniqueRequests = [...new Map(requests.filter((request) => {
    const sent = Date.parse(request.sent_at);
    return sent >= Date.parse(startIso) && sent < Date.parse(endIso);
  }).map((request) => [request.request_id, request])).values()];
  console.log(`Found ${uniqueRequests.length} successful requests with retained history.`);

  const assetResult = await paginate("/assets", { section: "generated", media_type: ["image", "video"], limit: 100 }, "assets", { optional: true });
  const startTime = Date.parse(startIso), endTime = Date.parse(endIso);
  const assets = assetResult.items.filter((asset) => { const created = Date.parse(asset.created_at); return created >= startTime && created < endTime; });
  const assetsStatus = assetResult.metadata.unavailable ? assetResult.metadata : { ...assetResult.metadata, count: assets.length };

  const costByRequest = new Map();
  const billingEndpointByRequest = new Map();
  for (const event of billing) {
    costByRequest.set(event.request_id, (costByRequest.get(event.request_id) ?? 0) + Number(event.cost_total ?? event.cost ?? 0));
    if (!billingEndpointByRequest.has(event.request_id)) billingEndpointByRequest.set(event.request_id, event.endpoint_id);
  }
  const textRequests = uniqueRequests
    .filter((request) => endpointType(request.endpoint_id) === "text")
    .map((request) => ({
      type: "text",
      requestId: request.request_id,
      endpoint: request.endpoint_id,
      billingEndpoint: billingEndpointByRequest.get(request.request_id) ?? request.endpoint_id,
      endedAt: request.ended_at,
      date: localDate(new Date(request.ended_at), args.timezone),
      prompt: promptFor(request.json_input),
      requestCost: costByRequest.get(request.request_id) ?? 0,
    }));
  const media = [];
  const seenUrls = new Set();
  for (const request of uniqueRequests) {
    const candidates = collectOutputMedia(request.json_output);
    let outputIndex = 0;
    for (const candidate of candidates) {
      if (seenUrls.has(candidate.url)) continue;
      seenUrls.add(candidate.url); outputIndex += 1;
      media.push({
        ...candidate,
        requestId: request.request_id,
        endpoint: request.endpoint_id,
        billingEndpoint: billingEndpointByRequest.get(request.request_id) ?? request.endpoint_id,
        endedAt: request.ended_at,
        date: localDate(new Date(request.ended_at), args.timezone),
        prompt: promptFor(request.json_input),
        requestCost: costByRequest.get(request.request_id) ?? 0,
        outputIndex,
        discoveredBy: "request_history",
      });
    }
  }
  for (const asset of assets) {
    if (!asset.url || seenUrls.has(asset.url) || !["image", "video"].includes(asset.type)) continue;
    seenUrls.add(asset.url);
    media.push({
      url: asset.url, type: asset.type, contentType: asset.content_type ?? "", width: asset.width ?? null, height: asset.height ?? null,
      requestId: asset.request_id ?? asset.vector_id, endpoint: asset.endpoint ?? "unknown", endedAt: asset.created_at,
      billingEndpoint: billingEndpointByRequest.get(asset.request_id) ?? asset.endpoint ?? "unknown",
      date: localDate(new Date(asset.created_at), args.timezone), prompt: asset.prompt ?? asset.title ?? "",
      requestCost: costByRequest.get(asset.request_id) ?? 0, outputIndex: 1, discoveredBy: "assets",
    });
  }
  media.sort((a, b) => b.endedAt.localeCompare(a.endedAt) || a.endpoint.localeCompare(b.endpoint) || a.url.localeCompare(b.url));
  console.log(`Discovered ${media.length} unique generated image/video files. Downloading…`);
  const downloaded = await mapConcurrent(media, 6, (item) => downloadOne(item, root));

  const downloadedRequestIds = new Set(downloaded.filter((item) => item.status !== "failed").map((item) => item.requestId));
  const dailyNames = []; for (let date = args.start; date <= args.end; date = addDays(date, 1)) dailyNames.push(date);
  const dailyCostMap = new Map(dailyNames.map((date) => [date, 0]));
  for (const event of billing) { const date = localDate(new Date(event.timestamp), args.timezone); if (dailyCostMap.has(date)) dailyCostMap.set(date, dailyCostMap.get(date) + Number(event.cost_total ?? 0)); }
  const endpointRows = endpoints.map((endpoint) => ({
    endpoint, type: endpointType(endpoint), events: billing.filter((event) => event.endpoint_id === endpoint).length,
    outputs: downloaded.filter((item) => item.billingEndpoint === endpoint && item.status !== "failed").length,
    cost: billing.filter((event) => event.endpoint_id === endpoint).reduce((sum, event) => sum + Number(event.cost_total ?? 0), 0),
  })).filter((row) => row.events || row.outputs).sort((a, b) => b.cost - a.cost);
  const totalCost = billing.reduce((sum, event) => sum + Number(event.cost_total ?? 0), 0);
  const mediaCost = billing.filter((event) => downloadedRequestIds.has(event.request_id)).reduce((sum, event) => sum + Number(event.cost_total ?? 0), 0);
  const mediaByType = groupSum(downloaded.filter((item) => item.status !== "failed"), (item) => item.type, () => 1);
  const costByType = groupSum(billing, (event) => endpointType(event.endpoint_id), (event) => event.cost_total);
  const averageSpendPerFile = ["video", "image"].map((name) => {
    const files = mediaByType.find((row) => row.name === name)?.value ?? 0;
    const spend = costByType.find((row) => row.name === name)?.value ?? 0;
    return files ? { name, value: spend / files, files, spend } : null;
  }).filter(Boolean);
  const summary = {
    dateRange: { start: args.start, endInclusive: args.end, endExclusive: endExclusiveDate, timezone: args.timezone, startIso, endIso },
    generatedAt: new Date().toISOString(),
    totalCost, mediaCost,
    billedRequestCount: new Set(billing.map((event) => event.request_id)).size,
    requestCount: uniqueRequests.length,
    discoveredRequestCount: discoveredRequests.length,
    mediaRequestCount: downloadedRequestIds.size,
    mediaCount: downloaded.length,
    downloaded: downloaded.filter((item) => item.status !== "failed").length,
    failedDownloads: downloaded.filter((item) => item.status === "failed").length,
    imageCount: downloaded.filter((item) => item.type === "image" && item.status !== "failed").length,
    videoCount: downloaded.filter((item) => item.type === "video" && item.status !== "failed").length,
    textCount: textRequests.length,
    contentCount: downloaded.filter((item) => item.status !== "failed").length + textRequests.length,
    downloadBytes: downloaded.reduce((sum, item) => sum + Number(item.bytes ?? 0), 0),
    mediaByType,
    contentByType: groupSum([...downloaded.filter((item) => item.status !== "failed"), ...textRequests], (item) => item.type, () => 1),
    costByType,
    averageSpendPerFile,
    costByEndpoint: groupSum(billing, (event) => event.endpoint_id, (event) => event.cost_total),
    dailyCost: [...dailyCostMap].map(([name, value]) => ({ name, value })),
    endpointRows,
    assets: assetsStatus,
  };
  const generatedAt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: args.timezone }).format(new Date());
  await Promise.all([
    writeFileRetry(path.join(dataRoot, "billing-events.json"), `${JSON.stringify({ billing_events: billing, ...billingResult.metadata }, null, 2)}\n`),
    writeFileRetry(path.join(dataRoot, "requests.json"), `${JSON.stringify({ items: uniqueRequests }, null, 2)}\n`),
    writeFileRetry(path.join(dataRoot, "request-discovery.json"), `${JSON.stringify({ results: discoveredRequests, pagination: discoveryResult.metadata }, null, 2)}\n`),
    writeFileRetry(path.join(dataRoot, "assets.json"), `${JSON.stringify({ assets, status: assetsStatus }, null, 2)}\n`),
    writeFileRetry(path.join(dataRoot, "media-manifest.json"), `${JSON.stringify({ media: downloaded }, null, 2)}\n`),
    writeFileRetry(path.join(dataRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`),
    writeFileRetry(path.join(dataRoot, "billing-events.csv"), toCsv(billing, ["timestamp", "request_id", "endpoint_id", "output_units", "unit_price", "percent_discount", "cost_subtotal", "cost_discount", "cost_total"])),
    writeFileRetry(path.join(dataRoot, "media-manifest.csv"), toCsv(downloaded, ["date", "endedAt", "type", "endpoint", "requestId", "requestCost", "status", "bytes", "contentType", "relativePath", "url", "prompt", "sha256", "error"])),
    writeFileRetry(path.join(root, "report.html"), buildReport({ args, generatedAt, falKey: process.env.FAL_KEY, media: downloaded, summary, textRequests })),
  ]);
  console.log(JSON.stringify({ report: path.join(root, "report.html"), ...summary }, null, 2));
  if (summary.failedDownloads) process.exitCode = 2;
}

await main();
