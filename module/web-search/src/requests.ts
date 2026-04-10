import { WebSearchModuleError } from "./errors.js";
import { SafeSearchMode, SearchRequest, SearchRequestFilters } from "./types.js";

const REQUEST_FIELDS = [
  "type",
  "query",
  "limit",
  "language",
  "region",
  "safeSearch",
  "site",
  "freshness",
  "includeRaw",
] as const;

export function parseSearchRequest(payload: unknown): SearchRequest {
  if (typeof payload === "string") {
    return createSearchRequest({ query: payload });
  }

  if (payload === undefined || payload === null) {
    throw new WebSearchModuleError("Search payload is required", "invalid-request");
  }

  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new WebSearchModuleError("Search payload must be a string or object", "invalid-request");
  }

  const candidate = payload as Record<string, unknown>;
  const type = candidate.type;

  if (type === "info") {
    return { type: "info" };
  }

  return createSearchRequest(candidate);
}

export function getSupportedRequestFields(): string[] {
  return [...REQUEST_FIELDS];
}

function createSearchRequest(candidate: Record<string, unknown>): SearchRequest {
  const query = normalizeString(candidate.query ?? candidate.prompt);
  if (!query) {
    throw new WebSearchModuleError("Search query must be a non-empty string", "invalid-request");
  }

  const request: SearchRequest = {
    type: "search",
    query,
    ...parseFilters(candidate),
  };

  return request;
}

function parseFilters(candidate: Record<string, unknown>): SearchRequestFilters {
  const limit = parseOptionalInteger(candidate.limit, "limit");
  const includeRaw = parseOptionalBoolean(candidate.includeRaw, "includeRaw");
  const language = parseOptionalString(candidate.language, "language");
  const region = parseOptionalString(candidate.region, "region");
  const site = parseOptionalString(candidate.site, "site");
  const freshness = parseOptionalString(candidate.freshness, "freshness");
  const safeSearch = parseSafeSearch(candidate.safeSearch);

  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(includeRaw !== undefined ? { includeRaw } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(site !== undefined ? { site } : {}),
    ...(freshness !== undefined ? { freshness } : {}),
    ...(safeSearch !== undefined ? { safeSearch } : {}),
  };
}

function parseOptionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new WebSearchModuleError(`${label} must be a positive integer`, "invalid-request");
  }

  return value;
}

function parseOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new WebSearchModuleError(`${label} must be a boolean`, "invalid-request");
  }

  return value;
}

function parseOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = normalizeString(value);
  if (!normalized) {
    throw new WebSearchModuleError(`${label} must be a non-empty string`, "invalid-request");
  }

  return normalized;
}

function parseSafeSearch(value: unknown): SafeSearchMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "off" || value === "moderate" || value === "strict") {
    return value;
  }

  throw new WebSearchModuleError("safeSearch must be off, moderate, or strict", "invalid-request");
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
