import { AiModuleError } from "./errors.js";
import {
  AiInferenceRequest,
  AiMessage,
  AiToolCall,
  AiToolChoice,
  AiToolDefinition,
} from "./types.js";

export function parseAiInferenceRequest(payload: unknown): AiInferenceRequest {
  if (isAiInferenceRequest(payload)) {
    validateRequest(payload);
    return payload;
  }

  return parseLegacyRequest(payload);
}

function isAiInferenceRequest(payload: unknown): payload is AiInferenceRequest {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }

  const candidate = payload as Partial<AiInferenceRequest>;
  return candidate.type === "completion" || candidate.type === "tool_use";
}

function parseLegacyRequest(payload: unknown): AiInferenceRequest {
  if (typeof payload === "string") {
    return createLegacyCompletion(payload);
  }

  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const candidate = payload as { prompt?: unknown };

    if (typeof candidate.prompt === "string" && candidate.prompt.trim().length > 0) {
      return createLegacyCompletion(candidate.prompt);
    }
  }

  return createLegacyCompletion(JSON.stringify(payload ?? null, null, 2));
}

function createLegacyCompletion(prompt: string): AiInferenceRequest {
  return {
    type: "completion",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  };
}

function validateRequest(request: AiInferenceRequest): void {
  if (request.model !== undefined && !isNonEmptyString(request.model)) {
    throw new AiModuleError("AI request model must be a non-empty string", "invalid-request");
  }

  if (request.system !== undefined && typeof request.system !== "string") {
    throw new AiModuleError("AI request system must be a string", "invalid-request");
  }

  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new AiModuleError("AI request messages must be a non-empty array", "invalid-request");
  }

  for (const message of request.messages) {
    validateMessage(message);
  }

  if (request.temperature !== undefined && typeof request.temperature !== "number") {
    throw new AiModuleError("AI request temperature must be a number", "invalid-request");
  }

  if (request.includeRaw !== undefined && typeof request.includeRaw !== "boolean") {
    throw new AiModuleError("AI request includeRaw must be a boolean", "invalid-request");
  }

  if (request.type === "tool_use") {
    if (!Array.isArray(request.tools) || request.tools.length === 0) {
      throw new AiModuleError("Tool use requests require at least one tool", "invalid-request");
    }

    for (const tool of request.tools) {
      validateTool(tool);
    }

    if (request.toolChoice !== undefined) {
      validateToolChoice(request.toolChoice);
    }
  }
}

function validateMessage(message: AiMessage): void {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    throw new AiModuleError("AI request messages must contain objects", "invalid-request");
  }

  if (!["system", "user", "assistant", "tool"].includes(message.role)) {
    throw new AiModuleError(`Unsupported AI message role: ${String((message as { role?: unknown }).role)}`, "invalid-request");
  }

  if (message.role === "system" || message.role === "user") {
    if (!isNonEmptyString(message.content)) {
      throw new AiModuleError(`AI ${message.role} messages require string content`, "invalid-request");
    }
    return;
  }

  if (message.role === "tool") {
    if (!isNonEmptyString(message.content) || !isNonEmptyString(message.toolCallId)) {
      throw new AiModuleError("AI tool messages require content and toolCallId", "invalid-request");
    }
    return;
  }

  if (
    message.content !== undefined
    && typeof message.content !== "string"
  ) {
    throw new AiModuleError("AI assistant message content must be a string when provided", "invalid-request");
  }

  if (message.refusal !== undefined && typeof message.refusal !== "string") {
    throw new AiModuleError("AI assistant refusal must be a string when provided", "invalid-request");
  }

  if (message.toolCalls !== undefined) {
    if (!Array.isArray(message.toolCalls)) {
      throw new AiModuleError("AI assistant toolCalls must be an array", "invalid-request");
    }

    for (const toolCall of message.toolCalls) {
      validateToolCall(toolCall);
    }
  }

  if (!message.content && !message.refusal && (!message.toolCalls || message.toolCalls.length === 0)) {
    throw new AiModuleError("AI assistant messages require content, refusal, or toolCalls", "invalid-request");
  }
}

function validateTool(tool: AiToolDefinition): void {
  if (tool.type !== "function") {
    throw new AiModuleError(`Unsupported tool type: ${String((tool as { type?: unknown }).type)}`, "invalid-request");
  }

  if (!isNonEmptyString(tool.name)) {
    throw new AiModuleError("Function tools require a non-empty name", "invalid-request");
  }

  if (tool.description !== undefined && typeof tool.description !== "string") {
    throw new AiModuleError("Function tool description must be a string", "invalid-request");
  }

  if (
    tool.parameters !== undefined
    && (typeof tool.parameters !== "object" || tool.parameters === null || Array.isArray(tool.parameters))
  ) {
    throw new AiModuleError("Function tool parameters must be a JSON schema object", "invalid-request");
  }
}

function validateToolCall(toolCall: AiToolCall): void {
  if (toolCall.type !== "function") {
    throw new AiModuleError(`Unsupported tool call type: ${String((toolCall as { type?: unknown }).type)}`, "invalid-request");
  }

  if (!isNonEmptyString(toolCall.id) || !isNonEmptyString(toolCall.name) || typeof toolCall.arguments !== "string") {
    throw new AiModuleError("Tool calls require id, name and arguments", "invalid-request");
  }
}

function validateToolChoice(toolChoice: AiToolChoice): void {
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return;
  }

  if (
    typeof toolChoice === "object"
    && toolChoice !== null
    && toolChoice.type === "function"
    && isNonEmptyString(toolChoice.name)
  ) {
    return;
  }

  throw new AiModuleError("toolChoice must be auto, none, required, or a function selector", "invalid-request");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
