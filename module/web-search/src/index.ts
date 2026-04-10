import { ModuleRuntime } from "@smallbot/framework";

import { createSources } from "./sources/factory.js";
import { SearchAggregator } from "./searchAggregator.js";
import { WebSearchService } from "./service.js";

const serviceName = process.env.SERVICE_NAME ?? "search:1";
const serviceKind = process.env.SERVICE_KIND ?? "search";
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
  capabilities: ["web-search", "search", "info"],
  metadata: {
    dataPath,
  },
});

const aggregator = new SearchAggregator(createSources({ env: process.env }), serviceName);
const service = new WebSearchService(runtime, aggregator, serviceName);

await runtime.start(async (message) => {
  await service.onMessage(message);
});

console.log(`[module:${serviceName}] ready on ${listenSocketPath}`);
