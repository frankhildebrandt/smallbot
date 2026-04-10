import type { ProgressUpdatePayload } from "../contracts.js";
import type { WorkerServiceReadyPayload } from "../types/taskWorkerTypes.js";

export function normalizeProgressUpdate(payload: string | ProgressUpdatePayload): Required<ProgressUpdatePayload> {
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

export function normalizeCompletionPayload(
  payload: string | { summary: string; resultFile?: string },
): { summary: string; resultFile?: string } {
  if (typeof payload === "string") {
    return { summary: payload };
  }

  return payload;
}

export function normalizeFailurePayload(payload: string | { summary: string }): { summary: string } {
  if (typeof payload === "string") {
    return { summary: payload };
  }

  return payload;
}

export function normalizeServiceReadyPayload(
  payload: string | WorkerServiceReadyPayload,
): WorkerServiceReadyPayload {
  if (typeof payload === "string") {
    return {
      summary: payload,
      host: "127.0.0.1",
      port: 0,
      path: "/",
    };
  }

  return {
    ...payload,
    path: normalizeServicePath(payload.path),
  };
}

export function normalizeServicePath(pathValue?: string): string {
  if (!pathValue || pathValue === "/") {
    return "/";
  }

  return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
}

export function buildServiceUrl(host: string, port: number, pathValue = "/"): string {
  const normalizedHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${normalizedHost}:${port}${normalizeServicePath(pathValue)}`;
}

export function extractTaskHttpChecks(task: string): Array<{ requestBody: string; expectedBody: string }> {
  const requestBodies = [...task.matchAll(/<APIDATA>[\s\S]*?<\/APIDATA>/g)].map((match) => match[0].trim());
  const expectedBodies = [...task.matchAll(/<RESULT>[\s\S]*?<\/RESULT>/g)].map((match) => match[0].trim());
  const count = Math.min(requestBodies.length, expectedBodies.length);
  const checks = [];

  for (let index = 0; index < count; index += 1) {
    const requestBody = requestBodies[index];
    const expectedBody = expectedBodies[index];

    if (requestBody && expectedBody) {
      checks.push({ requestBody, expectedBody });
    }
  }

  return checks;
}

export function normalizeComparableText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}
