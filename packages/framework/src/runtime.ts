import net from "node:net";

import { RegistrationPayload, ServiceState, WireMessage, createMessage } from "./messages.js";
import { createWireServer, sendWireMessage } from "./unixSockets.js";

export interface ModuleRuntimeOptions {
  name: string;
  kind: string;
  managerSocketPath: string;
  listenSocketPath: string;
  capabilities?: string[];
  metadata?: Record<string, string>;
}

export interface ModuleContext {
  runtime: ModuleRuntime;
}

export class ModuleRuntime {
  #server?: net.Server;

  constructor(private readonly options: ModuleRuntimeOptions) {}

  async start(onMessage: (message: WireMessage, context: ModuleContext) => Promise<void> | void): Promise<void> {
    this.#server = await createWireServer(this.options.listenSocketPath, async (message) => {
      await onMessage(message, { runtime: this });
    });

    await this.register();
  }

  async stop(): Promise<void> {
    if (!this.#server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.#server?.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async register(): Promise<void> {
    const payload: RegistrationPayload = {
      kind: this.options.kind,
      listenSocketPath: this.options.listenSocketPath,
      state: "free",
      capabilities: this.options.capabilities,
      metadata: this.options.metadata,
    };

    await this.send(
      createMessage({
        s: this.options.name,
        c: "register",
        m: payload,
      }),
    );
  }

  async updateState(state: ServiceState): Promise<void> {
    await this.send(
      createMessage({
        s: this.options.name,
        c: "state",
        m: { state },
      }),
    );
  }

  async send(message: WireMessage): Promise<void> {
    await sendWireMessage(this.options.managerSocketPath, message);
  }

  async respond(target: string, payload: unknown, command = "result"): Promise<void> {
    await this.send(
      createMessage({
        s: this.options.name,
        t: target,
        c: command,
        m: payload,
      }),
    );
  }
}
