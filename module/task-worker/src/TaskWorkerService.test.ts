import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WireMessage } from "@smallbot/framework";

import { TaskWorkerService } from "./TaskWorkerService.js";
import { WorkerRuntime } from "./contracts.js";

class RuntimeStub implements WorkerRuntime {
  readonly sent: WireMessage[] = [];
  readonly states: Array<"free" | "busy" | "stopped"> = [];
  onSend?: (message: WireMessage) => boolean | void;

  constructor(readonly serviceName: string) {}

  async updateState(state: "free" | "busy" | "stopped"): Promise<void> {
    this.states.push(state);
  }

  async send(message: WireMessage): Promise<void> {
    const shouldStore = this.onSend?.(message);
    if (shouldStore !== false) {
      this.sent.push(message);
    }
  }
}

async function createDataDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "smallbot-task-worker-"));
}

function createAiFiles(
  appContent: string,
  todoContent = "# TODO\n- [x] Review existing app\n",
): Array<{ path: string; content: string }> {
  return [
    {
      path: "app/index.ts",
      content: appContent,
    },
    {
      path: "todo.md",
      content: todoContent,
    },
  ];
}

async function waitForAiTool(runtime: RuntimeStub, count: number, target = "ai:1", timeoutMs = 4_000): Promise<WireMessage> {
  await waitFor(() => runtime.sent.filter((message) => message.t === target && message.c === "tool").length >= count, timeoutMs);
  return runtime.sent.filter((message) => message.t === target && message.c === "tool")[count - 1]!;
}

async function replyWithTodoPlan(
  service: TaskWorkerService,
  request: WireMessage,
  target = "ai:1",
  todo = "# TODO\n- [x] Review existing app\n",
): Promise<void> {
  await service.onMessage({
    s: target,
    t: "worker:1",
    c: "result",
    i: request.i,
    m: {
      todo,
    },
  });
}

function enableAutoTodoPlanner(service: TaskWorkerService, runtime: RuntimeStub): void {
  runtime.onSend = (message) => {
    if (message.c !== "tool" || typeof message.t !== "string" || !message.t.startsWith("ai:")) {
      return true;
    }

    const payload = JSON.stringify(message.m);
    if (!payload.includes("Return only todo.md content")) {
      return true;
    }

    queueMicrotask(() => {
      void service.onMessage({
        s: message.t!,
        t: "worker:1",
        c: "result",
        i: message.i,
        m: {
          todo: "# TODO\n- [x] Review existing app\n",
        },
      });
    });

    return false;
  };
}

test("worker reports missing task.md and returns to free", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  await service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-1",
  });

  assert.deepEqual(runtime.states, ["busy", "free"]);
  assert.equal(runtime.sent.at(-1)?.c, "error");
  assert.match(String((runtime.sent.at(-1)?.m as { reason?: string })?.reason), /Missing task\.md/);
});

test("worker uses an existing app first when it already solves the task", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await mkdir(path.join(dataPath, "app"), { recursive: true });
  await writeFile(path.join(dataPath, "task.md"), "reuse existing app", "utf8");
  await writeFile(path.join(dataPath, "app", "index.ts"), `export default async function run(host) {
  await host.writeFile("result.md", "already done");
  await host.completeTask({ summary: "existing app worked", resultFile: "result.md" });
}
`, "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-existing-1",
  });

  await waitFor(() => runtime.sent.some((message) => message.t === "ai:1" && message.c === "tool"));
  const verificationRequest = runtime.sent.find((message) => message.t === "ai:1" && message.c === "tool");
  assert.ok(verificationRequest);
  assert.match(JSON.stringify(verificationRequest!.m), /existing app worked/);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest!.i,
    m: { answer: "VALID: existing app already solved the task" },
  });

  await runPromise;

  assert.equal(runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length, 1);
  assert.match(await readFile(path.join(dataPath, "result.json"), "utf8"), /existing app worked/);
  await assert.rejects(access(path.join(dataPath, "todo.md")));
});

test("worker generates app, writes progress and completes task", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "# solve\nWrite memory and result\n", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-2",
  });

  const aiRequest = await waitForAiTool(runtime, 1);
  assert.ok(aiRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: aiRequest!.i,
    m: {
      files: createAiFiles(`export default async function run(host) {
  const task = await host.readTask();
  await host.writeMemory("remembered");
  await host.appendProgress({ phase: "app", message: "working", updatedFiles: ["memory.md"] });
  await host.writeFile("result.md", task.toUpperCase());
  await host.completeTask({ summary: "done", resultFile: "result.md" });
}
`),
    },
  });

  const verificationRequest = await waitForAiTool(runtime, 2);
  assert.ok(verificationRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest!.i,
    m: {
      answer: "Verification: result matches task",
    },
  });

  await runPromise;

  assert.deepEqual(runtime.states, ["busy", "free"]);
  assert.ok(runtime.sent.some((message) => message.c === "progress"));
  assert.ok(runtime.sent.some((message) => message.c === "result"));
  assert.equal(await readFile(path.join(dataPath, "memory.md"), "utf8"), "remembered");
  assert.match(await readFile(path.join(dataPath, "logs", "progress.log"), "utf8"), /working/);
  assert.match(await readFile(path.join(dataPath, "result.json"), "utf8"), /"success": true/);
  assert.match(await readFile(path.join(dataPath, "result.json"), "utf8"), /Verification: result matches task/);
  assert.equal(await readFile(path.join(dataPath, "result.md"), "utf8"), "# SOLVE\nWRITE MEMORY AND RESULT\n");
});

test("worker watches storage and starts when task.md appears", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  t.after(async () => {
    await service.stopWatching();
    await rm(dataPath, { recursive: true, force: true });
  });

  await service.startWatching();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await writeFile(path.join(dataPath, "task.md"), "watch task", "utf8");

  const aiRequest = await waitForAiTool(runtime, 1);
  assert.ok(aiRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: aiRequest!.i,
    m: {
      files: createAiFiles(`export default async function run(host) {
  await host.completeTask({ summary: "watched", resultFile: "result.md" });
}
`),
    },
  });

  const verificationRequest = await waitForAiTool(runtime, 2);
  assert.ok(verificationRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest!.i,
    m: { answer: "verified watched" },
  });

  await waitFor(() => runtime.states.join(",") === "busy,free");
  assert.deepEqual(runtime.states, ["busy", "free"]);
  assert.match(await readFile(path.join(dataPath, "logs", "progress.log"), "utf8"), /Detected task\.md in storage/);
  assert.match(await readFile(path.join(dataPath, "result.json"), "utf8"), /"summary": "watched"/);

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length, 2);
});

test("worker only clears tmp when a new task.md is detected", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "memory.md"), "old memory", "utf8");
  await writeFile(path.join(dataPath, "result.json"), "{\"old\":true}", "utf8");
  await mkdir(path.join(dataPath, "tmp"), { recursive: true });
  await writeFile(path.join(dataPath, "tmp", "old.txt"), "transient", "utf8");
  await mkdir(path.join(dataPath, "app", "nested"), { recursive: true });
  await writeFile(path.join(dataPath, "app", "nested", "old.ts"), "export {};\n", "utf8");

  t.after(async () => {
    await service.stopWatching();
    await rm(dataPath, { recursive: true, force: true });
  });

  await service.startWatching();
  await writeFile(path.join(dataPath, "task.md"), "fresh task", "utf8");

  const aiRequest = await waitForAiTool(runtime, 1);
  assert.ok(aiRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: aiRequest!.i,
    m: {
      files: createAiFiles(`export default async function run(host) {
  await host.completeTask("fresh");
}
`),
    },
  });

  const verificationRequest = await waitForAiTool(runtime, 2);
  assert.ok(verificationRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest!.i,
    m: { answer: "verified fresh" },
  });

  await waitFor(() => runtime.states.join(",") === "busy,free");
  assert.equal(await readFile(path.join(dataPath, "memory.md"), "utf8"), "old memory");
  assert.equal(await readFile(path.join(dataPath, "app", "nested", "old.ts"), "utf8"), "export {};\n");
  await assert.rejects(access(path.join(dataPath, "tmp", "old.txt")));
  assert.equal(await readFile(path.join(dataPath, "task.md"), "utf8"), "fresh task");
  assert.match(await readFile(path.join(dataPath, "result.json"), "utf8"), /"summary": "fresh"/);
});

test("worker can discover a free ai target before sending the tool call", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "use discovery", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-3",
  });

  await waitFor(() => runtime.sent.some((message) => message.d === "ai"));
  const discovery = runtime.sent.find((message) => message.d === "ai");
  assert.ok(discovery);

  await service.onMessage({
    s: "broker:1",
    t: "worker:1",
    c: "discovery:result",
    i: discovery!.i,
    m: {
      services: [{ name: "ai:9" }],
    },
  });

  await waitFor(() => runtime.sent.some((message) => message.t === "ai:9" && message.c === "tool"));
  const aiRequest = runtime.sent.find((message) => message.t === "ai:9" && message.c === "tool");
  assert.ok(aiRequest);

  await service.onMessage({
    s: "ai:9",
    t: "worker:1",
    c: "result",
    i: aiRequest!.i,
    m: {
      files: createAiFiles(`export default async function run(host) {
  await host.completeTask({ summary: "ok", resultFile: "result.md" });
}
`),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:9" && message.c === "tool").length >= 2);
  const verificationRequest = runtime.sent.filter((message) => message.t === "ai:9" && message.c === "tool").at(-1);
  assert.ok(verificationRequest);
  await service.onMessage({
    s: "ai:9",
    t: "worker:1",
    c: "result",
    i: verificationRequest!.i,
    m: { answer: "verified ok" },
  });

  await runPromise;
  assert.ok(runtime.sent.some((message) => message.t === "ai:9" && message.c === "tool"));
});

test("worker retries ai discovery when the first discovery request is dropped", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", messageBusTimeoutMs: 50 });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "retry discovery", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-4",
  });

  await waitFor(() => runtime.sent.filter((message) => message.d === "ai").length >= 1);
  const firstDiscoveryCount = runtime.sent.filter((message) => message.d === "ai").length;
  assert.equal(firstDiscoveryCount, 1);

  await waitFor(() => runtime.sent.filter((message) => message.d === "ai").length >= 2, 1_000);
  const discoveryMessages = runtime.sent.filter((message) => message.d === "ai");
  const retryDiscovery = discoveryMessages.at(-1);
  assert.ok(retryDiscovery);

  await service.onMessage({
    s: "broker:1",
    t: "worker:1",
    c: "discovery:result",
    i: retryDiscovery!.i,
    m: {
      services: [{ name: "ai:7" }],
    },
  });

  await waitFor(() => runtime.sent.some((message) => message.t === "ai:7" && message.c === "tool"));
  const aiRequest = runtime.sent.find((message) => message.t === "ai:7" && message.c === "tool");
  assert.ok(aiRequest);

  await service.onMessage({
    s: "ai:7",
    t: "worker:1",
    c: "result",
    i: aiRequest!.i,
    m: {
      files: createAiFiles(`export default async function run(host) {
  await host.completeTask({ summary: "retried", resultFile: "result.md" });
}
`),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:7" && message.c === "tool").length >= 2);
  const verificationRequest = runtime.sent.filter((message) => message.t === "ai:7" && message.c === "tool").at(-1);
  assert.ok(verificationRequest);
  await service.onMessage({
    s: "ai:7",
    t: "worker:1",
    c: "result",
    i: verificationRequest!.i,
    m: { answer: "verified retried" },
  });

  await runPromise;
  assert.ok(runtime.sent.filter((message) => message.d === "ai").length >= 2);
  assert.ok(runtime.sent.some((message) => message.t === "ai:7" && message.c === "tool"));
});

test("worker host accepts shorthand progress and completion payloads", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "use shorthand", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-5",
  });

  await waitFor(() => runtime.sent.some((message) => message.t === "ai:1" && message.c === "tool"));
  const aiRequest = runtime.sent.find((message) => message.t === "ai:1" && message.c === "tool");
  assert.ok(aiRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: aiRequest!.i,
    m: {
      files: createAiFiles(`export default async function run(host) {
  await host.appendProgress("time: 12:34:56");
  await host.completeTask("12:34:56");
}
`),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 2);
  const verificationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").at(-1);
  assert.ok(verificationRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest!.i,
    m: { answer: "verified shorthand" },
  });

  await runPromise;

  assert.match(await readFile(path.join(dataPath, "logs", "progress.log"), "utf8"), /app: time: 12:34:56/);
  assert.match(await readFile(path.join(dataPath, "result.json"), "utf8"), /"summary": "12:34:56"/);
});

test("worker host can use configured search module from generated app code", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, {
    dataPath,
    aiKind: "ai",
    aiTarget: "ai:1",
    searchTarget: "search:1",
  });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "search for berlin", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-search-1",
  });

  await waitFor(() => runtime.sent.some((message) => message.t === "ai:1" && message.c === "tool"));
  const generationRequest = runtime.sent.find((message) => message.t === "ai:1" && message.c === "tool");
  assert.ok(generationRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: generationRequest!.i,
    m: {
      files: createAiFiles(`export default async function run(host) {
  const response = await host.search({ query: "Berlin news", limit: 1 });
  await host.writeFile("result.md", response.results[0]?.title ?? "none");
  await host.completeTask({ summary: "searched", resultFile: "result.md" });
}
`),
    },
  });

  await waitFor(() => runtime.sent.some((message) => message.t === "search:1" && message.c === "tool"));
  const searchRequest = runtime.sent.find((message) => message.t === "search:1" && message.c === "tool");
  assert.ok(searchRequest);
  assert.equal((searchRequest!.m as { query?: string }).query, "Berlin news");

  await service.onMessage({
    s: "search:1",
    t: "worker:1",
    c: "result",
    i: searchRequest!.i,
    m: {
      requestId: searchRequest!.i,
      responder: "search:1",
      status: "ok",
      type: "search",
      query: "Berlin news",
      results: [
        {
          url: "https://example.com/berlin",
          normalizedUrl: "https://example.com/berlin",
          title: "Berlin result",
          snippet: "Example snippet",
          source: "example",
          rank: 1,
        },
      ],
      sourcesTried: ["example"],
      sourcesSucceeded: ["example"],
      sourcesFailed: [],
      dedupe: {
        inputCount: 1,
        uniqueCount: 1,
        removedCount: 0,
      },
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 2);
  const verificationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").at(-1);
  assert.ok(verificationRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest!.i,
    m: { answer: "VALID: searched" },
  });

  await runPromise;

  assert.equal(await readFile(path.join(dataPath, "result.md"), "utf8"), "Berlin result");
  assert.match(await readFile(path.join(dataPath, "result.json"), "utf8"), /"summary": "searched"/);
});

test("worker retries after app execution errors and keeps going until repair succeeds", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "keep going", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-6",
  });

  await waitFor(() => runtime.sent.some((message) => message.t === "ai:1" && message.c === "tool"));
  const firstAiRequest = runtime.sent.find((message) => message.t === "ai:1" && message.c === "tool");
  assert.ok(firstAiRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: firstAiRequest!.i,
    m: {
      files: createAiFiles(`export default async function run(host) {
  await host.appendProgress("ai: Requesting weather answer");
  const value = { now: "12:00" };
  await host.completeTask(value.trim());
}
`),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 2, 4_000);
  const memoryRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[1];
  assert.ok(memoryRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: memoryRequest.i,
    m: { answer: "Remember trim failed on object value." },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 3, 4_000);
  const repairRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[2];
  assert.ok(repairRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: repairRequest!.i,
    m: {
      files: createAiFiles(`export default async function run(host) {
  await host.writeFile("result.md", "repaired");
  await host.completeTask("repaired");
}
`),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 4);
  const verificationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").at(-1);
  assert.ok(verificationRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest!.i,
    m: { answer: "verified repaired" },
  });

  await runPromise;

  assert.match(await readFile(path.join(dataPath, "logs", "progress.log"), "utf8"), /Attempt 1 failed: .*trim is not a function/);
  assert.match(await readFile(path.join(dataPath, "result.json"), "utf8"), /"summary": "repaired"/);
});

test("worker retries after AI response timeout instead of stopping", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, {
    dataPath,
    aiKind: "ai",
    aiTarget: "ai:1",
    messageBusTimeoutMs: 50,
  });
  enableAutoTodoPlanner(service, runtime);
  const previousRetryDelay = TaskWorkerService.RUN_RETRY_DELAY_MS;

  await writeFile(path.join(dataPath, "task.md"), "retry ai timeout", "utf8");

  (TaskWorkerService as unknown as { RUN_RETRY_DELAY_MS: number }).RUN_RETRY_DELAY_MS = 20;

  t.after(async () => {
    (TaskWorkerService as unknown as { RUN_RETRY_DELAY_MS: number }).RUN_RETRY_DELAY_MS = previousRetryDelay;
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-7",
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 1);
  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 2, 1_000);
  const memoryRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[1];
  assert.ok(memoryRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: memoryRequest.i,
    m: { answer: "Remember the previous AI request timed out." },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 3, 1_000);
  const secondRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[2];
  assert.ok(secondRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: secondRequest!.i,
    m: {
      files: createAiFiles(`export default async function run(host) {
  await host.completeTask("timeout recovered");
}
`),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 4, 1_000);
  const verificationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").at(-1);
  assert.ok(verificationRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest!.i,
    m: { answer: "verified timeout recovered" },
  });

  await runPromise;

  assert.match(await readFile(path.join(dataPath, "logs", "progress.log"), "utf8"), /Timed out waiting for AI response/);
  assert.match(await readFile(path.join(dataPath, "result.json"), "utf8"), /timeout recovered/);
});

test("worker retries until verification returns a valid verdict", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "needs verified result", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-7b",
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 1);
  const firstGenerationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[0];
  assert.ok(firstGenerationRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: firstGenerationRequest.i,
    m: {
      files: createAiFiles(`export default async function run(host) {
  await host.completeTask("first result");
}
`),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 2);
  const firstVerificationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[1];
  assert.ok(firstVerificationRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: firstVerificationRequest.i,
    m: {
      answer: "INVALID: result does not satisfy the task yet",
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 3, 4_000);
  const memoryRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[2];
  assert.ok(memoryRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: memoryRequest.i,
    m: {
      answer: "Remember: previous result was rejected because it did not satisfy the task.",
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 4, 4_000);
  const repairRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[3];
  assert.ok(repairRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: repairRequest.i,
    m: {
      files: createAiFiles(`export default async function run(host) {
  await host.writeFile("result.md", "fixed");
  await host.completeTask({ summary: "fixed result", resultFile: "result.md" });
}
`),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 5, 4_000);
  const secondVerificationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[4];
  assert.ok(secondVerificationRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: secondVerificationRequest.i,
    m: {
      answer: "VALID: verified fixed result",
    },
  });

  await runPromise;

  assert.match(await readFile(path.join(dataPath, "logs", "progress.log"), "utf8"), /Verification rejected result/);
  assert.match(await readFile(path.join(dataPath, "result.json"), "utf8"), /"summary": "fixed result"/);
  assert.match(await readFile(path.join(dataPath, "result.json"), "utf8"), /VALID: verified fixed result/);
});

test("worker synthesizes memory.md after a failed attempt and reuses it on repair", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "use failure memory", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-7c",
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 1);
  const firstGenerationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[0];
  assert.ok(firstGenerationRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: firstGenerationRequest.i,
    m: {
      files: createAiFiles(`export default async function run(host) {
  throw new Error("boom");
}
`),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 2, 4_000);
  const memoryRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[1];
  assert.ok(memoryRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: memoryRequest.i,
    m: {
      answer: "Remember: previous run threw boom; avoid throwing and write a stable result file.",
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 3, 4_000);
  const repairRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[2];
  assert.ok(repairRequest);
  assert.match(JSON.stringify(repairRequest.m), /previous run threw boom/i);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: repairRequest.i,
    m: {
      files: createAiFiles(`export default async function run(host) {
  await host.writeFile("result.md", "ok");
  await host.completeTask({ summary: "ok", resultFile: "result.md" });
}
`),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 4, 4_000);
  const verificationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[3];
  assert.ok(verificationRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest.i,
    m: {
      answer: "VALID: repaired with synthesized memory",
    },
  });

  await runPromise;

  assert.equal(
    await readFile(path.join(dataPath, "memory.md"), "utf8"),
    "Remember: previous run threw boom; avoid throwing and write a stable result file.",
  );
  assert.match(await readFile(path.join(dataPath, "logs", "progress.log"), "utf8"), /Updated memory\.md from failed attempt/);
});

test("worker logs used AI tools to tools.log", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "log tools", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-8",
  });

  await waitFor(() => runtime.sent.some((message) => message.t === "ai:1" && message.c === "tool"));
  const firstAiRequest = runtime.sent.find((message) => message.t === "ai:1" && message.c === "tool");
  assert.ok(firstAiRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: firstAiRequest!.i,
    m: {
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          name: "lookup_weather",
          arguments: "{\"city\":\"Berlin\"}",
        },
      ],
      files: createAiFiles(`export default async function run(host) {
  await host.completeTask("logged tools");
}
`),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 2);
  const verificationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").at(-1);
  assert.ok(verificationRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest!.i,
    m: { answer: "verified logged tools" },
  });

  await runPromise;

  assert.match(await readFile(path.join(dataPath, "logs", "tools.log"), "utf8"), /tool=lookup_weather/);
  assert.match(await readFile(path.join(dataPath, "logs", "tools.log"), "utf8"), /source=iteration/);
});

test("worker rejects generated app source that calls host.askAi and repairs it", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "no nested ai", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-9",
  });

  await waitFor(() => runtime.sent.some((message) => message.t === "ai:1" && message.c === "tool"));
  const firstRequest = runtime.sent.find((message) => message.t === "ai:1" && message.c === "tool");
  assert.ok(firstRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: firstRequest!.i,
    m: {
      files: createAiFiles(`export default async function run(host) {
  const answer = await host.askAi("bad");
  await host.completeTask(String(answer));
}
`),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 2);
  const memoryRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[1];
  assert.ok(memoryRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: memoryRequest.i,
    m: { answer: "Remember: never call host.askAi from generated app code." },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 3);
  const repairRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[2];
  assert.ok(repairRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: repairRequest.i,
    m: {
      files: createAiFiles(`export default async function run(host) {
  await host.completeTask("repaired without nested ai");
}
`),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 4);
  const verificationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").at(-1);
  assert.ok(verificationRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest!.i,
    m: { answer: "verified without nested ai" },
  });

  await runPromise;
  assert.match(await readFile(path.join(dataPath, "logs", "progress.log"), "utf8"), /Generated app must not call host\.askAi/);
});

test("worker archives tasks and includes existing app source in the first iteration request", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);
  const task = "archive me";

  await mkdir(path.join(dataPath, "app"), { recursive: true });
  await writeFile(path.join(dataPath, "app", "index.ts"), "export default async function run() {}\n", "utf8");
  await writeFile(path.join(dataPath, "task.md"), task, "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-archive-1",
  });

  await waitFor(() => runtime.sent.some((message) => message.t === "ai:1" && message.c === "tool"));
  const aiRequest = runtime.sent.find((message) => message.t === "ai:1" && message.c === "tool");
  assert.ok(aiRequest);
  assert.match(JSON.stringify(aiRequest!.m), /existingAppSource/);
  assert.match(JSON.stringify(aiRequest!.m), /export default async function run\(\) \{\}/);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: aiRequest!.i,
    m: {
      decision: "test",
      summary: "ready",
      files: createAiFiles(`export default async function run(host) {
  await host.completeTask("ok");
}
`),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 2);
  const verificationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").at(-1);
  assert.ok(verificationRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest!.i,
    m: { answer: "VALID: archived" },
  });

  await runPromise;

  const hash = createHash("sha1").update(task).digest("hex");
  assert.equal(await readFile(path.join(dataPath, "old-tasks", `${hash}.md`), "utf8"), task);
});

test("worker can iterate with continue before testing and grows working context", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "iterate first", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-iter-1",
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 1);
  const firstRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[0];
  assert.ok(firstRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: firstRequest.i,
    m: {
      decision: "continue",
      summary: "scaffolded api server",
      notes: "keep iterating",
      files: createAiFiles(
        `export default async function run(host) {
  await host.appendProgress("continue");
}
`,
        "# TODO\n- [x] Review existing app\n- [ ] Implement API routes\n",
      ),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 2);
  const secondRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[1];
  assert.ok(secondRequest);
  assert.match(JSON.stringify(secondRequest.m), /scaffolded api server/);
  assert.match(JSON.stringify(secondRequest.m), /continue/);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: secondRequest.i,
    m: {
      decision: "test",
      summary: "ready to test",
      files: createAiFiles(
        `export default async function run(host) {
  await host.writeFile("result.md", "ok");
  await host.completeTask({ summary: "ok", resultFile: "result.md" });
}
`,
        "# TODO\n- [x] Review existing app\n- [x] Implement API routes\n",
      ),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 3);
  const verificationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[2];
  assert.ok(verificationRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest.i,
    m: { answer: "VALID: iterative success" },
  });

  await runPromise;

  assert.equal(
    await readFile(path.join(dataPath, "todo.md"), "utf8"),
    "# TODO\n- [x] Review existing app\n- [x] Implement API routes\n",
  );
  const contextLog = await readFile(path.join(dataPath, "logs", "context.log"), "utf8");
  assert.equal(contextLog, "");
  assert.match(await readFile(path.join(dataPath, "logs", "progress.log"), "utf8"), /Cleared implementation working context before test/);
});

test("worker rejects invalid todo.md responses and retries with repair", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "todo must be valid", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-todo-1",
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 1);
  const firstRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[0];
  assert.ok(firstRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: firstRequest.i,
    m: {
      decision: "test",
      summary: "invalid todo",
      files: createAiFiles(
        `export default async function run(host) {
  await host.completeTask("bad todo");
}
`,
        "# TODO\nDo the thing\n",
      ),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 2, 4_000);
  const memoryRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[1];
  assert.ok(memoryRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: memoryRequest.i,
    m: { answer: "Remember: todo.md must contain checkbox items." },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 3, 4_000);
  const repairRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[2];
  assert.ok(repairRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: repairRequest.i,
    m: {
      decision: "test",
      summary: "todo repaired",
      files: createAiFiles(
        `export default async function run(host) {
  await host.completeTask("todo repaired");
}
`,
        "# TODO\n- [x] Repair todo format\n",
      ),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 4, 4_000);
  const verificationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[3];
  assert.ok(verificationRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest.i,
    m: { answer: "VALID: todo repaired" },
  });

  await runPromise;

  assert.match(await readFile(path.join(dataPath, "logs", "progress.log"), "utf8"), /Generated todo\.md contains invalid checklist formatting/);
  assert.equal(await readFile(path.join(dataPath, "todo.md"), "utf8"), "# TODO\n- [x] Repair todo format\n");
});

test("worker prefers TypeScript fenced app source when answer also includes todo content", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "return the actual app source even if todo is restated", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-mixed-answer-1",
  });

  const firstRequest = await waitForAiTool(runtime, 1);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: firstRequest.i,
    m: {
      answer: [
        "decision: test",
        "summary: implemented http api",
        "# TODO",
        "- [x] Review existing app",
        "- [x] Implement API routes",
        "```md",
        "# TODO",
        "- [x] Review existing app",
        "- [x] Implement API routes",
        "```",
        "```ts",
        "export default async function run(host) {",
        "  await host.writeFile(\"result.md\", \"ok\");",
        "  await host.completeTask({ summary: \"implemented http api\", resultFile: \"result.md\" });",
        "}",
        "```",
      ].join("\n"),
    },
  });

  const verificationRequest = await waitForAiTool(runtime, 2);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest.i,
    m: { answer: "VALID: implemented http api" },
  });

  await runPromise;

  const appSource = await readFile(path.join(dataPath, "app", "index.ts"), "utf8");
  assert.match(appSource, /export default async function run\(host\)/);
  assert.doesNotMatch(appSource, /^# TODO/m);
  assert.equal(
    await readFile(path.join(dataPath, "todo.md"), "utf8"),
    "# TODO\n- [x] Review existing app\n- [x] Implement API routes",
  );
});

test("worker blocks test runs while todo.md still has open items", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "finish todo before test", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-open-todo-1",
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 1);
  const firstRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[0];
  assert.ok(firstRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: firstRequest.i,
    m: {
      decision: "test",
      summary: "trying to test too early",
      files: createAiFiles(
        `export default async function run(host) {
  await host.completeTask("too early");
}
`,
        "# TODO\n- [x] Analyze existing implementation\n- [ ] Patch remaining bug\n",
      ),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 2, 4_000);
  const secondIterationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[1];
  assert.ok(secondIterationRequest);
  assert.match(JSON.stringify(secondIterationRequest.m), /Patch remaining bug/);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: secondIterationRequest.i,
    m: {
      decision: "test",
      summary: "all implementation work completed",
      files: createAiFiles(
        `export default async function run(host) {
  await host.completeTask("done");
}
`,
        "# TODO\n- [x] Analyze existing implementation\n- [x] Patch remaining bug\n",
      ),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 3, 4_000);
  const verificationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[2];
  assert.ok(verificationRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest.i,
    m: { answer: "VALID: completed after todo finished" },
  });

  await runPromise;

  assert.match(
    await readFile(path.join(dataPath, "logs", "progress.log"), "utf8"),
    /Generated todo\.md still has open items, so the worker will keep iterating instead of starting test/,
  );
  assert.doesNotMatch(
    await readFile(path.join(dataPath, "logs", "progress.log"), "utf8"),
    /Attempt 1 failed: Generated todo\.md still has open items/,
  );
});

test("worker rejects continue iterations that make no implementation progress", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "must make real implementation progress", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-no-progress-1",
  });

  const firstIterationRequest = await waitForAiTool(runtime, 1);
  const unchangedApp = `export default async function run(host) {
  await host.appendProgress("still planning");
}
`;
  const unchangedTodo = "# TODO\n- [x] Review existing app\n- [ ] Implement HTTP API\n";

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: firstIterationRequest.i,
    m: {
      decision: "continue",
      summary: "still planning",
      files: createAiFiles(unchangedApp, unchangedTodo),
    },
  });

  const secondIterationRequest = await waitForAiTool(runtime, 2);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: secondIterationRequest.i,
    m: {
      decision: "continue",
      summary: "still planning",
      files: createAiFiles(unchangedApp, unchangedTodo),
    },
  });

  const memoryRequest = await waitForAiTool(runtime, 3);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: memoryRequest.i,
    m: { answer: "Remember: each continue iteration must change code or todo.md." },
  });

  const repairRequest = await waitForAiTool(runtime, 4);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: repairRequest.i,
    m: {
      decision: "test",
      summary: "implemented api",
      files: createAiFiles(
        `export default async function run(host) {
  await host.writeFile("result.md", "api implemented");
  await host.completeTask({ summary: "implemented api", resultFile: "result.md" });
}
`,
        "# TODO\n- [x] Implement HTTP API\n",
      ),
    },
  });

  const verificationRequest = await waitForAiTool(runtime, 5);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest.i,
    m: { answer: "VALID: implemented api" },
  });

  await runPromise;

  assert.match(
    await readFile(path.join(dataPath, "logs", "progress.log"), "utf8"),
    /Attempt 1 failed: Iteration made no implementation progress: app\/index\.ts and todo\.md were unchanged/,
  );
});

test("worker allows todo-only progress when analysis tasks are completed", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "analyze files before implementing", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-analysis-progress-1",
  });

  const firstIterationRequest = await waitForAiTool(runtime, 1);
  const unchangedApp = `export default async function run(host) {
  await host.appendProgress("analysis complete");
}
`;

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: firstIterationRequest.i,
    m: {
      decision: "continue",
      summary: "reviewed the existing files and clarified the next implementation tasks",
      notes: "Inspected the current app entrypoint and task inputs. Both review todos are done.",
      files: createAiFiles(
        unchangedApp,
        "# TODO\n- [x] Inspect existing app/index.ts\n- [x] Review task and memory inputs\n- [ ] Implement HTTP API\n",
      ),
    },
  });

  const secondIterationRequest = await waitForAiTool(runtime, 2);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: secondIterationRequest.i,
    m: {
      decision: "test",
      summary: "implemented api after the review work",
      files: createAiFiles(
        `export default async function run(host) {
  await host.writeFile("result.md", "implemented after analysis");
  await host.completeTask({ summary: "implemented api after analysis", resultFile: "result.md" });
}
`,
        "# TODO\n- [x] Inspect existing app/index.ts\n- [x] Review task and memory inputs\n- [x] Implement HTTP API\n",
      ),
    },
  });

  const verificationRequest = await waitForAiTool(runtime, 3);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest.i,
    m: { answer: "VALID: implemented after analysis" },
  });

  await runPromise;

  const progressLog = await readFile(path.join(dataPath, "logs", "progress.log"), "utf8");
  assert.doesNotMatch(progressLog, /Iteration made no implementation progress/);
  assert.equal(
    await readFile(path.join(dataPath, "todo.md"), "utf8"),
    "# TODO\n- [x] Inspect existing app/index.ts\n- [x] Review task and memory inputs\n- [x] Implement HTTP API\n",
  );
});

test("worker rejects deferred test iterations that do not advance checklist completion", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "must not loop on the same remaining todo", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-deferred-no-checklist-progress-1",
  });

  const firstIterationRequest = await waitForAiTool(runtime, 1);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: firstIterationRequest.i,
    m: {
      decision: "test",
      summary: "server is running",
      files: createAiFiles(
        `export default async function run(host) {
  await host.appendProgress("server is running");
}
`,
        "# TODO\n- [x] Review existing app\n- [ ] Verify observable response body\n",
      ),
    },
  });

  const secondIterationRequest = await waitForAiTool(runtime, 2);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: secondIterationRequest.i,
    m: {
      decision: "test",
      summary: "server is still running",
      files: createAiFiles(
        `export default async function run(host) {
  await host.appendProgress("server is running");
}
`,
        "# TODO\n- [x] Review existing app\n- [ ] Verify observable response body\n",
      ),
    },
  });

  const memoryRequest = await waitForAiTool(runtime, 3);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: memoryRequest.i,
    m: { answer: "Remember: if testing is deferred, the next iteration must complete additional checklist items before trying again." },
  });

  const repairRequest = await waitForAiTool(runtime, 4);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: repairRequest.i,
    m: {
      decision: "test",
      summary: "observable response fixed",
      files: createAiFiles(
        `export default async function run(host) {
  await host.writeFile("result.md", "observable response fixed");
  await host.completeTask({ summary: "observable response fixed", resultFile: "result.md" });
}
`,
        "# TODO\n- [x] Review existing app\n- [x] Verify observable response body\n",
      ),
    },
  });

  const verificationRequest = await waitForAiTool(runtime, 5);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest.i,
    m: { answer: "VALID: observable response fixed" },
  });

  await runPromise;

  assert.match(
    await readFile(path.join(dataPath, "logs", "progress.log"), "utf8"),
    /Attempt 1 failed: Iteration made no implementation progress: app\/index\.ts and todo\.md were unchanged/,
  );
});

test("worker emits clear step-by-step progress messages", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "clear progress", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-progress-1",
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 1);
  const firstRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[0];
  assert.ok(firstRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: firstRequest.i,
    m: {
      decision: "continue",
      summary: "planning api shape",
      files: createAiFiles(
        `export default async function run(host) {
  await host.appendProgress("updating file result.md");
}
`,
        "# TODO\n- [x] Review existing app\n- [ ] Write result file\n",
      ),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 2);
  const secondRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[1];
  assert.ok(secondRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: secondRequest.i,
    m: {
      decision: "test",
      summary: "ready for smoke test",
      files: createAiFiles(
        `export default async function run(host) {
  await host.writeFile("result.md", "ok");
  await host.completeTask({ summary: "finished", resultFile: "result.md" });
}
`,
        "# TODO\n- [x] Review existing app\n- [x] Write result file\n",
      ),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 3);
  const verificationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[2];
  assert.ok(verificationRequest);
  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest.i,
    m: { answer: "VALID: clear progress" },
  });

  await runPromise;

  const progressMessages = runtime.sent
    .filter((message) => message.c === "progress")
    .map((message) => String((message.m as { message?: string }).message ?? ""));

  assert.ok(progressMessages.some((message) => message.includes("planning next implementation step 1")));
  assert.ok(progressMessages.some((message) => message.includes("planning final implementation step 2")));
  assert.ok(progressMessages.some((message) => message.includes("implementation checklist is complete. start fresh test run.")));
  assert.ok(progressMessages.some((message) => message.includes("test passed. finished")));
});

test("worker clears working context after each test and keeps memory", async (t) => {
  const dataPath = await createDataDir();
  const runtime = new RuntimeStub("worker:1");
  const service = new TaskWorkerService(runtime, { dataPath, aiKind: "ai", aiTarget: "ai:1" });
  enableAutoTodoPlanner(service, runtime);

  await writeFile(path.join(dataPath, "task.md"), "context reset", "utf8");

  t.after(async () => {
    await rm(dataPath, { recursive: true, force: true });
  });

  const runPromise = service.onMessage({
    s: "agent:1",
    t: "worker:1",
    c: "tool",
    i: "req-reset-1",
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 1);
  const firstRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[0];
  assert.ok(firstRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: firstRequest.i,
    m: {
      decision: "continue",
      summary: "collecting context",
      files: createAiFiles(
        `export default async function run(host) {
  throw new Error("boom");
}
`,
        "# TODO\n- [x] Review existing app\n- [ ] Fix failing test path\n",
      ),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 2);
  const secondRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[1];
  assert.ok(secondRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: secondRequest.i,
    m: {
      decision: "test",
      summary: "ready to fail test",
      files: createAiFiles(
        `export default async function run(host) {
  throw new Error("boom");
}
`,
        "# TODO\n- [x] Review existing app\n- [x] Fix failing test path\n",
      ),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 3);
  const memoryRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[2];
  assert.ok(memoryRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: memoryRequest.i,
    m: { answer: "Remember the failed test result." },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 4);
  const repairRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[3];
  assert.ok(repairRequest);
  assert.doesNotMatch(JSON.stringify(repairRequest.m), /collecting context/);
  assert.match(JSON.stringify(repairRequest.m), /Remember the failed test result\./);
  assert.doesNotMatch(JSON.stringify(repairRequest.m), /Fix failing test path/);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: repairRequest.i,
    m: {
      decision: "test",
      summary: "repaired",
      files: createAiFiles(
        `export default async function run(host) {
  await host.completeTask("ok");
}
`,
        "# TODO\n- [x] Review existing app\n- [x] Fix failing test path\n- [x] Repair runtime failure\n",
      ),
    },
  });

  await waitFor(() => runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool").length >= 5);
  const verificationRequest = runtime.sent.filter((message) => message.t === "ai:1" && message.c === "tool")[4];
  assert.ok(verificationRequest);

  await service.onMessage({
    s: "ai:1",
    t: "worker:1",
    c: "result",
    i: verificationRequest.i,
    m: { answer: "VALID: repaired" },
  });

  await runPromise;

  assert.equal(await readFile(path.join(dataPath, "logs", "context.log"), "utf8"), "");
  assert.equal(await readFile(path.join(dataPath, "memory.md"), "utf8"), "Remember the failed test result.");
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
