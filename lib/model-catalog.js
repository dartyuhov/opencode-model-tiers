import { execFileSync } from "node:child_process";

export function parseModelList(output) {
  return [...new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(isModelId),
  )].sort((left, right) => left.localeCompare(right));
}

function isModelId(value) {
  return typeof value === "string" && /^[^\s/]+\/\S+$/.test(value);
}

function findJsonEnd(source, start) {
  let depth = 0;
  let quote = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quote = false;
      }
      continue;
    }

    if (character === '"') {
      quote = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }

  return -1;
}

export function parseVerboseModels(output) {
  const models = new Map();
  const lines = [];
  let lineStart = 0;
  while (lineStart <= output.length) {
    const lineEnd = output.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? output.length : lineEnd;
    lines.push({
      text: output.slice(lineStart, end).replace(/\r$/, ""),
      start: lineStart,
    });
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const modelId = lines[index].text.trim();
    if (!isModelId(modelId)) continue;

    let jsonLine = index + 1;
    while (jsonLine < lines.length && !lines[jsonLine].text.trim().startsWith("{")) {
      jsonLine += 1;
    }
    if (jsonLine >= lines.length) continue;

    const jsonStart = output.indexOf("{", lines[jsonLine].start);
    const jsonEnd = findJsonEnd(output, jsonStart);
    if (jsonEnd === -1) continue;

    try {
      models.set(modelId, JSON.parse(output.slice(jsonStart, jsonEnd)));
    } catch {
      // Ignore malformed verbose records and keep the model in the plain list.
    }
  }

  return models;
}

export function runOpenCode(args) {
  try {
    return execFileSync("opencode", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export function loadModelCatalog(run = runOpenCode) {
  const modelOutput = run(["models"]);
  const verboseOutput = run(["models", "--verbose"]);
  const verboseModels = verboseOutput === null ? new Map() : parseVerboseModels(verboseOutput);

  return {
    modelIds: modelOutput === null ? [] : parseModelList(modelOutput),
    variantsByModel: new Map(
      [...verboseModels].map(([id, model]) => [
        id,
        model?.variants && typeof model.variants === "object"
          ? Object.entries(model.variants)
            .filter(([, variant]) => !variant || variant.disabled !== true)
            .map(([name]) => name)
            .sort((left, right) => left.localeCompare(right))
          : [],
      ]),
    ),
  };
}
