import { AiModuleError } from "../errors.js";
import {
  AiInferenceRequest,
  AiInferenceResponse,
  AiMessage,
  AiToolCall,
  AiToolChoice,
  AiToolDefinition,
} from "../types.js";
import { AiProvider } from "./base.js";

export interface ChatCompletionsProviderOptions {
  name: string;
  apiKey: string;
  model: string;
  serviceName: string;
  baseUrl: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  rateLimitRetryDelayMs?: number;
  maxRateLimitRetries?: number;
  sleepImpl?: (delayMs: number) => Promise<void>;
}

interface ChatCompletionResponse {
  model: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

export class ChatCompletionsProvider implements AiProvider {
  readonly name: string;
  readonly #fetchImpl: typeof fetch;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #serviceName: string;
  readonly #baseUrl: string;
  readonly #headers: Record<string, string>;
  readonly #rateLimitRetryDelayMs: number;
  readonly #maxRateLimitRetries: number;
  readonly #sleepImpl: (delayMs: number) => Promise<void>;

  constructor(options: ChatCompletionsProviderOptions) {
    this.name = options.name;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#serviceName = options.serviceName;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#headers = options.headers ?? {};
    this.#rateLimitRetryDelayMs = options.rateLimitRetryDelayMs ?? 0;
    this.#maxRateLimitRetries = options.maxRateLimitRetries ?? 0;
    this.#sleepImpl = options.sleepImpl ?? sleep;
  }

  async complete(requestId: string, request: AiInferenceRequest): Promise<AiInferenceResponse> {
    let response: Response | undefined;
    let payload: ChatCompletionResponse | undefined;

    for (let attempt = 0; attempt <= this.#maxRateLimitRetries; attempt += 1) {
      response = await this.#fetchImpl(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.#headers,
        },
        body: JSON.stringify(this.createRequestBody(request)),
      });

      payload = await response.json() as ChatCompletionResponse;

      if (
        response.ok
        || attempt === this.#maxRateLimitRetries
        || !isRateLimitResponse(response, payload)
      ) {
        break;
      }

      await this.#sleepImpl(getRetryDelayMs(response, this.#rateLimitRetryDelayMs));
    }

    if (!response || !payload) {
      throw new AiModuleError(`${this.name} response was empty`, "provider-response-invalid", {
        provider: this.name,
      });
    }

    if (!response.ok) {
      throw new AiModuleError(
        payload.error?.message ?? `${this.name} request failed with status ${response.status}`,
        "provider-request-failed",
        {
          provider: this.name,
          status: response.status,
          errorType: payload.error?.type,
          errorCode: payload.error?.code,
        },
      );
    }

    const choice = payload.choices?.[0];
    if (!choice?.message) {
      throw new AiModuleError(`${this.name} response did not contain a completion choice`, "provider-response-invalid", {
        provider: this.name,
      });
    }

    const toolCalls = normalizeToolCalls(choice.message.tool_calls);
    const content = choice.message.content ?? undefined;
    const refusal = choice.message.refusal ?? undefined;

    return {
      requestId,
      status: "ok",
      responder: this.#serviceName,
      provider: this.name,
      model: payload.model ?? request.model ?? this.#model,
      type: request.type,
      ...(payload.usage
        ? {
            usage: {
              inputTokens: payload.usage.prompt_tokens,
              outputTokens: payload.usage.completion_tokens,
              totalTokens: payload.usage.total_tokens,
            },
          }
        : {}),
      message: {
        role: "assistant",
        ...(content ? { content } : {}),
        ...(refusal ? { refusal } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      },
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason: choice.finish_reason,
      ...(content ? { answer: content } : {}),
      ...(request.includeRaw ? { raw: payload } : {}),
    };
  }

  private createRequestBody(request: AiInferenceRequest): Record<string, unknown> {
    return {
      model: request.model ?? this.#model,
      messages: toOpenAIMessages(request),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.type === "tool_use"
        ? {
            tools: request.tools.map(toOpenAITool),
            ...(request.toolChoice !== undefined ? { tool_choice: toOpenAIToolChoice(request.toolChoice) } : {}),
          }
        : {}),
    };
  }
}

function isRateLimitResponse(response: Response, payload: ChatCompletionResponse): boolean {
  return response.status === 429
    || payload.error?.type === "too_many_requests"
    || payload.error?.code === "too_many_requests";
}

function getRetryDelayMs(response: Response, minimumDelayMs: number): number {
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
  const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
    ? retryAfterSeconds * 1000
    : 0;
  return Math.max(minimumDelayMs, retryAfterMs);
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function toOpenAIMessages(request: AiInferenceRequest): Array<Record<string, unknown>> {
  const messages: AiMessage[] = request.system
    ? [{ role: "system", content: request.system }, ...request.messages]
    : request.messages;

  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
      };
    }

    if (message.role === "assistant") {
      return {
        role: "assistant",
        ...(message.content !== undefined ? { content: message.content } : { content: null }),
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: "function",
                function: {
                  name: toolCall.name,
                  arguments: toolCall.arguments,
                },
              })),
            }
          : {}),
      };
    }

    return {
      role: message.role,
      content: message.content,
    };
  });
}

function toOpenAITool(tool: AiToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.parameters ? { parameters: tool.parameters } : {}),
    },
  };
}

function toOpenAIToolChoice(toolChoice: AiToolChoice): unknown {
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }

  return {
    type: "function",
    function: {
      name: toolChoice.name,
    },
  };
}

type ToolCallPayload = NonNullable<
  NonNullable<
    NonNullable<ChatCompletionResponse["choices"]>[number]["message"]
  >["tool_calls"]
>;

function normalizeToolCalls(toolCalls: ToolCallPayload | undefined): AiToolCall[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .filter((toolCall) => toolCall.type === "function" && toolCall.id && toolCall.function?.name)
    .map((toolCall) => ({
      id: toolCall.id as string,
      type: "function",
      name: toolCall.function?.name as string,
      arguments: toolCall.function?.arguments ?? "",
    }));
}

export function createAuthorizationHeader(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}
