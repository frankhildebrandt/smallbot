import net from "node:net";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { WireMessage, parseWireMessage, stringifyWireMessage } from "./messages.js";

export async function prepareSocketPath(socketPath: string): Promise<void> {
  await mkdir(path.dirname(socketPath), { recursive: true });
  await rm(socketPath, { force: true });
}

export async function sendWireMessage(socketPath: string, message: WireMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const client = net.createConnection(socketPath);

    client.on("connect", () => {
      client.end(stringifyWireMessage(message));
    });

    client.on("close", () => resolve());
    client.on("error", reject);
  });
}

export function createWireServer(
  socketPath: string,
  onMessage: (message: WireMessage) => Promise<void> | void,
): Promise<net.Server> {
  return new Promise(async (resolve, reject) => {
    await prepareSocketPath(socketPath);

    const server = net.createServer((socket) => {
      let buffer = "";

      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;

        while (buffer.includes("\n")) {
          const separator = buffer.indexOf("\n");
          const raw = buffer.slice(0, separator).trim();

          buffer = buffer.slice(separator + 1);

          if (!raw) {
            continue;
          }

          Promise.resolve(onMessage(parseWireMessage(raw))).catch((error) => {
            console.error("[smallbot-framework] incoming message failed", error);
          });
        }
      });
    });

    server.once("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}
