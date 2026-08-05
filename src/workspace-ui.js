export function generationTabs() {
  return ["text", "image", "video", "audio"];
}

function applyResultToBatch(batch, result) {
  if (batch.id !== result.batchId) return batch;
  return {
    ...batch,
    ...(result.sourceFields && { sourceFields: result.sourceFields }),
    results: batch.results.some((item) => item.id === result.id)
      ? batch.results.map((item) => (item.id === result.id ? result : item))
      : [...batch.results, result],
  };
}

export function reconcileBatchResults(state, incoming, pendingLimit = 200) {
  if (incoming.kind === "batch") {
    const matching = state.pendingResults.filter(
      (result) => result.batchId === incoming.batch.id,
    );
    const batch = matching.reduce(applyResultToBatch, incoming.batch);
    return {
      batches: [batch, ...state.batches.filter((item) => item.id !== batch.id)],
      pendingResults: state.pendingResults.filter(
        (result) => result.batchId !== incoming.batch.id,
      ),
    };
  }

  const matched = state.batches.some((batch) => batch.id === incoming.result.batchId);
  if (matched) {
    return {
      batches: state.batches.map((batch) => applyResultToBatch(batch, incoming.result)),
      pendingResults: state.pendingResults.filter(
        (result) => result.id !== incoming.result.id,
      ),
    };
  }
  const pendingResults = [
    ...state.pendingResults.filter((result) => result.id !== incoming.result.id),
    incoming.result,
  ];
  return {
    batches: state.batches,
    pendingResults: pendingResults.slice(-Math.max(1, pendingLimit)),
  };
}

export function modelProvider(model) {
  if (model?.provider) return String(model.provider);
  const [provider] = String(model?.id ?? "").split("/");
  return provider || "Unknown provider";
}

export function modelMatchesSearch(model, query) {
  const normalized = String(query ?? "").trim().toLowerCase();
  if (!normalized) return true;
  return [
    model?.name,
    model?.label,
    modelProvider(model),
    model?.id,
  ].some((value) => String(value ?? "").toLowerCase().includes(normalized));
}

export function modelCatalogState({ error, loading, models }) {
  if (loading) {
    return {
      disabled: true,
      placeholder: "Loading models…",
      status: "Loading the FAL model catalog. This can take a moment after restarting the app.",
    };
  }
  if (error && !models.length) {
    return {
      disabled: true,
      placeholder: "Models unavailable",
      status: error,
    };
  }
  return {
    disabled: false,
    placeholder: "Choose a model…",
    status: "",
  };
}

export function resultRefreshesAccount(result) {
  return result?.state === "completed";
}

function cloneParameterValue(value) {
  if (Array.isArray(value)) return value.map(cloneParameterValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => [name, cloneParameterValue(child)]),
    );
  }
  return value;
}

export function defaultValueForParameter(field) {
  if (Object.hasOwn(field, "default")) {
    return { present: true, value: cloneParameterValue(field.default) };
  }
  if (field.control === "group") {
    const entries = (field.fields ?? []).flatMap((child) => {
      const nested = defaultValueForParameter(child);
      return nested.present ? [[child.name, nested.value]] : [];
    });
    if (entries.length) return { present: true, value: Object.fromEntries(entries) };
  }
  return { present: false, value: undefined };
}

export function initialParametersForModel(model, current = {}) {
  return Object.fromEntries(
    (model?.parameterFields ?? []).flatMap((field) => {
      if (
        Object.hasOwn(current, field.name) &&
        parameterValueIsValid({ ...field, required: false }, current[field.name])
      ) {
        return [[field.name, cloneParameterValue(current[field.name])]];
      }
      const fallback = defaultValueForParameter(field);
      return fallback.present ? [[field.name, fallback.value]] : [];
    }),
  );
}

export function updateParameterContainerValue(container, key, value) {
  if (typeof key === "number") {
    const next = Array.isArray(container) ? [...container] : [];
    next[key] = value;
    return next;
  }
  const next =
    container && typeof container === "object" && !Array.isArray(container)
      ? { ...container }
      : {};
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

export function parameterValueIsValid(field, value) {
  if (value === undefined || value === "") return !field.required;
  if (value === null) return Boolean(field.nullable);
  if (field.options) return field.options.some((option) => Object.is(option, value));
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "string") {
    if (typeof value !== "string") return false;
    if (Number.isFinite(field.minLength) && value.length < field.minLength) return false;
    if (Number.isFinite(field.maxLength) && value.length > field.maxLength) return false;
    if (field.pattern) {
      try {
        if (!new RegExp(field.pattern).test(value)) return false;
      } catch {}
    }
    return true;
  }
  if (field.type === "array") {
    return (
      Array.isArray(value) &&
      (!Number.isFinite(field.minItems) || value.length >= field.minItems) &&
      (!Number.isFinite(field.maxItems) || value.length <= field.maxItems) &&
      (!field.item ||
        value.every((item) =>
          parameterValueIsValid({ ...field.item, required: true }, item),
        ))
    );
  }
  if (field.type === "object") {
    return (
      Boolean(value) &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (field.fields ?? []).every((child) =>
        parameterValueIsValid(child, value[child.name]),
      )
    );
  }
  if (field.type === "json") return true;
  if (!["integer", "number"].includes(field.type)) return false;
  return (
    Number.isFinite(value) &&
    (field.type !== "integer" || Number.isInteger(value)) &&
    (!Number.isFinite(field.minimum) || value >= field.minimum) &&
    (!Number.isFinite(field.maximum) || value <= field.maximum)
  );
}

export function generationIssues({
  composer,
  selectedModel,
  selectedModelId,
  visibleFileFields,
}) {
  const issues = [];
  if (!selectedModelId) {
    issues.push("choose a model");
  } else if (!selectedModel) {
    issues.push("choose an available model");
  }
  if (selectedModel?.prompt?.required && !composer.prompt.trim()) {
    issues.push(`enter ${selectedModel.prompt.label || "the required prompt"}`);
  } else if (
    selectedModel?.prompt &&
    composer.prompt &&
    !parameterValueIsValid(
      { ...selectedModel.prompt, type: "string", required: false },
      composer.prompt,
    )
  ) {
    issues.push(`enter a valid ${selectedModel.prompt.label || "prompt"}`);
  }
  for (const field of visibleFileFields.filter((item) => item.required)) {
    if (!(composer.sourceFields[field.name] ?? []).length) {
      issues.push(`add ${field.label || field.name}`);
    }
  }
  for (const field of selectedModel?.parameterFields ?? []) {
    const value = composer.parameters?.[field.name];
    if (value === undefined || value === "") {
      if (field.required) issues.push(`set ${field.label || field.name}`);
      continue;
    }
    if (!parameterValueIsValid(field, value)) {
      issues.push(`enter a valid ${field.label || field.name}`);
    }
  }
  if (
    !Number.isInteger(composer.quantity) ||
    composer.quantity < 1 ||
    composer.quantity > 50
  ) {
    issues.push("set Results per Batch from 1 to 50");
  }
  return issues;
}

export function compactText(value, maximum = 120) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

export function mediaAlt(result, type) {
  const kind = type === "video" ? "video" : type === "audio" ? "audio" : "image";
  const prompt = compactText(result?.prompt, 140);
  if (prompt) return `Generated ${kind}: ${prompt}`;
  if (result?.model) return `Generated ${kind} from ${result.model}`;
  return `Generated ${kind} result`;
}

export function mediaPreviewTag(type) {
  return type === "audio" ? "audio" : type === "video" ? "video" : "img";
}
