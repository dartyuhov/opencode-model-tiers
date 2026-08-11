import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const configDirectory = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "opencode",
);
const globalRegistryPath = join(configDirectory, "model-tiers.json");
const modelStatePath = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
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

  if (!existsSync(registryPath)) return null;

  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new Error("[model-tiers] Registry must contain a JSON object.");
  }

  const tiers = new Map();
  for (const [name, policy] of Object.entries(registry)) {
    const tierName = name.trim();
    if (!tierName) {
      throw new Error("[model-tiers] Tier names cannot be empty.");
    }
    if (tiers.has(tierName)) {
      throw new Error(`[model-tiers] Duplicate tier name: ${name}`);
    }
    if (!policy || typeof policy !== "object" || typeof policy.model !== "string") {
      throw new Error(`[model-tiers] Tier ${name} must define a model.`);
    }
    if (policy.variant !== undefined && typeof policy.variant !== "string") {
      throw new Error(`[model-tiers] Tier ${name} variant must be a string.`);
    }

    tiers.set(tierName, policy);
  }

  return tiers;
}

function getTierName(value) {
  if (typeof value !== "string" || !/^tier:/i.test(value)) return null;
  return value.slice("tier:".length).trim();
}

function resolveModel(config, field, tiers, invalidTiers) {
  const tierName = getTierName(config[field]);
  if (tierName === null) return;

  const policy = tiers?.get(tierName);
  if (!policy) {
    delete config[field];
    invalidTiers.push(tierName);
    return;
  }

  config[field] = policy.model;
}

function resolveAgents(config, tiers, invalidTiers) {
  for (const agent of Object.values(config.agent ?? {})) {
    if (!agent || agent.disable === true || agent.hidden === true) continue;

    const tierName = getTierName(agent.model);
    if (tierName === null) continue;

    const policy = tiers?.get(tierName);
    if (!policy) {
      delete agent.model;
      invalidTiers.push(tierName);
      continue;
    }

    agent.model = policy.model;
    if (policy.variant === undefined) {
      delete agent.variant;
    } else {
      agent.variant = policy.variant;
    }
  }
}

function showInvalidTierWarnings(client, invalidTiers) {
  for (const tierName of invalidTiers) {
    setTimeout(() => {
      try {
        Promise.resolve(
          client?.tui?.showToast?.({
            body: {
              message: `Model Tier: ${tierName} does not exist`,
              variant: "warning",
            },
          }),
        ).catch(() => {
          // TUI notification is best effort; invalid values were already removed.
        });
      } catch {
        // TUI notification is best effort; invalid values were already removed.
      }
    }, 0);
  }
}

export default async function ModelTiersPlugin({ client } = {}) {
  return {
    config(config) {
      const tiers = loadTiers();
      const invalidTiers = [];
      resolveModel(config, "model", tiers, invalidTiers);
      resolveModel(config, "small_model", tiers, invalidTiers);
      resolveAgents(config, tiers, invalidTiers);
      showInvalidTierWarnings(client, invalidTiers);
      resetPersistedVariants();
    },
  };
}
