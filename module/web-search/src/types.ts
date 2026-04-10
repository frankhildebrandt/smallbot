export type SearchRequestType = "search" | "info";
export type SafeSearchMode = "off" | "moderate" | "strict";

export interface SearchRequestFilters {
  limit?: number;
  language?: string;
  region?: string;
  safeSearch?: SafeSearchMode;
  site?: string;
  freshness?: string;
  includeRaw?: boolean;
}

export interface SearchQueryRequest extends SearchRequestFilters {
  type: "search";
  query: string;
}

export interface SearchInfoRequest {
  type: "info";
}

export type SearchRequest = SearchQueryRequest | SearchInfoRequest;

export interface SearchResult {
  url: string;
  normalizedUrl: string;
  title: string;
  snippet?: string;
  source: string;
  rank?: number;
  publishedAt?: string;
}

export interface SearchSourceResult {
  source: string;
  results: SearchResult[];
  raw?: unknown;
}

export interface SearchSourceFailure {
  source: string;
  reason: string;
  code?: string;
}

export interface SearchResponse {
  requestId: string;
  responder: string;
  status: "ok";
  type: "search";
  query: string;
  results: SearchResult[];
  sourcesTried: string[];
  sourcesSucceeded: string[];
  sourcesFailed: SearchSourceFailure[];
  dedupe: {
    inputCount: number;
    uniqueCount: number;
    removedCount: number;
  };
  raw?: Record<string, unknown>;
}

export interface SearchInfoResponse {
  requestId: string;
  responder: string;
  status: "ok";
  type: "info";
  module: string;
  capabilities: string[];
  requestTypes: SearchRequestType[];
  requestFields: string[];
  sources: Array<{
    name: string;
    enabled: boolean;
    description: string;
  }>;
  dedupe: {
    strategy: string;
    normalization: string[];
  };
}

export type SearchModuleResponse = SearchResponse | SearchInfoResponse;
