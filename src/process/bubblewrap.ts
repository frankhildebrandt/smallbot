import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export type SandboxMode = "auto" | "bwrap" | "process";

export interface SpawnIsolatedNodeOptions {
  name: string;
  scriptPath: string;
  managerSocketPath: string;
  listenSocketPath: string;
  dataPath: string;
  env?: Record<string, string>;
  mode?: SandboxMode;
  permissions: ServicePermissions;
}

export interface ServicePermissions {
  networking: boolean;
}

export async function spawnIsolatedNode(options: SpawnIsolatedNodeOptions): Promise<ChildProcess> {
  const mode = await resolveSandboxMode(options.mode ?? "auto", options.permissions);

  return mode === "bwrap" ? spawnWithBubblewrap(options) : spawnDirectNode(options);
}

export async function resolveSandboxMode(
  mode: SandboxMode,
  permissions: ServicePermissions,
): Promise<Exclude<SandboxMode, "auto">> {
  if (!permissions.networking) {
    if (process.platform !== "linux") {
      throw new Error("permissions.networking=false requires Linux bubblewrap isolation");
    }

    if (!(await hasBubblewrap())) {
      throw new Error("permissions.networking=false requires bubblewrap to be installed");
    }

    return "bwrap";
  }

  if (mode === "process" || mode === "bwrap") {
    if (mode === "bwrap" && process.platform === "linux" && !(await hasBubblewrap())) {
      throw new Error("sandboxMode=bwrap requires bubblewrap to be installed");
    }

    if (mode === "bwrap" && process.platform !== "linux") {
      throw new Error("sandboxMode=bwrap is only supported on Linux");
    }

    return mode;
  }

  if (process.platform !== "linux") {
    return "process";
  }

  return (await hasBubblewrap()) ? "bwrap" : "process";
}

function hasBubblewrap(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("bwrap", ["--version"], { stdio: "ignore" });

    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function spawnDirectNode({
  name,
  scriptPath,
  managerSocketPath,
  listenSocketPath,
  dataPath,
  env = {},
}: SpawnIsolatedNodeOptions): ChildProcess {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: path.dirname(scriptPath),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SERVICE_NAME: name,
      MANAGER_SOCKET_PATH: managerSocketPath,
      LISTEN_SOCKET_PATH: listenSocketPath,
      DATA_PATH: dataPath,
      ...env,
    },
  });

  forwardChildLogs(name, child);
  return child;
}

function spawnWithBubblewrap({
  name,
  scriptPath,
  managerSocketPath,
  listenSocketPath,
  dataPath,
  env = {},
  permissions,
}: SpawnIsolatedNodeOptions): ChildProcess {
  const appDir = path.dirname(path.resolve(scriptPath));
  const nodeBinary = process.execPath;
  const socketDir = path.dirname(managerSocketPath);
  const args = [
    "--unshare-pid",
    "--unshare-ipc",
    ...(permissions.networking ? [] : ["--unshare-net"]),
    "--die-with-parent",
    "--clearenv",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/run",
    "--dir",
    "/data",
    "--dir",
    "/mnt",
    "--dir",
    "/run/sockets",
    ...readOnlyBind("/usr"),
    ...readOnlyBind("/bin"),
    ...readOnlyBind("/lib"),
    ...readOnlyBind("/lib64"),
    ...readOnlyBind("/usr/local"),
    "--ro-bind",
    appDir,
    "/app",
    "--bind",
    socketDir,
    "/run/sockets",
    "--bind",
    dataPath,
    "/mnt/data",
    "--symlink",
    "/mnt/data",
    "/data/persistent",
    "--chdir",
    "/app",
    "--setenv",
    "SERVICE_NAME",
    name,
    "--setenv",
    "MANAGER_SOCKET_PATH",
    `/run/sockets/${path.basename(managerSocketPath)}`,
    "--setenv",
    "LISTEN_SOCKET_PATH",
    `/run/sockets/${path.basename(listenSocketPath)}`,
    "--setenv",
    "DATA_PATH",
    "/data/persistent",
    ...Object.entries(env).flatMap(([key, value]) => ["--setenv", key, value]),
    nodeBinary,
    `/app/${path.basename(scriptPath)}`,
  ];

  const child = spawn("bwrap", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  forwardChildLogs(name, child);
  return child;
}

function readOnlyBind(targetPath: string): string[] {
  return [targetPath]
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .flatMap((candidate) => (existsSync(candidate) ? ["--ro-bind", candidate, candidate] : []));
}

function forwardChildLogs(name: string, child: ChildProcess): void {
  child.stdout?.on("data", (buffer) => {
    process.stdout.write(`[${name}] ${buffer.toString()}`);
  });

  child.stderr?.on("data", (buffer) => {
    process.stderr.write(`[${name}] ${buffer.toString()}`);
  });
}
