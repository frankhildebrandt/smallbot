import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MessageBroker } from "../broker/MessageBroker.js";
import { WireMessage, createMessage, parseWireMessage } from "../messages.js";
import { prepareSocketPath, sendWireMessage } from "../unixSockets.js";

test("broker preserves request id on discovery replies", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "smallbot-broker-test-"));
  const brokerSocketPath = path.join(tempDir, "broker.sock");
  const workerSocketPath = path.join(tempDir, "worker.sock");
  const broker = new MessageBroker(brokerSocketPath);

  t.after(async () => {
    await broker.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  await prepareSocketPath(workerSocketPath);
  const received = waitForSingleMessage(workerSocketPath);

  broker.upsertService({
    name: "worker:1",
    kind: "worker",
    listenSocketPath: workerSocketPath,
    state: "free",
    capabilities: [],
    metadata: {},
    updatedAt: new Date().toISOString(),
  });

  broker.upsertService({
    name: "ai:1",
    kind: "ai",
    listenSocketPath: path.join(tempDir, "ai.sock"),
    state: "free",
    capabilities: ["completion"],
    metadata: {},
    updatedAt: new Date().toISOString(),
  });

  await broker.start();

  const requestId = "discover-1";
  await sendWireMessage(
    brokerSocketPath,
    createMessage({
      s: "worker:1",
      d: "ai",
      q: "free",
      i: requestId,
    }),
  );

  const response = await received;
  assert.equal(response.c, "discovery:result");
  assert.equal(response.i, requestId);
  assert.deepEqual(response.m, {
    services: [{ name: "ai:1", kind: "ai", state: "free", capabilities: ["completion"] }],
    requestId,
  });
});

function waitForSingleMessage(socketPath: string): Promise<WireMessage> {
  return new Promise((resolve, reject) => {
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

          server.close();
          resolve(parseWireMessage(raw));
        }
      });
    });

    server.once("error", reject);
    server.listen(socketPath);
  });
}
