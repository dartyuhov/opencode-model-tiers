import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { applyEdits } from "./jsonc.js";

export function parseFrontmatter(source) {
  const opening = source.match(/^---\s*\r?\n/);
  if (!opening) return null;

  const closing = source.slice(opening[0].length).match(/^---[ \t]*(?:\r?\n|$)/m);
  if (!closing) return null;

  const bodyStart = opening[0].length;
  const bodyEnd = bodyStart + closing.index;
  const body = source.slice(bodyStart, bodyEnd);
  const model = /^(\s*model\s*:\s*)([^\r\n#]*?)(\s*(?:#.*)?)(\r?$)/m.exec(body);
  if (!model) return { bodyStart, bodyEnd, model: null };

  return {
    bodyStart,
    bodyEnd,
    model: {
      start: bodyStart + model.index + model[1].length,
      end: bodyStart + model.index + model[1].length + model[2].length,
      value: model[2].trim().replace(/^['"]|['"]$/g, ""),
    },
  };
}

export function agentMarkdownFiles(baseDirectory) {
  const directory = join(baseDirectory, "agents");
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === ".md")
    .map((entry) => join(directory, entry.name))
    .sort();
}

export function collectMarkdownSelectors(files) {
  const selectors = [];
  for (const filePath of files) {
    const source = readFileSync(filePath, "utf8");
    const frontmatter = parseFrontmatter(source);
    if (!frontmatter?.model?.value) continue;
    const agentName = basename(filePath, ".md");
    selectors.push({
      filePath,
      source,
      label: `agent "${agentName}"`,
      question: `Agent "${agentName}" uses "${frontmatter.model.value}". What do you want to do?`,
      current: frontmatter.model.value,
      node: frontmatter.model,
    });
  }
  return selectors;
}

export function updateMarkdownSource(source, start, end, tier) {
  return replaceMarkdownModels(source, [{ start, end, tier }]);
}

export function updateMarkdownSources(source, migrations) {
  return replaceMarkdownModels(source, migrations.map(({ node, tier }) => ({
    start: node.start,
    end: node.end,
    tier,
  })));
}

function replaceMarkdownModels(source, replacements) {
  return applyEdits(source, replacements.map(({ start, end, tier }) => ({
    start,
    end,
    text: `tier:${tier}`,
  })));
}
