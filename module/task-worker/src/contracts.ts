import { WireMessage } from "@smallbot/framework";

export interface ProgressEvent {
  requestId: string;
  worker: string;
  phase: string;
  message: string;
  updatedFiles: string[];
  done: boolean;
  state: "running" | "completed" | "failed";
}

export interface ProgressUpdatePayload {
  phase: string;
  message: string;
  updatedFiles?: string[];
}

export interface CompletionPayload {
  success: boolean;
  summary: string;
  resultFile?: string;
  verificationSummary?: string;
}

export interface FailurePayload {
  summary: string;
}

export interface WorkerRuntime {
  readonly serviceName: string;
  updateState(state: "free" | "busy" | "stopped"): Promise<void>;
  send(message: WireMessage): Promise<void>;
}

export interface WorkerSearchRequest {
  type?: "search" | "info";
  query?: string;
  prompt?: string;
  limit?: number;
  language?: string;
  region?: string;
  safeSearch?: "off" | "moderate" | "strict";
  site?: string;
  freshness?: string;
  includeRaw?: boolean;
}

export interface WorkerSearchResult {
  url: string;
  normalizedUrl: string;
  title: string;
  snippet?: string;
  source: string;
  rank?: number;
  publishedAt?: string;
}

export interface WorkerSearchResponse {
  requestId: string;
  responder: string;
  status: "ok";
  type: "search";
  query: string;
  results: WorkerSearchResult[];
  sourcesTried: string[];
  sourcesSucceeded: string[];
  sourcesFailed: Array<{
    source: string;
    reason: string;
    code?: string;
  }>;
  dedupe: {
    inputCount: number;
    uniqueCount: number;
    removedCount: number;
  };
  raw?: Record<string, unknown>;
}

export interface WorkerContextConfig {
  dataPath: string;
  aiKind: string;
  aiTarget?: string;
  searchKind?: string;
  searchTarget?: string;
  messageBusTimeoutMs?: number;
}

export interface WorkerRunResult {
  success: boolean;
  summary: string;
  resultFile?: string;
  verificationSummary?: string;
}

export interface PendingRequest {
  resolve: (message: WireMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}
