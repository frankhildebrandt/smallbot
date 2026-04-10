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

interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  serviceName: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface OpenAIChatCompletionResponse {
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

export class OpenAIProvider implements AiProvider {
  readonly name = "openai";
  readonly #fetchImpl: typeof fetch;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #serviceName: string;
  readonly #baseUrl: string;

  constructor(options: OpenAIProviderOptions) {
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#serviceName = options.serviceName;
    this.#baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
  }

  async complete(requestId: string, request: AiInferenceRequest): Promise<AiInferenceResponse> {
    const response = await this.#fetchImpl(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(this.createRequestBody(request)),
    });

    const payload = await response.json() as OpenAIChatCompletionResponse;

    if (!response.ok) {
      throw new AiModuleError(
        payload.error?.message ?? `OpenAI request failed with status ${response.status}`,
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
      throw new AiModuleError("OpenAI response did not contain a completion choice", "provider-response-invalid", {
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

type OpenAIToolCallPayload = NonNullable<
  NonNullable<
    NonNullable<OpenAIChatCompletionResponse["choices"]>[number]["message"]
  >["tool_calls"]
>;

function normalizeToolCalls(toolCalls: OpenAIToolCallPayload | undefined): AiToolCall[] {
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
