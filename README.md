# opencode-model-tiers

OpenCode plugin for resolving named model tiers in project and global config.

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

The `tier:` prefix is case-insensitive. Tier names match registry keys exactly
after trimming, so `tier:LIGHT` matches `LIGHT`, but `tier:light` does not.
Direct model IDs remain supported and pass through unchanged:

```yaml
model: anthropic/claude-sonnet-4-5
```

When a tier does not exist, the plugin shows a TUI warning, removes that model
override, and lets OpenCode choose its normal default. The old `model_tier`
setting is not supported. On startup, the plugin also clears persisted TUI
variants while preserving recent and favorite models.

The plugin checks the project registry first:

```text
./.opencode/model-tiers.json
```

If the project registry doesn't exist, the plugin uses the global registry:

```text
$XDG_CONFIG_HOME/opencode/model-tiers.json
```

When `XDG_CONFIG_HOME` is unset, use `~/.config/opencode/model-tiers.json`.

Register the plugin in global OpenCode config:

```jsonc
{
  "plugin": [
    "file:///Users/dartsiukhou/dev/personal/opencode-model-tiers/index.js"
  ]
}
```
