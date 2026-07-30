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
