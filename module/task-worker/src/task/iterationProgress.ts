import type { WorkerTask } from "../types/taskWorkerTypes.js";

export function taskListHasOpenItems(tasks: WorkerTask[]): boolean {
  return tasks.some((task) => task.status === "open");
}

export function normalizeForProgressComparison(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

export function normalizeTaskListForProgressComparison(tasks: WorkerTask[]): string {
  return JSON.stringify(tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
  })));
}

export function getTaskStats(tasks: WorkerTask[]): { completed: number; open: number } {
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

export function formatPlanningMessage(
  iteration: number,
  instruction: { decision: "continue" | "test"; intent: string; summary: string },
): string {
  const intent = instruction.intent.trim();
  const summary = instruction.summary.trim();

  if (instruction.decision === "continue") {
    return `planning next implementation step ${iteration}. intent: ${intent}. updating app/index.ts and reviewing tasks.json. ${summary}`;
  }

  return `planning final implementation step ${iteration}. intent: ${intent}. updating app/index.ts and reviewing tasks.json. deciding work is complete. start test. ${summary}`;
}
