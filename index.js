import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDirectory, modelStatePath } from "./lib/paths.js";
import { readRegistry } from "./lib/registry.js";

function resetPersistedModels(env = process.env) {
  const statePath = modelStatePath(env);
  let tempPath;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      return "state must contain a JSON object";
    }

    tempPath = join(dirname(statePath), `.model-${process.pid}.json`);
    const nextState = { ...state, variant: {} };
    delete nextState.model;
    writeFileSync(tempPath, `${JSON.stringify(nextState)}\n`, { mode: 0o600 });
    renameSync(tempPath, statePath);
    return null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return error instanceof Error ? error.message : String(error);
  } finally {
    if (tempPath) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Temporary-file cleanup is best effort.
      }
    }
  }
}

function loadRegistry(env = process.env) {
  const localRegistryPath = join(process.cwd(), ".opencode", "model-tiers.json");
  const globalRegistryPath = join(configDirectory(env), "model-tiers.json");
  const registryPath = existsSync(localRegistryPath)
    ? localRegistryPath
    : globalRegistryPath;

  if (!existsSync(registryPath)) return null;

  const registry = readRegistry(registryPath);
  return {
    ...registry,
    tiers: new Map(
      Object.entries(registry.tiers).map(([name, policy]) => [name.trim(), policy]),
    ),
  };
}

function getTierName(value) {
  if (typeof value !== "string" || !/^tier:/i.test(value)) return null;
  return value.slice("tier:".length).trim();
}

function resolveTier(value, tiers) {
  const tierName = getTierName(value);
  if (tierName === null) return null;
  return { tierName, policy: tiers?.get(tierName) };
}

function resolveModel(config, field, tiers, invalidTiers) {
  const resolution = resolveTier(config[field], tiers);
  if (!resolution) return undefined;

  if (!resolution.policy) {
    delete config[field];
    invalidTiers.add(resolution.tierName);
    return undefined;
  }

  config[field] = resolution.policy.model;
  return resolution.policy;
}

function resolveAgents(config, tiers, invalidTiers) {
  for (const agent of Object.values(config.agent ?? {})) {
    if (!agent || agent.disable === true || agent.hidden === true) continue;

    const policy = resolveModel(agent, "model", tiers, invalidTiers);
    if (!policy) continue;

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

function showWarning(client, message) {
  setTimeout(() => {
    try {
      Promise.resolve(
        client?.tui?.showToast?.({ body: { message, variant: "warning" } }),
      ).catch(() => {
        // TUI notification is best effort.
      });
    } catch {
      // TUI notification is best effort.
    }
  }, 0);
}

export default async function ModelTiersPlugin({ client } = {}) {
  return {
    config(config) {
      const registry = loadRegistry();
      const tiers = registry?.tiers;
      const invalidTiers = new Set();
      resolveModel(config, "model", tiers, invalidTiers);
      resolveModel(config, "small_model", tiers, invalidTiers);
      resolveAgents(config, tiers, invalidTiers);
      showInvalidTierWarnings(client, invalidTiers);
      if (registry?.options.resetModelsOnStart === true) {
        const error = resetPersistedModels();
        if (error) showWarning(client, `Model Tier: could not reset persisted models (${error})`);
      }
    },
  };
}
