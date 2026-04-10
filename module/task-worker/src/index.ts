import { ModuleRuntime, WireMessage } from "@smallbot/framework";

import { TaskWorkerService } from "./TaskWorkerService.js";
import type { WorkerAiToolName } from "./contracts.js";

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
const enabledTools = parseEnabledTools();

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
    enabledTools,
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

function parseEnabledTools(): Partial<Record<WorkerAiToolName, boolean>> {
  const toolEnvNames: Record<WorkerAiToolName, string> = {
    list_files: "WORKER_TOOL_LIST_FILES_ENABLED",
    read_file: "WORKER_TOOL_READ_FILE_ENABLED",
    write_file: "WORKER_TOOL_WRITE_FILE_ENABLED",
    search_files: "WORKER_TOOL_SEARCH_FILES_ENABLED",
    create_task: "WORKER_TOOL_CREATE_TASK_ENABLED",
    update_task: "WORKER_TOOL_UPDATE_TASK_ENABLED",
    list_tasks: "WORKER_TOOL_LIST_TASKS_ENABLED",
    web_search: "WORKER_TOOL_WEB_SEARCH_ENABLED",
    execute_typescript: "WORKER_TOOL_EXECUTE_TYPESCRIPT_ENABLED",
  };

  return Object.fromEntries(
    (Object.entries(toolEnvNames) as Array<[WorkerAiToolName, string]>)
      .flatMap(([toolName, envName]) => {
        const value = process.env[envName];
        if (value === undefined) {
          return [];
        }

        return [[toolName, parseBooleanEnv(value, envName)]];
      }),
  );
}

function parseBooleanEnv(value: string, envName: string): boolean {
  const normalized = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${envName} must be a boolean-like value`);
}
