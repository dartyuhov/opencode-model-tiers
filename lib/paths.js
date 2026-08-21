import { homedir } from "node:os";
import { join } from "node:path";

export function configDirectory(env = process.env) {
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
}

export function modelStatePath(env = process.env) {
  return join(
    env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "opencode",
    "model.json",
  );
}
