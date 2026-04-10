import { ModuleRuntime } from "@smallbot/framework";

import { createProvider } from "./providers/factory.js";
import { AiService } from "./service.js";

const serviceName = process.env.SERVICE_NAME ?? "ai:1";
const serviceKind = process.env.SERVICE_KIND ?? "ai";
const managerSocketPath = process.env.MANAGER_SOCKET_PATH;
const listenSocketPath = process.env.LISTEN_SOCKET_PATH;
const dataPath = process.env.DATA_PATH ?? "/data/persistent";

if (!managerSocketPath || !listenSocketPath) {
  throw new Error("MANAGER_SOCKET_PATH and LISTEN_SOCKET_PATH must be configured");
}

const runtime = new ModuleRuntime({
  name: serviceName,
  kind: serviceKind,
  managerSocketPath,
  listenSocketPath,
  capabilities: ["free", "inference", "completion", "tool-use"],
  metadata: {
    dataPath,
    provider: process.env.PROVIDER ?? "openai",
  },
});

const service = new AiService(runtime, createProvider({ serviceName, env: process.env }), serviceName, dataPath);

await runtime.start(async (message) => {
  await service.onMessage(message);
});

console.log(`[module:${serviceName}] ready on ${listenSocketPath}`);
