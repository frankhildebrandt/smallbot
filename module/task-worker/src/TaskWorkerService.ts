import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { access, appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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
import { createDefaultAppTemplate } from "./defaultAppTemplate.js";

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

interface IterationContextEntry {
  iteration: number;
  decision: "continue" | "test";
  summary: string;
  notes?: string;
  todo: string;
  appSource: string;
  updatedFiles: string[];
}

interface IterationInstruction {
  decision: "continue" | "test";
  summary: string;
  notes?: string;
  todo: string;
  appSource: string;
  wasTestDeferred?: boolean;
}

interface PromptContext {
  task: string;
  memory: string;
  existingAppSource: string;
  todo: string;
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
  todo: string;
}

export class TaskWorkerService {
  static readonly DISCOVERY_ATTEMPTS = 5;
  static readonly DISCOVERY_RETRY_DELAY_MS = 150;
  static readonly MESSAGE_BUS_TIMEOUT_MS = 30_000;
  static readonly RUN_RETRY_DELAY_MS = 1_000;

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
    const target = this.config.aiTarget
      ?? this.#resolvedAiTarget
      ?? (this.#resolvedAiTarget = await this.discoverTarget(this.config.aiKind, "AI"));

    return this.requestToolMessage(target, {
      kind: "task-worker:generate-app",
      prompt,
      requestId: this.#currentRequestId,
    }, "Timed out waiting for AI response");
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

  private async readTodoFile(): Promise<string> {
    try {
      return await readFile(this.resolveStoragePath("todo.md"), "utf8");
    } catch {
      return "";
    }
  }

  private async readProgressLog(): Promise<string> {
    return readFile(this.resolveStoragePath("logs/progress.log"), "utf8").catch(() => "");
  }

  private async readContextLog(): Promise<string> {
    return readFile(this.resolveStoragePath("logs/context.log"), "utf8").catch(() => "");
  }

  private async buildPromptContext(task: string, workingContext: IterationContextEntry[]): Promise<PromptContext> {
    const [memory, existingAppSource, todo, progressLog, contextLog] = await Promise.all([
      this.readMemoryFile(),
      this.readExistingAppSource(),
      this.readTodoFile(),
      this.readProgressLog(),
      this.readContextLog(),
    ]);

    return {
      task,
      memory,
      existingAppSource,
      todo,
      workingContext,
      progressLog,
      contextLog,
    };
  }

  private async askAiToPlanTodo(context: PromptContext, error?: string): Promise<string> {
    await this.appendProgressLog("ai", "Requesting todo planning over the message bus");

    const response = await this.askAi(JSON.stringify({
      type: "completion",
      system: [
        "You plan implementation work for task.md and return only todo.md content.",
        "todo.md is only for the implementation work needed to solve task.md.",
        "First think through what must be implemented, including checking whether the existing app already solves the task and which patches or improvements are needed if it does not.",
        "Return only todo.md content in this exact format: first line '# TODO', followed by checkbox lines '- [ ] ...' or '- [x] ...'.",
        "Do not return app/index.ts, explanations, markdown fences, or any other file.",
        "If this is a retry after failure, create a fresh implementation checklist for the new attempt based on the failure context.",
      ].join(" "),
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            goal: error
              ? "Create a fresh implementation todo list for the next retry"
              : "Create the implementation todo list for the current task",
            task: context.task,
            memory: context.memory,
            existingAppSource: context.existingAppSource,
            currentTodo: context.todo,
            workingContext: context.workingContext,
            progress: context.progressLog,
            contextLog: context.contextLog,
            failure: error,
            requiredResponse: {
              file: "todo.md",
              format: "# TODO followed by checkbox items",
            },
          }, null, 2),
        },
      ],
    }));

    await this.appendProgressLog("implementation:planning", `Received AI todo planning response via ${response.s}`);
    await this.logAiTools(response.m, "todo-planning");
    return selectTodoContent(response.m);
  }

  private async askAiForIteration(context: PromptContext): Promise<unknown> {
    await this.appendProgressLog("ai", "Requesting iterative app update over the message bus");

    const response = await this.askAi(JSON.stringify({
      type: "completion",
      system: [
        "You iteratively extend the existing TypeScript source code for app/index.ts.",
        "Prefer updating the existing app instead of replacing it from scratch.",
        "todo.md is only for the implementation work needed to solve task.md.",
        "At the start of each implementation run, think through what work is needed to solve the task, including analyzing the existing implementation and deciding which patches or improvements are needed.",
        "Before changing code, first consider whether the existing app already solves the task.",
        "If it does not, create or update todo.md as the implementation checklist for solving task.md.",
        "You may solve the problem in multiple implementation steps.",
        "Each iteration must perform a real implementation step, not just restate the task, memory, or todo.md.",
        "A real implementation step may be code work in app/index.ts or non-code implementation work such as inspecting an existing file, tracing behavior, or refining the plan when that work is required to solve the task.",
        "If an iteration does not change app/index.ts, the progress must still be visible in todo.md and in the iteration summary or notes.",
        "Do not leave app/index.ts and todo.md effectively unchanged across iterations.",
        "When work remains, make progress by completing one or more open todo items, or by replacing an open item with smaller concrete implementation tasks caused by what you just learned.",
        "It is valid to complete multiple todo items in a single iteration when the work was actually done.",
        "todo.md is required for every iteration and must use exactly this format: first line '# TODO', followed by checkbox lines '- [ ] ...' or '- [x] ...'.",
        "After each implementation step, review todo.md, decide whether the checklist is complete, and add newly discovered implementation tasks when needed.",
        "Only choose `test` after the implementation checklist is fully completed.",
        "The file must export `default async function run(host)`.",
        "The app must provide a local HTTP REST API.",
        "You may decide to continue editing without testing, or to stop editing and let the worker test the app.",
        "Return an explicit decision of `continue` or `test`.",
        "Return only one fenced ```ts code block for app/index.ts when you provide source code.",
        "Use `host.search(...)` when web lookup is required.",
        "Do not call AI, do not request more inference, and do not use host.askAi.",
        "Do not perform direct network requests; use only host methods.",
        "Use only the host methods described in the request.",
      ].join(" "),
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            goal: "Iteratively extend the task-worker app until it is ready for testing",
            task: context.task,
            memory: context.memory,
            existingAppSource: context.existingAppSource,
            todo: context.todo,
            workingContext: context.workingContext,
            progress: context.progressLog,
            contextLog: context.contextLog,
            requiredResponse: {
              decision: "continue | test",
              summary: "short summary of the change for the worker context",
              notes: "optional additional notes",
              todoFile: "todo.md in required checklist format",
              todoRule: "todo.md must only describe implementation work for solving task.md; after each completed step review it and expand it if more implementation work is needed; choose test only when all items are done",
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
            },
          }, null, 2),
        },
      ],
    }));

    await this.appendProgressLog("implementation:iterating", `Received AI iteration response via ${response.s}`);
    await this.logAiTools(response.m, "iteration");
    return response.m;
  }

  private async writeAppSource(source: string): Promise<void> {
    await writeFile(this.resolveStoragePath("app/index.ts"), source, "utf8");
    await this.appendProgressLog("implementation:iterating", "Wrote generated app/index.ts");
  }

  private async writeTodoFile(content: string): Promise<void> {
    await writeFile(this.resolveStoragePath("todo.md"), content, "utf8");
    await this.appendProgressLog("implementation:planning", "Wrote generated todo.md");
  }

  private async appendIterationContext(entry: IterationContextEntry): Promise<void> {
    const timestamp = new Date().toISOString();
    const record = JSON.stringify({
      timestamp,
      iteration: entry.iteration,
      decision: entry.decision,
      summary: entry.summary,
      notes: entry.notes,
      todo: entry.todo,
      updatedFiles: entry.updatedFiles,
    });
    await appendFile(this.resolveStoragePath("logs/context.log"), `${record}\n`, "utf8");
  }

  private async clearWorkingContext(reason = "Cleared implementation working context"): Promise<void> {
    await writeFile(this.resolveStoragePath("logs/context.log"), "", "utf8");
    await this.appendProgressLog("test", reason);
  }

  private async clearTodoFile(reason: string, phase: RuntimeModePhase = "implementation:planning"): Promise<void> {
    await rm(this.resolveStoragePath("todo.md"), { force: true });
    await this.appendProgressLog(phase, reason);
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

    const memory = extractMemoryContent(response.m);
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

    while (true) {
      attempt += 1;
      this.#completion = null;

      const failure = await this.runImplementationAttempt(task, requestId, attempt, iteration, lastErrorMessage);
      if (!failure) {
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
    lastErrorMessage?: string,
  ): Promise<FailedAttemptSnapshot | null> {
    let iteration = startingIteration;
    const workingContext: IterationContextEntry[] = [];

    try {
      const planningContext = await this.buildPromptContext(task, []);
      const plannedTodo = await this.askAiToPlanTodo(planningContext, lastErrorMessage);
      this.validateTodoContent(plannedTodo);
      await this.writeTodoFile(plannedTodo);
      await this.emitProgress({
        requestId,
        worker: this.runtime.serviceName,
        phase: "implementation:planning",
        message: "planned implementation todo.md for the current run.",
        updatedFiles: ["todo.md", this.relativeStoragePath("logs/progress.log")],
        done: false,
        state: "running",
      });

      while (true) {
        iteration += 1;
        const promptContext = await this.buildPromptContext(task, workingContext);
        const aiPayload = await this.askAiForIteration(promptContext);

        const instruction = this.selectIterationInstruction(
          task,
          promptContext.existingAppSource,
          promptContext.todo,
          aiPayload,
        );
        this.validateGeneratedAppSource(instruction.appSource);
        this.validateTodoContent(instruction.todo);
        const normalizedInstruction = await this.normalizeIterationDecisionAgainstTodo(instruction);
        this.validateIterationProgress(promptContext, normalizedInstruction);
        await this.writeAppSource(normalizedInstruction.appSource);
        await this.writeTodoFile(normalizedInstruction.todo);

        const updatedFiles = [
          "app/index.ts",
          "todo.md",
          this.relativeStoragePath("logs/context.log"),
          this.relativeStoragePath("logs/progress.log"),
        ];
        const entry: IterationContextEntry = {
          iteration,
          decision: normalizedInstruction.decision,
          summary: normalizedInstruction.summary,
          notes: normalizedInstruction.notes,
          todo: normalizedInstruction.todo,
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
          await this.appendProgressLog("implementation:iterating", `Continuing iterative edit loop after iteration ${iteration} after reviewing todo.md`);
          continue;
        }

        break;
      }

      await this.runTestMode(task, requestId);
      const completion = this.requireCompletion();
      if (!completion.success) {
        throw new Error(completion.summary);
      }

      this.#completion = await this.verifyCompletion(task, completion, []);
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
        todo: promptContext.todo,
      };
    }
  }

  private async runTestMode(task: string, requestId: string): Promise<void> {
    await this.clearWorkingContext("Cleared implementation working context before test");
    await this.appendProgressLog("test", "Starting fresh test run for app/index.ts");
    await this.evaluateApp(
      "app/index.ts",
      "test",
      "implementation checklist is complete. start fresh test run.",
      ["app/index.ts", "todo.md"],
    );
    await this.appendProgressLog("test", `Finished app execution for task '${task.slice(0, 80)}'`);
    await this.emitProgress({
      requestId,
      worker: this.runtime.serviceName,
      phase: "test",
      message: "app execution finished. verifying task result.",
      updatedFiles: ["app/index.ts", "todo.md", this.relativeStoragePath("logs/progress.log")],
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
      updatedFiles: ["app/index.ts", "todo.md", this.relativeStoragePath("logs/context.log"), this.relativeStoragePath("logs/progress.log")],
      done: false,
      state: "running",
    });

    try {
      const promptContext = await this.buildPromptContext(task, failure.workingContext);
      await this.synthesizeMemoryFromFailure(promptContext, failure.appSource, failure.error);
      await this.clearTodoFile(
        "Cleared todo.md after failed attempt so the next implementation planning phase can start fresh",
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
    const resultContent = completion.resultFile
      ? await readFile(this.resolveStoragePath(completion.resultFile), "utf8").catch(() => "")
      : "";

    const response = await this.askAi(JSON.stringify({
      type: "completion",
      system: [
        "You verify whether a generated task result appears to satisfy the task.",
        "Return a verdict of VALID or INVALID plus a short reason.",
      ].join(" "),
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            task,
            workingContext,
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
    const target = this.config.searchTarget ?? (await this.discoverTarget(this.config.searchKind ?? "search", "search"));
    const response = await this.requestToolMessage(
      target,
      normalizeSearchRequest(request),
      "Timed out waiting for search response",
    );

    return normalizeSearchResponse(response.m);
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

    if (/^\s*# TODO\b/m.test(source) || /^\s*- \[(?: |x)\] /m.test(source)) {
      throw new Error("Generated app source looks like todo.md content instead of TypeScript");
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
    fallbackTodo: string,
    aiPayload: unknown,
  ): IterationInstruction {
    const summary = extractIterationSummary(aiPayload) ?? "Updated app/index.ts";
    const notes = extractIterationNotes(aiPayload);
    const decision = extractIterationDecision(aiPayload) ?? "test";
    const appSource = selectAppSource(task, fallbackAppSource, aiPayload);
    const todo = selectTodoContent(aiPayload) || fallbackTodo;

    return {
      decision,
      summary,
      notes,
      todo,
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
      await this.clearTodoFile("Cleared todo.md before starting a new implementation-planning run", "start");
      this.#completion = null;
      return null;
    }
  }

  private validateTodoContent(content: string): void {
    const trimmed = content.trim();

    if (!trimmed) {
      throw new Error("Generated todo.md is required");
    }

    const lines = trimmed.split(/\r?\n/);
    if (lines[0] !== "# TODO") {
      throw new Error("Generated todo.md must start with '# TODO'");
    }

    const checklistLines = lines.slice(1).filter((line) => line.trim().length > 0);
    if (checklistLines.length === 0) {
      throw new Error("Generated todo.md must contain at least one checklist item");
    }

    for (const line of checklistLines) {
      if (!/^- \[(?: |x)\] .+$/.test(line)) {
        throw new Error("Generated todo.md contains invalid checklist formatting");
      }
    }
  }

  private async normalizeIterationDecisionAgainstTodo(instruction: IterationInstruction): Promise<IterationInstruction> {
    if (instruction.decision === "test" && todoHasOpenItems(instruction.todo)) {
      await this.appendProgressLog(
        "implementation:iterating",
        "Generated todo.md still has open items, so the worker will keep iterating instead of starting test",
      );
      return {
        ...instruction,
        decision: "continue",
        wasTestDeferred: true,
        notes: instruction.notes
          ? `${instruction.notes}\nWorker override: testing was deferred because todo.md still has open items.`
          : "Worker override: testing was deferred because todo.md still has open items.",
      };
    }

    return instruction;
  }

  private validateIterationProgress(previous: PromptContext, instruction: IterationInstruction): void {
    if (instruction.decision !== "continue") {
      return;
    }

    const appChanged = normalizeForProgressComparison(previous.existingAppSource) !== normalizeForProgressComparison(instruction.appSource);
    const todoChanged = normalizeForProgressComparison(previous.todo) !== normalizeForProgressComparison(instruction.todo);
    const previousTodoStats = getTodoStats(previous.todo);
    const currentTodoStats = getTodoStats(instruction.todo);

    if (!appChanged && !todoChanged) {
      throw new Error("Iteration made no implementation progress: app/index.ts and todo.md were unchanged");
    }

    if (currentTodoStats.completed < previousTodoStats.completed) {
      throw new Error("Iteration regressed todo progress: fewer checklist items are completed than in the previous iteration");
    }

    if (instruction.wasTestDeferred && currentTodoStats.completed === previousTodoStats.completed && !appChanged) {
      throw new Error("Iteration made no checklist progress after test was deferred because todo.md still had open items");
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

function selectTodoContent(aiPayload: unknown): string {
  const todoFile = extractNamedFileContent(aiPayload, "todo.md");
  if (todoFile) {
    return todoFile;
  }

  if (typeof aiPayload !== "object" || aiPayload === null) {
    return "";
  }

  const payload = aiPayload as {
    todo?: unknown;
    plan?: { todo?: unknown };
    answer?: unknown;
    message?: { content?: unknown };
  };

  if (typeof payload.todo === "string" && payload.todo.trim().length > 0) {
    return payload.todo.trim();
  }

  if (typeof payload.plan?.todo === "string" && payload.plan.todo.trim().length > 0) {
    return payload.plan.todo.trim();
  }

  const text = [
    typeof payload.answer === "string" ? payload.answer : undefined,
    typeof payload.message?.content === "string" ? payload.message.content : undefined,
  ].filter((value): value is string => Boolean(value)).join("\n");

  const match = text.match(/(?:^|\n)# TODO\n(?:- \[(?: |x)\] .*(?:\n|$))+/);
  return match?.[0]?.trim() ?? "";
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
  if (!trimmed || looksLikeTodoContent(trimmed)) {
    return false;
  }

  return /\bexport\s+default\s+async\s+function\s+run\s*\(\s*host\s*\)/.test(trimmed)
    || /\bhost\.(?:readFile|writeFile|appendProgress|readTask|readMemory|writeMemory|search|completeTask|failTask)\s*\(/.test(trimmed);
}

function looksLikeTodoContent(content: string): boolean {
  return /^\s*# TODO\b/m.test(content) || /^\s*- \[(?: |x)\] /m.test(content);
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
    return `planning next implementation step ${iteration}. updating app/index.ts and reviewing todo.md. ${summary}`;
  }

  return `planning final implementation step ${iteration}. updating app/index.ts and reviewing todo.md. deciding work is complete. start test. ${summary}`;
}

function todoHasOpenItems(todo: string): boolean {
  return /^- \[ \] /m.test(todo);
}

function normalizeForProgressComparison(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

function getTodoStats(todo: string): { completed: number; open: number } {
  let completed = 0;
  let open = 0;

  for (const line of todo.split(/\r?\n/)) {
    if (/^- \[x\] /.test(line)) {
      completed += 1;
    } else if (/^- \[ \] /.test(line)) {
      open += 1;
    }
  }

  return { completed, open };
}
