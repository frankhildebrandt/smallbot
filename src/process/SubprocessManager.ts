import { ChildProcess } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { MessageBroker } from "../broker/MessageBroker.js";
import { sanitizeServiceName } from "../messages.js";
import { SandboxMode, spawnIsolatedNode } from "./bubblewrap.js";

export interface ManagedModuleConfig {
  name: string;
  kind: string;
  entryScript: string;
  capabilities?: string[];
  env?: Record<string, string>;
  permissions: {
    networking: boolean;
  };
}

interface ManagedChild {
  process: ChildProcess;
  config: ManagedModuleConfig;
}

export class SubprocessManager {
  readonly #children = new Map<string, ManagedChild>();
  #stopping = false;

  constructor(
    private readonly broker: MessageBroker,
    private readonly brokerSocketPath: string,
    private readonly runtimeDir: string,
    private readonly socketDir: string,
    private readonly modules: ManagedModuleConfig[],
    private readonly sandboxMode: SandboxMode,
  ) {}

  async startAll(): Promise<void> {
    await mkdir(this.runtimeDir, { recursive: true });
    await mkdir(this.socketDir, { recursive: true });
    await mkdir(path.join(this.runtimeDir, "data"), { recursive: true });

    for (const moduleConfig of this.modules) {
      await this.startModule(moduleConfig);
    }
  }

  async stopAll(): Promise<void> {
    this.#stopping = true;

    await Promise.all(
      Array.from(this.#children.values()).map(async ({ process: child, config }) => {
        if (!child.killed) {
          child.kill("SIGTERM");
        }

        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          setTimeout(resolve, 2_000).unref();
        });

        this.broker.updateServiceState(config.name, "stopped");
      }),
    );
  }

  private async startModule(config: ManagedModuleConfig): Promise<void> {
    const slug = sanitizeServiceName(config.name);
    const dataPath = path.join(this.runtimeDir, "data", slug);
    const listenSocketPath = path.join(this.socketDir, `${slug}.sock`);

    await mkdir(dataPath, { recursive: true });
    await rm(listenSocketPath, { force: true });

    this.broker.upsertService({
      name: config.name,
      kind: config.kind,
      listenSocketPath,
      state: "busy",
      capabilities: config.capabilities ?? [],
      metadata: {},
      updatedAt: new Date().toISOString(),
      managed: true,
    });

    const child = await spawnIsolatedNode({
      name: config.name,
      scriptPath: config.entryScript,
      managerSocketPath: this.brokerSocketPath,
      listenSocketPath,
      dataPath,
      env: {
        SERVICE_KIND: config.kind,
        ...config.env,
      },
      permissions: config.permissions,
      mode: this.sandboxMode,
    });

    child.on("exit", () => {
      this.#children.delete(config.name);
      this.broker.updateServiceState(config.name, "stopped");

      if (!this.#stopping) {
        console.error(`[smallbot] module stopped: ${config.name}`);
      }
    });

    this.#children.set(config.name, {
      process: child,
      config,
    });
  }
}
