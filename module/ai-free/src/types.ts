export type AiRequestType = "completion" | "tool_use";
export type AiToolChoiceMode = "auto" | "none" | "required";
export type AiMessageRole = "system" | "user" | "assistant" | "tool";

export interface AiFunctionToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export type AiToolDefinition = AiFunctionToolDefinition;

export interface AiToolCall {
  id: string;
  type: "function";
  name: string;
  arguments: string;
}

export interface AiSystemMessage {
  role: "system";
  content: string;
}

export interface AiUserMessage {
  role: "user";
  content: string;
}

export interface AiAssistantMessage {
  role: "assistant";
  content?: string;
  refusal?: string;
  toolCalls?: AiToolCall[];
}

export interface AiToolMessage {
  role: "tool";
  content: string;
  toolCallId: string;
}

export type AiMessage = AiSystemMessage | AiUserMessage | AiAssistantMessage | AiToolMessage;

export interface AiBaseRequest {
  type: AiRequestType;
  model?: string;
  system?: string;
  messages: AiMessage[];
  temperature?: number;
  includeRaw?: boolean;
}

export interface AiCompletionRequest extends AiBaseRequest {
  type: "completion";
}

export interface AiFunctionToolChoice {
  type: "function";
  name: string;
}

export type AiToolChoice = AiToolChoiceMode | AiFunctionToolChoice;

export interface AiToolUseRequest extends AiBaseRequest {
  type: "tool_use";
  tools: AiToolDefinition[];
  toolChoice?: AiToolChoice;
}

export type AiInferenceRequest = AiCompletionRequest | AiToolUseRequest;

export interface AiInferenceResponse {
  requestId: string;
  status: "ok";
  responder: string;
  provider: string;
  model: string;
  type: AiRequestType;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  message?: AiAssistantMessage;
  toolCalls?: AiToolCall[];
  finishReason?: string;
  answer?: string;
  raw?: unknown;
}
