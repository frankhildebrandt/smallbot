import { ModuleRuntime, WireMessage, createMessage } from "@smallbot/framework";

const serviceName = process.env.SERVICE_NAME ?? "ai:1";
const serviceKind = process.env.SERVICE_KIND ?? "ai";
const managerSocketPath = process.env.MANAGER_SOCKET_PATH;
const listenSocketPath = process.env.LISTEN_SOCKET_PATH;
const dataPath = process.env.DATA_PATH ?? "/data/persistent";
const responsePrefix = process.env.MODULE_RESPONSE_PREFIX ?? "smallbot-ai";

if (!managerSocketPath || !listenSocketPath) {
  throw new Error("MANAGER_SOCKET_PATH and LISTEN_SOCKET_PATH must be configured");
}

const runtime = new ModuleRuntime({
  name: serviceName,
  kind: serviceKind,
  managerSocketPath,
  listenSocketPath,
  capabilities: ["free", "inference", "demo"],
  metadata: {
    dataPath,
  },
});

await runtime.start(async (message) => {
  await handleMessage(message);
});

console.log(`[module:${serviceName}] ready on ${listenSocketPath}`);

async function handleMessage(message: WireMessage): Promise<void> {
  if (message.c !== "tool") {
    return;
  }

  await runtime.updateState("busy");

  const response = createMessage({
    s: serviceName,
    t: message.s,
    c: "result",
    m: {
      responder: serviceName,
      status: "ok",
      answer: `${responsePrefix}: ${String(message.m ?? "")}`,
      dataPath,
      requestId: message.i,
    },
  });

  await runtime.send(response);
  await runtime.updateState("free");
}
