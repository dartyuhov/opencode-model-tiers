import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

const configDirectory = join(
  process.env.XDG_CONFIG_HOME ?? join(process.env.HOME, ".config"),
  "opencode",
);
const globalRegistryPath = join(configDirectory, "model-tiers.json");
const modelStatePath = join(
  process.env.XDG_STATE_HOME ?? join(process.env.HOME, ".local", "state"),
  "opencode",
  "model.json",
);

function resetPersistedVariants() {
  try {
    const state = JSON.parse(readFileSync(modelStatePath, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) return;

    const tempPath = join(dirname(modelStatePath), `.model-${process.pid}.json`);
    writeFileSync(tempPath, `${JSON.stringify({ ...state, variant: {} })}\n`, { mode: 0o600 });
    renameSync(tempPath, modelStatePath);
  } catch {
    // State reset is best effort; model-tier resolution must still work.
  }
}

function loadTiers() {
  const localRegistryPath = join(process.cwd(), ".opencode", "model-tiers.json");
  const registryPath = existsSync(localRegistryPath)
    ? localRegistryPath
    : globalRegistryPath;
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new Error("[model-tiers] Registry must contain a JSON object.");
  }

  const tiers = new Map();
  for (const [name, policy] of Object.entries(registry)) {
    const normalizedName = name.trim().toLowerCase();
    if (!normalizedName) {
      throw new Error("[model-tiers] Tier names cannot be empty.");
    }
    if (tiers.has(normalizedName)) {
      throw new Error(`[model-tiers] Duplicate tier name: ${name}`);
    }
    if (!policy || typeof policy !== "object" || typeof policy.model !== "string") {
      throw new Error(`[model-tiers] Tier ${name} must define a model.`);
    }
    if (policy.variant !== undefined && typeof policy.variant !== "string") {
      throw new Error(`[model-tiers] Tier ${name} variant must be a string.`);
    }

    tiers.set(normalizedName, policy);
  }

  return tiers;
}

function resolveAgents(config, tiers) {
  for (const [agentName, agent] of Object.entries(config.agent ?? {})) {
    if (!agent || agent.disable === true || agent.hidden === true) continue;

    const declaredTier = agent.options?.model_tier ?? agent.model_tier;
    if (typeof declaredTier !== "string" || !declaredTier.trim()) continue;

    const policy = tiers.get(declaredTier.trim().toLowerCase());
    if (!policy) {
      throw new Error(
        `[model-tiers] Agent ${agentName} references unknown tier ${declaredTier}. ` +
          `Available tiers: ${[...tiers.keys()].join(", ")}`,
      );
    }

    agent.model = policy.model;
    if (policy.variant === undefined) {
      delete agent.variant;
    } else {
      agent.variant = policy.variant;
    }

    if (agent.options) delete agent.options.model_tier;
    delete agent.model_tier;
  }
}

function resolveTopLevelModel(config, field, tiers) {
  const value = config[field];
  if (typeof value !== "string" || !value.startsWith("tier:")) return;

  const declaredTier = value.slice("tier:".length).trim();
  const policy = tiers.get(declaredTier.toLowerCase());
  if (!policy) {
    throw new Error(
      `[model-tiers] ${field} references unknown tier ${declaredTier}. ` +
        `Available tiers: ${[...tiers.keys()].join(", ")}`,
    );
  }

  config[field] = policy.model;
}

export default async function ModelTiersPlugin() {
  return {
    config(config) {
      const tiers = loadTiers();
      resolveTopLevelModel(config, "model", tiers);
      resolveTopLevelModel(config, "small_model", tiers);
      resolveAgents(config, tiers);
      resetPersistedVariants();
    },
  };
}
