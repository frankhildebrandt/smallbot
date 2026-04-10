import type {
  ProgressUpdatePayload,
  WorkerRunResult,
  WorkerSearchRequest,
  WorkerSearchResponse,
} from "../contracts.js";

export interface WorkerHost {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  appendProgress(event: string | ProgressUpdatePayload): Promise<void>;
  readTask(): Promise<string>;
  readMemory(): Promise<string>;
  writeMemory(content: string): Promise<void>;
  search(request: string | WorkerSearchRequest): Promise<WorkerSearchResponse>;
  serveHttp(options: WorkerHttpServiceOptions): Promise<{ url: string; close(): Promise<void> }>;
  markReady(payload: string | WorkerServiceReadyPayload): Promise<void>;
  completeTask(payload: string | { summary: string; resultFile?: string }): Promise<void>;
  failTask(payload: string | { summary: string }): Promise<void>;
}

export interface WorkerHttpServiceOptions {
  host: string;
  port: number;
  path?: string;
  fetch?: WorkerHttpHandler;
  handler?: WorkerHttpHandler;
  requestHandler?: WorkerHttpHandler;
}

export type WorkerHttpHandler = (request: Request) => Response | Promise<Response>;

export interface WorkerServiceReadyPayload {
  summary: string;
  host?: string;
  port: number;
  path?: string;
}

export interface ActiveServiceHandle {
  server: import("node:http").Server;
  host: string;
  port: number;
  path: string;
  url: string;
}

export type WorkerTaskStatus = "open" | "done";

export interface WorkerTask {
  id: string;
  title: string;
  status: WorkerTaskStatus;
}

export interface IterationContextEntry {
  iteration: number;
  decision: "continue" | "test";
  intent: string;
  summary: string;
  notes?: string;
  tasks: WorkerTask[];
  appSource: string;
  updatedFiles: string[];
}

export interface IterationInstruction {
  decision: "continue" | "test";
  intent: string;
  summary: string;
  notes?: string;
  appSource: string;
  wasTestDeferred?: boolean;
}

export interface PromptContext {
  task: string;
  memory: string;
  existingAppSource: string;
  tasks: WorkerTask[];
  workingContext: IterationContextEntry[];
  progressLog: string;
  contextLog: string;
}

export type RuntimeModePhase =
  | "start"
  | "implementation:planning"
  | "implementation:iterating"
  | "test"
  | "experience"
  | "idle";

export interface FailedAttemptSnapshot {
  attempt: number;
  iteration: number;
  error: string;
  workingContext: IterationContextEntry[];
  appSource: string;
  tasks: WorkerTask[];
}

export interface AiFunctionToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiToolCallMessage {
  id: string;
  type: "function";
  name: string;
  arguments: string;
}

export interface AiAssistantResponseMessage {
  role: "assistant";
  content?: string;
  refusal?: string;
  toolCalls?: AiToolCallMessage[];
}

export interface AiToolResponseMessage {
  role: "tool";
  content: string;
  toolCallId: string;
}

export interface AiInferenceToolUseRequest {
  type: "tool_use";
  system?: string;
  messages: Array<
    | { role: "user"; content: string }
    | AiAssistantResponseMessage
    | AiToolResponseMessage
  >;
  tools: AiFunctionToolDefinition[];
  toolChoice?: "auto" | "required" | "none";
}

export type WorkerRunResultService = NonNullable<WorkerRunResult["service"]>;
