import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { access, appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { WireMessage, createMessage } from "@smallbot/framework";
import ts from "typescript";

import {
  CompletionPayload,
  PendingRequest,
  ProgressEvent,
  ProgressUpdatePayload,
  WorkerContextConfig,
  WorkerRunResult,
  WorkerRuntime,
  WorkerSearchRequest,
  WorkerSearchResponse,
} from "./contracts.js";
import type { WorkerAiToolName } from "./contracts.js";
import { createDefaultAppTemplate } from "./defaultAppTemplate.js";

const exec = promisify(execCallback);

interface WorkerHost {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  appendProgress(event: string | ProgressUpdatePayload): Promise<void>;
  readTask(): Promise<string>;
  readMemory(): Promise<string>;
  writeMemory(content: string): Promise<void>;
  search(request: string | WorkerSearchRequest): Promise<WorkerSearchResponse>;
  completeTask(payload: string | { summary: string; resultFile?: string }): Promise<void>;
  failTask(payload: string | { summary: string }): Promise<void>;
}

type WorkerTaskStatus = "open" | "done";

interface WorkerTask {
  id: string;
  title: string;
  status: WorkerTaskStatus;
}

interface IterationContextEntry {
  iteration: number;
  decision: "continue" | "test";
  summary: string;
  notes?: string;
  tasks: WorkerTask[];
  appSource: string;
  updatedFiles: string[];
}

interface IterationInstruction {
  decision: "continue" | "test";
  summary: string;
  notes?: string;
  appSource: string;
  wasTestDeferred?: boolean;
}

interface PromptContext {
  task: string;
  memory: string;
  existingAppSource: string;
  tasks: WorkerTask[];
  workingContext: IterationContextEntry[];
  progressLog: string;
  contextLog: string;
}

type RuntimeModePhase =
  | "start"
  | "implementation:planning"
  | "implementation:iterating"
  | "test"
  | "experience"
  | "idle";

interface FailedAttemptSnapshot {
  attempt: number;
  iteration: number;
  error: string;
  workingContext: IterationContextEntry[];
  appSource: string;
  tasks: WorkerTask[];
}

interface AiFunctionToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface AiToolCallMessage {
  id: string;
  type: "function";
  name: string;
  arguments: string;
}

interface AiAssistantResponseMessage {
  role: "assistant";
  content?: string;
  refusal?: string;
  toolCalls?: AiToolCallMessage[];
}

interface AiToolResponseMessage {
  role: "tool";
  content: string;
  toolCallId: string;
}

interface AiInferenceToolUseRequest {
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

const IMPLEMENTATION_TOOLS: Array<AiFunctionToolDefinition & { name: WorkerAiToolName }> = [
  {
    type: "function",
    name: "list_files",
    description: "List files under the worker storage root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional relative directory inside storage." },
        limit: { type: "number", description: "Maximum number of paths to return." },
      },
    },
  },
  {
    type: "function",
    name: "read_file",
    description: "Read a UTF-8 text file from worker storage.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path inside storage." },
      },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "write_file",
    description: "Write a UTF-8 text file inside worker storage.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path inside storage." },
        content: { type: "string", description: "Full replacement file content." },
      },
      required: ["path", "content"],
    },
  },
  {
    type: "function",
    name: "search_files",
    description: "Search file paths and text contents inside worker storage.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Plain-text query to search for." },
        path: { type: "string", description: "Optional relative directory inside storage." },
        limit: { type: "number", description: "Maximum number of matches to return." },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "create_task",
    description: "Create a new open implementation task managed by the worker.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task title." },
      },
      required: ["title"],
    },
  },
  {
    type: "function",
    name: "update_task",
    description: "Update an existing worker-managed implementation task.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Existing task id." },
        status: { type: "string", description: "Task status: open or done." },
        title: { type: "string", description: "Optional replacement task title." },
      },
      required: ["id", "status"],
    },
  },
  {
    type: "function",
    name: "list_tasks",
    description: "List the current worker-managed implementation tasks.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "web_search",
    description: "Search the web through the configured search module.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        language: { type: "string" },
        region: { type: "string" },
        safeSearch: { type: "string" },
        site: { type: "string" },
        freshness: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "execute_typescript",
    description: "Execute arbitrary TypeScript with full Node.js access. Use this for package installs, shell commands, code generation, or any implementation step best handled by running TypeScript directly.",
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "TypeScript source code to execute." },
      },
      required: ["script"],
    },
  },
];

export class TaskWorkerService {
  static readonly DISCOVERY_ATTEMPTS = 5;
  static readonly DISCOVERY_RETRY_DELAY_MS = 150;
  static readonly MESSAGE_BUS_TIMEOUT_MS = 30_000;
  static readonly RUN_RETRY_DELAY_MS = 1_000;
  static readonly AI_TOOL_LOOP_MAX_ROUNDS = 12;

  readonly #pending = new Map<string, PendingRequest>();
  #activeRun?: Promise<void>;
  #currentCaller?: string;
  #currentRequestId?: string;
  #completion: WorkerRunResult | null = null;
  #watcher?: FSWatcher;
  #watchDebounce?: NodeJS.Timeout;
  #lastAutoRunTask?: string;
  #resolvedAiTarget?: string;

  constructor(
    private readonly runtime: WorkerRuntime,
    private readonly config: WorkerContextConfig,
  ) {}

  private get messageBusTimeoutMs(): number {
    return this.config.messageBusTimeoutMs ?? TaskWorkerService.MESSAGE_BUS_TIMEOUT_MS;
  }

  async onMessage(message: WireMessage): Promise<void> {
    if (message.c === "tool") {
      await this.beginRun(message.s, message.i);
      return;
    }

    const pending = this.#pending.get(message.i);

    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.#pending.delete(message.i);
    pending.resolve(message);
  }

  async startWatching(): Promise<void> {
    await this.prepareStorage();
    await this.checkAutoStart();

    if (this.#watcher) {
      return;
    }

    this.#watcher = watch(this.config.dataPath, () => {
      this.scheduleAutoStartCheck();
    });
  }

  async stopWatching(): Promise<void> {
    if (this.#watchDebounce) {
      clearTimeout(this.#watchDebounce);
      this.#watchDebounce = undefined;
    }

    this.#watcher?.close();
    this.#watcher = undefined;
  }

  async runTask(replyTarget?: string, requestId: string = randomUUID()): Promise<void> {
    this.#currentCaller = replyTarget;
    this.#currentRequestId = requestId;
    this.#completion = null;
    this.#resolvedAiTarget = undefined;

    try {
      await this.runtime.updateState("busy");
      await this.prepareStorage();

      const task = await this.readTaskFile();
      this.#lastAutoRunTask = task;
      await this.archiveTask(task);
      await this.appendProgressLog("start", "Loaded task from storage");
      await this.emitProgress({
        requestId,
        worker: this.runtime.serviceName,
        phase: "start",
        message: "loaded task.md. starting assessment of the current app.",
        updatedFiles: ["task.md", this.relativeStoragePath("logs/progress.log")],
        done: false,
        state: "running",
      });

      const verifiedCompletion = await this.runStartMode(task, requestId)
        ?? await this.runImplementationMode(task, requestId);
      await this.writeResultArtifact(verifiedCompletion);
      await this.appendProgressLog("idle", "Run completed. waiting for the next task.md");
      if (replyTarget) {
        await this.runtime.send(
          createMessage({
            s: this.runtime.serviceName,
            t: replyTarget,
            c: "result",
            i: requestId,
            m: {
              requestId,
              worker: this.runtime.serviceName,
              success: verifiedCompletion.success,
              summary: verifiedCompletion.summary,
              resultFile: verifiedCompletion.resultFile,
              verificationSummary: verifiedCompletion.verificationSummary,
            },
          }),
        );
      }
    } catch (error) {
      const summary = error instanceof Error ? error.message : "Worker execution failed";
      await this.appendProgressLog("error", summary);
      if (replyTarget) {
        await this.runtime.send(
          createMessage({
            s: this.runtime.serviceName,
            t: replyTarget,
            c: "error",
            i: requestId,
            m: {
              requestId,
              worker: this.runtime.serviceName,
              reason: summary,
            },
          }),
        );
      }
    } finally {
      await this.runtime.updateState("free");
      this.#currentCaller = undefined;
      this.#currentRequestId = undefined;
      this.#completion = null;
      this.#resolvedAiTarget = undefined;
      if (this.#watcher) {
        this.scheduleAutoStartCheck();
      }
    }
  }

  async askAi(prompt: string): Promise<WireMessage> {
    return this.askAiRequest({
      kind: "task-worker:generate-app",
      prompt,
      requestId: this.#currentRequestId,
    });
  }

  private async askAiRequest(payload: unknown): Promise<WireMessage> {
    const target = this.config.aiTarget
      ?? this.#resolvedAiTarget
      ?? (this.#resolvedAiTarget = await this.discoverTarget(this.config.aiKind, "AI"));

    return this.requestToolMessage(target, payload, "Timed out waiting for AI response");
  }

  private createImplementationTools(): AiFunctionToolDefinition[] {
    return IMPLEMENTATION_TOOLS.filter((tool) => this.isToolEnabled(tool.name));
  }

  private isToolEnabled(toolName: WorkerAiToolName): boolean {
    return this.config.enabledTools?.[toolName] ?? true;
  }

  private async runAiWithWorkerTools(request: AiInferenceToolUseRequest, source: string): Promise<unknown> {
    let currentRequest = request;

    for (let round = 1; round <= TaskWorkerService.AI_TOOL_LOOP_MAX_ROUNDS; round += 1) {
      const response = await this.askAiRequest(currentRequest);
      await this.logAiTools(response.m, source);

      const assistantMessage = extractAssistantResponseMessage(response.m);
      const toolCalls = assistantMessage.toolCalls ?? [];
      const supportedToolNames = new Set(currentRequest.tools.map((tool) => tool.name));
      const executableToolCalls = toolCalls.filter((toolCall) => supportedToolNames.has(toolCall.name));

      if (toolCalls.length === 0 || executableToolCalls.length === 0 || executableToolCalls.length !== toolCalls.length) {
        return response.m;
      }

      const toolResponses: AiToolResponseMessage[] = [];
      for (const toolCall of executableToolCalls) {
        const content = await this.executeWorkerToolCall(toolCall, source);
        toolResponses.push({
          role: "tool",
          content,
          toolCallId: toolCall.id,
        });
      }

      currentRequest = {
        ...currentRequest,
        messages: [
          ...currentRequest.messages,
          assistantMessage,
          ...toolResponses,
        ],
      };
    }

    throw new Error(`AI tool loop exceeded ${TaskWorkerService.AI_TOOL_LOOP_MAX_ROUNDS} rounds`);
  }

  private async executeWorkerToolCall(toolCall: AiToolCallMessage, source: string): Promise<string> {
    let args: Record<string, unknown>;
    try {
      args = toolCall.arguments.trim().length > 0
        ? JSON.parse(toolCall.arguments) as Record<string, unknown>
        : {};
    } catch {
      throw new Error(`AI tool call ${toolCall.name} used invalid JSON arguments`);
    }

    switch (toolCall.name) {
      case "list_files":
        return JSON.stringify(await this.aiToolListFiles(args), null, 2);
      case "read_file":
        return JSON.stringify(await this.aiToolReadFile(args, source), null, 2);
      case "write_file":
        return JSON.stringify(await this.aiToolWriteFile(args, source), null, 2);
      case "search_files":
        return JSON.stringify(await this.aiToolSearchFiles(args), null, 2);
      case "create_task":
        return JSON.stringify(await this.aiToolCreateTask(args), null, 2);
      case "update_task":
        return JSON.stringify(await this.aiToolUpdateTask(args), null, 2);
      case "list_tasks":
        return JSON.stringify(await this.aiToolListTasks(), null, 2);
      case "web_search":
        return JSON.stringify(await this.aiToolWebSearch(args), null, 2);
      case "execute_typescript":
        return JSON.stringify(await this.aiToolExecuteTypescript(args), null, 2);
      default:
        throw new Error(`Unsupported AI tool call: ${toolCall.name}`);
    }
  }

  private async aiToolListFiles(args: Record<string, unknown>): Promise<{ path: string; files: string[]; truncated: boolean }> {
    const relativeDir = typeof args.path === "string" && args.path.trim().length > 0 ? args.path : ".";
    const limit = normalizePositiveInteger(args.limit, 200);
    const rootPath = this.resolveStoragePath(relativeDir);
    const files = await this.collectFiles(rootPath, limit);
    return {
      path: relativeDir,
      files: files.map((filePath) => path.relative(this.config.dataPath, filePath)),
      truncated: files.length >= limit,
    };
  }

  private async aiToolReadFile(
    args: Record<string, unknown>,
    source: string,
  ): Promise<{ path: string; exists: boolean; content: string }> {
    const relativePath = requireStringArg(args.path, "path");
    this.validateAiToolPath(relativePath, source, "read");
    const fullPath = this.resolveStoragePath(relativePath);

    try {
      const content = await readFile(fullPath, "utf8");
      return {
        path: relativePath,
        exists: true,
        content,
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return {
          path: relativePath,
          exists: false,
          content: "",
        };
      }

      throw error;
    }
  }

  private async aiToolWriteFile(args: Record<string, unknown>, source: string): Promise<{ path: string; bytes: number; source: string }> {
    const relativePath = requireStringArg(args.path, "path");
    const content = requireStringArg(args.content, "content");
    this.validateAiToolPath(relativePath, source, "write");
    const fullPath = this.resolveStoragePath(relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
    await this.appendProgressLog(source === "memory" ? "experience" : "implementation:iterating", `AI tool wrote ${relativePath}`);
    return {
      path: relativePath,
      bytes: Buffer.byteLength(content, "utf8"),
      source,
    };
  }

  private async aiToolSearchFiles(args: Record<string, unknown>): Promise<{ query: string; matches: Array<{ path: string; line: number; preview: string }> }> {
    const query = requireStringArg(args.query, "query");
    const relativeDir = typeof args.path === "string" && args.path.trim().length > 0 ? args.path : ".";
    const limit = normalizePositiveInteger(args.limit, 20);
    const files = await this.collectFiles(this.resolveStoragePath(relativeDir), 500);
    const loweredQuery = query.toLowerCase();
    const matches: Array<{ path: string; line: number; preview: string }> = [];

    for (const filePath of files) {
      if (matches.length >= limit) {
        break;
      }

      const relativePath = path.relative(this.config.dataPath, filePath);
      if (relativePath.toLowerCase().includes(loweredQuery)) {
        matches.push({ path: relativePath, line: 0, preview: relativePath });
      }

      if (matches.length >= limit) {
        break;
      }

      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index]!.toLowerCase().includes(loweredQuery)) {
          continue;
        }

        matches.push({
          path: relativePath,
          line: index + 1,
          preview: summarizeLine(lines[index]!),
        });

        if (matches.length >= limit) {
          break;
        }
      }
    }

    return { query, matches };
  }

  private validateAiToolPath(relativePath: string, source: string, operation: "read" | "write"): void {
    if (source !== "iteration") {
      return;
    }

    if (relativePath === "memory.md" || relativePath === "tasks.json") {
      throw new Error(`AI iteration tool must not ${operation} ${relativePath}; ${relativePath} is managed by the worker text flow`);
    }
  }

  private async aiToolCreateTask(args: Record<string, unknown>): Promise<{ task: WorkerTask }> {
    const title = requireStringArg(args.title, "title").trim();
    if (!title) {
      throw new Error("create_task requires a non-empty title");
    }

    const tasks = await this.readTaskList();
    const task: WorkerTask = {
      id: randomUUID(),
      title,
      status: "open",
    };
    tasks.push(task);
    await this.writeTaskList(tasks);
    await this.appendProgressLog("implementation:planning", `Created implementation task '${task.title}'`);
    return { task };
  }

  private async aiToolUpdateTask(args: Record<string, unknown>): Promise<{ task: WorkerTask }> {
    const id = requireStringArg(args.id, "id");
    const status = requireTaskStatusArg(args.status, "status");
    const title = typeof args.title === "string" ? args.title.trim() : undefined;
    const tasks = await this.readTaskList();
    const index = tasks.findIndex((task) => task.id === id);
    if (index < 0) {
      throw new Error(`update_task referenced unknown task id '${id}'`);
    }

    const nextTask: WorkerTask = {
      ...tasks[index]!,
      status,
      ...(title ? { title } : {}),
    };
    tasks[index] = nextTask;
    await this.writeTaskList(tasks);
    await this.appendProgressLog("implementation:iterating", `Updated implementation task '${nextTask.title}' to ${nextTask.status}`);
    return { task: nextTask };
  }

  private async aiToolListTasks(): Promise<{ tasks: WorkerTask[] }> {
    return { tasks: await this.readTaskList() };
  }

  private async aiToolWebSearch(args: Record<string, unknown>): Promise<WorkerSearchResponse> {
    const query = requireStringArg(args.query, "query");
    return this.search({
      type: "search",
      query,
      ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      ...(typeof args.language === "string" ? { language: args.language } : {}),
      ...(typeof args.region === "string" ? { region: args.region } : {}),
      ...(typeof args.safeSearch === "string" ? { safeSearch: args.safeSearch as WorkerSearchRequest["safeSearch"] } : {}),
      ...(typeof args.site === "string" ? { site: args.site } : {}),
      ...(typeof args.freshness === "string" ? { freshness: args.freshness } : {}),
    });
  }

  private async aiToolExecuteTypescript(args: Record<string, unknown>): Promise<{
    ok: boolean;
    outputFile: string;
    stdout: string;
    stderr: string;
    returnValue?: unknown;
    error?: {
      message: string;
      stack?: string;
    };
  }> {
    const script = requireStringArg(args.script, "script");
    const outputFile = path.join("tmp", `execute-typescript-${Date.now()}-${randomUUID()}.mjs`);
    const outputPath = this.resolveStoragePath(outputFile);
    const transpiled = ts.transpileModule(script, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: "execute-typescript.ts",
    });

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, transpiled.outputText, "utf8");
    await this.appendProgressLog("implementation:iterating", "AI tool compiled execute_typescript script");

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const moduleUrl = `${pathToFileURL(outputPath).href}?t=${Date.now()}`;
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);

    const captureWrite = (chunks: string[], originalWrite: typeof process.stdout.write) => {
      return ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const resolvedEncoding = typeof encoding === "string" ? encoding : undefined;
        const resolvedCallback = typeof encoding === "function" ? encoding : callback;
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(resolvedEncoding ?? "utf8"));
        return originalWrite(chunk as never, encoding as never, resolvedCallback as never);
      }) as typeof process.stdout.write;
    };

    process.stdout.write = captureWrite(stdoutChunks, originalStdoutWrite);
    process.stderr.write = captureWrite(stderrChunks, originalStderrWrite);

    let result: {
      ok: boolean;
      outputFile: string;
      stdout: string;
      stderr: string;
      returnValue?: unknown;
      error?: {
        message: string;
        stack?: string;
      };
    };

    try {
      const imported = await import(moduleUrl);
      const executor = typeof imported.default === "function"
        ? imported.default
        : typeof imported.run === "function"
          ? imported.run
          : undefined;

      const returnValue = executor
        ? await executor(this.createExecuteTypescriptContext())
        : undefined;

      result = {
        ok: true,
        outputFile,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        ...(returnValue === undefined ? {} : { returnValue }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = {
        ok: false,
        outputFile,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        error: error instanceof Error
          ? { message, ...(error.stack ? { stack: error.stack } : {}) }
          : { message },
      };
      await this.appendProgressLog("implementation:iterating", `AI tool execute_typescript failed: ${message}`);
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    await this.appendProgressLog("implementation:iterating", "AI tool finished execute_typescript script");
    return result;
  }

  private createExecuteTypescriptContext(): {
    storagePath: string;
    resolvePath: (relativePath: string) => string;
    readTextFile: (relativePath: string) => Promise<string>;
    writeTextFile: (relativePath: string, content: string) => Promise<void>;
    appendTextFile: (relativePath: string, content: string) => Promise<void>;
    exec: (
      command: string,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
      },
    ) => Promise<{ stdout: string; stderr: string }>;
  } {
    return {
      storagePath: this.config.dataPath,
      resolvePath: (relativePath) => this.resolveStoragePath(relativePath),
      readTextFile: async (relativePath) => readFile(this.resolveStoragePath(relativePath), "utf8"),
      writeTextFile: async (relativePath, content) => {
        const fullPath = this.resolveStoragePath(relativePath);
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content, "utf8");
      },
      appendTextFile: async (relativePath, content) => {
        const fullPath = this.resolveStoragePath(relativePath);
        await mkdir(path.dirname(fullPath), { recursive: true });
        await appendFile(fullPath, content, "utf8");
      },
      exec: async (command, options) => {
        const cwd = options?.cwd ? path.resolve(this.config.dataPath, options.cwd) : this.config.dataPath;
        const { stdout, stderr } = await exec(command, {
          cwd,
          env: {
            ...process.env,
            ...options?.env,
          },
          maxBuffer: 10 * 1024 * 1024,
        });

        return { stdout, stderr };
      },
    };
  }

  private async collectFiles(rootPath: string, limit: number): Promise<string[]> {
    const results: string[] = [];
    const visit = async (currentPath: string): Promise<void> => {
      if (results.length >= limit) {
        return;
      }

      const entries = await readdir(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= limit) {
          return;
        }

        const fullPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          if (path.relative(this.config.dataPath, fullPath).startsWith("tmp")) {
            continue;
          }
          await visit(fullPath);
          continue;
        }

        if (entry.isFile()) {
          results.push(fullPath);
        }
      }
    };

    await visit(rootPath);
    return results;
  }

  private async prepareStorage(): Promise<void> {
    await mkdir(this.resolveStoragePath("."), { recursive: true });
    await mkdir(this.resolveStoragePath("app"), { recursive: true });
    await mkdir(this.resolveStoragePath("logs"), { recursive: true });
    await mkdir(this.resolveStoragePath("tmp"), { recursive: true });
    await mkdir(this.resolveStoragePath("old-tasks"), { recursive: true });
    await appendFile(this.resolveStoragePath("logs/progress.log"), "");
    await appendFile(this.resolveStoragePath("logs/tools.log"), "");
    await appendFile(this.resolveStoragePath("logs/context.log"), "");
  }

  private async readTaskFile(): Promise<string> {
    const taskPath = this.resolveStoragePath("task.md");

    try {
      await access(taskPath);
    } catch {
      throw new Error("Missing task.md in module storage");
    }

    return readFile(taskPath, "utf8");
  }

  private async readMemoryFile(): Promise<string> {
    try {
      return await readFile(this.resolveStoragePath("memory.md"), "utf8");
    } catch {
      return "";
    }
  }

  private async readExistingAppSource(): Promise<string> {
    try {
      return await readFile(this.resolveStoragePath("app/index.ts"), "utf8");
    } catch {
      return "";
    }
  }

  private async readTaskList(): Promise<WorkerTask[]> {
    try {
      const raw = await readFile(this.resolveStoragePath("tasks.json"), "utf8");
      return parseTaskList(raw);
    } catch {
      return [];
    }
  }

  private async writeTaskList(tasks: WorkerTask[]): Promise<void> {
    await writeFile(this.resolveStoragePath("tasks.json"), JSON.stringify({ tasks }, null, 2), "utf8");
  }

  private async clearTaskList(reason: string, phase: RuntimeModePhase = "implementation:planning"): Promise<void> {
    await this.writeTaskList([]);
    await this.appendProgressLog(phase, reason);
  }

  private async readProgressLog(): Promise<string> {
    return readFile(this.resolveStoragePath("logs/progress.log"), "utf8").catch(() => "");
  }

  private async readContextLog(): Promise<string> {
    return readFile(this.resolveStoragePath("logs/context.log"), "utf8").catch(() => "");
  }

  private async buildPromptContext(task: string, workingContext: IterationContextEntry[]): Promise<PromptContext> {
    const [memory, existingAppSource, tasks, progressLog, contextLog] = await Promise.all([
      this.readMemoryFile(),
      this.readExistingAppSource(),
      this.readTaskList(),
      this.readProgressLog(),
      this.readContextLog(),
    ]);

    return {
      task,
      memory,
      existingAppSource,
      tasks,
      workingContext,
      progressLog,
      contextLog,
    };
  }

  private async askAiForIteration(context: PromptContext): Promise<unknown> {
    await this.appendProgressLog("ai", "Requesting iterative app update over the message bus");
    const appFileExists = context.existingAppSource.trim().length > 0;
    const availableFiles = appFileExists
      ? ["task.md", "app/index.ts", "logs/progress.log", "logs/context.log"]
      : ["task.md", "logs/progress.log", "logs/context.log"];
    const implementationTools = this.createImplementationTools();
    const availableToolNames = implementationTools.map((tool) => tool.name as WorkerAiToolName);
    const hasWebSearchTool = availableToolNames.includes("web_search");
    const hasExecuteTypescriptTool = availableToolNames.includes("execute_typescript");

    const response = await this.runAiWithWorkerTools({
      type: "tool_use",
      system: [
        "You iteratively extend the existing TypeScript source code for app/index.ts.",
        "Prefer updating the existing app instead of replacing it from scratch when it already exists.",
        "At the start of each implementation run, think through what work is needed to solve the task, including analyzing the existing implementation and deciding which patches or improvements are needed.",
        "Before changing code, first consider whether the existing app already solves the task.",
        "Use the worker task tool as the only source of implementation work tracking.",
        "At the beginning of a fresh implementation run, create the implementation tasks you need with create_task.",
        "app/index.ts may be missing at the start of a fresh run.",
        "If app/index.ts is missing, treat that as normal and create it with write_file when you are ready to implement.",
        "Do not assume read_file(app/index.ts) will succeed on a fresh run.",
        "You may solve the problem in multiple implementation steps.",
        "Each iteration must perform a real implementation step, not just restate the task, memory, or the task list.",
        "A real implementation step may be code work in app/index.ts or non-code implementation work such as inspecting an existing file, tracing behavior, or refining the plan when that work is required to solve the task.",
        "If an iteration does not change app/index.ts, the progress must still be visible in the worker-managed task list and in the iteration summary or notes.",
        "Do not leave app/index.ts and the task list effectively unchanged across iterations.",
        "When work remains, make progress by completing one or more open tasks, or by replacing an open task with smaller concrete implementation tasks caused by what you just learned.",
        "It is valid to complete multiple tasks in a single iteration when the work was actually done.",
        "Review list_tasks() after each implementation step, keep the task list current, and add newly discovered implementation tasks when needed.",
        "Only choose `test` after list_tasks() shows no open tasks.",
        "The file must export `default async function run(host)`.",
        "The app must provide a local HTTP REST API.",
        [
          "Use the provided tools for file reads, file writes, task tracking, and content search during implementation.",
          hasExecuteTypescriptTool ? "Use execute_typescript when direct TypeScript execution is the best fit." : "",
        ].filter(Boolean).join(" "),
        ...(hasExecuteTypescriptTool
          ? [
            "Use execute_typescript whenever a step is easier or more reliable to perform by running TypeScript directly, including shell commands, npm installs, scaffolding, filesystem transforms, or analysis scripts.",
            "execute_typescript has full Node.js access and may use child_process, filesystem APIs, and any other built-in modules.",
          ]
          : []),
        "Do not use tools to read or write tasks.json or memory.md; those are managed by the worker.",
        "Read relevant files before changing them. Persist implementation changes to app/index.ts via write_file.",
        "You may decide to continue editing without testing, or to stop editing and let the worker test the app.",
        "Return an explicit decision of `continue` or `test`.",
        "Return only one fenced ```ts code block for app/index.ts when you provide source code.",
        ...(hasWebSearchTool
          ? ["Use the web_search tool when external lookup is required. Generated app code must use host.search(...) for runtime web lookups."]
          : []),
        "Do not call AI, do not request more inference, and do not use host.askAi.",
        "Do not perform direct network requests; use only host methods.",
        "Use only the host methods described in the request.",
      ].join(" "),
      toolChoice: "auto",
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            goal: "Iteratively extend the task-worker app until it is ready for testing",
            task: context.task,
            memory: context.memory,
            existingAppSource: context.existingAppSource,
            appFileExists,
            currentTasks: context.tasks,
            workingContext: context.workingContext,
            progress: context.progressLog,
            contextLog: context.contextLog,
            availableFiles,
            requiredResponse: {
              decision: "continue | test",
              summary: "short summary of the change for the worker context",
              notes: "optional additional notes",
              taskRule: "Implementation work must be tracked exclusively through create_task, update_task, and list_tasks; choose test only when all tasks are done",
              file: "app/index.ts",
              export: "default async function run(host)",
            },
            requiredInterface: {
              hostMethods: [
                "readFile",
                "writeFile",
                "appendProgress",
                "readTask",
                "readMemory",
                "writeMemory",
                "search",
                "completeTask",
                "failTask",
              ],
              taskTools: [
                "create_task",
                "update_task",
                "list_tasks",
              ],
              executionTools: hasExecuteTypescriptTool ? ["execute_typescript(script)"] : [],
              optionalLookupTools: hasWebSearchTool ? ["web_search(query)"] : [],
            },
          }, null, 2),
        },
      ],
      tools: implementationTools,
    }, "iteration");

    return response;
  }

  private async writeAppSource(source: string): Promise<void> {
    await writeFile(this.resolveStoragePath("app/index.ts"), source, "utf8");
    await this.appendProgressLog("implementation:iterating", "Wrote generated app/index.ts");
  }

  private async appendIterationContext(entry: IterationContextEntry): Promise<void> {
    const timestamp = new Date().toISOString();
    const record = JSON.stringify({
      timestamp,
      iteration: entry.iteration,
      decision: entry.decision,
      summary: entry.summary,
      notes: entry.notes,
      tasks: entry.tasks,
      updatedFiles: entry.updatedFiles,
    });
    await appendFile(this.resolveStoragePath("logs/context.log"), `${record}\n`, "utf8");
  }

  private async clearWorkingContext(reason = "Cleared implementation working context"): Promise<void> {
    await writeFile(this.resolveStoragePath("logs/context.log"), "", "utf8");
    await this.appendProgressLog("test", reason);
  }

  private async synthesizeMemoryFromFailure(
    context: PromptContext,
    appSource: string,
    error: string,
  ): Promise<void> {
    await this.appendProgressLog("experience", "Requesting memory synthesis from failed attempt");

    const response = await this.askAi(JSON.stringify({
      type: "completion",
      system: [
        "You prepare memory.md for the next worker attempt after a failed run.",
        "Memory is managed directly by the worker, so do not request tools for memory.md.",
        "Return only the memory.md content as plain text.",
        "You are given the existing memory.md and must carry forward any findings from it that still matter.",
        "Merge the old memory with the new failure context so relevant findings are not lost.",
        "Keep only information that is likely to help the next attempt.",
      ].join(" "),
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            goal: "Decide what should be remembered for the next task-worker retry",
            task: context.task,
            existingMemory: context.memory,
            workingContext: context.workingContext,
            progress: context.progressLog,
            contextLog: context.contextLog,
            failedAppSource: appSource || undefined,
            failure: error,
          }, null, 2),
        },
      ],
    }));

    await this.logAiTools(response.m, "memory");
    const memory = extractMemoryContent(response.m) || await this.readMemoryFile();
    if (!memory) {
      throw new Error("Memory synthesis returned no usable content");
    }

    await writeFile(this.resolveStoragePath("memory.md"), memory, "utf8");
    await this.appendProgressLog("experience", "Updated memory.md from failed attempt");
  }

  private async runImplementationMode(task: string, requestId: string): Promise<WorkerRunResult> {
    let attempt = 0;
    let iteration = 0;
    let lastErrorMessage: string | undefined;
    const workingContext: IterationContextEntry[] = [];

    await writeFile(this.resolveStoragePath("logs/context.log"), "", "utf8");

    while (true) {
      attempt += 1;
      this.#completion = null;

      const failure = await this.runImplementationAttempt(
        task,
        requestId,
        attempt,
        iteration,
        workingContext,
        lastErrorMessage,
      );
      if (!failure) {
        await this.clearWorkingContext("Cleared implementation working context after completed run");
        const completion = this.requireCompletion();
        return completion;
      }

      iteration = failure.iteration;
      lastErrorMessage = failure.error;
      await this.runExperienceMode(task, requestId, failure);
      await delay(TaskWorkerService.RUN_RETRY_DELAY_MS);
    }
  }

  private async runImplementationAttempt(
    task: string,
    requestId: string,
    attempt: number,
    startingIteration: number,
    workingContext: IterationContextEntry[],
    lastErrorMessage?: string,
  ): Promise<FailedAttemptSnapshot | null> {
    let iteration = startingIteration;

    try {
      await this.clearTaskList("Reset tasks.json before starting implementation planning", "implementation:planning");
      await this.emitProgress({
        requestId,
        worker: this.runtime.serviceName,
        phase: "implementation:planning",
        message: "starting implementation planning with worker-managed tasks.",
        updatedFiles: ["tasks.json", this.relativeStoragePath("logs/progress.log")],
        done: false,
        state: "running",
      });

      while (true) {
        iteration += 1;
        const promptContext = await this.buildPromptContext(task, workingContext);
        const aiPayload = await this.askAiForIteration(promptContext);
        const latestAppSource = await this.readExistingAppSource();
        let latestTasks = await this.readTaskList();
        const payloadTasks = selectTaskListContent(aiPayload);
        if (payloadTasks.length > 0) {
          latestTasks = payloadTasks;
          await this.writeTaskList(latestTasks);
        }

        const instruction = this.selectIterationInstruction(
          task,
          latestAppSource || promptContext.existingAppSource,
          aiPayload,
        );
        this.validateGeneratedAppSource(instruction.appSource);
        this.validateTaskList(latestTasks);
        const normalizedInstruction = await this.normalizeIterationDecisionAgainstTasks(instruction, latestTasks);
        this.validateIterationProgress(promptContext, normalizedInstruction, latestTasks);
        await this.writeAppSource(normalizedInstruction.appSource);

        const updatedFiles = [
          "app/index.ts",
          "tasks.json",
          this.relativeStoragePath("logs/context.log"),
          this.relativeStoragePath("logs/progress.log"),
        ];
        const entry: IterationContextEntry = {
          iteration,
          decision: normalizedInstruction.decision,
          summary: normalizedInstruction.summary,
          notes: normalizedInstruction.notes,
          tasks: latestTasks,
          appSource: normalizedInstruction.appSource,
          updatedFiles,
        };
        workingContext.push(entry);
        await this.appendIterationContext(entry);
        await this.emitProgress({
          requestId,
          worker: this.runtime.serviceName,
          phase: "implementation:iterating",
          message: formatPlanningMessage(iteration, normalizedInstruction),
          updatedFiles,
          done: false,
          state: "running",
        });

        if (normalizedInstruction.decision === "continue") {
          await this.appendProgressLog("implementation:iterating", `Continuing iterative edit loop after iteration ${iteration} after reviewing tasks.json`);
          continue;
        }

        break;
      }

      await this.runTestMode(task, requestId);
      const completion = this.requireCompletion();
      if (!completion.success) {
        throw new Error(completion.summary);
      }

      this.#completion = await this.verifyCompletion(task, completion, workingContext);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Worker execution failed";
      const promptContext = await this.buildPromptContext(task, workingContext);

      return {
        attempt,
        iteration,
        error: message,
        workingContext,
        appSource: promptContext.existingAppSource,
        tasks: promptContext.tasks,
      };
    }
  }

  private async runTestMode(task: string, requestId: string): Promise<void> {
    await this.appendProgressLog("test", "Starting fresh test run for app/index.ts");
    await this.evaluateApp(
      "app/index.ts",
      "test",
      "all tracked implementation tasks are complete. start fresh test run.",
      ["app/index.ts", "tasks.json"],
    );
    await this.appendProgressLog("test", `Finished app execution for task '${task.slice(0, 80)}'`);
    await this.emitProgress({
      requestId,
      worker: this.runtime.serviceName,
      phase: "test",
      message: "app execution finished. verifying task result.",
      updatedFiles: ["app/index.ts", "tasks.json", this.relativeStoragePath("logs/progress.log")],
      done: false,
      state: "running",
    });
  }

  private async runExperienceMode(task: string, requestId: string, failure: FailedAttemptSnapshot): Promise<void> {
    await this.appendProgressLog("experience", `Attempt ${failure.attempt} failed: ${failure.error}`);
    await this.emitProgress({
      requestId,
      worker: this.runtime.serviceName,
      phase: "experience",
      message: `attempt ${failure.attempt} failed: ${failure.error}. synthesizing memory for the next implementation plan.`,
      updatedFiles: ["app/index.ts", "tasks.json", this.relativeStoragePath("logs/context.log"), this.relativeStoragePath("logs/progress.log")],
      done: false,
      state: "running",
    });

    try {
      const promptContext = await this.buildPromptContext(task, failure.workingContext);
      await this.synthesizeMemoryFromFailure(promptContext, failure.appSource, failure.error);
      failure.workingContext.length = 0;
      await this.clearWorkingContext("Cleared implementation working context after memorizing failed attempt");
      await this.clearTaskList(
        "Cleared tasks.json after failed attempt so the next implementation planning phase can start fresh",
        "experience",
      );
    } catch (memoryError) {
      const reason = memoryError instanceof Error ? memoryError.message : "Memory synthesis failed";
      await this.appendProgressLog("experience", `Skipped memory update: ${reason}`);
    }
  }

  private async evaluateApp(
    relativeAppPath: string,
    phase: RuntimeModePhase,
    progressMessage: string,
    updatedFiles: string[],
  ): Promise<void> {
    const sourcePath = this.resolveStoragePath(relativeAppPath);
    const tsSource = await readFile(sourcePath, "utf8");
    const transpiled = ts.transpileModule(tsSource, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: "index.ts",
    });

    const outputPath = this.resolveStoragePath(path.join("tmp", `index-${Date.now()}.mjs`));
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, transpiled.outputText, "utf8");
    await this.appendProgressLog(phase, `Compiled generated TypeScript app from ${relativeAppPath}`);
    await this.emitProgress({
      requestId: this.#currentRequestId ?? randomUUID(),
      worker: this.runtime.serviceName,
      phase,
      message: progressMessage,
      updatedFiles: [...updatedFiles, this.relativeStoragePath(path.relative(this.config.dataPath, outputPath)), this.relativeStoragePath("logs/progress.log")],
      done: false,
      state: "running",
    });

    const moduleUrl = `${pathToFileURL(outputPath).href}?t=${Date.now()}`;
    const imported = await import(moduleUrl);
    const run = imported.default;

    if (typeof run !== "function") {
      throw new Error("Generated app must export a default function");
    }

    await run(this.createHost());
  }

  private createHost(): WorkerHost {
    return {
      readFile: async (filePath) => readFile(this.resolveStoragePath(filePath), "utf8"),
      writeFile: async (filePath, content) => {
        const fullPath = this.resolveStoragePath(filePath);
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content, "utf8");
      },
      appendProgress: async (payload) => {
        const { phase, message, updatedFiles } = normalizeProgressUpdate(payload);
        await this.appendProgressLog(phase, message);
        await this.emitProgress({
          requestId: this.#currentRequestId ?? randomUUID(),
          worker: this.runtime.serviceName,
          phase,
          message,
          updatedFiles: [...updatedFiles, this.relativeStoragePath("logs/progress.log")],
          done: false,
          state: "running",
        });
      },
      readTask: async () => this.readTaskFile(),
      readMemory: async () => this.readMemoryFile(),
      writeMemory: async (content) => {
        await writeFile(this.resolveStoragePath("memory.md"), content, "utf8");
        await this.appendProgressLog("experience", "Updated memory.md");
      },
      search: async (request) => {
        const response = await this.search(request);
        return response;
      },
      completeTask: async (payload) => {
        const { summary, resultFile } = normalizeCompletionPayload(payload);
        this.#completion = {
          success: true,
          summary,
          resultFile,
        };
        await this.appendProgressLog("complete", summary);
        await this.emitProgress({
          requestId: this.#currentRequestId ?? randomUUID(),
          worker: this.runtime.serviceName,
          phase: "complete",
          message: `test passed. ${summary}`,
          updatedFiles: resultFile ? [resultFile, this.relativeStoragePath("logs/progress.log")] : [this.relativeStoragePath("logs/progress.log")],
          done: true,
          state: "completed",
        });
      },
      failTask: async (payload) => {
        const { summary } = normalizeFailurePayload(payload);
        this.#completion = {
          success: false,
          summary,
        };
        await this.appendProgressLog("failed", summary);
        await this.emitProgress({
          requestId: this.#currentRequestId ?? randomUUID(),
          worker: this.runtime.serviceName,
          phase: "failed",
          message: `test failed. ${summary}`,
          updatedFiles: [this.relativeStoragePath("logs/progress.log")],
          done: true,
          state: "failed",
        });
      },
    };
  }

  private async verifyCompletion(
    task: string,
    completion: WorkerRunResult,
    workingContext: IterationContextEntry[],
  ): Promise<WorkerRunResult> {
    await this.appendProgressLog("test", "Requesting AI result verification");
    const appSource = await this.readExistingAppSource();
    const resultContent = completion.resultFile
      ? await readFile(this.resolveStoragePath(completion.resultFile), "utf8").catch(() => "")
      : completion.summary;

    const response = await this.askAi(JSON.stringify({
      type: "completion",
      system: [
        "You verify whether a generated task result appears to satisfy the task.",
        "Use the app source and completion summary when no result file content is available, such as for long-running services that only signal readiness.",
        "Return a verdict of VALID or INVALID plus a short reason.",
      ].join(" "),
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            task,
            workingContext,
            appSource,
            summary: completion.summary,
            resultFile: completion.resultFile,
            resultContent,
          }, null, 2),
        },
      ],
    }));
    await this.logAiTools(response.m, "verification");

    const verification = extractVerificationOutcome(response.m);
    if (!verification.summary) {
      throw new Error("Verification returned no usable verdict");
    }

    await this.appendProgressLog("test", verification.summary);

    if (!verification.verified) {
      throw new Error(`Verification rejected result: ${verification.summary}`);
    }

    return {
      ...completion,
      verificationSummary: verification.summary,
    };
  }

  private async search(request: string | WorkerSearchRequest): Promise<WorkerSearchResponse> {
    const normalizedRequest = normalizeSearchRequest(request);
    const target = this.config.searchTarget ?? (await this.discoverTarget(this.config.searchKind ?? "search", "search"));
    const response = await this.requestToolMessage(
      target,
      normalizedRequest,
      "Timed out waiting for search response",
    );

    if (response.c === "error") {
      const failure = normalizeSearchFailure(response.m);
      await this.appendProgressLog(
        "search",
        `Search returned no usable results for ${JSON.stringify(normalizedRequest.query ?? "")}: ${failure.reason}`,
      );
      return createEmptySearchResponse(response.i, target, normalizedRequest, failure);
    }

    try {
      return normalizeSearchResponse(response.m);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Search returned an invalid response payload";
      await this.appendProgressLog(
        "search",
        `Search response could not be normalized for ${JSON.stringify(normalizedRequest.query ?? "")}: ${reason}`,
      );
      return createEmptySearchResponse(response.i, target, normalizedRequest, { reason });
    }
  }

  private async discoverTarget(kind: string, label: string): Promise<string> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= TaskWorkerService.DISCOVERY_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.requestDiscovery(kind);
        const services = extractDiscoveryServices(response.m);
        const service = services[0];

        if (!service?.name) {
          lastError = new Error(`No free ${label} service found for kind "${kind}"`);
        } else {
          return service.name;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(`Timed out waiting for ${label} discovery`);
      }

      if (attempt < TaskWorkerService.DISCOVERY_ATTEMPTS) {
        await delay(TaskWorkerService.DISCOVERY_RETRY_DELAY_MS);
      }
    }

    throw lastError ?? new Error(`No free ${label} service found for kind "${kind}"`);
  }

  private async requestDiscovery(kind: string): Promise<WireMessage> {
    const requestId = randomUUID();
    const responsePromise = this.createPendingResponse(requestId, `Timed out waiting for ${kind} discovery`);
    await this.runtime.send(
      createMessage({
        s: this.runtime.serviceName,
        d: kind,
        q: "free",
        i: requestId,
      }),
    );

    return responsePromise;
  }

  private async requestToolMessage(target: string, payload: unknown, timeoutMessage: string): Promise<WireMessage> {
    const requestId = randomUUID();
    const responsePromise = this.createPendingResponse(requestId, timeoutMessage);

    await this.runtime.send(
      createMessage({
        s: this.runtime.serviceName,
        t: target,
        c: "tool",
        i: requestId,
        m: payload,
      }),
    );

    return responsePromise;
  }

  private createPendingResponse(requestId: string, timeoutMessage: string): Promise<WireMessage> {
    return new Promise<WireMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(timeoutMessage));
      }, this.messageBusTimeoutMs);

      this.#pending.set(requestId, { resolve, reject, timeout });
    });
  }

  private async emitProgress(event: ProgressEvent, explicitTarget?: string): Promise<void> {
    const target = explicitTarget ?? this.#currentCaller;
    if (!target) {
      return;
    }

    await this.runtime.send(
      createMessage({
        s: this.runtime.serviceName,
        t: target,
        c: "progress",
        i: event.requestId,
        m: event,
      }),
    );
  }

  private async appendProgressLog(phase: string, message: string): Promise<void> {
    const timestamp = new Date().toISOString();
    console.log(`[worker:${this.runtime.serviceName}] ${phase}: ${message}`);
    await appendFile(this.resolveStoragePath("logs/progress.log"), `[${timestamp}] ${phase}: ${message}\n`, "utf8");
  }

  private async logAiTools(payload: unknown, source: string): Promise<void> {
    const toolCalls = extractToolCalls(payload);

    if (toolCalls.length === 0) {
      return;
    }

    for (const toolCall of toolCalls) {
      const timestamp = new Date().toISOString();
      const logLine = `[${timestamp}] source=${source} tool=${toolCall.name} args=${toolCall.arguments}\n`;
      console.log(`[worker:${this.runtime.serviceName}] tool: source=${source} name=${toolCall.name} args=${toolCall.arguments}`);
      await appendFile(this.resolveStoragePath("logs/tools.log"), logLine, "utf8");
    }
  }

  private async writeResultArtifact(result: CompletionPayload): Promise<void> {
    const resultPath = this.resolveStoragePath("result.json");
    await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
  }

  private validateGeneratedAppSource(source: string): void {
    if (/\bhost\.askAi\s*\(/.test(source)) {
      throw new Error("Generated app must not call host.askAi");
    }

    if (/^\s*\{\s*"tasks"\s*:/m.test(source)) {
      throw new Error("Generated app source looks like tasks.json content instead of TypeScript");
    }
  }

  private requireCompletion(): WorkerRunResult {
    if (!this.#completion) {
      throw new Error("Generated app did not signal completion");
    }

    return this.#completion;
  }

  private selectIterationInstruction(
    task: string,
    fallbackAppSource: string,
    aiPayload: unknown,
  ): IterationInstruction {
    const summary = extractIterationSummary(aiPayload) ?? "Updated app/index.ts";
    const notes = extractIterationNotes(aiPayload);
    const decision = extractIterationDecision(aiPayload) ?? "test";
    const appSource = selectAppSource(task, fallbackAppSource, aiPayload);

    return {
      decision,
      summary,
      notes,
      appSource,
    };
  }

  private resolveStoragePath(filePath: string): string {
    const resolved = path.resolve(this.config.dataPath, filePath);
    const normalizedRoot = `${path.resolve(this.config.dataPath)}${path.sep}`;

    if (resolved !== path.resolve(this.config.dataPath) && !resolved.startsWith(normalizedRoot)) {
      throw new Error(`Path escapes module storage: ${filePath}`);
    }

    return resolved;
  }

  private relativeStoragePath(filePath: string): string {
    return path.relative(this.config.dataPath, this.resolveStoragePath(filePath));
  }

  private async beginRun(replyTarget?: string, requestId: string = randomUUID()): Promise<void> {
    if (this.#activeRun) {
      if (replyTarget) {
        await this.emitProgress({
          requestId,
          worker: this.runtime.serviceName,
          phase: "queue",
          message: "Worker is already busy",
          updatedFiles: [],
          done: false,
          state: "running",
        }, replyTarget);
      }
      return;
    }

    this.#activeRun = this.runTask(replyTarget, requestId).finally(() => {
      this.#activeRun = undefined;
    });
    await this.#activeRun;
  }

  private scheduleAutoStartCheck(): void {
    if (this.#watchDebounce) {
      clearTimeout(this.#watchDebounce);
    }

    this.#watchDebounce = setTimeout(() => {
      this.#watchDebounce = undefined;
      void this.checkAutoStart();
    }, 50);
  }

  private async checkAutoStart(): Promise<void> {
    if (this.#activeRun) {
      return;
    }

    let task: string;

    try {
      task = await this.readTaskFile();
    } catch {
      return;
    }

    if (task === this.#lastAutoRunTask) {
      return;
    }

    await this.clearTmpForNewTask();
    this.#lastAutoRunTask = task;
    await this.appendProgressLog("watch", "Detected task.md in storage");
    await this.beginRun();
  }

  private async clearTmpForNewTask(): Promise<void> {
    const tmpPath = this.resolveStoragePath("tmp");
    await rm(tmpPath, { recursive: true, force: true });
    await mkdir(tmpPath, { recursive: true });
  }

  private async archiveTask(task: string): Promise<void> {
    const hash = createHash("sha1").update(task).digest("hex");
    const archivePath = this.resolveStoragePath(path.join("old-tasks", `${hash}.md`));

    try {
      await access(archivePath);
      return;
    } catch {
      await writeFile(archivePath, task, "utf8");
      await this.appendProgressLog("archive", `Archived task to old-tasks/${hash}.md`);
    }
  }

  private async runStartMode(task: string, requestId: string): Promise<WorkerRunResult | null> {
    const existingAppSource = await this.readExistingAppSource();

    if (!existingAppSource.trim()) {
      await this.appendProgressLog("start", "No existing app/index.ts found. entering implementation mode");
      await this.emitProgress({
        requestId,
        worker: this.runtime.serviceName,
        phase: "start",
        message: "no existing app/index.ts found. entering implementation mode.",
        updatedFiles: [this.relativeStoragePath("logs/progress.log")],
        done: false,
        state: "running",
      });
      return null;
    }

    this.#completion = null;

    try {
      this.validateGeneratedAppSource(existingAppSource);
      await this.appendProgressLog("start", "Assessing existing app/index.ts before implementation mode");
      await this.emitProgress({
        requestId,
        worker: this.runtime.serviceName,
        phase: "start",
        message: "found existing app/index.ts. checking whether it already solves the task.",
        updatedFiles: ["app/index.ts", this.relativeStoragePath("logs/progress.log")],
        done: false,
        state: "running",
      });
      await this.evaluateApp("app/index.ts", "start", "existing app may already solve the task. start assessment test.", ["app/index.ts"]);

      const completion = this.requireCompletion();
      if (!completion.success) {
        throw new Error(completion.summary);
      }

      const verifiedCompletion = await this.verifyCompletion(task, completion, []);
      await this.appendProgressLog("start", "Existing app passed verification. skipping implementation mode");
      return verifiedCompletion;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Existing app pre-check failed";
      await this.appendProgressLog("start", `Existing app assessment failed: ${reason}`);
      await this.emitProgress({
        requestId,
        worker: this.runtime.serviceName,
        phase: "start",
        message: `existing app does not solve the task yet: ${reason}. entering implementation mode.`,
        updatedFiles: ["app/index.ts", this.relativeStoragePath("logs/progress.log")],
        done: false,
        state: "running",
      });
      await this.clearTaskList("Cleared tasks.json before starting a new implementation-planning run", "start");
      this.#completion = null;
      return null;
    }
  }

  private validateTaskList(tasks: WorkerTask[]): void {
    if (tasks.length === 0) {
      throw new Error("Generated task list is required");
    }

    for (const task of tasks) {
      if (!task.id.trim()) {
        throw new Error("Generated task list contains a task without an id");
      }
      if (!task.title.trim()) {
        throw new Error("Generated task list contains a task without a title");
      }
      if (task.status !== "open" && task.status !== "done") {
        throw new Error("Generated task list contains an invalid task status");
      }
    }
  }

  private async normalizeIterationDecisionAgainstTasks(
    instruction: IterationInstruction,
    tasks: WorkerTask[],
  ): Promise<IterationInstruction> {
    if (instruction.decision === "test" && taskListHasOpenItems(tasks)) {
      await this.appendProgressLog(
        "implementation:iterating",
        "Generated task list still has open items, so the worker will keep iterating instead of starting test",
      );
      return {
        ...instruction,
        decision: "continue",
        wasTestDeferred: true,
        notes: instruction.notes
          ? `${instruction.notes}\nWorker override: testing was deferred because open tasks remain in tasks.json.`
          : "Worker override: testing was deferred because open tasks remain in tasks.json.",
      };
    }

    return instruction;
  }

  private validateIterationProgress(
    previous: PromptContext,
    instruction: IterationInstruction,
    tasks: WorkerTask[],
  ): void {
    if (instruction.decision !== "continue") {
      return;
    }

    const appChanged = normalizeForProgressComparison(previous.existingAppSource) !== normalizeForProgressComparison(instruction.appSource);
    const tasksChanged = normalizeTaskListForProgressComparison(previous.tasks) !== normalizeTaskListForProgressComparison(tasks);
    const previousTaskStats = getTaskStats(previous.tasks);
    const currentTaskStats = getTaskStats(tasks);

    if (!appChanged && !tasksChanged) {
      throw new Error("Iteration made no implementation progress: app/index.ts and tasks.json were unchanged");
    }

    if (currentTaskStats.completed < previousTaskStats.completed) {
      throw new Error("Iteration regressed task progress: fewer tasks are completed than in the previous iteration");
    }

    if (instruction.wasTestDeferred && currentTaskStats.completed === previousTaskStats.completed && !appChanged) {
      throw new Error("Iteration made no task progress after test was deferred because tasks.json still had open items");
    }
  }
}

function extractDiscoveryServices(payload: unknown): Array<{ name: string }> {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }

  const candidate = payload as { services?: Array<{ name: string }> };
  return Array.isArray(candidate.services) ? candidate.services : [];
}

function normalizeSearchRequest(request: string | WorkerSearchRequest): WorkerSearchRequest {
  if (typeof request === "string") {
    return { type: "search", query: request };
  }

  return request;
}

function normalizeSearchResponse(payload: unknown): WorkerSearchResponse {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Search returned an invalid response payload");
  }

  const candidate = payload as Partial<WorkerSearchResponse>;
  if (candidate.type !== "search" || candidate.status !== "ok" || !Array.isArray(candidate.results) || typeof candidate.query !== "string") {
    throw new Error("Search returned no usable search results");
  }

  return candidate as WorkerSearchResponse;
}

function normalizeSearchFailure(payload: unknown): { reason: string; code?: string } {
  if (typeof payload !== "object" || payload === null) {
    return { reason: "Unknown search module error" };
  }

  const candidate = payload as { reason?: unknown; code?: unknown };
  return {
    reason: typeof candidate.reason === "string" && candidate.reason.trim().length > 0
      ? candidate.reason
      : "Unknown search module error",
    ...(typeof candidate.code === "string" && candidate.code.trim().length > 0 ? { code: candidate.code } : {}),
  };
}

function createEmptySearchResponse(
  requestId: string,
  responder: string,
  request: WorkerSearchRequest,
  failure?: { reason: string; code?: string },
): WorkerSearchResponse {
  return {
    requestId,
    responder,
    status: "ok",
    type: "search",
    query: request.query ?? "",
    results: [],
    sourcesTried: [],
    sourcesSucceeded: [],
    sourcesFailed: failure ? [{
      source: responder,
      reason: failure.reason,
      ...(failure.code ? { code: failure.code } : {}),
    }] : [],
    dedupe: {
      inputCount: 0,
      uniqueCount: 0,
      removedCount: 0,
    },
  };
}

function extractNamedFileContent(
  aiPayload: unknown,
  filePath: string,
): string | undefined {
  if (typeof aiPayload !== "object" || aiPayload === null) {
    return undefined;
  }

  const payload = aiPayload as {
    files?: Array<{ path?: string; content?: string }>;
  };

  return payload.files?.find((file) => file.path === filePath && typeof file.content === "string")?.content;
}

function selectAppSource(task: string, fallbackAppSource: string, aiPayload: unknown): string {
  const appFile = extractNamedFileContent(aiPayload, "app/index.ts");
  if (appFile) {
    return appFile;
  }

  if (typeof aiPayload === "object" && aiPayload !== null) {
    const payload = aiPayload as {
      app?: { entry?: string; source?: string };
      answer?: string;
      message?: { content?: string };
    };

    if (payload.app?.source) {
      return payload.app.source;
    }

    if (typeof payload.answer === "string") {
      const fenced = extractAppCodeBlock(payload.answer);
      if (fenced) {
        return fenced;
      }
    }

    if (payload.message && typeof payload.message === "object" && typeof (payload.message as { content?: unknown }).content === "string") {
      const fenced = extractAppCodeBlock((payload.message as { content: string }).content);
      if (fenced) {
        return fenced;
      }
    }
  }

  if (fallbackAppSource.trim().length > 0) {
    return fallbackAppSource;
  }

  return createDefaultAppTemplate(task);
}

function selectTaskListContent(aiPayload: unknown): WorkerTask[] {
  const taskFile = extractNamedFileContent(aiPayload, "tasks.json");
  if (taskFile) {
    return parseTaskList(taskFile);
  }

  if (typeof aiPayload !== "object" || aiPayload === null) {
    return [];
  }

  const payload = aiPayload as {
    tasks?: unknown;
    plan?: { tasks?: unknown };
    answer?: unknown;
    message?: { content?: unknown };
  };

  const directTasks = tryNormalizeTaskArray(payload.tasks);
  if (directTasks.length > 0) {
    return directTasks;
  }

  const plannedTasks = tryNormalizeTaskArray(payload.plan?.tasks);
  if (plannedTasks.length > 0) {
    return plannedTasks;
  }

  const texts = [
    typeof payload.answer === "string" ? payload.answer : undefined,
    typeof payload.message?.content === "string" ? payload.message.content : undefined,
  ].filter((value): value is string => Boolean(value));

  for (const text of texts) {
    const parsed = tryParseJson(text);
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }

    const tasks = tryNormalizeTaskArray((parsed as { tasks?: unknown }).tasks);
    if (tasks.length > 0) {
      return tasks;
    }
  }

  return [];
}

function extractAppCodeBlock(text: string): string | undefined {
  const codeBlockPattern = /```([^\n]*)\n([\s\S]*?)```/g;
  const candidates: Array<{ language: string; content: string }> = [];

  for (const match of text.matchAll(codeBlockPattern)) {
    candidates.push({
      language: match[1]?.trim().toLowerCase() ?? "",
      content: match[2] ?? "",
    });
  }

  const preferred = candidates.find((candidate) => looksLikeAppSource(candidate.content) && isTypeScriptFence(candidate.language));
  if (preferred) {
    return preferred.content;
  }

  const plausible = candidates.find((candidate) => looksLikeAppSource(candidate.content));
  if (plausible) {
    return plausible.content;
  }

  return undefined;
}

function looksLikeAppSource(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed || looksLikeTasksContent(trimmed)) {
    return false;
  }

  return /\bexport\s+default\s+async\s+function\s+run\s*\(\s*host\s*\)/.test(trimmed)
    || /\bhost\.(?:readFile|writeFile|appendProgress|readTask|readMemory|writeMemory|search|completeTask|failTask)\s*\(/.test(trimmed);
}

function looksLikeTasksContent(content: string): boolean {
  return /^\s*\{\s*"tasks"\s*:/m.test(content);
}

function isTypeScriptFence(language: string): boolean {
  return language === "ts" || language === "typescript";
}

function extractToolCalls(payload: unknown): Array<{ name: string; arguments: string }> {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }

  const candidate = payload as {
    toolCalls?: Array<{ name?: unknown; arguments?: unknown }>;
    message?: { toolCalls?: Array<{ name?: unknown; arguments?: unknown }> };
  };

  const rawToolCalls = Array.isArray(candidate.toolCalls)
    ? candidate.toolCalls
    : Array.isArray(candidate.message?.toolCalls)
      ? candidate.message.toolCalls
      : [];

  return rawToolCalls
    .filter((toolCall) => typeof toolCall?.name === "string" && typeof toolCall?.arguments === "string")
    .map((toolCall) => ({
      name: toolCall.name as string,
      arguments: toolCall.arguments as string,
    }));
}

function extractAssistantResponseMessage(payload: unknown): AiAssistantResponseMessage {
  if (typeof payload === "object" && payload !== null) {
    const candidate = payload as {
      message?: {
        role?: unknown;
        content?: unknown;
        refusal?: unknown;
        toolCalls?: unknown;
      };
      answer?: unknown;
      toolCalls?: unknown;
    };

    if (candidate.message && typeof candidate.message === "object") {
      const toolCalls = normalizeAiToolCalls(candidate.message.toolCalls);
      return {
        role: "assistant",
        ...(typeof candidate.message.content === "string" ? { content: candidate.message.content } : {}),
        ...(typeof candidate.message.refusal === "string" ? { refusal: candidate.message.refusal } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    }

    const toolCalls = normalizeAiToolCalls(candidate.toolCalls);
    return {
      role: "assistant",
      ...(typeof candidate.answer === "string" ? { content: candidate.answer } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  return {
    role: "assistant",
    content: typeof payload === "string" ? payload : "",
  };
}

function normalizeAiToolCalls(value: unknown): AiToolCallMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((toolCall) => (
      typeof toolCall === "object"
      && toolCall !== null
      && (toolCall as { type?: unknown }).type === "function"
      && typeof (toolCall as { id?: unknown }).id === "string"
      && typeof (toolCall as { name?: unknown }).name === "string"
      && typeof (toolCall as { arguments?: unknown }).arguments === "string"
    ))
    .map((toolCall) => ({
      id: (toolCall as { id: string }).id,
      type: "function",
      name: (toolCall as { name: string }).name,
      arguments: (toolCall as { arguments: string }).arguments,
    }));
}

function requireStringArg(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`AI tool argument '${key}' must be a non-empty string`);
  }

  return value;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function summarizeLine(line: string): string {
  const normalized = line.trim().replace(/\s+/g, " ");
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function extractIterationDecision(payload: unknown): "continue" | "test" | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const candidate = payload as {
    decision?: unknown;
    nextAction?: unknown;
    plan?: { decision?: unknown };
    answer?: unknown;
    message?: { content?: unknown };
  };

  const direct = [candidate.decision, candidate.nextAction, candidate.plan?.decision];
  for (const value of direct) {
    if (value === "continue" || value === "test") {
      return value;
    }
  }

  const text = [
    typeof candidate.answer === "string" ? candidate.answer : undefined,
    typeof candidate.message?.content === "string" ? candidate.message.content : undefined,
  ].filter((value): value is string => Boolean(value)).join("\n");

  if (/\bdecision\s*:\s*continue\b/i.test(text) || /\bnext(?: action)?\s*:\s*continue\b/i.test(text)) {
    return "continue";
  }

  if (/\bdecision\s*:\s*test\b/i.test(text) || /\bnext(?: action)?\s*:\s*test\b/i.test(text)) {
    return "test";
  }

  return undefined;
}

function extractIterationSummary(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const candidate = payload as {
    summary?: unknown;
    notes?: unknown;
    plan?: { summary?: unknown };
    answer?: unknown;
    message?: { content?: unknown };
  };

  if (typeof candidate.summary === "string" && candidate.summary.trim().length > 0) {
    return candidate.summary.trim();
  }

  if (typeof candidate.plan?.summary === "string" && candidate.plan.summary.trim().length > 0) {
    return candidate.plan.summary.trim();
  }

  const text = [
    typeof candidate.answer === "string" ? candidate.answer : undefined,
    typeof candidate.message?.content === "string" ? candidate.message.content : undefined,
  ].filter((value): value is string => Boolean(value)).join("\n");

  const match = text.match(/\bsummary\s*:\s*(.+)/i);
  return match?.[1]?.trim();
}

function extractIterationNotes(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const candidate = payload as {
    notes?: unknown;
    plan?: { notes?: unknown };
    answer?: unknown;
    message?: { content?: unknown };
  };

  if (typeof candidate.notes === "string" && candidate.notes.trim().length > 0) {
    return candidate.notes.trim();
  }

  if (typeof candidate.plan?.notes === "string" && candidate.plan.notes.trim().length > 0) {
    return candidate.plan.notes.trim();
  }

  const text = [
    typeof candidate.answer === "string" ? candidate.answer : undefined,
    typeof candidate.message?.content === "string" ? candidate.message.content : undefined,
  ].filter((value): value is string => Boolean(value)).join("\n");

  const match = text.match(/\bnotes?\s*:\s*([\s\S]+)/i);
  return match?.[1]?.trim();
}

function extractVerificationSummary(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const candidate = payload as {
    answer?: unknown;
    message?: { content?: unknown };
  };

  if (typeof candidate.answer === "string" && candidate.answer.trim().length > 0) {
    return candidate.answer.trim();
  }

  if (typeof candidate.message?.content === "string" && candidate.message.content.trim().length > 0) {
    return candidate.message.content.trim();
  }

  return undefined;
}

function extractMemoryContent(payload: unknown): string | undefined {
  if (typeof payload === "string" && payload.trim().length > 0) {
    return payload.trim();
  }

  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const candidate = payload as {
    memory?: unknown;
    answer?: unknown;
    message?: { content?: unknown };
  };

  if (typeof candidate.memory === "string" && candidate.memory.trim().length > 0) {
    return candidate.memory.trim();
  }

  if (typeof candidate.answer === "string" && candidate.answer.trim().length > 0) {
    return candidate.answer.trim();
  }

  if (typeof candidate.message?.content === "string" && candidate.message.content.trim().length > 0) {
    return candidate.message.content.trim();
  }

  return undefined;
}

function extractVerificationOutcome(payload: unknown): { verified: boolean; summary?: string } {
  const summary = extractVerificationSummary(payload);

  if (!summary) {
    return { verified: false };
  }

  const normalized = summary.trim().toLowerCase();

  if (isNegativeVerification(normalized)) {
    return { verified: false, summary };
  }

  if (isPositiveVerification(normalized)) {
    return { verified: true, summary };
  }

  return { verified: false, summary };
}

function isPositiveVerification(summary: string): boolean {
  return /\b(valid|verified|verification:\s*result matches|satisf(?:y|ies|ied)|pass(?:ed|es)?|correct)\b/.test(summary)
    && !isNegativeVerification(summary);
}

function isNegativeVerification(summary: string): boolean {
  return /\b(invalid|not valid|reject(?:ed|s)?|fail(?:ed|s)?|does not satisfy|doesn't satisfy|missing|insufficient|incorrect|not verified|unverified)\b/.test(summary);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeProgressUpdate(payload: string | ProgressUpdatePayload): Required<ProgressUpdatePayload> {
  if (typeof payload === "string") {
    return {
      phase: "app",
      message: payload,
      updatedFiles: [],
    };
  }

  return {
    phase: payload.phase,
    message: payload.message,
    updatedFiles: payload.updatedFiles ?? [],
  };
}

function normalizeCompletionPayload(
  payload: string | { summary: string; resultFile?: string },
): { summary: string; resultFile?: string } {
  if (typeof payload === "string") {
    return { summary: payload };
  }

  return payload;
}

function normalizeFailurePayload(payload: string | { summary: string }): { summary: string } {
  if (typeof payload === "string") {
    return { summary: payload };
  }

  return payload;
}

function formatPlanningMessage(
  iteration: number,
  instruction: { decision: "continue" | "test"; summary: string },
): string {
  const summary = instruction.summary.trim();

  if (instruction.decision === "continue") {
    return `planning next implementation step ${iteration}. updating app/index.ts and reviewing tasks.json. ${summary}`;
  }

  return `planning final implementation step ${iteration}. updating app/index.ts and reviewing tasks.json. deciding work is complete. start test. ${summary}`;
}

function taskListHasOpenItems(tasks: WorkerTask[]): boolean {
  return tasks.some((task) => task.status === "open");
}

function normalizeForProgressComparison(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

function normalizeTaskListForProgressComparison(tasks: WorkerTask[]): string {
  return JSON.stringify(tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
  })));
}

function getTaskStats(tasks: WorkerTask[]): { completed: number; open: number } {
  let completed = 0;
  let open = 0;

  for (const task of tasks) {
    if (task.status === "done") {
      completed += 1;
    } else if (task.status === "open") {
      open += 1;
    }
  }

  return { completed, open };
}

function parseTaskList(raw: string): WorkerTask[] {
  if (!raw.trim()) {
    return [];
  }

  const parsed = JSON.parse(raw) as { tasks?: unknown };
  if (!Array.isArray(parsed.tasks)) {
    throw new Error("tasks.json must contain a top-level tasks array");
  }

  return parsed.tasks.map((task, index) => normalizeTaskRecord(task, index));
}

function tryNormalizeTaskArray(value: unknown): WorkerTask[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((task, index) => normalizeTaskRecord(task, index));
}

function normalizeTaskRecord(task: unknown, index: number): WorkerTask {
  if (typeof task !== "object" || task === null) {
    throw new Error(`tasks.json contains a non-object task at index ${index}`);
  }

  const candidate = task as Partial<WorkerTask>;
  if (typeof candidate.id !== "string" || typeof candidate.title !== "string") {
    throw new Error(`tasks.json contains an invalid task at index ${index}`);
  }

  return {
    id: candidate.id,
    title: candidate.title,
    status: requireTaskStatusArg(candidate.status, "status"),
  };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function requireTaskStatusArg(value: unknown, name: string): WorkerTaskStatus {
  if (value === "open" || value === "done") {
    return value;
  }

  throw new Error(`${name} must be 'open' or 'done'`);
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
