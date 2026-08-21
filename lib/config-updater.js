import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyEdits,
  findProperty,
  insertArrayItem,
  insertObjectProperties,
  insertObjectProperty,
  parseJsonc,
} from "./jsonc.js";

export const pluginName = "opencode-model-tiers";

export function configPath(baseDirectory) {
  const jsonc = join(baseDirectory, "opencode.jsonc");
  if (existsSync(jsonc)) return jsonc;

  const json = join(baseDirectory, "opencode.json");
  if (existsSync(json)) return json;

  return json;
}

export function configSource(baseDirectory) {
  const path = configPath(baseDirectory);
  if (!existsSync(path)) return { path, source: null, root: null };

  const source = readFileSync(path, "utf8");
  const root = parseJsonc(source);
  validateConfigRoot(root);
  return { path, source, root };
}

function validateConfigRoot(root) {
  if (root.type !== "object") throw new Error("OpenCode config must contain an object.");

  const agents = findProperty(root, "agent")?.value;
  if (!agents) return;
  if (agents.type !== "object") throw new Error("OpenCode config agent must be an object.");
  for (const agent of agents.properties) {
    if (agent.value.type !== "object") {
      throw new Error(`OpenCode config agent ${agent.key} must be an object.`);
    }
  }
}

function addStandardAgentEdits(source, root, migrations, edits) {
  const additions = migrations.filter((migration) => migration.configAgentName);
  if (additions.length === 0) return;

  const agentProperty = findProperty(root, "agent");
  if (!agentProperty) {
    const insertion = insertObjectProperties(
      source,
      root,
      [{
        key: "agent",
        value: JSON.stringify(Object.fromEntries(additions.map(({ configAgentName, tier }) => [
          configAgentName,
          { model: `tier:${tier}` },
        ]))),
      }],
    );
    edits.push({ start: insertion.position, end: insertion.position, text: insertion.text });
    return;
  }

  if (agentProperty.value.type !== "object") {
    throw new Error("OpenCode config agent must be an object.");
  }

  const missingAgents = [];
  for (const migration of additions) {
    const agent = findProperty(agentProperty.value, migration.configAgentName);
    if (!agent) {
      missingAgents.push({
        key: migration.configAgentName,
        value: JSON.stringify({ model: `tier:${migration.tier}` }),
      });
      continue;
    }

    if (agent.value.type !== "object") {
      throw new Error(`OpenCode config agent ${migration.configAgentName} must be an object.`);
    }

    const model = findProperty(agent.value, "model");
    if (model?.value?.type === "string") {
      edits.push({
        start: model.value.start,
        end: model.value.end,
        text: JSON.stringify(`tier:${migration.tier}`),
      });
    } else {
      const insertion = insertObjectProperties(source, agent.value, [{
        key: "model",
        value: JSON.stringify(`tier:${migration.tier}`),
      }]);
      edits.push({ start: insertion.position, end: insertion.position, text: insertion.text });
    }
  }

  if (missingAgents.length > 0) {
    const insertion = insertObjectProperties(source, agentProperty.value, missingAgents);
    edits.push({ start: insertion.position, end: insertion.position, text: insertion.text });
  }
}

export function createConfigSource(migrations) {
  const agents = Object.fromEntries(
    migrations
      .filter(({ configAgentName }) => configAgentName)
      .map(({ configAgentName, tier }) => [configAgentName, { model: `tier:${tier}` }]),
  );
  return `${JSON.stringify({
    plugin: [pluginName],
    ...(Object.keys(agents).length > 0 ? { agent: agents } : {}),
  }, null, 2)}\n`;
}

export function updateConfigSource(source, migrations = []) {
  const root = parseJsonc(source);
  validateConfigRoot(root);

  const edits = migrations.filter(({ node }) => node).map(({ node, tier }) => ({
    start: node.start,
    end: node.end,
    text: JSON.stringify(`tier:${tier}`),
  }));
  const standardMigrations = migrations.filter(({ configAgentName }) => configAgentName);
  const plugin = findProperty(root, "plugin");
  const canCombineEmptyRoot = root.properties.length === 0 && !plugin && standardMigrations.length > 0;

  if (canCombineEmptyRoot) {
    const insertion = insertObjectProperties(source, root, [
      {
        key: "agent",
        value: JSON.stringify(Object.fromEntries(standardMigrations.map(({ configAgentName, tier }) => [
          configAgentName,
          { model: `tier:${tier}` },
        ]))),
      },
      { key: "plugin", value: JSON.stringify([pluginName]) },
    ]);
    edits.push({ start: insertion.position, end: insertion.position, text: insertion.text });
  } else {
    addStandardAgentEdits(source, root, migrations, edits);
  }

  if (plugin) {
    if (plugin.value.type !== "array") {
      throw new Error("OpenCode config plugin must be an array.");
    }
    if (plugin.value.items.some((item) => item.type !== "string")) {
      throw new Error("OpenCode config plugin entries must be strings.");
    }
    if (!plugin.value.items.some((item) =>
      item.value === pluginName || item.value.startsWith(`${pluginName}@`))) {
      const insertion = insertArrayItem(source, plugin.value, pluginName);
      edits.push({ start: insertion.position, end: insertion.position, text: insertion.text });
    }
  } else if (!canCombineEmptyRoot) {
    const insertion = insertObjectProperty(source, root, "plugin", JSON.stringify([pluginName]));
    edits.push({ start: insertion.position, end: insertion.position, text: insertion.text });
  }

  return applyEdits(source, edits);
}
