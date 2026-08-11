import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import rootPlugin from "opencode-model-tiers";
import serverPlugin from "opencode-model-tiers/server";

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

test("exports the plugin from the package root and server subpath", () => {
  assert.equal(typeof rootPlugin, "function");
  assert.equal(typeof serverPlugin, "function");
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
      { message: "Model Tier: MISSING does not exist", variant: "warning" },
    ],
  );
});

test("clears persisted variants while preserving other model state", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const state = {
    variant: { "provider/model": "high" },
    recent: ["provider/model"],
    favorite: ["provider/model"],
  };

  await runPlugin({
    fixture,
    config: { model: "provider/direct" },
    state,
  });

  assert.deepEqual(await readState(fixture), {
    ...state,
    variant: {},
  });
});
