#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configSource,
  createConfigSource,
  updateConfigSource,
} from "./lib/config-updater.js";
import { createChangePlan, displayPath } from "./lib/change-plan.js";
import { applyChangePlan } from "./lib/file-writer.js";
import {
  collectAgentSelectors,
  collectConfigSelectors,
  chooseMigrations,
} from "./lib/migrations.js";
import {
  agentMarkdownFiles,
  collectMarkdownSelectors,
} from "./lib/markdown-agents.js";
import { loadModelCatalog } from "./lib/model-catalog.js";
import { configDirectory } from "./lib/paths.js";
import { readRegistry } from "./lib/registry.js";
import { mergeRegistries } from "./lib/registry-writer.js";
import {
  input as terminalInput,
  search as terminalSearch,
  select as terminalSelect,
} from "./lib/terminal-prompts.js";

const vimSelectTheme = { keybindings: ["vim"] };
const fallbackPrompts = {
  input: terminalInput,
  search: terminalSearch,
  select: terminalSelect,
};

async function loadPrompts() {
  try {
    return await import("@inquirer/prompts");
  } catch {
    return fallbackPrompts;
  }
}

function usage() {
  return `Usage: npx opencode-model-tiers init`;
}

async function chooseModel(tierName, modelIds, promptContext, prompts) {
  const options = modelIds.map((value) => ({ name: value, value }));
  options.push({ name: "Enter custom model ID", value: "__custom__" });
  const selected = await prompts.search({
    message: `Select model for ${tierName} tier:`,
    pageSize: 12,
    source: async (term = "") => [
      ...options.slice(0, -1).filter(({ name }) =>
        name.toLowerCase().includes(term.toLowerCase())),
      options.at(-1),
    ],
  }, promptContext);
  if (selected !== "__custom__") return selected;

  const custom = (await prompts.input({ message: "Model ID:" }, promptContext)).trim();
  if (!custom) throw new Error("Model ID cannot be empty.");
  return custom;
}

async function chooseVariant(tierName, modelId, catalog, promptContext, prompts) {
  const variants = catalog.variantsByModel.get(modelId) ?? [];
  const options = [
    { name: "Default (clear existing variant)", value: "__default__" },
    ...variants.map((value) => ({ name: value, value })),
    { name: "Enter custom variant", value: "__custom__" },
  ];
  const selected = await prompts.search({
    message: `Select variant for ${tierName} tier:`,
    default: "__default__",
    pageSize: 12,
    source: async (term = "") => [
      options[0],
      ...options.slice(1, -1).filter(({ name }) =>
        name.toLowerCase().includes(term.toLowerCase())),
      options.at(-1),
    ],
  }, promptContext);
  if (selected === "__default__") return undefined;
  if (selected !== "__custom__") return selected;

  const custom = (await prompts.input({ message: "Variant:" }, promptContext)).trim();
  if (!custom) throw new Error("Variant cannot be empty.");
  return custom;
}

async function collectTier(name, catalog, promptContext, prompts) {
  const model = await chooseModel(name, catalog.modelIds, promptContext, prompts);
  const variant = await chooseVariant(name, model, catalog, promptContext, prompts);
  return { [name]: { model, ...(variant ? { variant } : {}) } };
}

async function collectTiers(catalog, promptContext, prompts) {
  const tiers = {};

  while (true) {
    const name = (await prompts.input({
      message: "Tier name (blank to finish):",
      default: "",
    }, promptContext)).trim();
    if (!name) break;
    if (Object.hasOwn(tiers, name)) throw new Error(`Duplicate tier name: ${name}`);

    Object.assign(tiers, await collectTier(name, catalog, promptContext, prompts));
  }

  if (Object.keys(tiers).length === 0) throw new Error("At least one tier is required.");
  return tiers;
}

async function chooseTierMode(promptContext, output, prompts) {
  output.write("\nNow we need to choose model tiers.\n");
  output.write("Standard tiers are PLAN for planning and BUILD for implementation.\n\n");

  return prompts.select({
    message: "How do you want to configure model tiers?",
    theme: vimSelectTheme,
    choices: [
      {
        name: "Use standard PLAN and BUILD tiers",
        value: "standard",
        description: "Choose a model and variant for each standard tier.",
      },
      {
        name: "Create custom tiers",
        value: "custom",
        description: "Choose your own tier names and model mappings.",
      },
    ],
  }, promptContext);
}

async function chooseDestination(promptContext, prompts) {
  return prompts.select({
    message: "Where should the registry be created?",
    default: "project",
    theme: vimSelectTheme,
    choices: [
      { name: "Project (.opencode/model-tiers.json)", value: "project" },
      { name: "Global (OpenCode config directory)", value: "global" },
    ],
  }, promptContext);
}

async function chooseResetModels(existingRegistry, promptContext, prompts) {
  return prompts.select({
    message: "Reset selected model and variant when OpenCode starts?",
    default: existingRegistry.options.resetModelsOnStart ?? false,
    theme: vimSelectTheme,
    choices: [
      { name: "No", value: false },
      { name: "Yes", value: true },
    ],
  }, promptContext);
}

async function reviewChanges(summary, promptContext, output, prompts) {
  output.write(summary);
  return prompts.select({
    message: "What do you want to do?",
    theme: vimSelectTheme,
    choices: [
      { name: "Apply changes", value: "apply" },
      { name: "Start over", value: "restart" },
      { name: "Cancel", value: "cancel" },
    ],
  }, promptContext);
}

async function runInitOnce({
  cwd,
  env,
  input,
  output,
  prompts,
  loadCatalog = loadModelCatalog,
  applyPlan = applyChangePlan,
}) {
  const activePrompts = prompts ?? await loadPrompts();
  const promptContext = { input, output };
  const destination = await chooseDestination(promptContext, activePrompts);
  const baseDirectory = destination === "project"
    ? join(cwd, ".opencode")
    : configDirectory(env);
  const registryPath = join(baseDirectory, "model-tiers.json");
  const existingRegistry = readRegistry(registryPath);
  const resetModelsOnStart = await chooseResetModels(existingRegistry, promptContext, activePrompts);
  const tierMode = await chooseTierMode(promptContext, output, activePrompts);
  const catalog = loadCatalog();
  const newTiers = tierMode === "standard"
    ? {
      ...await collectTier("PLAN", catalog, promptContext, activePrompts),
      ...await collectTier("BUILD", catalog, promptContext, activePrompts),
    }
    : await collectTiers(catalog, promptContext, activePrompts);
  const registry = mergeRegistries(existingRegistry, newTiers, { resetModelsOnStart });

  const config = configSource(baseDirectory);
  const configSelectors = config.root
    ? collectConfigSelectors(config.source, config.root)
    : [];
  const standardAgentSelectors = collectAgentSelectors(config.root, tierMode === "standard");
  const markdownSelectors = collectMarkdownSelectors(agentMarkdownFiles(baseDirectory));
  const migrations = await chooseMigrations(
    [...configSelectors, ...standardAgentSelectors, ...markdownSelectors],
    registry.tiers,
    promptContext,
    vimSelectTheme,
    activePrompts,
  );

  const updatedConfig = config.source === null
    ? createConfigSource(migrations)
    : updateConfigSource(
      config.source,
      migrations
        .filter(({ filePath }) => !filePath),
    );
  const plan = createChangePlan({
    cwd,
    registryPath,
    existingRegistry,
    registry,
    config,
    updatedConfig,
    migrations,
  });

  const action = await reviewChanges(plan.summary, promptContext, output, activePrompts);
  if (action !== "apply") return action;

  const registryExisted = existsSync(registryPath);
  const configWasMissing = config.source === null;
  applyPlan(plan.files);
  output.write(`${registryExisted ? "Updated" : "Created"} ${displayPath(registryPath, cwd)}\n`);
  if (plan.files.some(({ path }) => path === config.path)) {
    output.write(`${configWasMissing ? "Created" : "Updated"} ${displayPath(config.path, cwd)}\n`);
  }
  for (const file of plan.files.filter(({ path }) => path !== registryPath && path !== config.path)) {
    output.write(`Updated ${displayPath(file.path, cwd)}\n`);
  }
  return true;
}

async function runInit({
  cwd = process.cwd(),
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  prompts,
  loadCatalog = loadModelCatalog,
  applyPlan = applyChangePlan,
} = {}) {
  const activePrompts = prompts ?? await loadPrompts();
  while (true) {
    const result = await runInitOnce({
      cwd,
      env,
      input,
      output,
      prompts: activePrompts,
      loadCatalog,
      applyPlan,
    });
    if (result !== "restart") return result;
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] !== "init") {
    console.error(usage());
    return 1;
  }

  try {
    await runInit();
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const invokedPath = process.argv[1] && (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedPath) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export { runInit };
