import { ModuleRuntime, WireMessage, createMessage } from "@smallbot/framework";

import { WebSearchModuleError } from "./errors.js";
import { createInfoResponse } from "./info.js";
import { parseSearchRequest } from "./requests.js";
import { SearchAggregator } from "./searchAggregator.js";

export class WebSearchService {
  constructor(
    private readonly runtime: ModuleRuntime,
    private readonly aggregator: SearchAggregator,
    private readonly serviceName: string,
  ) {}

  async onMessage(message: WireMessage): Promise<void> {
    if (message.c !== "tool") {
      return;
    }

    await this.runtime.updateState("busy");

    try {
      const request = parseSearchRequest(message.m);
      this.logSearchRequest(message.i, request);
      const response = request.type === "info"
        ? createInfoResponse(message.i, this.serviceName, this.aggregator.describeSources())
        : await this.aggregator.search(message.i, request);

      await this.runtime.send(
        createMessage({
          s: this.serviceName,
          t: message.s,
          c: "result",
          i: message.i,
          m: response,
        }),
      );
    } catch (error) {
      const searchError = normalizeError(error);
      await this.runtime.send(
        createMessage({
          s: this.serviceName,
          t: message.s,
          c: "error",
          i: message.i,
          m: {
            requestId: message.i,
            responder: this.serviceName,
            reason: searchError.message,
            code: searchError.code,
            ...(searchError.details ? { details: searchError.details } : {}),
          },
        }),
      );
    } finally {
      await this.runtime.updateState("free");
    }
  }

  private logSearchRequest(requestId: string, request: ReturnType<typeof parseSearchRequest>): void {
    if (request.type !== "search") {
      return;
    }

    const metadata = [
      request.limit !== undefined ? `limit=${request.limit}` : undefined,
      request.language ? `language=${request.language}` : undefined,
      request.region ? `region=${request.region}` : undefined,
      request.safeSearch ? `safe_search=${request.safeSearch}` : undefined,
      request.site ? `site=${request.site}` : undefined,
      request.freshness ? `freshness=${request.freshness}` : undefined,
      request.includeRaw !== undefined ? `include_raw=${request.includeRaw}` : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join(" ");

    console.log(
      `[module:${this.serviceName}] search request=${requestId} query=${JSON.stringify(request.query)}${metadata ? ` ${metadata}` : ""}`,
    );
  }
}

function normalizeError(error: unknown): WebSearchModuleError {
  if (error instanceof WebSearchModuleError) {
    return error;
  }

  if (error instanceof Error) {
    return new WebSearchModuleError(error.message, "unknown-error");
  }

  return new WebSearchModuleError("Unknown web search module error", "unknown-error");
}
