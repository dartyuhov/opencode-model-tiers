import { relative } from "node:path";
import { serializeRegistry } from "./registry-writer.js";
import { updateMarkdownSources } from "./markdown-agents.js";

export function displayPath(filePath, cwd) {
  const displayed = relative(cwd, filePath);
  return displayed || ".";
}

export function groupMarkdownMigrations(migrations) {
  const markdownByFile = new Map();
  for (const migration of migrations.filter((entry) => entry.filePath)) {
    const entries = markdownByFile.get(migration.filePath) ?? {
      source: migration.source,
      migrations: [],
    };
    entries.migrations.push(migration);
    markdownByFile.set(migration.filePath, entries);
  }
  return markdownByFile;
}

export function changeSummary({ cwd, registryPath, existingRegistry, registry, config, updatedConfig, migrations, markdownByFile }) {
  const { existingTiers, tiers } = {
    existingTiers: existingRegistry.tiers,
    tiers: registry.tiers,
  };
  const lines = ["\nReview changes\n", `Registry: ${displayPath(registryPath, cwd)}`];
  const added = Object.keys(tiers).filter((name) => !Object.hasOwn(existingTiers, name));
  const updated = Object.keys(tiers).filter((name) =>
    Object.hasOwn(existingTiers, name) && JSON.stringify(existingTiers[name]) !== JSON.stringify(tiers[name]));

  if (added.length > 0) {
    lines.push("  Added tiers:");
    for (const name of added) lines.push(`    ${name} → ${tiers[name].model}`);
  }
  if (updated.length > 0) {
    lines.push("  Updated tiers:");
    for (const name of updated) lines.push(`    ${name} → ${tiers[name].model}`);
  }
  if (added.length === 0 && updated.length === 0) lines.push("  No tier changes");

  if (existingRegistry.options.resetModelsOnStart !== registry.options.resetModelsOnStart) {
    lines.push(`  Reset models on start: ${registry.options.resetModelsOnStart ? "enabled" : "disabled"}`);
  }

  lines.push("", `Configuration: ${displayPath(config.path, cwd)}`);
  if (config.source === null) lines.push("  Create OpenCode config with plugin entry");
  else if (updatedConfig !== config.source) lines.push("  Install plugin and apply selected model changes");
  else lines.push("  No configuration changes");

  const configMigrations = migrations.filter((migration) => !migration.filePath);
  if (configMigrations.length > 0) {
    lines.push("  Model assignments:");
    for (const migration of configMigrations) lines.push(`    ${migration.label} → tier:${migration.tier}`);
  }
  for (const [filePath, entries] of markdownByFile) {
    lines.push("", `Agent file: ${displayPath(filePath, cwd)}`);
    for (const migration of entries.migrations) lines.push(`  ${migration.current} → tier:${migration.tier}`);
  }

  return `${lines.join("\n")}\n`;
}

export function createChangePlan({
  cwd,
  registryPath,
  existingRegistry,
  registry,
  config,
  updatedConfig,
  migrations,
  markdownByFile = groupMarkdownMigrations(migrations),
}) {
  const files = [{ path: registryPath, content: serializeRegistry(registry) }];
  if (config.source === null || updatedConfig !== config.source) {
    files.push({ path: config.path, content: updatedConfig });
  }
  for (const [filePath, entries] of markdownByFile) {
    files.push({
      path: filePath,
      content: updateMarkdownSources(entries.source, entries.migrations),
    });
  }

  return {
    files,
    markdownByFile,
    summary: changeSummary({
      cwd,
      registryPath,
      existingRegistry,
      registry,
      config,
      updatedConfig,
      migrations,
      markdownByFile,
    }),
  };
}
