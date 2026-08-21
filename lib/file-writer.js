import {
  existsSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

function temporaryPath(filePath, suffix) {
  return join(dirname(filePath), `.${suffix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function missingDirectories(directory) {
  const missing = [];
  let current = directory;
  while (!existsSync(current)) {
    missing.push(current);
    current = dirname(current);
  }
  return missing;
}

export function applyChangePlan(files) {
  const createdDirectories = [];
  const states = files.map((file, index) => ({
    ...file,
    tempPath: temporaryPath(file.path, `model-tiers-${index}`),
    backupPath: temporaryPath(file.path, `model-tiers-backup-${index}`),
    backedUp: false,
    installed: false,
  }));

  try {
    for (const state of states) {
      createdDirectories.push(...missingDirectories(dirname(state.path)).reverse());
      mkdirSync(dirname(state.path), { recursive: true });
      writeFileSync(state.tempPath, state.content);
    }

    for (const state of states) {
      if (existsSync(state.path)) {
        renameSync(state.path, state.backupPath);
        state.backedUp = true;
      }
      renameSync(state.tempPath, state.path);
      state.installed = true;
    }
  } catch (error) {
    for (const state of [...states].reverse()) {
      if (state.installed && existsSync(state.path)) unlinkSync(state.path);
      if (state.backedUp && existsSync(state.backupPath)) renameSync(state.backupPath, state.path);
    }
    for (const state of states) {
      if (existsSync(state.tempPath)) unlinkSync(state.tempPath);
      if (existsSync(state.backupPath)) unlinkSync(state.backupPath);
    }
    for (const directory of [...new Set(createdDirectories)].reverse()) {
      try {
        rmdirSync(directory);
      } catch {
        // Keep non-empty or externally-created directories intact.
      }
    }
    throw error;
  }

  for (const state of states) {
    if (existsSync(state.backupPath)) unlinkSync(state.backupPath);
  }
}
