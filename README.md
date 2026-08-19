# opencode-model-tiers

`opencode-model-tiers` is a dependency-free OpenCode plugin that resolves
named model tiers in project and global configuration. This project is
community-maintained and isn't affiliated with or endorsed by OpenCode.

> [!NOTE]
> Version `0.1.0` is experimental. Configuration behavior may change before
> the first stable release.

## Install

Add the package to your OpenCode configuration. OpenCode installs and caches
npm plugins automatically when it starts.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-model-tiers@0.1.0"
  ]
}
```

Use an exact version in configuration for reproducible startup. Restart
OpenCode after changing the plugin entry, registry, or model configuration.

## Configure tiers

Use `tier:<NAME>` anywhere OpenCode accepts a model value:

```jsonc
{
  "model": "tier:IMPLEMENTATION",
  "small_model": "tier:SMALL",
  "agent": {
    "reviewer": {
      "model": "tier:LIGHT"
    }
  }
}
```

Agent Markdown frontmatter uses the same syntax:

```yaml
---
model: tier:LIGHT
---
```

Create a registry as `./.opencode/model-tiers.json` for one project:

```json
{
  "IMPLEMENTATION": {
    "model": "anthropic/claude-sonnet-4-5",
    "variant": "high"
  },
  "LIGHT": {
    "model": "anthropic/claude-haiku-4-5"
  },
  "SMALL": {
    "model": "anthropic/claude-haiku-4-5"
  }
}
```

For a global registry, use
`$XDG_CONFIG_HOME/opencode/model-tiers.json`. When
`XDG_CONFIG_HOME` is unset, use `~/.config/opencode/model-tiers.json`.

The project registry takes precedence when it exists. The plugin doesn't fall
back to the global registry if an existing project registry is malformed.

## Behavior

The plugin applies these rules during OpenCode startup:

- The `tier:` prefix is case-insensitive.
- Tier names are trimmed, then matched case-sensitively against registry keys.
- Direct model IDs pass through unchanged.
- Top-level `model` and `small_model` values resolve to the tier's `model`.
- Enabled, visible agent models resolve to the tier's `model`.
- An agent tier with `variant` replaces the agent's existing variant.
- An agent tier without `variant` clears the agent's existing variant.
- Disabled and hidden agents are skipped.
- An unknown tier removes its model override and shows a TUI warning, allowing
  OpenCode to choose its normal default.
- The old `model_tier` setting isn't supported.

Tier variants apply to agent configuration only. Top-level model fields use
the tier's model ID and don't set a top-level variant.

## Persisted variants

At startup, the plugin best-effort clears persisted TUI variants in
`$XDG_STATE_HOME/opencode/model.json`. When `XDG_STATE_HOME` is unset, it uses
`~/.local/state/opencode/model.json`.

The plugin preserves other state fields and replaces only the `variant` value
with an empty object. Missing, malformed, or inaccessible state files don't
prevent tier resolution.

## Upgrade or remove

To upgrade, replace the pinned version in OpenCode configuration:

```jsonc
"plugin": ["opencode-model-tiers@0.1.1"]
```

Restart OpenCode after the change. To remove the plugin, delete its entry from
the `plugin` array and restart OpenCode.

## Troubleshooting

Use these checks when a tier doesn't resolve or an old variant remains visible.

### Tier isn't resolved

Check these conditions:

- The registry path matches the project or global path described above.
- The tier name has the same case as the registry key.
- The registry policy contains a string `model` value.
- A project registry isn't shadowing the global registry.

### OpenCode shows a missing-tier warning

The plugin removed the invalid model override. Add the tier to the active
registry, or replace the value with a direct model ID, then restart OpenCode.

### Old variant still appears

The plugin clears persisted variants during startup. Restart OpenCode after
changing the registry. If the state file is not writable, remove or edit the
stale `variant` entry manually.

## Local development

The repository has no runtime dependencies. Run checks with Node.js:

```bash
node --check index.js
npm test
npm pack --dry-run --json
npm publish --dry-run
```

The test suite also runs under Bun because OpenCode executes npm plugins with
Bun. The package allowlist publishes only `index.js`, `README.md`, `LICENSE`,
and `CHANGELOG.md`; tests, workflows, local registries, and other repository
files stay out of the npm tarball.

For local plugin development, use a generic file URL in OpenCode config:

```jsonc
{
  "plugin": [
    "file:///absolute/path/to/opencode-model-tiers/index.js"
  ]
}
```

## Releases

Releases publish automatically through GitHub Actions after every push to
`main`. npm permits each package version only once, so increment `version` in
`package.json` before each release push. Pushes with an already-published
version pass checks and skip publishing.

Publishing uses npm Trusted Publishing with GitHub Actions OIDC. Configure the
trusted publisher for this package with these values:

- GitHub user: `dartyuhov`
- Repository: `opencode-model-tiers`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

The workflow needs no npm token secret. After confirming a successful OIDC
publish, revoke any temporary `NPM_TOKEN` previously used for the first
release.

Push the version change to `main` to publish it. Don't run `npm publish`
locally.
