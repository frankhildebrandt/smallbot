import { WebSearchModuleError } from "./errors.js";
import { mergeAndDedupeResults } from "./normalize.js";
import { SearchSource } from "./sources/base.js";
import { SearchQueryRequest, SearchResponse, SearchSourceFailure } from "./types.js";

export class SearchAggregator {
  constructor(
    private readonly sources: SearchSource[],
    private readonly serviceName: string,
  ) {}

  async search(requestId: string, request: SearchQueryRequest): Promise<SearchResponse> {
    const enabledSources = this.sources.filter((source) => source.enabled);
    const sourcesTried = enabledSources.map((source) => source.name);
    const sourcesSucceeded: string[] = [];
    const sourcesFailed: SearchSourceFailure[] = [];
    const rawPayloads: Record<string, unknown> = {};
    const collectedResults = [];

    for (const source of enabledSources) {
      try {
        const response = await source.search(request);
        sourcesSucceeded.push(source.name);
        collectedResults.push(...response.results);

        if (request.includeRaw && response.raw !== undefined) {
          rawPayloads[source.name] = response.raw;
        }
      } catch (error) {
        const failure = normalizeFailure(source.name, error);
        sourcesFailed.push(failure);
      }
    }

    if (collectedResults.length === 0 && sourcesFailed.length > 0) {
      throw new WebSearchModuleError("All search sources failed", "search-sources-failed", {
        sourcesFailed,
      });
    }

    const limit = request.limit ?? 10;
    const { results, dedupe } = mergeAndDedupeResults(collectedResults, limit);

    return {
      requestId,
      responder: this.serviceName,
      status: "ok",
      type: "search",
      query: request.query,
      results,
      sourcesTried,
      sourcesSucceeded,
      sourcesFailed,
      dedupe,
      ...(request.includeRaw ? { raw: rawPayloads } : {}),
    };
  }

  describeSources(): Array<{ name: string; enabled: boolean; description: string }> {
    return this.sources.map((source) => ({
      name: source.name,
      enabled: source.enabled,
      description: source.description,
    }));
  }
}

function normalizeFailure(source: string, error: unknown): SearchSourceFailure {
  if (error instanceof WebSearchModuleError) {
    return {
      source,
      reason: error.message,
      code: error.code,
    };
  }

  if (error instanceof Error) {
    return {
      source,
      reason: error.message,
    };
  }

  return {
    source,
    reason: "Unknown search source error",
  };
}
