import { existsSync, readFileSync } from "node:fs";

function validateTiers(registry, registryPath) {
  const names = new Set();
  for (const [name, policy] of Object.entries(registry)) {
    const tierName = name.trim();
    if (!tierName) {
      throw new Error(`Registry tier name cannot be empty: ${registryPath}`);
    }
    if (names.has(tierName)) {
      throw new Error(`Duplicate tier name: ${name}: ${registryPath}`);
    }
    names.add(tierName);
    if (!policy || typeof policy !== "object" || typeof policy.model !== "string" || !policy.model.trim()) {
      throw new Error(`Registry tier ${name} must define a model: ${registryPath}`);
    }
    if (policy.model !== policy.model.trim()) {
      throw new Error(`Registry tier ${name} model cannot have surrounding whitespace: ${registryPath}`);
    }
    if (policy.variant !== undefined && typeof policy.variant !== "string") {
      throw new Error(`Registry tier ${name} variant must be a string: ${registryPath}`);
    }
    if (policy.variant !== undefined && !policy.variant.trim()) {
      throw new Error(`Registry tier ${name} variant cannot be empty: ${registryPath}`);
    }
    if (policy.variant !== undefined && policy.variant !== policy.variant.trim()) {
      throw new Error(`Registry tier ${name} variant cannot have surrounding whitespace: ${registryPath}`);
    }
  }

  return registry;
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function validateRegistry(registry, registryPath = "registry") {
  if (!isObject(registry)) {
    throw new Error(`Registry must contain a JSON object: ${registryPath}`);
  }

  const isEnvelope = Object.hasOwn(registry, "options") && Object.hasOwn(registry, "tiers");
  if (!isEnvelope) {
    return { options: {}, tiers: validateTiers(registry, registryPath) };
  }

  if (Object.hasOwn(registry, "options") && !isObject(registry.options)) {
    throw new Error(`Registry options must contain a JSON object: ${registryPath}`);
  }
  const options = registry.options ?? {};
  if (typeof options.resetModelsOnStart !== "undefined" &&
      typeof options.resetModelsOnStart !== "boolean") {
    throw new Error(`Registry option resetModelsOnStart must be a boolean: ${registryPath}`);
  }
  if (!isObject(registry.tiers)) {
    throw new Error(`Registry tiers must contain a JSON object: ${registryPath}`);
  }

  return {
    options,
    tiers: validateTiers(registry.tiers, registryPath),
  };
}

export function readRegistry(registryPath) {
  if (!existsSync(registryPath)) return { options: {}, tiers: {} };

  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    throw new Error(`Registry is not valid JSON: ${registryPath}`);
  }

  return validateRegistry(registry, registryPath);
}
