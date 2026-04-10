import { createDefaultAppTemplate } from "../template/defaultAppTemplate.js";
import { parseTaskList, tryNormalizeTaskArray, tryParseJson } from "../task/taskJson.js";
import type {
  AiAssistantResponseMessage,
  AiToolCallMessage,
  WorkerTask,
} from "../types/taskWorkerTypes.js";

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

export function selectAppSource(task: string, fallbackAppSource: string, aiPayload: unknown): string {
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

export function selectTaskListContent(aiPayload: unknown): WorkerTask[] {
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

export function extractToolCalls(payload: unknown): Array<{ name: string; arguments: string }> {
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

export function extractAssistantResponseMessage(payload: unknown): AiAssistantResponseMessage {
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

export function extractIterationDecision(payload: unknown): "continue" | "test" | undefined {
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

export function extractIterationSummary(payload: unknown): string | undefined {
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

export function extractIterationIntent(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const candidate = payload as {
    intent?: unknown;
    reason?: unknown;
    plan?: { intent?: unknown; reason?: unknown };
    answer?: unknown;
    message?: { content?: unknown };
  };

  if (typeof candidate.intent === "string" && candidate.intent.trim().length > 0) {
    return candidate.intent.trim();
  }

  if (typeof candidate.reason === "string" && candidate.reason.trim().length > 0) {
    return candidate.reason.trim();
  }

  if (typeof candidate.plan?.intent === "string" && candidate.plan.intent.trim().length > 0) {
    return candidate.plan.intent.trim();
  }

  if (typeof candidate.plan?.reason === "string" && candidate.plan.reason.trim().length > 0) {
    return candidate.plan.reason.trim();
  }

  const text = [
    typeof candidate.answer === "string" ? candidate.answer : undefined,
    typeof candidate.message?.content === "string" ? candidate.message.content : undefined,
  ].filter((value): value is string => Boolean(value)).join("\n");

  const match = text.match(/\b(?:intent|reason)\s*:\s*(.+)/i);
  return match?.[1]?.trim();
}

export function extractIterationNotes(payload: unknown): string | undefined {
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

export function extractMemoryContent(payload: unknown): string | undefined {
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

export function extractVerificationOutcome(payload: unknown): { verified: boolean; summary?: string } {
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
