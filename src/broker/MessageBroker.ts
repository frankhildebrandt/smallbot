import net from "node:net";

import {
  RegistrationPayload,
  ServiceRecord,
  ServiceState,
  StatePayload,
  WireMessage,
  createMessage,
} from "../messages.js";
import { ServiceRegistry } from "../serviceRegistry.js";
import { attachWireListener, prepareSocketPath, sendWireMessage } from "../unixSockets.js";

const BROKER_NAME = "broker:1";

export class MessageBroker {
  readonly #registry = new ServiceRegistry();
  #server?: net.Server;

  constructor(private readonly socketPath: string) {}

  async start(): Promise<void> {
    await prepareSocketPath(this.socketPath);

    this.#server = net.createServer((socket) => {
      attachWireListener(socket, async (message) => {
        await this.handleMessage(message);
      });

      socket.on("error", (error) => {
        console.error("[smallbot] broker socket error", error);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.socketPath, () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (!this.#server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.#server?.close((error) => (error ? reject(error) : resolve()));
    });
  }

  listServices(): ServiceRecord[] {
    return this.#registry.list();
  }

  upsertService(service: ServiceRecord): void {
    this.#registry.upsert(service);
  }

  updateServiceState(name: string, state: ServiceState): void {
    const existing = this.#registry.get(name);

    if (!existing) {
      return;
    }

    this.#registry.upsert({
      ...existing,
      state,
      updatedAt: new Date().toISOString(),
    });
  }

  private async handleMessage(message: WireMessage): Promise<void> {
    if (message.c === "register") {
      this.registerService(message);
      return;
    }

    if (message.c === "state") {
      this.applyState(message);
      return;
    }

    if (message.d) {
      await this.handleDiscovery(message);
      return;
    }

    await this.route(message);
  }

  private registerService(message: WireMessage): void {
    const payload = parseRegistrationPayload(message.m);

    this.#registry.upsert({
      name: message.s,
      kind: payload.kind,
      listenSocketPath: payload.listenSocketPath,
      state: payload.state ?? "free",
      capabilities: payload.capabilities ?? [],
      metadata: payload.metadata ?? {},
      updatedAt: new Date().toISOString(),
      managed: true,
    });
  }

  private applyState(message: WireMessage): void {
    const payload = parseStatePayload(message.m);
    this.updateServiceState(message.s, payload.state);
  }

  private async handleDiscovery(message: WireMessage): Promise<void> {
    const services = this.#registry.find(message.d ?? "", message.q).map((service) => ({
      name: service.name,
      kind: service.kind,
      state: service.state,
      capabilities: service.capabilities,
    }));

    await this.reply(
      message.s,
      createMessage({
        s: BROKER_NAME,
        t: message.s,
        c: "discovery:result",
        i: message.i,
        m: { services, requestId: message.i },
      }),
    );
  }

  private async route(message: WireMessage): Promise<void> {
    const target = message.n ?? message.t;

    if (!target) {
      await this.replyError(message.s, "missing-target", message.i);
      return;
    }

    const service = this.#registry.get(target);

    if (!service) {
      await this.replyError(message.s, `unknown-target:${target}`, message.i);
      return;
    }

    await sendWireMessage(service.listenSocketPath, message);
  }

  private async reply(target: string, message: WireMessage): Promise<void> {
    const service = this.#registry.get(target);

    if (!service) {
      return;
    }

    await sendWireMessage(service.listenSocketPath, message);
  }

  private async replyError(target: string, reason: string, requestId: string): Promise<void> {
    await this.reply(
      target,
      createMessage({
        s: BROKER_NAME,
        t: target,
        c: "error",
        i: requestId,
        m: { reason, requestId },
      }),
    );
  }
}

function parseRegistrationPayload(payload: unknown): RegistrationPayload {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Invalid register payload");
  }

  const candidate = payload as Partial<RegistrationPayload>;

  if (typeof candidate.kind !== "string" || typeof candidate.listenSocketPath !== "string") {
    throw new Error("Invalid register payload");
  }

  return {
    kind: candidate.kind,
    listenSocketPath: candidate.listenSocketPath,
    state: candidate.state,
    capabilities: candidate.capabilities ?? [],
    metadata: candidate.metadata ?? {},
  };
}

function parseStatePayload(payload: unknown): StatePayload {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Invalid state payload");
  }

  const candidate = payload as Partial<StatePayload>;

  if (candidate.state !== "free" && candidate.state !== "busy" && candidate.state !== "stopped") {
    throw new Error("Invalid state payload");
  }

  return {
    state: candidate.state,
  };
}
