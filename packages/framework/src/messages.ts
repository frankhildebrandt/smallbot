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

export interface RegistrationPayload {
  kind: string;
  listenSocketPath: string;
  state?: ServiceState;
  capabilities?: string[];
  metadata?: Record<string, string>;
}

export interface RoutingStep {
  target: string;
  command: string;
}

export function createMessage(message: Omit<WireMessage, "i"> & Partial<Pick<WireMessage, "i">>): WireMessage {
  return {
    ...message,
    i: message.i ?? randomUUID(),
  };
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

export function stringifyWireMessage(message: WireMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseWireMessage(raw: string): WireMessage {
  const parsed: unknown = JSON.parse(raw);

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid wire message");
  }

  const candidate = parsed as Partial<WireMessage>;

  if (typeof candidate.s !== "string" || typeof candidate.i !== "string") {
    throw new Error("Invalid wire message");
  }

  return candidate as WireMessage;
}
