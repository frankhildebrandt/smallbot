import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ModuleRuntime, WireMessage } from "@smallbot/framework";

import { AzureAIProvider } from "./providers/azureai.js";
import { createProvider } from "./providers/factory.js";
import { OpenAIProvider } from "./providers/openai.js";
import { OpenRouterProvider } from "./providers/openrouter.js";
import { parseAiInferenceRequest } from "./requests.js";
import { AiService } from "./service.js";

class RuntimeStub {
  readonly sent: WireMessage[] = [];
  readonly states: Array<"free" | "busy" | "stopped"> = [];

  async updateState(state: "free" | "busy" | "stopped"): Promise<void> {
    this.states.push(state);
  }

  async send(message: WireMessage): Promise<void> {
    this.sent.push(message);
  }
}

class ProviderStub {
  constructor(private readonly response: unknown) {}

  readonly name = "stub";

  async complete(requestId: string): Promise<any> {
    return {
      requestId,
      responder: "ai:1",
      provider: this.name,
      model: "stub-model",
      type: "completion",
      status: "ok",
      ...((typeof this.response === "object" && this.response !== null) ? this.response : {}),
    };
  }
}

test("parseAiInferenceRequest accepts typed completion requests", () => {
  const parsed = parseAiInferenceRequest({
    type: "completion",
    system: "You are helpful",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(parsed.type, "completion");
  assert.equal(parsed.messages[0]?.role, "user");
});

test("parseAiInferenceRequest accepts typed tool use requests", () => {
  const parsed = parseAiInferenceRequest({
    type: "tool_use",
    messages: [{ role: "user", content: "what time is it?" }],
    tools: [
      {
        type: "function",
        name: "get_time",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    ],
    toolChoice: "auto",
  });

  assert.equal(parsed.type, "tool_use");
  assert.equal(parsed.tools.length, 1);
});

test("parseAiInferenceRequest falls back to legacy prompt payloads", () => {
  const parsed = parseAiInferenceRequest({
    kind: "task-worker:generate-app",
    prompt: "write code",
  });

  assert.equal(parsed.type, "completion");
  assert.deepEqual(parsed.messages, [{ role: "user", content: "write code" }]);
});

test("parseAiInferenceRequest rejects invalid tool requests", () => {
  assert.throws(
    () => parseAiInferenceRequest({
      type: "tool_use",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    }),
    /at least one tool/,
  );
});

test("createProvider supports OpenAI env aliases", () => {
  const provider = createProvider({
    serviceName: "ai:1",
    env: {
      PROVIDER: "openai",
      OPEN_AI_KEY: "key",
      OPEN_AI_MODEL: "gpt-test",
    } as NodeJS.ProcessEnv,
  });

  assert.ok(provider instanceof OpenAIProvider);
});

test("createProvider supports AzureAI env aliases", () => {
  const provider = createProvider({
    serviceName: "ai:1",
    env: {
      PROVIDER: "azureai",
      AZURE_AI_API_KEY: "key",
      AZURE_AI_MODEL: "gpt-4.1-mini",
      AZURE_AI_BASE_URL: "https://example.openai.azure.com/openai/v1",
    } as NodeJS.ProcessEnv,
  });

  assert.ok(provider instanceof AzureAIProvider);
});

test("createProvider supports OpenRouter env configuration", () => {
  const provider = createProvider({
    serviceName: "ai:1",
    env: {
      PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "key",
      OPENROUTER_MODEL: "openai/gpt-4.1-mini",
    } as NodeJS.ProcessEnv,
  });

  assert.ok(provider instanceof OpenRouterProvider);
});

test("createProvider rejects unsupported providers", () => {
  assert.throws(
    () => createProvider({
      serviceName: "ai:1",
      env: {
        PROVIDER: "anthropic",
      } as NodeJS.ProcessEnv,
    }),
    /Unsupported AI provider/,
  );
});

test("OpenAIProvider normalizes completion responses", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const provider = new OpenAIProvider({
    apiKey: "key",
    model: "gpt-5.4-mini",
    serviceName: "ai:1",
    fetchImpl: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        model: "gpt-5.4-mini",
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Hello back",
            },
          },
        ],
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    },
  });

  const response = await provider.complete("req-1", {
    type: "completion",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(requests[0]?.model, "gpt-5.4-mini");
  assert.equal(response.answer, "Hello back");
  assert.equal(response.message?.content, "Hello back");
  assert.equal(response.usage?.inputTokens, 12);
  assert.equal(response.usage?.outputTokens, 4);
});

test("OpenAIProvider normalizes tool calls", async () => {
  const provider = new OpenAIProvider({
    apiKey: "key",
    model: "gpt-5.4-mini",
    serviceName: "ai:1",
    fetchImpl: async () => new Response(JSON.stringify({
      model: "gpt-5.4-mini",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "lookup_weather",
                  arguments: "{\"city\":\"Berlin\"}",
                },
              },
            ],
          },
        },
      ],
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    }),
  });

  const response = await provider.complete("req-2", {
    type: "tool_use",
    messages: [{ role: "user", content: "weather" }],
    tools: [
      {
        type: "function",
        name: "lookup_weather",
      },
    ],
  });

  assert.equal(response.toolCalls?.[0]?.name, "lookup_weather");
  assert.equal(response.message?.toolCalls?.[0]?.arguments, "{\"city\":\"Berlin\"}");
});

test("AzureAIProvider uses api-key header", async () => {
  let headers: HeadersInit | undefined;
  const provider = new AzureAIProvider({
    apiKey: "azure-key",
    model: "gpt-4.1-mini",
    serviceName: "ai:1",
    baseUrl: "https://example.openai.azure.com/openai/v1",
    fetchImpl: async (_input, init) => {
      headers = init?.headers;
      return new Response(JSON.stringify({
        model: "gpt-4.1-mini",
        choices: [
          {
            message: {
              content: "Azure response",
            },
          },
        ],
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    },
  });

  const response = await provider.complete("req-azure", {
    type: "completion",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(response.answer, "Azure response");
  assert.deepEqual(headers, {
    "Content-Type": "application/json",
    "api-key": "azure-key",
  });
});

test("AzureAIProvider waits at least 60 seconds before retrying rate limits", async () => {
  const seenDelays: number[] = [];
  let attempts = 0;

  const provider = new AzureAIProvider({
    apiKey: "azure-key",
    model: "gpt-4.1-mini",
    serviceName: "ai:1",
    baseUrl: "https://example.openai.azure.com/openai/v1",
    sleepImpl: async (delayMs) => {
      seenDelays.push(delayMs);
    },
    fetchImpl: async () => {
      attempts += 1;

      if (attempts === 1) {
        return new Response(JSON.stringify({
          error: {
            message: "Too Many Requests",
            type: "too_many_requests",
            code: "too_many_requests",
          },
        }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "5",
          },
        });
      }

      return new Response(JSON.stringify({
        model: "gpt-4.1-mini",
        choices: [
          {
            message: {
              content: "Azure retried response",
            },
          },
        ],
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    },
  });

  const response = await provider.complete("req-azure-retry", {
    type: "completion",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(attempts, 2);
  assert.deepEqual(seenDelays, [60_000]);
  assert.equal(response.answer, "Azure retried response");
});

test("OpenRouterProvider sets optional attribution headers", async () => {
  let headers: HeadersInit | undefined;
  let requestBody: Record<string, unknown> | undefined;

  const provider = new OpenRouterProvider({
    apiKey: "router-key",
    model: "openai/gpt-4.1-mini",
    serviceName: "ai:1",
    siteUrl: "https://smallbot.example",
    appName: "SmallBot",
    fetchImpl: async (_input, init) => {
      headers = init?.headers;
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        model: "openai/gpt-4.1-mini",
        choices: [
          {
            message: {
              content: "OpenRouter response",
            },
          },
        ],
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    },
  });

  const response = await provider.complete("req-openrouter", {
    type: "completion",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(response.answer, "OpenRouter response");
  assert.equal(requestBody?.model, "openai/gpt-4.1-mini");
  assert.deepEqual(headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer router-key",
    "HTTP-Referer": "https://smallbot.example",
    "X-Title": "SmallBot",
  });
});

test("AiService returns results for typed requests", async () => {
  const dataPath = await mkdtemp(path.join(os.tmpdir(), "smallbot-ai-"));
  try {
  const runtime = new RuntimeStub() as unknown as ModuleRuntime;
  const service = new AiService(runtime, new ProviderStub({
    answer: "done",
    message: { role: "assistant", content: "done" },
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  }), "ai:1", dataPath);

  await service.onMessage({
    s: "worker:1",
    t: "ai:1",
    c: "tool",
    i: "req-1",
    m: {
      type: "completion",
      messages: [{ role: "user", content: "hello" }],
    },
  });

  const typedRuntime = runtime as unknown as RuntimeStub;
  assert.deepEqual(typedRuntime.states, ["busy", "free"]);
  assert.equal(typedRuntime.sent[0]?.c, "result");
  assert.equal((typedRuntime.sent[0]?.m as { answer?: string }).answer, "done");
  assert.match(await readFile(path.join(dataPath, "logs", "usage.log"), "utf8"), /request=req-1/);
  assert.match(await readFile(path.join(dataPath, "logs", "usage.log"), "utf8"), /total_tokens=15/);
  } finally {
    await rm(dataPath, { recursive: true, force: true });
  }
});

test("AiService keeps legacy payloads working", async () => {
  const dataPath = await mkdtemp(path.join(os.tmpdir(), "smallbot-ai-"));
  try {
  const runtime = new RuntimeStub() as unknown as ModuleRuntime;
  const service = new AiService(runtime, new ProviderStub({ answer: "legacy", message: { role: "assistant", content: "legacy" } }), "ai:1", dataPath);

  await service.onMessage({
    s: "worker:1",
    t: "ai:1",
    c: "tool",
    i: "req-2",
    m: {
      prompt: "hello from legacy",
    },
  });

  const typedRuntime = runtime as unknown as RuntimeStub;
  assert.equal(typedRuntime.sent[0]?.c, "result");
  } finally {
    await rm(dataPath, { recursive: true, force: true });
  }
});

test("AiService logs inference errors to stderr and file", async () => {
  const dataPath = await mkdtemp(path.join(os.tmpdir(), "smallbot-ai-"));
  const runtime = new RuntimeStub() as unknown as ModuleRuntime;
  const provider = {
    name: "openrouter",
    async complete(): Promise<never> {
      throw new Error("provider exploded");
    },
  };

  const originalConsoleError = console.error;
  const stderrLines: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    stderrLines.push(args);
  };

  try {
    const service = new AiService(runtime, provider, "ai:1", dataPath);
    await service.onMessage({
      s: "worker:1",
      t: "ai:1",
      c: "tool",
      i: "req-error",
      m: {
        prompt: "fail please",
      },
    });

    const typedRuntime = runtime as unknown as RuntimeStub;
    assert.equal(typedRuntime.sent[0]?.c, "error");
    assert.match(String(stderrLines[0]?.[0] ?? ""), /request=req-error/);
    assert.match(String(stderrLines[0]?.[0] ?? ""), /provider=openrouter/);
    assert.match(await readFile(path.join(dataPath, "logs", "error.log"), "utf8"), /provider=openrouter/);
    assert.match(await readFile(path.join(dataPath, "logs", "error.log"), "utf8"), /provider exploded/);
  } finally {
    console.error = originalConsoleError;
    await rm(dataPath, { recursive: true, force: true });
  }
});
