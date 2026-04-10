import type { WorkerTask, WorkerTaskStatus } from "../types/taskWorkerTypes.js";

export function parseTaskList(raw: string): WorkerTask[] {
  if (!raw.trim()) {
    return [];
  }

  const parsed = JSON.parse(raw) as { tasks?: unknown };
  if (!Array.isArray(parsed.tasks)) {
    throw new Error("tasks.json must contain a top-level tasks array");
  }

  return parsed.tasks.map((task, index) => normalizeTaskRecord(task, index));
}

export function tryNormalizeTaskArray(value: unknown): WorkerTask[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((task, index) => normalizeTaskRecord(task, index));
}

export function normalizeTaskRecord(task: unknown, index: number): WorkerTask {
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

export function requireTaskStatusArg(value: unknown, name: string): WorkerTaskStatus {
  if (value === "open" || value === "done") {
    return value;
  }

  throw new Error(`${name} must be 'open' or 'done'`);
}

export function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
