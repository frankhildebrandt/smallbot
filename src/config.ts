import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ManagedModuleConfig } from "./process/SubprocessManager.js";
import { SandboxMode } from "./process/bubblewrap.js";

export interface AppConfig {
  runtimeDir: string;
  socketDir: string;
  brokerSocketPath: string;
  sandboxMode: SandboxMode;
  modules: ManagedModuleConfig[];
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(): AppConfig {
  const runtimeDir = path.resolve(projectRoot, process.env.SMALLBOT_RUNTIME_DIR ?? ".runtime");
  const socketDir = resolveSocketDir();
  const brokerSocketPath = path.join(socketDir, "broker.sock");
  const sandboxMode = (process.env.SMALLBOT_SANDBOX_MODE ?? "auto") as SandboxMode;
  const modules = process.env.SMALLBOT_DISABLE_MODULES === "1" ? [] : buildDefaultModules(projectRoot);

  return {
    runtimeDir,
    socketDir,
    brokerSocketPath,
    sandboxMode,
    modules,
  };
}

function resolveSocketDir(): string {
  if (process.env.SMALLBOT_SOCKET_DIR) {
    return path.resolve(projectRoot, process.env.SMALLBOT_SOCKET_DIR);
  }

  const suffix = createHash("sha1").update(projectRoot).digest("hex").slice(0, 8);
  return process.platform === "win32"
    ? path.join(os.tmpdir(), `smallbot-${suffix}`)
    : path.join("/tmp", `sb-${suffix}`);
}

function buildDefaultModules(rootDir: string): ManagedModuleConfig[] {
  return [
    {
      name: process.env.SMALLBOT_DEFAULT_AI_NAME ?? "ai:1",
      kind: "ai",
      entryScript: path.resolve(rootDir, process.env.SMALLBOT_AI_MODULE_PATH ?? "module/ai-free/dist/index.js"),
      capabilities: ["free", "inference", "demo"],
      env: {
        MODULE_RESPONSE_PREFIX: process.env.MODULE_RESPONSE_PREFIX ?? "smallbot-ai",
      },
    },
  ];
}
