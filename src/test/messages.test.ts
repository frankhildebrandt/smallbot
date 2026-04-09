import assert from "node:assert/strict";
import test from "node:test";

import { advanceRoute, createMessage, parseVia } from "../messages.js";
import { ServiceRegistry } from "../serviceRegistry.js";

test("parseVia splits routing steps", () => {
  assert.deepEqual(parseVia("rag:1:enrich,comp:1:normalize"), [
    { target: "rag:1", command: "enrich" },
    { target: "comp:1", command: "normalize" },
  ]);
});

test("advanceRoute moves to next hop and then final target", () => {
  const routed = createMessage({
    s: "agt:1",
    t: "ai:1",
    n: "rag:1",
    v: "rag:1:enrich,comp:1:normalize",
    c: "tool",
    m: "payload",
  });

  assert.equal(advanceRoute(routed, "rag:1").n, "comp:1");
  assert.equal(advanceRoute(routed, "comp:1").n, "ai:1");
});

test("service registry filters by type and query", () => {
  const registry = new ServiceRegistry();

  registry.upsert({
    name: "ai:1",
    kind: "ai",
    listenSocketPath: "/tmp/ai-1.sock",
    state: "free",
    capabilities: ["demo", "free"],
    metadata: {},
    updatedAt: new Date().toISOString(),
  });

  registry.upsert({
    name: "rag:1",
    kind: "rag",
    listenSocketPath: "/tmp/rag-1.sock",
    state: "busy",
    capabilities: ["enrich"],
    metadata: {},
    updatedAt: new Date().toISOString(),
  });

  assert.equal(registry.find("ai", "free").length, 1);
  assert.equal(registry.find("rag", "free").length, 0);
});
