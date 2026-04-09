import { randomUUID } from "node:crypto";

export type ServiceState = "free" | "busy" | "stopped";

export interface WireMessage {
  s: string;
  t?: string;
  m?: unknown;
  c?: string;
  i: string;
  v?: string;
  n?: string;
  d?: string;
  q?: string;
}

export interface RoutingStep {
  target: string;
  command: string;
}

export interface RegistrationPayload {
  kind: string;
  listenSocketPath: string;
  state?: ServiceState;
  capabilities?: string[];
  metadata?: Record<string, string>;
}

export interface StatePayload {
  state: ServiceState;
}

export interface ServiceRecord {
  name: string;
  kind: string;
  listenSocketPath: string;
  state: ServiceState;
  capabilities: string[];
  metadata: Record<string, string>;
  updatedAt: string;
  managed?: boolean;
}

export function createMessage(message: Omit<WireMessage, "i"> & Partial<Pick<WireMessage, "i">>): WireMessage {
  return {
    ...message,
    i: message.i ?? randomUUID(),
  };
}

export function sanitizeServiceName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export function parseVia(via?: string): RoutingStep[] {
  if (!via) {
    return [];
  }

  return via
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.lastIndexOf(":");

      if (separator <= 0 || separator === entry.length - 1) {
        throw new Error(`Invalid routing step: ${entry}`);
      }

      return {
        target: entry.slice(0, separator),
        command: entry.slice(separator + 1),
      };
    });
}

export function advanceRoute(message: WireMessage, currentTarget: string): WireMessage {
  const steps = parseVia(message.v);

  if (!steps.length) {
    return {
      ...message,
      n: message.t,
    };
  }

  const currentIndex = steps.findIndex((step) => step.target === currentTarget);
  const nextStep = currentIndex >= 0 ? steps[currentIndex + 1] : steps[0];

  return {
    ...message,
    n: nextStep?.target ?? message.t,
  };
}

export function parseWireMessage(raw: string): WireMessage {
  const parsed: unknown = JSON.parse(raw);

  if (!isWireMessage(parsed)) {
    throw new Error("Invalid wire message");
  }

  return parsed;
}

export function stringifyWireMessage(message: WireMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function isWireMessage(value: unknown): value is WireMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<WireMessage>;

  return typeof candidate.s === "string" && typeof candidate.i === "string";
}
