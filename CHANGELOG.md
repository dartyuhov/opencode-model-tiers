# Changelog

## 0.1.6

- Apply the same model migration flow during global initialization as during
  project initialization.
- Discover Markdown agents in both `agent/` and `agents/` directories.

## 0.1.5

- Pin `@inquirer/prompts` to the Node.js 18-compatible 7.x release line to avoid
  engine warnings on Node.js 22.12.

## 0.1.4

- Include `@inquirer/prompts` as a production dependency so the `npx` initializer
  uses its interactive picker instead of the terminal fallback.

## 0.1.3

- Support envelope registries with configurable persisted model reset.
- Publish the `npx opencode-model-tiers init` command.
- Use a built-in terminal prompt fallback so the CLI has no production
  dependencies.
- Publish only the OpenCode plugin runtime and required documentation files.
- Keep initializer and CLI code out of the published package.
- Improve agent migration prompts and preserve recommended `PLAN` and `BUILD`
  tier ordering.
- Add shared runtime helpers and validation improvements.

## 0.1.2

- Publish releases automatically from pushes to `main` through npm Trusted
  Publishing.
- Skip publishing when the package version already exists on npm.

## 0.1.0

- Add named model tier resolution for OpenCode configuration.
- Support project and global tier registries.
- Preserve direct model IDs and fall back safely for unknown tiers.
- Clear persisted OpenCode TUI variants during startup.
