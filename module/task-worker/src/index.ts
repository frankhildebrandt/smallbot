import { ModuleRuntime, WireMessage } from "@smallbot/framework";

import { TaskWorkerService } from "./TaskWorkerService.js";

const serviceName = process.env.SERVICE_NAME ?? "worker:1";
const serviceKind = process.env.SERVICE_KIND ?? "worker";
const managerSocketPath = process.env.MANAGER_SOCKET_PATH;
const listenSocketPath = process.env.LISTEN_SOCKET_PATH;
const dataPath = process.env.DATA_PATH ?? "/data/persistent";
const aiKind = process.env.WORKER_AI_KIND ?? "ai";
const aiTarget = process.env.WORKER_AI_TARGET;
const searchKind = process.env.WORKER_SEARCH_KIND ?? "search";
const searchTarget = process.env.WORKER_SEARCH_TARGET;
const messageBusTimeoutMs = parseOptionalInteger(process.env.WORKER_MESSAGE_BUS_TIMEOUT_MS);

if (!managerSocketPath || !listenSocketPath) {
  throw new Error("MANAGER_SOCKET_PATH and LISTEN_SOCKET_PATH must be configured");
}

const runtime = new ModuleRuntime({
  name: serviceName,
  kind: serviceKind,
  managerSocketPath,
  listenSocketPath,
  capabilities: ["task-worker", "typescript-eval", "progress-reporting"],
  metadata: {
    dataPath,
    aiKind,
    searchKind,
    ...(aiTarget ? { aiTarget } : {}),
    ...(searchTarget ? { searchTarget } : {}),
  },
});

const worker = new TaskWorkerService(
  {
    serviceName,
    updateState: (state) => runtime.updateState(state),
    send: (message: WireMessage) => runtime.send(message),
  },
  {
    dataPath,
    aiKind,
    aiTarget,
    searchKind,
    searchTarget,
    messageBusTimeoutMs,
  },
);

await runtime.start(async (message) => {
  await worker.onMessage(message);
});

await worker.startWatching();

console.log(`[module:${serviceName}] ready on ${listenSocketPath}`);

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("WORKER_MESSAGE_BUS_TIMEOUT_MS must be a positive integer");
  }

  return parsed;
}
