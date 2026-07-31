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

export function parameterValueIsValid(field, value) {
  if (value === undefined || value === null || value === "") return !field.required;
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
      (!Number.isFinite(field.maxItems) || value.length <= field.maxItems)
    );
  }
  if (field.type === "object") {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  }
  for (const field of visibleFileFields.filter((item) => item.required)) {
    if (!(composer.sourceFields[field.name] ?? []).length) {
      issues.push(`add ${field.label || field.name}`);
    }
  }
  for (const field of selectedModel?.parameterFields ?? []) {
    const value = composer.parameters?.[field.name];
    if (field.required && (value === undefined || value === null || value === "")) {
      issues.push(`set ${field.label || field.name}`);
      continue;
    }
    if (value === undefined || value === null || value === "") continue;
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
  const kind = type === "video" ? "video" : "image";
  const prompt = compactText(result?.prompt, 140);
  if (prompt) return `Generated ${kind}: ${prompt}`;
  if (result?.model) return `Generated ${kind} from ${result.model}`;
  return `Generated ${kind} result`;
}
