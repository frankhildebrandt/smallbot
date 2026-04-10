import readline from "node:readline";

import { loadConfig } from "./config.js";
import { MessageBroker } from "./broker/MessageBroker.js";
import { SubprocessManager } from "./process/SubprocessManager.js";
import { QuitDetector } from "./quitDetector.js";

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
  console.log("[smallbot] host tui ready, enter /quit or press ESC twice to stop all modules and exit");

  const tui = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let shuttingDown = false;
  const quitDetector = new QuitDetector();

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    tui.close();

    await manager.stopAll();
    await broker.stop();
    process.exit(0);
  };

  tui.on("line", (input) => {
    const command = input.trim();

    if (command === "/quit") {
      void shutdown();
      return;
    }

    if (command.length > 0) {
      console.log(`[smallbot] unknown command: ${command}`);
    }
  });

  readline.emitKeypressEvents(process.stdin, tui);
  if (process.stdin.isTTY) {
    process.stdin.on("keypress", (_str, key) => {
      if (key.sequence && quitDetector.registerKeypress(key.sequence)) {
        void shutdown();
      }
    });
  }

  tui.on("close", () => {
    if (!shuttingDown) {
      void shutdown();
    }
  });

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
