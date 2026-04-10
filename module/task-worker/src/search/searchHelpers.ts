import type { WorkerSearchRequest, WorkerSearchResponse } from "../contracts.js";

export function extractDiscoveryServices(payload: unknown): Array<{ name: string }> {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }

  const candidate = payload as { services?: Array<{ name: string }> };
  return Array.isArray(candidate.services) ? candidate.services : [];
}

export function normalizeSearchRequest(request: string | WorkerSearchRequest): WorkerSearchRequest {
  if (typeof request === "string") {
    return { type: "search", query: request };
  }

  return request;
}

export function normalizeSearchResponse(payload: unknown): WorkerSearchResponse {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Search returned an invalid response payload");
  }

  const candidate = payload as Partial<WorkerSearchResponse>;
  if (candidate.type !== "search" || candidate.status !== "ok" || !Array.isArray(candidate.results) || typeof candidate.query !== "string") {
    throw new Error("Search returned no usable search results");
  }

  return candidate as WorkerSearchResponse;
}

export function normalizeSearchFailure(payload: unknown): { reason: string; code?: string } {
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

export function createEmptySearchResponse(
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
