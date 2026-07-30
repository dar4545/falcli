import "@picocss/pico/css/pico.min.css";
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { allowsMultipleFileSelection } from "./media-file-selection.js";
import "./workspace.css";

const tabs = ["text", "image", "video"];

async function api(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }
  return response.status === 204 ? null : response.json();
}

async function stageMediaSource(file, duration) {
  const query = new URLSearchParams({ name: file.name });
  if (duration !== undefined) query.set("duration", String(duration));
  const response = await fetch(`/api/media-sources?${query}`, {
    body: file,
    headers: { "content-type": file.type || "application/octet-stream" },
    method: "POST",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Could not stage source file");
  return { ...body, file };
}

function readVideoDuration(file) {
  if (!file.type.startsWith("video/")) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const source = URL.createObjectURL(file);
    const finish = (duration) => {
      URL.revokeObjectURL(source);
      resolve(duration);
    };
    video.onloadedmetadata = () =>
      finish(Number.isFinite(video.duration) ? video.duration : undefined);
    video.onerror = () => finish(undefined);
    video.preload = "metadata";
    video.src = source;
  });
}

async function readEvents(response, onEvent) {
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Chat request failed");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line));
    }
    if (done) break;
  }
}

function fileAsAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read attachment"));
    reader.onload = () =>
      resolve({
        name: file.name,
        type: file.type,
        data: String(reader.result).split(",")[1],
      });
    reader.readAsDataURL(file);
  });
}

function ErrorNotice({ error }) {
  return error ? <p class="error" role="alert">{error}</p> : null;
}

function Account({ account, error, onRefresh, refreshing }) {
  const maximum = Math.max(0.01, ...(account?.daily || []).map((day) => day.spend));
  return (
    <aside class="account" aria-label="FAL account usage">
      <div>
        <strong>{account?.username || "FAL account"}</strong>
        <small>{account ? `${account.remainingCredits.toFixed(2)} credits · ${account.monthSpend.toFixed(2)} this month` : "Usage unavailable"}</small>
      </div>
      {account && (
        <div class="usage-chart" aria-label="Daily usage for the latest seven days">
          {account.daily.map((day) => (
            <i
              aria-label={`${day.date}: ${day.spend.toFixed(2)}`}
              style={{ height: `${Math.max(4, (day.spend / maximum) * 28)}px` }}
              title={`${day.date}: ${day.spend.toFixed(2)}`}
            />
          ))}
        </div>
      )}
      <button class="secondary outline compact" disabled={refreshing} onClick={onRefresh} type="button">
        {refreshing ? "Refreshing…" : "Refresh usage"}
      </button>
      {account?.refreshedAt && <small>{account.stale ? "Stale · " : ""}{new Date(account.refreshedAt).toLocaleString()}</small>}
      <ErrorNotice error={error || account?.error} />
    </aside>
  );
}

function TemplateTools({ prompt, setPrompt, templates, type, reload }) {
  const [selected, setSelected] = useState("");

  async function save() {
    const name = window.prompt("Template name");
    if (!name) return;
    await api("/api/templates", {
      body: JSON.stringify({ type, name, prompt }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await reload();
  }

  async function edit() {
    const template = templates.find((item) => item.id === selected);
    if (!template) return;
    const name = window.prompt("Template name", template.name);
    if (!name) return;
    const body = window.prompt("Prompt text", template.prompt);
    if (!body) return;
    await api(`/api/templates/${template.id}`, {
      body: JSON.stringify({ name, prompt: body }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    setPrompt(body);
    await reload();
  }

  async function remove() {
    const template = templates.find((item) => item.id === selected);
    if (!template || !window.confirm(`Delete Prompt template “${template.name}”?`)) return;
    await api(`/api/templates/${template.id}`, { method: "DELETE" });
    setSelected("");
    await reload();
  }

  return (
    <details class="template-tools">
      <summary>Prompt templates</summary>
      <div class="inline-controls">
        <select
          aria-label={`${type} Prompt templates`}
          onChange={(event) => {
            const id = event.currentTarget.value;
            setSelected(id);
            const template = templates.find((item) => item.id === id);
            if (template) setPrompt(template.prompt);
          }}
          value={selected}
        >
          <option value="">Choose a template…</option>
          {templates.map((template) => <option value={template.id}>{template.name}</option>)}
        </select>
        <button class="secondary" disabled={!prompt.trim()} onClick={save} type="button">Save current</button>
        <button class="secondary outline" disabled={!selected} onClick={edit} type="button">Edit</button>
        <button class="contrast outline" disabled={!selected} onClick={remove} type="button">Delete</button>
      </div>
    </details>
  );
}

function ModelSelect({
  models,
  onChoose = null,
  preferences,
  savePreferences,
  selectedId = undefined,
  type,
}) {
  const selected = selectedId ?? preferences.selections[type] ?? "";
  const model = models.find((item) => item.id === selected);
  const favorite = type !== "text" && model?.favorite;

  async function choose(id) {
    if (onChoose) return onChoose(id);
    await savePreferences({
      ...preferences,
      selections: { ...preferences.selections, [type]: id },
    });
  }

  async function toggleFavorite() {
    const current = preferences.favorites[type] || [];
    const next = favorite ? current.filter((id) => id !== selected) : [...current, selected];
    await savePreferences({
      ...preferences,
      favorites: { ...preferences.favorites, [type]: next },
    });
  }

  return (
    <div class="model-row">
      <label>
        {type === "text" ? "Model via openrouter/router" : "FAL model"}
        <select onChange={(event) => choose(event.currentTarget.value)} value={selected}>
          <option value="">Choose a model…</option>
          {models.map((item) => (
            <option value={item.id}>{item.favorite ? "★ " : ""}{item.name} · {item.id}</option>
          ))}
        </select>
      </label>
      {type !== "text" && selected && (
        <button
          aria-label={favorite ? "Remove selected model from favourites" : "Add selected model to favourites"}
          class="secondary outline favorite"
          onClick={toggleFavorite}
          title={favorite ? "Remove favourite" : "Add favourite"}
          type="button"
        >
          {favorite ? "★" : "☆"}
        </button>
      )}
    </div>
  );
}

function ChatWorkspace({
  conversations,
  currentId,
  error,
  models,
  preferences,
  refreshConversations,
  savePreferences,
  setCurrentId,
  templates,
  reloadTemplates,
}) {
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState("");
  const fileRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const conversation = conversations.find((item) => item.id === currentId);

  async function newConversation() {
    setLocalError("");
    const created = await api("/api/conversations", {
      body: JSON.stringify({ model: preferences.selections.text }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await refreshConversations();
    setCurrentId(created.id);
  }

  async function consume(response) {
    setDraft("");
    await readEvents(response, (event) => {
      if (event.type === "delta") setDraft((value) => value + event.content);
      if (event.type === "error") setLocalError(event.error);
    });
    setDraft("");
    await refreshConversations();
  }

  async function send(event) {
    event.preventDefault();
    if ((!prompt.trim() && !attachments.length) || busy) return;
    setBusy(true);
    setLocalError("");
    try {
      let id = currentId;
      if (!id) {
        const created = await api("/api/conversations", {
          body: JSON.stringify({ model: preferences.selections.text }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        id = created.id;
        setCurrentId(id);
      }
      const body = {
        content: prompt,
        ...(attachments.length && {
          attachments: await Promise.all(attachments.map(fileAsAttachment)),
        }),
      };
      setPrompt("");
      setAttachments([]);
      if (fileRef.current) fileRef.current.value = "";
      await consume(
        await fetch(`/api/conversations/${id}/messages`, {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
    } catch (caught) {
      setLocalError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    if (!conversation || busy) return;
    setBusy(true);
    setLocalError("");
    try {
      await consume(await fetch(`/api/conversations/${conversation.id}/regenerate`, { method: "POST" }));
    } catch (caught) {
      setLocalError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  async function keep() {
    await api(`/api/conversations/${conversation.id}/keep`, { method: "POST" });
    await refreshConversations();
  }

  async function discard() {
    if (!window.confirm("Discard this whole Conversation and its attachments?")) return;
    await api(`/api/conversations/${conversation.id}`, { method: "DELETE" });
    setCurrentId("");
    await refreshConversations();
  }

  return (
    <div class="chat-layout">
      <aside class="conversation-list">
        <button onClick={newConversation} type="button">New chat</button>
        <nav aria-label="Conversation history">
          {conversations.map((item) => (
            <button
              aria-current={item.id === currentId ? "page" : undefined}
              class={item.id === currentId ? "secondary" : "secondary outline"}
              onClick={() => setCurrentId(item.id)}
              type="button"
            >
              {(item.messages.find((message) => message.role === "user")?.content || "New Conversation").slice(0, 38)}
              {item.kept ? " · kept" : ""}
            </button>
          ))}
        </nav>
      </aside>
      <section>
        <ModelSelect models={models} preferences={preferences} savePreferences={savePreferences} type="text" />
        <div class="messages" aria-live="polite">
          {!conversation && <p class="empty">Start a new Conversation or send a message.</p>}
          {conversation?.messages.map((message) => (
            <article class={`message ${message.role} ${message.superseded ? "superseded" : ""}`}>
              <header>{message.role === "assistant" ? "Assistant" : "You"}{message.superseded ? " · replaced" : ""}</header>
              <p>{message.content}</p>
              {message.attachments?.map((item) =>
                item.type?.startsWith("image/") ? (
                  <img alt={item.name} loading="lazy" src={item.fileUrl} />
                ) : (
                  <p><a download={item.name} href={item.fileUrl}>{item.name}</a></p>
                ),
              )}
            </article>
          ))}
          {draft && <article class="message assistant"><header>Assistant · streaming</header><p>{draft}</p></article>}
        </div>
        <ErrorNotice error={localError || error} />
        <form onSubmit={send}>
          <TemplateTools prompt={prompt} reload={reloadTemplates} setPrompt={setPrompt} templates={templates} type="text" />
          <label>
            Message
            <textarea onInput={(event) => setPrompt(event.currentTarget.value)} rows={4} value={prompt} />
          </label>
          <label>
            Attachments (any file type)
            <input
              multiple
              onChange={(event) => setAttachments(Array.from(event.currentTarget.files ?? []))}
              ref={fileRef}
              type="file"
            />
          </label>
          <div class="inline-controls">
            <button disabled={busy || (!prompt.trim() && !attachments.length) || !preferences.selections.text}>Send</button>
            <button class="secondary outline" disabled={busy || !conversation?.messages.some((message) => message.role === "assistant" && !message.superseded)} onClick={regenerate} type="button">Regenerate</button>
            <button class="secondary outline" disabled={!conversation || conversation.kept} onClick={keep} type="button">Keep Conversation</button>
            <button class="contrast outline" disabled={!conversation} onClick={discard} type="button">Discard Conversation</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function formatDuration(seconds) {
  const wholeSeconds = Math.round(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

function SourceItem({ index, onRemove = null, onReorder = null, source }) {
  return (
    <article
      class="source-item"
      draggable={Boolean(onReorder)}
      onDragStart={(event) => event.dataTransfer.setData("text/source-index", String(index))}
      onDragOver={(event) => onReorder && event.preventDefault()}
      onDrop={(event) => {
        if (!onReorder) return;
        event.preventDefault();
        onReorder(Number(event.dataTransfer.getData("text/source-index")), index);
      }}
    >
      {source.fileUrl && source.type?.startsWith("image/") && (
        <img alt="" src={source.fileUrl} />
      )}
      <span>
        <strong>{source.name}</strong>
        <small>
          {formatBytes(source.size)}
          {Number.isFinite(source.duration) && ` · ${formatDuration(source.duration)}`}
        </small>
      </span>
      {onRemove && (
        <button
          aria-label={`Remove ${source.name}`}
          class="contrast outline compact"
          onClick={() => onRemove(source)}
          type="button"
        >
          Remove
        </button>
      )}
    </article>
  );
}

function FileFieldControl({ field, mode, onFiles, onRemove, onReorder, sources }) {
  const acceptsMultiple = allowsMultipleFileSelection(mode, field);
  return (
    <fieldset class="file-field">
      <legend>
        {field.label}{field.required ? " *" : ""}
      </legend>
      {field.description && <small>{field.description}</small>}
      <label
        class="drop-zone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          onFiles([...event.dataTransfer.files]);
        }}
      >
        Drop {acceptsMultiple ? "files" : "a file"} here or browse
        <input
          aria-label={`Choose ${field.label}`}
          multiple={acceptsMultiple}
          onChange={(event) => {
            onFiles([...(event.currentTarget.files ?? [])]);
            event.currentTarget.value = "";
          }}
          type="file"
        />
      </label>
      <div class="source-list">
        {sources.map((source, index) => (
          <SourceItem
            index={index}
            onRemove={onRemove}
            onReorder={field.cardinality === "array" ? onReorder : null}
            source={source}
          />
        ))}
      </div>
    </fieldset>
  );
}

function ResultCard({ onEdit, result, selected, setSelected, type, updateResult }) {
  async function action(path, method = "POST") {
    const updated = await api(`/api/results/${result.id}${path}`, { method });
    if (updated) updateResult(updated);
  }

  return (
    <article class="result-card">
      <header>
        <label>
          <input
            checked={selected}
            disabled={!["completed", "failed", "not-submitted"].includes(result.state)}
            onChange={(event) => setSelected(result.id, event.currentTarget.checked)}
            type="checkbox"
          />
          <span class={`status ${result.state}`}>{result.state}</span>
        </label>
      </header>
      {result.fileUrl && type === "image" && <a href={result.fileUrl} target="_blank"><img alt={result.prompt} loading="lazy" src={result.fileUrl} /></a>}
      {result.fileUrl && type === "video" && <video controls preload="metadata" src={result.fileUrl} />}
      <p>
        {result.failure?.status && `${result.failure.status} · `}
        {result.error || result.prompt}
      </p>
      {result.failure?.details !== undefined && (
        <details class="failure-detail">
          <summary>Failure details</summary>
          <pre>{JSON.stringify(result.failure.details, null, 2)}</pre>
        </details>
      )}
      {result.attemptOf && <small>Retry of {result.attemptOf.slice(0, 8)}</small>}
      <footer class="inline-controls">
        <button disabled={result.state !== "completed"} onClick={() => action("/keep")} type="button">Keep</button>
        <button class="contrast outline" disabled={!["completed", "failed", "not-submitted"].includes(result.state)} onClick={() => action("", "DELETE")} type="button">Discard</button>
        <button class="secondary outline" disabled={!["queued", "submitted", "remote-queued", "running"].includes(result.state)} onClick={() => action("/cancel")} type="button">Cancel</button>
        <button class="secondary outline" disabled={!["failed", "not-submitted"].includes(result.state)} onClick={() => action("/retry")} type="button">Retry</button>
        <button
          class="secondary outline"
          disabled={["queued", "submitting", "submitted", "remote-queued", "running", "cancelling"].includes(result.state)}
          onClick={() => onEdit(result)}
          type="button"
        >
          Edit as new Batch
        </button>
      </footer>
    </article>
  );
}

const mediaModes = {
  image: [
    ["text-to-image", "Text to Image"],
    ["image-to-image", "Image to Image"],
  ],
  video: [
    ["text-to-video", "Text to Video"],
    ["image-to-video", "Image to Video"],
    ["video-to-video", "Video to Video"],
    ["mixed-references-to-video", "Mixed References to Video"],
  ],
};

function MediaWorkspace({
  batches,
  composer,
  error,
  modelWarning,
  models,
  preferences,
  refreshModels,
  reloadLibrary,
  reloadModels,
  reloadTemplates,
  savePreferences,
  setBatches,
  setComposer,
  templates,
  type,
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelectedState] = useState(new Set());
  const [localError, setLocalError] = useState("");
  const [busy, setBusy] = useState(false);
  const mode = preferences.modes?.[type] ?? mediaModes[type][0][0];
  const selectedModelId =
    preferences.modeSelections?.[type]?.[mode] ?? preferences.selections[type] ?? "";
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const visibleModels = useMemo(
    () =>
      models.filter(
        (model) =>
          model.modes?.includes(mode) &&
          (model.id === selectedModelId ||
            `${model.name} ${model.id} ${model.description}`
              .toLowerCase()
              .includes(search.toLowerCase())),
      ),
    [mode, models, search, selectedModelId],
  );
  const visibleFileFields =
    mode === "text-to-image" || mode === "text-to-video"
      ? selectedModel?.fileFields?.filter((field) => field.required) ?? []
      : selectedModel?.fileFields ?? [];
  const selectedResults = batches
    .flatMap((batch) => batch.results)
    .filter((result) => selected.has(result.id));

  function setSelected(id, checked) {
    setSelectedState((current) => {
      const next = new Set(current);
      checked ? next.add(id) : next.delete(id);
      return next;
    });
  }

  function updateResult(updated) {
    setBatches((current) =>
      current.map((batch) => ({
        ...batch,
        ...(updated.batchId === batch.id &&
          updated.sourceFields && { sourceFields: updated.sourceFields }),
        results: batch.results.some((result) => result.id === updated.id)
          ? batch.results.map((result) => (result.id === updated.id ? updated : result))
          : updated.batchId === batch.id
            ? [...batch.results, updated]
            : batch.results,
      })),
    );
    reloadLibrary();
  }

  async function editAsNew(result) {
    setLocalError("");
    try {
      const editable = await api(`/api/results/${result.id}/edit-input`);
      await savePreferences({
        ...preferences,
        modes: { ...preferences.modes, [type]: editable.mode },
        selections: { ...preferences.selections, [type]: editable.model },
        modeSelections: {
          ...preferences.modeSelections,
          [type]: {
            ...preferences.modeSelections?.[type],
            [editable.mode]: editable.model,
          },
        },
      });
      setComposer((current) => ({
        ...current,
        prompt: editable.prompt,
        sourceFields: Object.fromEntries(
          Object.entries(editable.sourceFields).map(([field, assigned]) => [
            field,
            Array.isArray(assigned) ? assigned : [assigned],
          ]),
        ),
        unassigned: [],
      }));
    } catch (caught) {
      setLocalError(caught.message);
    }
  }

  function reconcileComposerForModel(model) {
    const fields = new Map((model?.fileFields ?? []).map((field) => [field.name, field]));
    setComposer((current) => {
      const sourceFields = {};
      const unassigned = [...current.unassigned];
      for (const [name, sources] of Object.entries(current.sourceFields)) {
        const field = fields.get(name);
        if (!field) {
          unassigned.push(...sources);
        } else if (field.cardinality === "single" && sources.length > 1) {
          sourceFields[name] = sources.slice(0, 1);
          unassigned.push(...sources.slice(1));
        } else {
          sourceFields[name] = sources;
        }
      }
      return { ...current, sourceFields, unassigned };
    });
  }

  async function chooseMode(nextMode) {
    const nextModel = preferences.modeSelections?.[type]?.[nextMode] ?? "";
    reconcileComposerForModel(models.find((model) => model.id === nextModel));
    await savePreferences({
      ...preferences,
      modes: { ...preferences.modes, [type]: nextMode },
      selections: { ...preferences.selections, [type]: nextModel },
    });
  }

  async function chooseModel(id) {
    const model = models.find((item) => item.id === id);
    reconcileComposerForModel(model);
    await savePreferences({
      ...preferences,
      selections: { ...preferences.selections, [type]: id },
      modeSelections: {
        ...preferences.modeSelections,
        [type]: {
          ...preferences.modeSelections?.[type],
          [mode]: id,
        },
      },
    });
  }

  async function removeSource(source) {
    await api(`/api/media-sources/${source.id}`, { method: "DELETE" }).catch(() => {});
    setComposer((current) => ({
      ...current,
      sourceFields: Object.fromEntries(
        Object.entries(current.sourceFields).map(([name, sources]) => [
          name,
          sources.filter((item) => item.id !== source.id),
        ]),
      ),
      unassigned: current.unassigned.filter((item) => item.id !== source.id),
    }));
  }

  async function addFiles(field, files) {
    if (!files.length) return;
    setLocalError("");
    try {
      const staged = [];
      for (const file of files) {
        staged.push(await stageMediaSource(file, await readVideoDuration(file)));
      }
      const previous = composer.sourceFields[field.name] ?? [];
      if (field.cardinality === "single") {
        for (const source of previous) {
          await api(`/api/media-sources/${source.id}`, { method: "DELETE" }).catch(() => {});
        }
      }
      setComposer((current) => ({
        ...current,
        sourceFields: {
          ...current.sourceFields,
          [field.name]:
            field.cardinality === "array"
              ? [...(current.sourceFields[field.name] ?? []), ...staged]
              : staged.slice(0, 1),
        },
        unassigned:
          field.cardinality === "single" && staged.length > 1
            ? [...current.unassigned, ...staged.slice(1)]
            : current.unassigned,
      }));
    } catch (caught) {
      setLocalError(caught.message);
    }
  }

  function reorder(field, from, to) {
    if (!Number.isInteger(from) || from === to) return;
    setComposer((current) => {
      const reordered = [...(current.sourceFields[field.name] ?? [])];
      const [moved] = reordered.splice(from, 1);
      if (moved) reordered.splice(to, 0, moved);
      return {
        ...current,
        sourceFields: { ...current.sourceFields, [field.name]: reordered },
      };
    });
  }

  function assignUnassigned(source, field) {
    setComposer((current) => {
      const existing = current.sourceFields[field.name] ?? [];
      return {
        ...current,
        sourceFields: {
          ...current.sourceFields,
          [field.name]: field.cardinality === "array" ? [...existing, source] : [source],
        },
        unassigned: [
          ...current.unassigned.filter((item) => item.id !== source.id),
          ...(field.cardinality === "single" ? existing : []),
        ],
      };
    });
  }

  async function generate(event) {
    event.preventDefault();
    setLocalError("");
    setBusy(true);
    try {
      const readySourceFields = {};
      for (const field of visibleFileFields) {
        const ready = [];
        for (const source of composer.sourceFields[field.name] ?? []) {
          if (source.state === "Uploaded" && source.file) {
            const replacement = await stageMediaSource(source.file, source.duration);
            await api(`/api/media-sources/${source.id}`, { method: "DELETE" }).catch(() => {});
            ready.push(replacement);
          } else {
            ready.push(source);
          }
        }
        readySourceFields[field.name] = ready;
      }
      setComposer((current) => ({
        ...current,
        sourceFields: { ...current.sourceFields, ...readySourceFields },
      }));
      const sourceFields = Object.fromEntries(
        visibleFileFields.flatMap((field) => {
          const sources = readySourceFields[field.name] ?? [];
          if (!sources.length) return [];
          return [[
            field.name,
            field.cardinality === "array"
              ? sources.map((source) => source.id)
              : sources[0].id,
          ]];
        }),
      );
      const assignedIds = new Set(
        Object.values(sourceFields).flatMap((value) =>
          Array.isArray(value) ? value : [value],
        ),
      );
      setComposer((current) => ({
        ...current,
        sourceFields: Object.fromEntries(
          Object.entries(current.sourceFields).map(([name, sources]) => [
            name,
            sources.map((source) =>
              assignedIds.has(source.id) ? { ...source, state: "Uploading" } : source,
            ),
          ]),
        ),
      }));
      const batch = await api("/api/batches", {
        body: JSON.stringify({
          type,
          mode,
          model: selectedModelId,
          ...(selectedModel?.prompt && { prompt: composer.prompt }),
          quantity: composer.quantity,
          sourceFields,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      setBatches((current) => [batch, ...current]);
      setComposer((current) => ({
        ...current,
        sourceFields: Object.fromEntries(
          Object.entries(current.sourceFields).map(([name, sources]) => [
            name,
            sources.map((source) => ({ ...source, state: "Uploaded" })),
          ]),
        ),
      }));
    } catch (caught) {
      setComposer((current) => ({
        ...current,
        sourceFields: Object.fromEntries(
          Object.entries(current.sourceFields).map(([name, sources]) => [
            name,
            sources.map((source) =>
              source.state === "Uploading" ? { ...source, state: "Failed" } : source,
            ),
          ]),
        ),
      }));
      setLocalError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  async function review(action) {
    const ids = [...selected];
    if (!ids.length) return;
    if (action === "discard" && !window.confirm(`Discard ${ids.length} selected results?`)) return;
    const reviewed = await api("/api/results/bulk", {
      body: JSON.stringify({ keep: action === "keep" ? ids : [], discard: action === "discard" ? ids : [] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    for (const result of reviewed.results) updateResult(result);
    setSelectedState(new Set());
  }

  return (
    <div class="media-layout">
      <form class="composer" onSubmit={generate}>
        <label>
          Generation mode
          <select onChange={(event) => chooseMode(event.currentTarget.value)} value={mode}>
            {mediaModes[type].map(([value, label]) => <option value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          Search models
          <input onInput={(event) => setSearch(event.currentTarget.value)} placeholder={`Search ${type} models`} type="search" value={search} />
        </label>
        <button class="secondary outline" onClick={refreshModels} type="button">
          {modelWarning ? "Retry model schemas" : "Refresh models"}
        </button>
        {modelWarning && <p class="model-warning" role="status">{modelWarning}</p>}
        <ModelSelect
          models={visibleModels}
          onChoose={chooseModel}
          preferences={preferences}
          savePreferences={async (next) => {
            await savePreferences(next);
            await reloadModels(type);
          }}
          selectedId={selectedModelId}
          type={type}
        />
        {selectedModel?.prompt && (
          <>
            <TemplateTools
              prompt={composer.prompt}
              reload={reloadTemplates}
              setPrompt={(prompt) => setComposer((current) => ({ ...current, prompt }))}
              templates={templates}
              type={type}
            />
            <label>
              {selectedModel.prompt.label}{selectedModel.prompt.required ? " *" : ""}
              {selectedModel.prompt.description && <small>{selectedModel.prompt.description}</small>}
              <textarea
                onInput={(event) =>
                  setComposer((current) => ({
                    ...current,
                    prompt: event.currentTarget.value,
                  }))}
                rows={6}
                value={composer.prompt}
              />
            </label>
          </>
        )}
        {visibleFileFields.map((field) => (
          <FileFieldControl
            field={field}
            mode={mode}
            onFiles={(files) => addFiles(field, files)}
            onRemove={removeSource}
            onReorder={(from, to) => reorder(field, from, to)}
            sources={composer.sourceFields[field.name] ?? []}
          />
        ))}
        {composer.unassigned.length > 0 && (
          <fieldset class="file-field">
            <legend>Unassigned files</legend>
            <small>Choose an exact schema field; files are never remapped automatically.</small>
            {composer.unassigned.map((source, index) => (
              <div class="unassigned-row">
                <SourceItem index={index} onRemove={removeSource} source={source} />
                <div class="inline-controls">
                  {visibleFileFields.map((field) => (
                    <button
                      class="secondary outline compact"
                      onClick={() => assignUnassigned(source, field)}
                      type="button"
                    >
                      Assign to {field.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </fieldset>
        )}
        <label>
          Results per Batch
          <input
            max="50"
            min="1"
            onInput={(event) =>
              setComposer((current) => ({
                ...current,
                quantity: Number(event.currentTarget.value),
              }))}
            type="number"
            value={composer.quantity}
          />
        </label>
        <button disabled={busy || !selectedModelId}>
          {busy ? "Preparing Batch…" : "Generate Batch"}
        </button>
        <ErrorNotice error={localError || error} />
      </form>
      <section>
        <div class="review-bar">
          <strong>Batch preview</strong>
          <div class="inline-controls">
            <button disabled={!selected.size || selectedResults.some((result) => result.state !== "completed")} onClick={() => review("keep")} type="button">Keep selected</button>
            <button class="contrast outline" disabled={!selected.size} onClick={() => review("discard")} type="button">Discard selected</button>
          </div>
        </div>
        {!batches.length && <p class="empty">Generated results will appear here as they complete.</p>}
        {batches.map((batch) => (
          <details open>
            <summary>
              {batch.model} · {mediaModes[type].find(([value]) => value === batch.mode)?.[1] ?? batch.mode} · {batch.results.length} results
            </summary>
            {batch.prompt && <p>{batch.prompt}</p>}
            {Object.entries(batch.sourceFields ?? {}).map(([name, assigned]) => (
              <div class="batch-sources">
                <strong>{name}</strong>
                <div class="source-list">
                  {(Array.isArray(assigned) ? assigned : [assigned]).map((source, index) => (
                    <SourceItem index={index} source={source} />
                  ))}
                </div>
              </div>
            ))}
            <div class="result-grid">
              {batch.results.map((result) => (
                <ResultCard
                  onEdit={editAsNew}
                  result={result}
                  selected={selected.has(result.id)}
                  setSelected={setSelected}
                  type={type}
                  updateResult={updateResult}
                />
              ))}
            </div>
          </details>
        ))}
      </section>
    </div>
  );
}

function Library({ results, type }) {
  const kept = results.filter((result) => result.state === "kept");
  if (!kept.length) return null;
  return (
    <section>
      <h3>Kept library</h3>
      <div class="library-grid">
        {kept.map((result) => (
          <article>
            {type === "image" ? <img alt={result.prompt} loading="lazy" src={result.fileUrl} /> : <video controls preload="metadata" src={result.fileUrl} />}
            <small>{result.model}</small>
            <p>{result.prompt}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function Workspace() {
  const [active, setActive] = useState("text");
  const [readiness, setReadiness] = useState(null);
  const [preferences, setPreferences] = useState({
    favorites: { image: [], video: [] },
    selections: { text: "", image: "", video: "" },
    modes: { image: "text-to-image", video: "text-to-video" },
    modeSelections: { image: {}, video: {} },
    concurrency: 2,
  });
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [models, setModels] = useState({ text: [], image: [], video: [] });
  const [modelErrors, setModelErrors] = useState({ text: "", image: "", video: "" });
  const [modelWarnings, setModelWarnings] = useState({ image: "", video: "" });
  const [account, setAccount] = useState(null);
  const [accountError, setAccountError] = useState("");
  const [refreshingAccount, setRefreshingAccount] = useState(false);
  const [conversations, setConversations] = useState([]);
  const [currentId, setCurrentId] = useState("");
  const [batches, setBatches] = useState({ image: [], video: [] });
  const [mediaComposers, setMediaComposers] = useState({
    image: { prompt: "", quantity: 1, sourceFields: {}, unassigned: [] },
    video: { prompt: "", quantity: 1, sourceFields: {}, unassigned: [] },
  });
  const [library, setLibrary] = useState({ image: [], video: [] });
  const [templates, setTemplates] = useState({ text: [], image: [], video: [] });

  async function loadModels(type, refresh = false) {
    try {
      const data = await api(`/api/models/${type}${refresh ? "?refresh=1" : ""}`);
      setModels((current) => ({ ...current, [type]: data.models }));
      setModelErrors((current) => ({ ...current, [type]: "" }));
      if (type !== "text") {
        setModelWarnings((current) => ({ ...current, [type]: data.warning || "" }));
      }
    } catch (error) {
      setModelErrors((current) => ({ ...current, [type]: error.message }));
    }
  }

  async function savePreferences(next) {
    const saved = await api("/api/preferences", {
      body: JSON.stringify(next),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    setPreferences(saved);
    return saved;
  }

  async function refreshAccount() {
    setRefreshingAccount(true);
    setAccountError("");
    try {
      setAccount(await api("/api/account", { method: "POST" }));
    } catch (error) {
      setAccountError(error.message);
    } finally {
      setRefreshingAccount(false);
    }
  }

  async function refreshConversations() {
    const data = await api("/api/conversations");
    setConversations(data.conversations);
    if (!currentId && data.conversations[0]) setCurrentId(data.conversations[0].id);
  }

  async function reloadLibrary(type) {
    if (type) {
      const data = await api(`/api/results?type=${type}`);
      setLibrary((current) => ({ ...current, [type]: data.results }));
      return;
    }
    await Promise.all(["image", "video"].map((item) => reloadLibrary(item)));
  }

  async function reloadTemplates(type) {
    if (type) {
      const data = await api(`/api/templates?type=${type}`);
      setTemplates((current) => ({ ...current, [type]: data.templates }));
      return;
    }
    await Promise.all(tabs.map((item) => reloadTemplates(item)));
  }

  useEffect(() => {
    Promise.allSettled([
      api("/api/readiness").then(setReadiness),
      api("/api/preferences").then((value) => {
        setPreferences(value);
        setPreferencesLoaded(true);
      }),
      refreshConversations(),
      reloadLibrary(),
      reloadTemplates(),
      refreshAccount(),
    ]);
  }, []);

  useEffect(() => {
    if (!preferencesLoaded) return;
    for (const type of tabs) loadModels(type);
  }, [preferencesLoaded, preferences.favorites.image.join(","), preferences.favorites.video.join(",")]);

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.addEventListener("result", (event) => {
      const result = JSON.parse(event.data);
      setBatches((current) => ({
        ...current,
        [result.type]: current[result.type].map((batch) => ({
          ...batch,
          ...(result.batchId === batch.id &&
            result.sourceFields && { sourceFields: result.sourceFields }),
          results: batch.results.map((item) => (item.id === result.id ? result : item)),
        })),
      }));
    });
    return () => events.close();
  }, []);

  const activeTemplates = templates[active] || [];
  return (
    <>
      <header class="workspace-header">
        <div>
          <h1>Generation Workspace</h1>
          <small>FAL-powered Chat, Image, and Video</small>
          {!readiness?.generation.ready && <ErrorNotice error={readiness?.generation.message} />}
        </div>
        <label class="concurrency">
          Queue concurrency
          <input
            max="20"
            min="1"
            onChange={(event) => savePreferences({ ...preferences, concurrency: Number(event.currentTarget.value) })}
            type="number"
            value={preferences.concurrency}
          />
        </label>
        <Account account={account} error={accountError} onRefresh={refreshAccount} refreshing={refreshingAccount} />
      </header>
      <nav class="tabs" role="tablist" aria-label="Generation type">
        {tabs.map((tab) => (
          <button
            aria-controls={`${tab}-panel`}
            aria-selected={active === tab}
            class={active === tab ? "" : "secondary outline"}
            id={`${tab}-tab`}
            onClick={() => setActive(tab)}
            role="tab"
            type="button"
          >
            {tab[0].toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </nav>
      <main
        aria-labelledby={`${active}-tab`}
        id={`${active}-panel`}
        role="tabpanel"
      >
        {active === "text" ? (
          <ChatWorkspace
            conversations={conversations}
            currentId={currentId}
            error={modelErrors.text}
            models={models.text}
            preferences={preferences}
            refreshConversations={refreshConversations}
            reloadTemplates={() => reloadTemplates("text")}
            savePreferences={savePreferences}
            setCurrentId={setCurrentId}
            templates={activeTemplates}
          />
        ) : (
          <>
            <MediaWorkspace
              batches={batches[active]}
              composer={mediaComposers[active]}
              error={modelErrors[active]}
              modelWarning={modelWarnings[active]}
              models={models[active]}
              preferences={preferences}
              refreshModels={() => loadModels(active, true)}
              reloadLibrary={() => reloadLibrary(active)}
              reloadModels={loadModels}
              reloadTemplates={() => reloadTemplates(active)}
              savePreferences={savePreferences}
              setComposer={(update) =>
                setMediaComposers((current) => ({
                  ...current,
                  [active]:
                    typeof update === "function" ? update(current[active]) : update,
                }))
              }
              setBatches={(update) =>
                setBatches((current) => ({
                  ...current,
                  [active]: typeof update === "function" ? update(current[active]) : update,
                }))
              }
              templates={activeTemplates}
              type={active}
            />
            <Library results={library[active]} type={active} />
          </>
        )}
      </main>
    </>
  );
}

render(<Workspace />, document.getElementById("app"));
