# opencode-model-tiers

`opencode-model-tiers` is an OpenCode plugin that resolves named model tiers in
project and global configuration. This project is community-maintained and
isn't affiliated with or endorsed by OpenCode.

## Install

To install and create a registry interactively, run:

```bash
npx opencode-model-tiers init
```

Or add the plugin to `opencode.json` manually:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-model-tiers"
  ]
}
```

Start OpenCode:

```bash
opencode
```

OpenCode installs npm plugins automatically at startup.

## Configure tiers

Use `tier:<NAME>` anywhere OpenCode accepts a model value:

```jsonc
{
  "model": "tier:PLAN",
  "small_model": "tier:SMALL",
  "agent": {
    "reviewer": {
      "model": "tier:INVESTIGATION"
    }
  }
}
```

Agent Markdown frontmatter uses the same syntax:

```yaml
---
model: tier:INVESTIGATION
---
```

## Registry

Create a registry as `./.opencode/model-tiers.json` for one project:

```json
{
  "options": {
    "resetModelsOnStart": false
  },
  "tiers": {
    "PLAN": {
      "model": "anthropic/claude-opus-4-1",
      "variant": "high"
    },
    "BUILD": {
      "model": "anthropic/claude-sonnet-4-5"
    },
    "INVESTIGATION": {
      "model": "anthropic/claude-sonnet-4-5"
    },
    "SMALL": {
      "model": "anthropic/claude-haiku-4-5"
    },
    "FREE": {
      "model": "opencode/free"
    }
  }
}
```

For a global registry, use
`$XDG_CONFIG_HOME/opencode/model-tiers.json`. When
`XDG_CONFIG_HOME` is unset, use `~/.config/opencode/model-tiers.json`.

The project registry takes precedence when it exists. The plugin doesn't fall
back to the global registry if an existing project registry is malformed.

Existing flat registries remain supported for compatibility:

```json
{
  "PLAN": {
    "model": "anthropic/claude-opus-4-1"
  }
}
```

The initializer writes the envelope format and asks whether to enable
`resetModelsOnStart`.

## Options

Registry options configure optional plugin behavior. Set
`options.resetModelsOnStart` to `true` when you want the registry to restore
the configured model after every OpenCode restart:

```json
{
  "options": {
    "resetModelsOnStart": true
  },
  "tiers": {
    "PLAN": {
      "model": "anthropic/claude-opus-4-1"
    },
    "BUILD": {
      "model": "anthropic/claude-sonnet-4-5"
    },
    "INVESTIGATION": {
      "model": "anthropic/claude-sonnet-4-5"
    },
    "SMALL": {
      "model": "anthropic/claude-haiku-4-5"
    },
    "FREE": {
      "model": "opencode/free"
    }
  }
}
```

`resetModelsOnStart` defaults to `false`. When enabled, the plugin deletes the
persisted `model` property, clears persisted `variant` values, and preserves
other state in `$XDG_STATE_HOME/opencode/model.json`. When
`XDG_STATE_HOME` is unset, it uses `~/.local/state/opencode/model.json`.

The initializer asks for this option and writes either `true` or `false`.

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

Missing, malformed, or inaccessible state files don't prevent tier resolution.
The plugin shows a TUI warning when an enabled reset fails.

## Upgrade or remove

To upgrade, restart OpenCode after a newer package version is published. To
remove the plugin, delete its entry from the `plugin` array and restart
OpenCode.

## Troubleshooting

Use these checks when a tier doesn't resolve or an old model selection remains
visible.

### Tier isn't resolved

Check these conditions:

- The registry path matches the project or global path described above.
- The tier name has the same case as the registry key.
- The registry policy contains a string `model` value.
- A project registry isn't shadowing the global registry.

### OpenCode shows a missing-tier warning

The plugin removed the invalid model override. Add the tier to the active
registry, or replace the value with a direct model ID, then restart OpenCode.

### Old model or variant still appears

Set `options.resetModelsOnStart` to `true`, then restart OpenCode after changing
the registry. If the state file is not writable, use the TUI warning to locate
the problem and remove or edit the stale `model` or `variant` entry manually.

## Local development

Run checks with Node.js:

```bash
node --check index.js
npm test
npm pack --dry-run --json
npm publish --dry-run
```

The test suite also runs under Bun because OpenCode executes npm plugins with
Bun. The package publishes the plugin entry point, the `npx` initializer, their
runtime modules, and package documentation. Tests, workflows, local registries,
and other repository files stay out of the npm tarball. The initializer has no
production dependencies, so OpenCode does not install an additional dependency
when it loads the plugin.

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
