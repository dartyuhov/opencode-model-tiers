# Repository Guidance

- This is a dependency-free Node ESM OpenCode plugin. Keep runtime code in
  `index.js` using ESM imports; `package.json` has no build, lint, typecheck, or
  test scripts.
- `index.js` exports the plugin function. Its `config` hook loads the adjacent
  `model-tiers.json`, resolves `tier:<name>` in top-level `model` and
  `small_model`, and resolves `model_tier` on agents. Tier names are trimmed
  and case-insensitive.
- Agent tier declarations may be in `agent.options.model_tier` or
  `agent.model_tier`. Disabled or hidden agents are skipped. Unknown tiers and
  malformed registry entries intentionally throw configuration errors.
- `model-tiers.json` is the source of truth for tier names, model IDs, and
  optional variants. A tier without `variant` clears any agent variant; do not
  assume omitted variant means "preserve existing variant."
- The config hook best-effort resets persisted OpenCode TUI variants in
  `$XDG_STATE_HOME/opencode/model.json`, falling back to
  `~/.local/state/opencode/model.json`, while preserving other state. Treat
  this side effect as intentional when changing startup behavior.
- The README's `file:///.../index.js` plugin registration is the supported
  integration path; the registry is bundled by relative URL, so keep
  `model-tiers.json` beside `index.js`.
- After edits, run `node --check index.js` and parse the registry with:
  `node -e 'JSON.parse(require("fs").readFileSync("model-tiers.json", "utf8"))'`.
