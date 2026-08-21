import { findProperty } from "./jsonc.js";
import { input as promptInput, select } from "./terminal-prompts.js";

export function collectConfigSelectors(source, root) {
  const selectors = [];
  const add = (label, question, property) => {
    if (property?.value?.type === "string" && property.value.value.trim()) {
      selectors.push({ label, question, current: property.value.value, node: property.value });
    }
  };

  add(
    "top-level model",
    "What do you want to assign as a default model?",
    findProperty(root, "model"),
  );
  add(
    "top-level small_model",
    "What do you want to assign as a small model?",
    findProperty(root, "small_model"),
  );

  const agents = findProperty(root, "agent")?.value;
  if (agents?.type === "object") {
    for (const agent of agents.properties) {
      const currentModel = findProperty(agent.value, "model")?.value?.value;
      add(
        `agent ${agent.key}`,
        `Agent "${agent.key}" uses "${currentModel}". What do you want to do?`,
        findProperty(agent.value, "model"),
      );
      const selector = selectors.at(-1);
      if (selector && currentModel && ["plan", "build"].includes(agent.key)) {
        selector.suggestedTier = agent.key.toUpperCase();
      }
    }
  }

  return selectors;
}

export function collectAgentSelectors(root, suggested = false) {
  const agents = findProperty(root, "agent")?.value;
  const selectors = [];

  for (const name of ["plan", "build"]) {
    const agent = agents?.type === "object" ? findProperty(agents, name) : undefined;
    const model = agent?.value?.type === "object" ? findProperty(agent.value, "model") : undefined;
    if (model?.value?.type === "string" && model.value.value.trim()) continue;

    selectors.push({
      configAgentName: name,
      label: `agent "${name}"`,
      question: `Agent "${name}" has no model configured. What do you want to do?`,
      current: "not configured",
      ...(suggested ? { suggestedTier: name.toUpperCase() } : {}),
    });
  }

  return selectors;
}

export function migrationChoices(selector, tiers) {
  const tierChoices = Object.keys(tiers).map((value) => ({
    name: `Use tier:${value}${value === selector.suggestedTier ? " (recommended)" : ""}`,
    value,
  }));
  const keepCurrent = {
    name: selector.current === "not configured"
      ? "Keep as is (OpenCode Default)"
      : `Keep as is (${selector.current})`,
    value: undefined,
  };
  const choices = selector.suggestedTier
    ? [
      ...tierChoices.filter(({ value }) => value === selector.suggestedTier),
      ...tierChoices.filter(({ value }) => value !== selector.suggestedTier),
      keepCurrent,
    ]
    : [keepCurrent, ...tierChoices];
  if (selector.current !== "not configured") {
    choices.push({
      name: "Create new tier",
      value: "__create_from_current__",
    });
  }
  return choices;
}

export async function chooseMigrations(
  selectors,
  tiers,
  promptContext,
  theme,
  prompts = { input: promptInput, select },
) {
  const migrations = [];

  for (const selector of selectors) {
    const selected = await prompts.select({
      message: selector.question ?? `What model do you want ${selector.label} to use?`,
      theme,
      choices: migrationChoices(selector, tiers),
    }, promptContext);
    if (selected === "__create_from_current__") {
      const tierName = (await prompts.input({
        message: `New tier name for ${selector.current}:`,
      }, promptContext)).trim();
      if (!tierName) throw new Error("Tier name cannot be empty.");
      if (Object.hasOwn(tiers, tierName)) throw new Error(`Duplicate tier name: ${tierName}`);
      tiers[tierName] = { model: selector.current };
      migrations.push({ ...selector, tier: tierName });
    } else if (selected) {
      migrations.push({ ...selector, tier: selected });
    }
  }

  return migrations;
}
