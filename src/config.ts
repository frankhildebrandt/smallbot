import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { ManagedModuleConfig } from "./process/SubprocessManager.js";
import { SandboxMode } from "./process/bubblewrap.js";

export interface AppConfig {
  runtimeDir: string;
  socketDir: string;
  brokerSocketPath: string;
  sandboxMode: SandboxMode;
  modules: ManagedModuleConfig[];
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(): AppConfig {
  return loadConfigFromRoot(projectRoot);
}

export function loadConfigFromRoot(rootDir: string): AppConfig {
  const settings = readSettingsFile(path.join(rootDir, "settings.yml"));
  const runtimeDir = path.resolve(rootDir, settings.runtimeDir ?? process.env.SMALLBOT_RUNTIME_DIR ?? ".runtime");
  const socketDir = resolveSocketDir(rootDir, settings.socketDir);
  const brokerSocketPath = path.join(socketDir, "broker.sock");
  const sandboxMode = parseSandboxMode(settings.sandboxMode ?? process.env.SMALLBOT_SANDBOX_MODE ?? "auto");
  const modules = settings.services.map((service) => mapServiceToModule(rootDir, service));

  return {
    runtimeDir,
    socketDir,
    brokerSocketPath,
    sandboxMode,
    modules,
  };
}

function resolveSocketDir(rootDir: string, configuredSocketDir?: string): string {
  if (configuredSocketDir) {
    return path.resolve(rootDir, configuredSocketDir);
  }

  if (process.env.SMALLBOT_SOCKET_DIR) {
    return path.resolve(rootDir, process.env.SMALLBOT_SOCKET_DIR);
  }

  const suffix = createHash("sha1").update(rootDir).digest("hex").slice(0, 8);
  return process.platform === "win32"
    ? path.join(os.tmpdir(), `smallbot-${suffix}`)
    : path.join("/tmp", `sb-${suffix}`);
}

interface SettingsFile {
  runtimeDir?: string;
  socketDir?: string;
  sandboxMode?: string;
  services: SettingsService[];
}

interface SettingsService {
  name: string;
  kind: string;
  module: string;
  environment?: Record<string, string>;
  permissions: {
    networking: boolean;
  };
}

function readSettingsFile(filePath: string): SettingsFile {
  if (!existsSync(filePath)) {
    throw new Error(`Missing required settings file at ${filePath}`);
  }

  const raw = readFileSync(filePath, "utf8");
  const parsed = parse(raw);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("settings.yml must contain a top-level mapping");
  }

  return validateSettingsFile(parsed as Record<string, unknown>);
}

function validateSettingsFile(candidate: Record<string, unknown>): SettingsFile {
  assertAllowedKeys(candidate, ["runtimeDir", "socketDir", "sandboxMode", "services"], "settings.yml");

  if (!Array.isArray(candidate.services)) {
    throw new Error("settings.yml services must be an array");
  }

  return {
    runtimeDir: optionalString(candidate.runtimeDir, "runtimeDir"),
    socketDir: optionalString(candidate.socketDir, "socketDir"),
    sandboxMode: optionalString(candidate.sandboxMode, "sandboxMode"),
    services: candidate.services.map((service, index) => validateService(service, index)),
  };
}

function validateService(candidate: unknown, index: number): SettingsService {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error(`services[${index}] must be a mapping`);
  }

  const service = candidate as Record<string, unknown>;

  if ("enviroment" in service) {
    throw new Error(`services[${index}].enviroment is invalid; use environment`);
  }

  assertAllowedKeys(service, ["name", "kind", "module", "permissions", "environment"], `services[${index}]`);

  return {
    name: requiredString(service.name, `services[${index}].name`),
    kind: requiredString(service.kind, `services[${index}].kind`),
    module: requiredString(service.module, `services[${index}].module`),
    environment: optionalStringRecord(service.environment, `services[${index}].environment`),
    permissions: validatePermissions(service.permissions, index),
  };
}

function validatePermissions(candidate: unknown, index: number): SettingsService["permissions"] {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error(`services[${index}].permissions must be a mapping`);
  }

  const permissions = candidate as Record<string, unknown>;
  assertAllowedKeys(permissions, ["networking"], `services[${index}].permissions`);

  if (typeof permissions.networking !== "boolean") {
    throw new Error(`services[${index}].permissions.networking must be a boolean`);
  }

  return {
    networking: permissions.networking,
  };
}

function mapServiceToModule(rootDir: string, service: SettingsService): ManagedModuleConfig {
  const entryScript = path.resolve(rootDir, "module", service.module, "dist", "index.js");

  if (!existsSync(entryScript)) {
    throw new Error(`Configured module "${service.module}" does not exist at ${entryScript}`);
  }

  return {
    name: service.name,
    kind: service.kind,
    entryScript,
    env: service.environment,
    permissions: service.permissions,
  };
}

function parseSandboxMode(value: string): SandboxMode {
  if (value === "auto" || value === "bwrap" || value === "process") {
    return value;
  }

  throw new Error(`Invalid sandboxMode "${value}" in settings.yml`);
}

function assertAllowedKeys(candidate: Record<string, unknown>, allowedKeys: string[], label: string): void {
  const allowed = new Set(allowedKeys);
  const invalidKeys = Object.keys(candidate).filter((key) => !allowed.has(key));

  if (invalidKeys.length > 0) {
    throw new Error(`${label} contains unsupported keys: ${invalidKeys.join(", ")}`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string when provided`);
  }

  return value;
}

function optionalStringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }

  const entries = Object.entries(value);

  for (const [key, entryValue] of entries) {
    if (typeof entryValue !== "string") {
      throw new Error(`${label}.${key} must be a string`);
    }
  }

  return Object.fromEntries(entries);
}
