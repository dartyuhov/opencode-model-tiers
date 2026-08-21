import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import rootPlugin from "opencode-model-tiers";
import serverPlugin from "opencode-model-tiers/server";
import { createChangePlan } from "../lib/change-plan.js";
import { changeSummary } from "../lib/change-plan.js";
import { configPath, configSource, updateConfigSource } from "../lib/config-updater.js";
import { applyChangePlan } from "../lib/file-writer.js";
import { parseJsonc } from "../lib/jsonc.js";
import {
  collectAgentSelectors,
  collectConfigSelectors,
  migrationChoices,
} from "../lib/migrations.js";
import {
  agentMarkdownFiles,
  collectMarkdownSelectors,
  parseFrontmatter,
  updateMarkdownSource,
} from "../lib/markdown-agents.js";
import {
  loadModelCatalog,
  parseModelList,
  parseVerboseModels,
} from "../lib/model-catalog.js";
import { readRegistry } from "../lib/registry.js";
import { mergeRegistries } from "../lib/registry-writer.js";
import { runInit } from "../cli.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function createFixture() {
  const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "opencode-model-tiers-"));
  const fixture = {
    root,
    project: join(root, "project"),
    configHome: join(root, "config"),
    stateHome: join(root, "state"),
    home: join(root, "home"),
  };

  await Promise.all([
    mkdir(join(fixture.project, ".opencode"), { recursive: true }),
    mkdir(join(fixture.configHome, "opencode"), { recursive: true }),
    mkdir(join(fixture.stateHome, "opencode"), { recursive: true }),
    mkdir(fixture.home, { recursive: true }),
  ]);

  return fixture;
}

async function runPlugin({ fixture, config, globalRegistry, projectRegistry, state }) {
  if (globalRegistry !== undefined) {
    await writeFile(
      join(fixture.configHome, "opencode", "model-tiers.json"),
      `${JSON.stringify(globalRegistry)}\n`,
    );
  }
  if (projectRegistry !== undefined) {
    await writeFile(
      join(fixture.project, ".opencode", "model-tiers.json"),
      `${JSON.stringify(projectRegistry)}\n`,
    );
  }
  if (state !== undefined) {
    await writeFile(
      join(fixture.stateHome, "opencode", "model.json"),
      `${JSON.stringify(state)}\n`,
    );
  }

  const script = `
    import plugin from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "index.js")).href)};

    const config = ${JSON.stringify(config)};
    const toasts = [];
    const hooks = await plugin({
      client: {
        tui: {
          showToast(input) {
            toasts.push(input);
          },
        },
      },
    });
    hooks.config(config);
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.stdout.write(JSON.stringify({ config, toasts }));
  `;

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: fixture.project,
      env: {
        ...process.env,
        HOME: fixture.home,
        XDG_CONFIG_HOME: fixture.configHome,
        XDG_STATE_HOME: fixture.stateHome,
      },
    },
  );

  return JSON.parse(stdout);
}

async function readState(fixture) {
  return JSON.parse(await readFile(join(fixture.stateHome, "opencode", "model.json"), "utf8"));
}

async function runCli(args, cwd, env = {}) {
  try {
    const result = await execFileAsync(process.execPath, [join(repositoryRoot, "cli.js"), ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
    return { code: 0, ...result };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
    };
  }
}

function scriptedPrompts({ selects = {}, searches = {}, inputs = {} } = {}) {
  const calls = [];
  const next = (answers, message) => {
    const answer = answers[message];
    if (Array.isArray(answer)) {
      if (answer.length === 0) throw new Error(`No scripted answer for ${message}`);
      return answer.shift();
    }
    if (!Object.hasOwn(answers, message)) throw new Error(`No scripted answer for ${message}`);
    return answer;
  };
  return {
    calls,
    input: async ({ message }) => {
      calls.push(["input", message]);
      return next(inputs, message);
    },
    search: async ({ message, source }) => {
      calls.push(["search", message]);
      const answer = next(searches, message);
      const options = await source("");
      assert.ok(options.some(({ value }) => value === answer), `Missing search option ${answer}`);
      return answer;
    },
    select: async ({ message, choices }) => {
      calls.push(["select", message]);
      if (message === "Reset selected model and variant when OpenCode starts?" &&
          !Object.hasOwn(selects, message)) {
        return choices.find(({ value }) => value === false).value;
      }
      const answer = next(selects, message);
      assert.ok(choices.some(({ value }) => value === answer), `Missing select option ${answer}`);
      return answer;
    },
  };
}

function fakeCatalog() {
  return {
    modelIds: ["provider/build", "provider/plan", "provider/review"],
    variantsByModel: new Map([
      ["provider/build", ["fast"]],
      ["provider/plan", ["high"]],
      ["provider/review", []],
    ]),
  };
}

function silentOutput() {
  return { write() {} };
}

test("exports the plugin from the package root and server subpath", () => {
  assert.equal(typeof rootPlugin, "function");
  assert.equal(typeof serverPlugin, "function");
});

test("publishes plugin and initializer entry points", async () => {
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));

  assert.equal(packageJson.bin["opencode-model-tiers"], "./cli.js");
  assert.equal(packageJson.dependencies, undefined);
  assert.deepEqual(packageJson.files, [
    "index.js",
    "cli.js",
    "lib",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
  ]);
  assert.deepEqual(parseModelList("provider/z\nprovider/a\nprovider/a\n"), [
    "provider/a",
    "provider/z",
  ]);
});

test("reports usage and nonzero status for unsupported CLI commands", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const result = await runCli(["update"], fixture.project, {
    HOME: fixture.home,
    XDG_CONFIG_HOME: fixture.configHome,
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Usage: npx opencode-model-tiers init/);
});

test("reports usage for unsupported CLI options and missing commands", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  for (const args of [[], ["init", "--help"]]) {
    const result = await runCli(args, fixture.project, {
      HOME: fixture.home,
      XDG_CONFIG_HOME: fixture.configHome,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage: npx opencode-model-tiers init/);
  }
});

test("loads model and variant catalogs once", () => {
  const calls = [];
  const catalog = loadModelCatalog((args) => {
    calls.push(args);
    return args[1] === "--verbose"
      ? 'provider/model\n{"variants":{"high":{},"disabled":{"disabled":true}}}'
      : "provider/model\n";
  });

  assert.deepEqual(calls, [["models"], ["models", "--verbose"]]);
  assert.deepEqual(catalog.modelIds, ["provider/model"]);
  assert.deepEqual(catalog.variantsByModel.get("provider/model"), ["high"]);
});

test("keeps custom model entry available when model commands fail", () => {
  const calls = [];
  const catalog = loadModelCatalog((args) => {
    calls.push(args);
    return null;
  });

  assert.deepEqual(calls, [["models"], ["models", "--verbose"]]);
  assert.deepEqual(catalog.modelIds, []);
  assert.deepEqual([...catalog.variantsByModel], []);
});

test("merges new tiers over existing same-name tiers", () => {
  assert.deepEqual(
    mergeRegistries(
      {
        options: {},
        tiers: {
          PLAN: { model: "provider/old" },
          LIGHT: { model: "provider/light" },
        },
      },
      {
        PLAN: { model: "provider/new", variant: "high" },
        BUILD: { model: "provider/build" },
      },
    ),
    {
      options: {},
      tiers: {
        PLAN: { model: "provider/new", variant: "high" },
        LIGHT: { model: "provider/light" },
        BUILD: { model: "provider/build" },
      },
    },
  );
});

test("preserves unrelated tiers during complete standard init", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(
    join(fixture.project, ".opencode", "model-tiers.json"),
    JSON.stringify({ PLAN: { model: "provider/old" }, LIGHT: { model: "provider/light" } }),
  );
  const prompts = scriptedPrompts({
    selects: {
      "Where should the registry be created?": "project",
      "How do you want to configure model tiers?": "standard",
      'Agent "plan" has no model configured. What do you want to do?': undefined,
      'Agent "build" has no model configured. What do you want to do?': undefined,
      "What do you want to do?": "apply",
    },
    searches: {
      "Select model for PLAN tier:": "provider/plan",
      "Select variant for PLAN tier:": "high",
      "Select model for BUILD tier:": "provider/build",
      "Select variant for BUILD tier:": "__default__",
    },
  });
  await runInit({
    cwd: fixture.project,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome },
    input: {},
    output: silentOutput(),
    prompts,
    loadCatalog: fakeCatalog,
  });
  assert.deepEqual(JSON.parse(await readFile(join(fixture.project, ".opencode", "model-tiers.json"))), {
    options: { resetModelsOnStart: false },
    tiers: {
      PLAN: { model: "provider/plan", variant: "high" },
      LIGHT: { model: "provider/light" },
      BUILD: { model: "provider/build" },
    },
  });
});

test("rejects malformed and empty registry policies", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const registryPath = join(fixture.project, ".opencode", "model-tiers.json");

  await writeFile(registryPath, '{" ": {"model": "provider/model"}}');
  assert.throws(() => readRegistry(registryPath), /tier name cannot be empty/);
  await writeFile(registryPath, '{"PLAN": {"model": "   "}}');
  assert.throws(() => readRegistry(registryPath), /must define a model/);
  await writeFile(registryPath, '{"PLAN": {"model": "provider/model", "variant": 1}}');
  assert.throws(() => readRegistry(registryPath), /variant must be a string/);
  await writeFile(registryPath, '{"PLAN": {"model": " provider/model"}}');
  assert.throws(() => readRegistry(registryPath), /model cannot have surrounding whitespace/);
  await writeFile(registryPath, '{"PLAN": {"model": "provider/model", "variant": " "}}');
  assert.throws(() => readRegistry(registryPath), /variant cannot be empty/);
});

test("reads flat and envelope registries with reset options", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const registryPath = join(fixture.project, ".opencode", "model-tiers.json");

  await writeFile(registryPath, JSON.stringify({ PLAN: { model: "provider/plan" } }));
  assert.deepEqual(readRegistry(registryPath), {
    options: {},
    tiers: { PLAN: { model: "provider/plan" } },
  });

  await writeFile(registryPath, JSON.stringify({
    options: { resetModelsOnStart: true, futureOption: "keep" },
    tiers: { PLAN: { model: "provider/plan" } },
  }));
  assert.deepEqual(readRegistry(registryPath), {
    options: { resetModelsOnStart: true, futureOption: "keep" },
    tiers: { PLAN: { model: "provider/plan" } },
  });
});

test("rejects malformed envelope options and tiers", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const registryPath = join(fixture.project, ".opencode", "model-tiers.json");

  await writeFile(registryPath, JSON.stringify({ options: { resetModelsOnStart: "yes" }, tiers: {} }));
  assert.throws(() => readRegistry(registryPath), /resetModelsOnStart must be a boolean/);
  await writeFile(registryPath, JSON.stringify({ options: [], tiers: {} }));
  assert.throws(() => readRegistry(registryPath), /options must contain a JSON object/);
  await writeFile(registryPath, JSON.stringify({ options: {}, tiers: [] }));
  assert.throws(() => readRegistry(registryPath), /tiers must contain a JSON object/);
});

test("offers creating a tier from configured current models", () => {
  const choices = migrationChoices(
    { current: "provider/current" },
    { PLAN: { model: "provider/plan" } },
  );

  assert.deepEqual(choices.map(({ name }) => name), [
    "Keep as is (provider/current)",
    "Use tier:PLAN",
    "Create new tier",
  ]);
  assert.deepEqual(
    migrationChoices({ current: "not configured" }, {}).map(({ name }) => name),
    ["Keep as is (OpenCode Default)"],
  );

  assert.deepEqual(
    migrationChoices({ current: "not configured", suggestedTier: "PLAN" }, {
      PLAN: { model: "provider/plan" },
      BUILD: { model: "provider/build" },
    }).map(({ name }) => name),
    [
      "Use tier:PLAN (recommended)",
      "Use tier:BUILD",
      "Keep as is (OpenCode Default)",
    ],
  );
});

test("asks about missing plan and build agents without custom-mode recommendations", () => {
  const root = parseJsonc("{}");
  const selectors = collectAgentSelectors(root);

  assert.deepEqual(selectors.map(({ configAgentName, suggestedTier }) => ({
    configAgentName,
    suggestedTier,
  })), [
    { configAgentName: "plan", suggestedTier: undefined },
    { configAgentName: "build", suggestedTier: undefined },
  ]);
});

test("recommends matching tiers for configured plan and build agents", () => {
  const root = parseJsonc(`{
    "agent": {
      "plan": { "model": "provider/plan" },
      "build": { "model": "provider/build" },
      "jira": { "model": "provider/review" }
    }
  }`);
  const selectors = collectConfigSelectors("", root);

  assert.deepEqual(selectors.map(({ label, suggestedTier }) => ({ label, suggestedTier })), [
    { label: "agent plan", suggestedTier: "PLAN" },
    { label: "agent build", suggestedTier: "BUILD" },
    { label: "agent jira", suggestedTier: undefined },
  ]);
  assert.deepEqual(
    migrationChoices(selectors[0], {
      PLAN: { model: "provider/plan" },
      BUILD: { model: "provider/build" },
      DEFAULT: { model: "provider/default" },
    }).map(({ name }) => name),
    [
      "Use tier:PLAN (recommended)",
      "Use tier:BUILD",
      "Use tier:DEFAULT",
      "Keep as is (provider/plan)",
      "Create new tier",
    ],
  );
});

test("skips empty configured selectors and configured built-in agents", () => {
  const root = parseJsonc(`{
    "model": "",
    "small_model": "provider/small",
    "agent": {
      "plan": { "model": "provider/plan" },
      "build": {}
    }
  }`);

  assert.deepEqual(collectConfigSelectors("", root).map(({ label }) => label), [
    "top-level small_model",
    "agent plan",
  ]);
  assert.deepEqual(collectAgentSelectors(root).map(({ configAgentName }) => configAgentName), ["build"]);
});

test("puts matching standard tiers first for missing built-in agents", () => {
  const root = parseJsonc("{}");
  const selectors = collectAgentSelectors(root, true);

  assert.deepEqual(
    selectors.map(({ configAgentName, suggestedTier }) => ({ configAgentName, suggestedTier })),
    [
      { configAgentName: "plan", suggestedTier: "PLAN" },
      { configAgentName: "build", suggestedTier: "BUILD" },
    ],
  );
  assert.equal(migrationChoices(selectors[0], {
    PLAN: { model: "provider/plan" },
    BUILD: { model: "provider/build" },
  })[0].value, "PLAN");
});

test("renders review summary before writes", () => {
  const summary = changeSummary({
    cwd: "/project",
    registryPath: "/project/.opencode/model-tiers.json",
      existingRegistry: { options: {}, tiers: { OLD: { model: "provider/old" } } },
      registry: {
        options: {},
        tiers: {
          OLD: { model: "provider/new" },
          PLAN: { model: "provider/plan" },
        },
    },
    config: { path: "/project/.opencode/opencode.json", source: "{}" },
    updatedConfig: '{"plugin":["opencode-model-tiers"]}',
    migrations: [{ label: 'agent "plan"', tier: "PLAN" }],
    markdownByFile: new Map(),
  });

  assert.match(summary, /Review changes/);
  assert.match(summary, /Added tiers:/);
  assert.match(summary, /Updated tiers:/);
  assert.match(summary, /agent "plan" → tier:PLAN/);
});

test("builds and applies one shared plan for registry and config outputs", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const registryPath = join(fixture.project, ".opencode", "model-tiers.json");
  const configPath = join(fixture.project, ".opencode", "opencode.json");
  const plan = createChangePlan({
    cwd: fixture.project,
    registryPath,
    existingRegistry: { options: {}, tiers: {} },
    registry: { options: {}, tiers: { PLAN: { model: "provider/plan" } } },
    config: { path: configPath, source: null },
    updatedConfig: '{"plugin":["opencode-model-tiers"]}\n',
    migrations: [],
  });

  assert.deepEqual(plan.files.map(({ path }) => path), [registryPath, configPath]);
  applyChangePlan(plan.files);

   assert.equal(await readFile(registryPath, "utf8"), '{\n  "options": {},\n  "tiers": {\n    "PLAN": {\n      "model": "provider/plan"\n    }\n  }\n}\n');
  assert.equal(await readFile(configPath, "utf8"), '{"plugin":["opencode-model-tiers"]}\n');
});

test("stages every output before changing existing files", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const existingPath = join(fixture.project, ".opencode", "existing.json");
  const blockedParent = join(fixture.project, "blocked");
  await writeFile(existingPath, "original\n");
  await writeFile(blockedParent, "not a directory\n");

  assert.throws(
    () => applyChangePlan([
      { path: existingPath, content: "replacement\n" },
      { path: join(blockedParent, "nested.json"), content: "cannot write\n" },
    ]),
  );
  assert.equal(await readFile(existingPath, "utf8"), "original\n");
  assert.equal(await readFile(join(fixture.project, "blocked"), "utf8"), "not a directory\n");
});

test("removes directories created during a failed apply", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const outputDirectory = join(fixture.root, "new", "nested");
  const blockedPath = join(fixture.project, "blocked");
  await writeFile(blockedPath, "not a directory\n");

  assert.throws(() => applyChangePlan([
    { path: join(outputDirectory, "first.json"), content: "first\n" },
    { path: join(blockedPath, "second.json"), content: "second\n" },
  ]));
  await assert.rejects(readFile(join(outputDirectory, "first.json")));
  await assert.rejects(readFile(join(fixture.root, "new")));
});

test("keeps search pickers separate from Vim-enabled select prompts", async () => {
  const source = await readFile(join(repositoryRoot, "cli.js"), "utf8");
  assert.match(source, /const vimSelectTheme = \{ keybindings: \["vim"\] \}/);
  assert.equal((source.match(/theme: vimSelectTheme/g) ?? []).length, 4);
  assert.match(source, /message: `Select model for \$\{tierName\} tier:`,[\s\S]*source: async/);
  assert.match(source, /message: `Select variant for \$\{tierName\} tier:`,[\s\S]*source: async/);
});

test("parses verbose model variants", () => {
  const models = parseVerboseModels([
    "provider/model",
    '{"variants":{"high":{},"low":{}}}',
    "provider/other",
    '{"variants":{"fast":{}}}',
  ].join("\n"));

  assert.deepEqual(Object.keys(models.get("provider/model").variants), ["high", "low"]);
});

test("parses verbose model records with Windows line endings", () => {
  const models = parseVerboseModels([
    "provider/model",
    '{"variants":{"high":{}}}',
  ].join("\r\n"));

  assert.deepEqual(Object.keys(models.get("provider/model").variants), ["high"]);
});

test("filters model records and excludes disabled variants", () => {
  assert.deepEqual(parseModelList([
    "Models:",
    "provider/z",
    "provider/a extra",
    "provider/z",
    "invalid",
  ].join("\n")), ["provider/z"]);
  const models = loadModelCatalog((args) => args[1] === "--verbose"
    ? 'provider/model\n{"variants":{"enabled":{},"disabled":{"disabled":true}}}'
    : "provider/model\n");
  assert.deepEqual(models.variantsByModel.get("provider/model"), ["enabled"]);
});

test("updates JSONC config and discovers model selectors", () => {
  const source = `{
  // Keep this comment.
  "model": "provider/main",
  "small_model": "provider/small",
  "agent": {
    "reviewer": { "model": "provider/reviewer" }
  },
}`;
  const root = parseJsonc(source);
  const selectors = collectConfigSelectors(source, root);
  assert.equal(selectors[0].question, "What do you want to assign as a default model?");
  assert.equal(selectors[2].question, 'Agent "reviewer" uses "provider/reviewer". What do you want to do?');
  const updated = updateConfigSource(source, selectors.map((selector, index) => ({
    node: selector.node,
    tier: ["MAIN", "SMALL", "REVIEW"][index],
  })));
  const updatedRoot = parseJsonc(updated);

  assert.match(updated, /Keep this comment/);
  assert.deepEqual(
    updatedRoot.properties.find(({ key }) => key === "plugin").value.items[0].value,
    "opencode-model-tiers",
  );
  assert.deepEqual(
    selectors.map(({ node }) => node.value),
    ["provider/main", "provider/small", "provider/reviewer"],
  );
  assert.match(updated, /tier:MAIN/);
  assert.match(updated, /tier:SMALL/);
  assert.match(updated, /tier:REVIEW/);
});

test("writes selected missing built-in agent overrides", () => {
  const source = `{
  "model": "provider/main"
}`;
  const updated = updateConfigSource(source, [
    { configAgentName: "plan", tier: "PLAN" },
    { configAgentName: "build", tier: "BUILD" },
  ]);
  const root = parseJsonc(updated);
  const agents = root.properties.find(({ key }) => key === "agent").value;

  assert.deepEqual(
    agents.properties.map(({ key, value }) => ({
      key,
      model: value.properties.find(({ key: propertyKey }) => propertyKey === "model").value.value,
    })),
    [
      { key: "plan", model: "tier:PLAN" },
      { key: "build", model: "tier:BUILD" },
    ],
  );
});

test("inserts missing agent properties into multiline JSONC", () => {
  const source = `{
  "agent": {
    "reviewer": {}
  }
}`;
  const updated = updateConfigSource(source, [
    { configAgentName: "plan", tier: "PLAN" },
  ]);
  const root = parseJsonc(updated);
  const agents = root.properties.find(({ key }) => key === "agent").value;

  assert.deepEqual(agents.properties.map(({ key }) => key), ["reviewer", "plan"]);
});

test("does not duplicate versioned plugin entries", () => {
  const source = '{\n  "plugin": [\n    "opencode-model-tiers@0.1.2",\n  ],\n}\n';
  assert.equal(updateConfigSource(source), source);
});

test("rejects non-string plugin entries", () => {
  assert.throws(() => updateConfigSource('{"plugin":["other", 1]}'), /plugin entries must be strings/);
  assert.throws(() => updateConfigSource('{"plugin": {}}'), /plugin must be an array/);
});

test("keeps an already installed unversioned plugin unchanged", () => {
  const source = '{\n  "plugin": ["opencode-model-tiers"],\n}\n';
  assert.equal(updateConfigSource(source), source);
});

test("updates Markdown agent frontmatter model", () => {
  const source = "---\nmodel: provider/reviewer # existing\n---\n\n# Reviewer\n";
  const frontmatter = parseFrontmatter(source);

  assert.equal(frontmatter.model.value, "provider/reviewer");
  assert.equal(
    updateMarkdownSource(source, frontmatter.model.start, frontmatter.model.end, "REVIEW"),
    "---\nmodel: tier:REVIEW # existing\n---\n\n# Reviewer\n",
  );
});

test("preserves Markdown quoting, CRLF, and unrelated frontmatter", () => {
  const source = "---\r\nname: Reviewer\r\nmodel: 'provider/reviewer'\r\n---\r\n# Reviewer\r\n";
  const frontmatter = parseFrontmatter(source);
  assert.equal(frontmatter.model.value, "provider/reviewer");
  const updated = updateMarkdownSource(source, frontmatter.model.start, frontmatter.model.end, "REVIEW");
  assert.match(updated, /name: Reviewer\r\nmodel: tier:REVIEW\r\n/);
});

test("accepts Markdown frontmatter closing delimiter at end of file", () => {
  const frontmatter = parseFrontmatter("---\nmodel: provider/model\n---");
  assert.equal(frontmatter.model.value, "provider/model");
});

test("skips empty and unusable Markdown model values", () => {
  assert.equal(parseFrontmatter("---\nmodel:   \n---\n").model.value, "");
  assert.equal(parseFrontmatter("# no frontmatter\n"), null);
  assert.equal(parseFrontmatter("---\nname: agent\n---\n").model, null);
});

test("discovers only usable Markdown agent files in stable order", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const agentsPath = join(fixture.project, ".opencode", "agents");
  await mkdir(agentsPath);
  await writeFile(join(agentsPath, "zeta.md"), "---\nmodel: provider/z\n---\n");
  await writeFile(join(agentsPath, "alpha.md"), "---\nmodel: \n---\n");
  await writeFile(join(agentsPath, "broken.md"), "---\nmodel: provider/broken\n");
  await writeFile(join(agentsPath, "notes.txt"), "model: provider/ignored\n");

  assert.deepEqual(agentMarkdownFiles(join(fixture.project, ".opencode")), [
    join(agentsPath, "alpha.md"),
    join(agentsPath, "broken.md"),
    join(agentsPath, "zeta.md"),
  ]);
  assert.deepEqual(collectMarkdownSelectors(agentMarkdownFiles(join(fixture.project, ".opencode")))
    .map(({ filePath }) => filePath), [join(agentsPath, "zeta.md")]);
});

test("config discovery validates root and agent structures", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const base = join(fixture.project, ".opencode");
  const config = join(base, "opencode.json");

  await writeFile(config, "[]");
  assert.throws(() => configSource(base), /config must contain an object/);
  await writeFile(config, '{"agent": []}');
  assert.throws(() => configSource(base), /agent must be an object/);
  await writeFile(config, '{"agent": {"reviewer": []}}');
  assert.throws(() => configSource(base), /agent reviewer must be an object/);
  assert.equal(configPath(base), config);
});

test("rejects duplicate tier names created from current models", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(join(fixture.project, ".opencode", "opencode.json"),
    '{"model":"provider/main","small_model":"provider/small"}');
  const prompts = scriptedPrompts({
    selects: {
      "Where should the registry be created?": "project",
      "How do you want to configure model tiers?": "custom",
      'What do you want to assign as a default model?': "__create_from_current__",
    },
    inputs: {
      "Tier name (blank to finish):": ["LOCAL", ""],
      "New tier name for provider/main:": "LOCAL",
    },
    searches: {
      "Select model for LOCAL tier:": "provider/review",
      "Select variant for LOCAL tier:": "__default__",
    },
  });

  await assert.rejects(runInit({
    cwd: fixture.project,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome },
    input: {},
    output: silentOutput(),
    prompts,
    loadCatalog: fakeCatalog,
  }), /Duplicate tier name/);
});

test("runs complete project init with config, built-in, and Markdown migrations", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await writeFile(join(fixture.project, ".opencode", "opencode.jsonc"), `{
  // Preserve this comment.
  "model": "provider/main",
  "small_model": "provider/small",
  "agent": { "reviewer": { "model": "provider/review" } },
}`);
  await mkdir(join(fixture.project, ".opencode", "agents"));
  await writeFile(
    join(fixture.project, ".opencode", "agents", "jira.md"),
    "---\nmodel: provider/review # preserve this comment\n---\n\n# Jira\n",
  );

  const prompts = scriptedPrompts({
    selects: {
      "Where should the registry be created?": "project",
      "How do you want to configure model tiers?": "standard",
      'What do you want to assign as a default model?': "PLAN",
      'What do you want to assign as a small model?': "BUILD",
      'Agent "reviewer" uses "provider/review". What do you want to do?': "PLAN",
      'Agent "plan" has no model configured. What do you want to do?': "PLAN",
      'Agent "build" has no model configured. What do you want to do?': "BUILD",
      'Agent "jira" uses "provider/review". What do you want to do?': "PLAN",
      "What do you want to do?": "apply",
    },
    searches: {
      "Select model for PLAN tier:": "provider/plan",
      "Select variant for PLAN tier:": "__default__",
      "Select model for BUILD tier:": "provider/build",
      "Select variant for BUILD tier:": "__default__",
    },
  });

  await runInit({
    cwd: fixture.project,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome },
    input: {},
    output: silentOutput(),
    prompts,
    loadCatalog: fakeCatalog,
  });

  assert.deepEqual(JSON.parse(await readFile(join(fixture.project, ".opencode", "model-tiers.json"))), {
    options: { resetModelsOnStart: false },
    tiers: {
      PLAN: { model: "provider/plan" },
      BUILD: { model: "provider/build" },
    },
  });
  const config = await readFile(join(fixture.project, ".opencode", "opencode.jsonc"), "utf8");
  const root = parseJsonc(config);
  assert.match(config, /Preserve this comment/);
  assert.equal(root.properties.find(({ key }) => key === "model").value.value, "tier:PLAN");
  assert.equal(root.properties.find(({ key }) => key === "small_model").value.value, "tier:BUILD");
  assert.equal(root.properties.find(({ key }) => key === "plugin").value.items[0].value, "opencode-model-tiers");
  const agent = root.properties.find(({ key }) => key === "agent").value;
  assert.deepEqual(agent.properties.map(({ key }) => key), ["reviewer", "plan", "build"]);
  assert.match(await readFile(join(fixture.project, ".opencode", "agents", "jira.md"), "utf8"),
    /model: tier:PLAN # preserve this comment/);
});

test("runs custom project init and creates a tier from current model", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(
    join(fixture.project, ".opencode", "opencode.json"),
    '{"model":"provider/current"}',
  );

  const prompts = scriptedPrompts({
    selects: {
      "Where should the registry be created?": "project",
      "How do you want to configure model tiers?": "custom",
      'What do you want to assign as a default model?': "__create_from_current__",
      'Agent "plan" has no model configured. What do you want to do?': "FAST",
      'Agent "build" has no model configured. What do you want to do?': "FAST",
      "What do you want to do?": "apply",
    },
    inputs: {
      "Tier name (blank to finish):": ["FAST", ""],
      "New tier name for provider/current:": "CURRENT",
    },
    searches: {
      "Select model for FAST tier:": "provider/build",
      "Select variant for FAST tier:": "fast",
    },
  });

  await runInit({
    cwd: fixture.project,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome },
    input: {},
    output: silentOutput(),
    prompts,
    loadCatalog: fakeCatalog,
  });

  assert.deepEqual(JSON.parse(await readFile(join(fixture.project, ".opencode", "model-tiers.json"))), {
    options: { resetModelsOnStart: false },
    tiers: {
      FAST: { model: "provider/build", variant: "fast" },
      CURRENT: { model: "provider/current" },
    },
  });
  assert.match(await readFile(join(fixture.project, ".opencode", "opencode.json"), "utf8"),
    /tier:CURRENT/);
});

test("creates multiple custom tiers in entry order", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prompts = scriptedPrompts({
    selects: {
      "Where should the registry be created?": "project",
      "How do you want to configure model tiers?": "custom",
      'Agent "plan" has no model configured. What do you want to do?': undefined,
      'Agent "build" has no model configured. What do you want to do?': undefined,
      "What do you want to do?": "apply",
    },
    inputs: { "Tier name (blank to finish):": ["FAST", "SAFE", ""] },
    searches: {
      "Select model for FAST tier:": "provider/build",
      "Select variant for FAST tier:": "fast",
      "Select model for SAFE tier:": "provider/plan",
      "Select variant for SAFE tier:": "__default__",
    },
  });
  await runInit({
    cwd: fixture.project,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome },
    input: {},
    output: silentOutput(),
    prompts,
    loadCatalog: fakeCatalog,
  });
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(fixture.project, ".opencode", "model-tiers.json"))).tiers), [
    "FAST",
    "SAFE",
  ]);
});

test("requires at least one custom tier and trims custom tier values", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const base = {
    cwd: fixture.project,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome },
    input: {},
    output: silentOutput(),
    loadCatalog: () => ({ modelIds: [], variantsByModel: new Map() }),
  };

  const emptyPrompts = scriptedPrompts({
    selects: {
      "Where should the registry be created?": "project",
      "How do you want to configure model tiers?": "custom",
    },
    inputs: { "Tier name (blank to finish):": "" },
  });
  await assert.rejects(runInit({ ...base, prompts: emptyPrompts }), /At least one tier is required/);

  const trimmedPrompts = scriptedPrompts({
    selects: {
      "Where should the registry be created?": "project",
      "How do you want to configure model tiers?": "custom",
      'Agent "plan" has no model configured. What do you want to do?': undefined,
      'Agent "build" has no model configured. What do you want to do?': undefined,
      "What do you want to do?": "apply",
    },
    inputs: {
      "Tier name (blank to finish):": ["  LOCAL  ", ""],
      "Model ID:": "  provider/custom  ",
    },
    searches: {
      "Select model for LOCAL tier:": "__custom__",
      "Select variant for LOCAL tier:": "__default__",
    },
  });
  await runInit({ ...base, prompts: trimmedPrompts });
  assert.deepEqual(JSON.parse(await readFile(join(fixture.project, ".opencode", "model-tiers.json"))), {
    options: { resetModelsOnStart: false },
    tiers: { LOCAL: { model: "provider/custom" } },
  });
});

test("global init does not modify project selectors", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const projectConfigPath = join(fixture.project, ".opencode", "opencode.json");
  await writeFile(projectConfigPath, '{"model":"provider/project"}');

  const prompts = scriptedPrompts({
    selects: {
      "Where should the registry be created?": "global",
      "How do you want to configure model tiers?": "standard",
      "What do you want to do?": "apply",
    },
    searches: {
      "Select model for PLAN tier:": "provider/plan",
      "Select variant for PLAN tier:": "__default__",
      "Select model for BUILD tier:": "provider/build",
      "Select variant for BUILD tier:": "__default__",
    },
  });

  await runInit({
    cwd: fixture.project,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome },
    input: {},
    output: silentOutput(),
    prompts,
    loadCatalog: fakeCatalog,
  });

  assert.equal(await readFile(projectConfigPath, "utf8"), '{"model":"provider/project"}');
  assert.deepEqual(JSON.parse(await readFile(join(fixture.configHome, "opencode", "model-tiers.json"))), {
    options: { resetModelsOnStart: false },
    tiers: {
      PLAN: { model: "provider/plan" },
      BUILD: { model: "provider/build" },
    },
  });
  assert.match(
    await readFile(join(fixture.configHome, "opencode", "opencode.json"), "utf8"),
    /opencode-model-tiers/,
  );
});

test("initializer writes selected reset policy and preserves unknown options", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const registryPath = join(fixture.configHome, "opencode", "model-tiers.json");
  await writeFile(registryPath, JSON.stringify({
    options: { resetModelsOnStart: true, futureOption: "keep" },
    tiers: { OLD: { model: "provider/old" } },
  }));

  const prompts = scriptedPrompts({
    selects: {
      "Where should the registry be created?": "global",
      "Reset selected model and variant when OpenCode starts?": false,
      "How do you want to configure model tiers?": "standard",
      "What do you want to do?": "apply",
    },
    searches: {
      "Select model for PLAN tier:": "provider/plan",
      "Select variant for PLAN tier:": "__default__",
      "Select model for BUILD tier:": "provider/build",
      "Select variant for BUILD tier:": "__default__",
    },
  });

  await runInit({
    cwd: fixture.project,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome },
    input: {},
    output: silentOutput(),
    prompts,
    loadCatalog: fakeCatalog,
  });

  assert.deepEqual(JSON.parse(await readFile(registryPath)), {
    options: { resetModelsOnStart: false, futureOption: "keep" },
    tiers: {
      OLD: { model: "provider/old" },
      PLAN: { model: "provider/plan" },
      BUILD: { model: "provider/build" },
    },
  });
});

test("uses custom model and variant when catalog is unavailable", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const prompts = scriptedPrompts({
    selects: {
      "Where should the registry be created?": "project",
      "How do you want to configure model tiers?": "custom",
      'Agent "plan" has no model configured. What do you want to do?': "LOCAL",
      'Agent "build" has no model configured. What do you want to do?': "LOCAL",
      "What do you want to do?": "apply",
    },
    inputs: {
      "Tier name (blank to finish):": ["LOCAL", ""],
      "Model ID:": "provider/custom",
      "Variant:": "custom-variant",
    },
    searches: {
      "Select model for LOCAL tier:": "__custom__",
      "Select variant for LOCAL tier:": "__custom__",
    },
  });

  await runInit({
    cwd: fixture.project,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome },
    input: {},
    output: silentOutput(),
    prompts,
    loadCatalog: () => ({ modelIds: [], variantsByModel: new Map() }),
  });

  assert.deepEqual(JSON.parse(await readFile(join(fixture.project, ".opencode", "model-tiers.json"))), {
    options: { resetModelsOnStart: false },
    tiers: { LOCAL: { model: "provider/custom", variant: "custom-variant" } },
  });
});

test("rejects empty custom model and variant input without writes", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const base = {
    cwd: fixture.project,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome },
    input: {},
    output: silentOutput(),
    loadCatalog: () => ({ modelIds: [], variantsByModel: new Map() }),
  };

  const emptyModelPrompts = scriptedPrompts({
    selects: {
      "Where should the registry be created?": "project",
      "How do you want to configure model tiers?": "custom",
    },
    inputs: {
      "Tier name (blank to finish):": "LOCAL",
      "Model ID:": "   ",
    },
    searches: { "Select model for LOCAL tier:": "__custom__" },
  });
  await assert.rejects(runInit({ ...base, prompts: emptyModelPrompts }), /Model ID cannot be empty/);

  const emptyVariantPrompts = scriptedPrompts({
    selects: {
      "Where should the registry be created?": "project",
      "How do you want to configure model tiers?": "custom",
    },
    inputs: {
      "Tier name (blank to finish):": "LOCAL",
      "Model ID:": "provider/custom",
      "Variant:": "   ",
    },
    searches: {
      "Select model for LOCAL tier:": "__custom__",
      "Select variant for LOCAL tier:": "__custom__",
    },
  });
  await assert.rejects(runInit({ ...base, prompts: emptyVariantPrompts }), /Variant cannot be empty/);
  await assert.rejects(readFile(join(fixture.project, ".opencode", "model-tiers.json")));
});

test("creates missing config with selected built-in agent overrides", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prompts = scriptedPrompts({
    selects: {
      "Where should the registry be created?": "project",
      "How do you want to configure model tiers?": "standard",
      'Agent "plan" has no model configured. What do you want to do?': "PLAN",
      'Agent "build" has no model configured. What do you want to do?': "BUILD",
      "What do you want to do?": "apply",
    },
    searches: {
      "Select model for PLAN tier:": "provider/plan",
      "Select variant for PLAN tier:": "__default__",
      "Select model for BUILD tier:": "provider/build",
      "Select variant for BUILD tier:": "__default__",
    },
  });
  await runInit({
    cwd: fixture.project,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome },
    input: {},
    output: silentOutput(),
    prompts,
    loadCatalog: fakeCatalog,
  });

  const config = JSON.parse(await readFile(join(fixture.project, ".opencode", "opencode.json")));
  assert.deepEqual(config.agent, {
    plan: { model: "tier:PLAN" },
    build: { model: "tier:BUILD" },
  });
  assert.deepEqual(config.plugin, ["opencode-model-tiers"]);
});

test("cancel leaves all project files absent", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  let applied = false;
  const prompts = scriptedPrompts({
    selects: {
      "Where should the registry be created?": "project",
      "How do you want to configure model tiers?": "standard",
      'Agent "plan" has no model configured. What do you want to do?': "PLAN",
      'Agent "build" has no model configured. What do you want to do?': "BUILD",
      "What do you want to do?": "cancel",
    },
    searches: {
      "Select model for PLAN tier:": "provider/plan",
      "Select variant for PLAN tier:": "__default__",
      "Select model for BUILD tier:": "provider/build",
      "Select variant for BUILD tier:": "__default__",
    },
  });

  await runInit({
    cwd: fixture.project,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome },
    input: {},
    output: silentOutput(),
    prompts,
    loadCatalog: fakeCatalog,
    applyPlan: () => {
      applied = true;
    },
  });

  assert.equal(applied, false);
  await assert.rejects(readFile(join(fixture.project, ".opencode", "model-tiers.json")));
  await assert.rejects(readFile(join(fixture.project, ".opencode", "opencode.json")));
});

test("prefers JSONC and leaves JSON sibling unchanged", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const jsonPath = join(fixture.project, ".opencode", "opencode.json");
  const jsoncPath = join(fixture.project, ".opencode", "opencode.jsonc");
  await writeFile(jsonPath, '{"model":"provider/json"}');
  await writeFile(jsoncPath, '{"model":"provider/jsonc"}');

  const prompts = scriptedPrompts({
    selects: {
      "Where should the registry be created?": "project",
      "How do you want to configure model tiers?": "custom",
      'What do you want to assign as a default model?': "LOCAL",
      'Agent "plan" has no model configured. What do you want to do?': "LOCAL",
      'Agent "build" has no model configured. What do you want to do?': "LOCAL",
      "What do you want to do?": "apply",
    },
    inputs: {
      "Tier name (blank to finish):": ["LOCAL", ""],
    },
    searches: {
      "Select model for LOCAL tier:": "provider/review",
      "Select variant for LOCAL tier:": "__default__",
    },
  });

  await runInit({
    cwd: fixture.project,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome },
    input: {},
    output: silentOutput(),
    prompts,
    loadCatalog: fakeCatalog,
  });

  assert.equal(await readFile(jsonPath, "utf8"), '{"model":"provider/json"}');
  assert.match(await readFile(jsoncPath, "utf8"), /tier:LOCAL/);
});

test("rejects malformed config before applying planned files", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(join(fixture.project, ".opencode", "opencode.json"), '{"plugin":{}}');
  const prompts = scriptedPrompts({
    selects: {
      "Where should the registry be created?": "project",
      "How do you want to configure model tiers?": "standard",
      'Agent "plan" has no model configured. What do you want to do?': undefined,
      'Agent "build" has no model configured. What do you want to do?': undefined,
    },
    searches: {
      "Select model for PLAN tier:": "provider/plan",
      "Select variant for PLAN tier:": "__default__",
      "Select model for BUILD tier:": "provider/build",
      "Select variant for BUILD tier:": "__default__",
    },
  });

  await assert.rejects(runInit({
    cwd: fixture.project,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome },
    input: {},
    output: silentOutput(),
    prompts,
    loadCatalog: fakeCatalog,
  }), /plugin must be an array/);
  await assert.rejects(readFile(join(fixture.project, ".opencode", "model-tiers.json")));
  assert.equal(await readFile(join(fixture.project, ".opencode", "opencode.json"), "utf8"), '{"plugin":{}}');
});

test("does not write when the registry is malformed", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const registryPath = join(fixture.project, ".opencode", "model-tiers.json");
  const configPath = join(fixture.project, ".opencode", "opencode.json");
  await writeFile(registryPath, "not json");

  const prompts = scriptedPrompts({
    selects: { "Where should the registry be created?": "project" },
  });
  await assert.rejects(runInit({
    cwd: fixture.project,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome },
    input: {},
    output: silentOutput(),
    prompts,
    loadCatalog: fakeCatalog,
  }), /Registry is not valid JSON/);
  assert.equal(await readFile(registryPath, "utf8"), "not json");
  await assert.rejects(readFile(configPath));
});

test("start over does not write incomplete plans", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prompts = scriptedPrompts({
    selects: {
      "Where should the registry be created?": ["project", "project"],
      "How do you want to configure model tiers?": ["standard", "standard"],
      "What do you want to do?": ["restart", "apply"],
      'Agent "plan" has no model configured. What do you want to do?': ["PLAN", "PLAN"],
      'Agent "build" has no model configured. What do you want to do?': ["BUILD", "BUILD"],
    },
    searches: {
      "Select model for PLAN tier:": ["provider/plan", "provider/plan"],
      "Select variant for PLAN tier:": ["__default__", "__default__"],
      "Select model for BUILD tier:": ["provider/build", "provider/build"],
      "Select variant for BUILD tier:": ["__default__", "__default__"],
    },
  });

  await runInit({
    cwd: fixture.project,
    env: { ...process.env, XDG_CONFIG_HOME: fixture.configHome },
    input: {},
    output: silentOutput(),
    prompts,
    loadCatalog: fakeCatalog,
  });

  assert.ok(await readFile(join(fixture.project, ".opencode", "model-tiers.json"), "utf8"));
  assert.ok(await readFile(join(fixture.project, ".opencode", "opencode.json"), "utf8"));
});

test("resolves tier models, preserves direct IDs, and applies agent variants", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = await runPlugin({
    fixture,
    globalRegistry: {
      FAST: { model: "provider/fast", variant: "high" },
      LIGHT: { model: "provider/light" },
    },
    config: {
      model: "tier:FAST",
      small_model: "provider/direct",
      agent: {
        reviewer: { model: "tier:LIGHT", variant: "old" },
        direct: { model: "provider/direct", variant: "keep" },
      },
    },
  });

  assert.equal(result.config.model, "provider/fast");
  assert.equal(result.config.small_model, "provider/direct");
  assert.equal(result.config.agent.reviewer.model, "provider/light");
  assert.equal(result.config.agent.reviewer.variant, undefined);
  assert.deepEqual(result.config.agent.direct, {
    model: "provider/direct",
    variant: "keep",
  });
});

test("resets persisted model and variant when enabled", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const state = {
    model: "provider/temporary",
    variant: { "provider/temporary": "high" },
    recent: ["provider/temporary"],
    favorite: ["provider/temporary"],
  };
  await runPlugin({
    fixture,
    globalRegistry: {
      options: { resetModelsOnStart: true },
      tiers: { PLAN: { model: "provider/plan" } },
    },
    config: { model: "tier:PLAN" },
    state,
  });

  assert.deepEqual(await readState(fixture), {
    variant: {},
    recent: state.recent,
    favorite: state.favorite,
  });
});

test("preserves persisted model state when reset is disabled", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const state = {
    model: "provider/temporary",
    variant: { "provider/temporary": "high" },
  };
  await runPlugin({
    fixture,
    globalRegistry: { PLAN: { model: "provider/plan" } },
    config: { model: "tier:PLAN" },
    state,
  });

  assert.deepEqual(await readState(fixture), state);
});

test("warns when enabled persisted model reset fails", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(join(fixture.stateHome, "opencode", "model.json"), "[]");

  const result = await runPlugin({
    fixture,
    globalRegistry: {
      options: { resetModelsOnStart: true },
      tiers: { PLAN: { model: "provider/plan" } },
    },
    config: { model: "tier:PLAN" },
  });

  assert.equal(result.config.model, "provider/plan");
  assert.deepEqual(result.toasts.map(({ body }) => body), [
    { message: "Model Tier: could not reset persisted models (state must contain a JSON object)", variant: "warning" },
  ]);
});

test("prefers the project registry over the global registry", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = await runPlugin({
    fixture,
    globalRegistry: { FAST: { model: "provider/global" } },
    projectRegistry: { FAST: { model: "provider/project" } },
    config: { model: "tier:FAST" },
  });

  assert.equal(result.config.model, "provider/project");
});

test("removes unknown tier overrides and reports warnings", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = await runPlugin({
    fixture,
    config: {
      model: "tier:MISSING",
      agent: { reviewer: { model: "tier:MISSING" } },
    },
  });

  assert.equal("model" in result.config, false);
  assert.equal("model" in result.config.agent.reviewer, false);
  assert.deepEqual(
    result.toasts.map(({ body }) => body),
    [
      { message: "Model Tier: MISSING does not exist", variant: "warning" },
    ],
  );
});

test("trims registry tier names for runtime lookup", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = await runPlugin({
    fixture,
    globalRegistry: { " FAST ": { model: "provider/fast" } },
    config: { model: "tier:FAST" },
  });

  assert.equal(result.config.model, "provider/fast");
});

test("clears persisted model and variants while preserving other model state", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const state = {
    model: "provider/model",
    variant: { "provider/model": "high" },
    recent: ["provider/model"],
    favorite: ["provider/model"],
  };

  await runPlugin({
    fixture,
    globalRegistry: { options: { resetModelsOnStart: true }, tiers: {} },
    config: { model: "provider/direct" },
    state,
  });

  assert.deepEqual(await readState(fixture), {
    recent: state.recent,
    favorite: state.favorite,
    variant: {},
  });
});
