import { loadConfig } from "./config.js";
import { MessageBroker } from "./broker/MessageBroker.js";
import { SubprocessManager } from "./process/SubprocessManager.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const broker = new MessageBroker(config.brokerSocketPath);
  const manager = new SubprocessManager(
    broker,
    config.brokerSocketPath,
    config.runtimeDir,
    config.socketDir,
    config.modules,
    config.sandboxMode,
  );

  await broker.start();
  await manager.startAll();

  console.log(`[smallbot] broker listening on ${config.brokerSocketPath}`);
  console.log(`[smallbot] registered modules: ${config.modules.map((moduleConfig) => moduleConfig.name).join(", ") || "none"}`);

  const shutdown = async (): Promise<void> => {
    await manager.stopAll();
    await broker.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });

  process.once("SIGTERM", () => {
    void shutdown();
  });
}

void main().catch((error) => {
  console.error("[smallbot] startup failed", error);
  process.exit(1);
});
