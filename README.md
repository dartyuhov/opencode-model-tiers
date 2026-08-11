# opencode-model-tiers

OpenCode plugin for resolving named model tiers in project and global config.

Agents with `model_tier` use the matching entry from `model-tiers.json`. Agents
without `model_tier` keep their explicit model and variant settings. On startup,
the plugin clears persisted TUI variants while preserving recent and favorite
models.

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
