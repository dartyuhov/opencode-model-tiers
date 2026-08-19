# Changelog

## 0.1.2

- Publish releases automatically from pushes to `main` through npm Trusted
  Publishing.
- Skip publishing when the package version already exists on npm.

## 0.1.0

- Add named model tier resolution for OpenCode configuration.
- Support project and global tier registries.
- Preserve direct model IDs and fall back safely for unknown tiers.
- Clear persisted OpenCode TUI variants during startup.
