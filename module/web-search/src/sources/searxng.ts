import { normalizeUrl } from "../normalize.js";
import { SearchQueryRequest, SearchSourceResult } from "../types.js";
import { SearchSource } from "./base.js";

interface SearxngSearchResponse {
  results?: Array<{
    url?: string;
    title?: string;
    content?: string;
    publishedDate?: string;
  }>;
}

interface SearxngSourceOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class SearxngSource implements SearchSource {
  readonly name = "searxng";
  readonly enabled: boolean;
  readonly description = "Configurable SearXNG JSON search endpoint";
  readonly #fetchImpl: typeof fetch;
  readonly #baseUrl?: string;

  constructor(options: SearxngSourceOptions = {}) {
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.enabled = Boolean(this.#baseUrl);
  }

  async search(request: SearchQueryRequest): Promise<SearchSourceResult> {
    if (!this.#baseUrl) {
      return {
        source: this.name,
        results: [],
      };
    }

    const url = new URL("/search", this.#baseUrl);
    url.searchParams.set("q", buildQuery(request));
    url.searchParams.set("format", "json");
    url.searchParams.set("language", request.language ?? "all");
    if (request.safeSearch) {
      url.searchParams.set("safesearch", toSearxSafeSearch(request.safeSearch));
    }

    const response = await this.#fetchImpl(url, {
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(4_000),
    });

    const payload = await response.json() as SearxngSearchResponse;

    return {
      source: this.name,
      results: (payload.results ?? [])
        .filter((entry): entry is Required<Pick<NonNullable<SearxngSearchResponse["results"]>[number], "url" | "title">> & NonNullable<SearxngSearchResponse["results"]>[number] => Boolean(entry.url && entry.title))
        .slice(0, request.limit ?? 10)
        .map((entry, index) => ({
          url: entry.url,
          normalizedUrl: normalizeUrl(entry.url),
          title: entry.title,
          ...(entry.content ? { snippet: entry.content } : {}),
          ...(entry.publishedDate ? { publishedAt: entry.publishedDate } : {}),
          source: this.name,
          rank: index + 1,
        })),
      raw: payload,
    };
  }
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl || baseUrl.trim().length === 0) {
    return undefined;
  }

  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function buildQuery(request: SearchQueryRequest): string {
  if (request.site) {
    return `${request.query} site:${request.site}`;
  }

  return request.query;
}

function toSearxSafeSearch(value: SearchQueryRequest["safeSearch"]): string {
  if (value === "strict") {
    return "2";
  }

  if (value === "moderate") {
    return "1";
  }

  return "0";
}
