# Repository Guidance

- This is a Node ESM OpenCode plugin with a CLI initializer. Keep plugin runtime
  code in `index.js`, CLI orchestration in `cli.js`, and reusable initializer
  code in `lib/`, using ESM imports;
  `package.json` has no build, lint, or typecheck scripts.
- `index.js` exports the plugin function. Its `config` hook loads the local or
  global `model-tiers.json`, resolves case-insensitive `tier:` prefixes in
  top-level `model`, `small_model`, and agent `model` fields, and leaves direct
  model IDs unchanged. Tier names are trimmed and case-sensitive.
- Disabled or hidden agents are skipped. Unknown tier references show a TUI
  warning, remove the invalid model override, and let OpenCode choose its
  default. Malformed registry entries still throw configuration errors.
- The old `model_tier` setting is not supported.
- `model-tiers.json` is the source of truth for tier names, model IDs, and
  optional variants. A tier without `variant` clears any agent variant; do not
  assume omitted variant means "preserve existing variant."
- Envelope registries use `options.resetModelsOnStart` to opt into clearing the
  persisted OpenCode model and TUI variants in
  `$XDG_STATE_HOME/opencode/model.json`, falling back to
  `~/.local/state/opencode/model.json`, while preserving other state. Flat
  registries remain readable and default this option to false. Reset failures
  show a TUI warning but do not block tier resolution.
- The README's `file:///.../index.js` plugin registration is the supported
  integration path. Project `.opencode/model-tiers.json` overrides the global
  registry; no registry is needed when config contains no tier references.
- After edits, run `node --check index.js` and parse the configured registry
  when present, for example:
  `node -e 'JSON.parse(require("fs").readFileSync(process.env.HOME + "/.config/opencode/model-tiers.json", "utf8"))'`.
