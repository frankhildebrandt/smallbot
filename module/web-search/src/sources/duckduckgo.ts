import { normalizeUrl } from "../normalize.js";
import { SearchQueryRequest, SearchResult, SearchSourceResult } from "../types.js";
import { SearchSource } from "./base.js";

interface DuckDuckGoResponse {
  AbstractText?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: DuckDuckGoTopic[];
  Results?: DuckDuckGoTopic[];
}

interface DuckDuckGoTopic {
  FirstURL?: string;
  Text?: string;
  Name?: string;
  Topics?: DuckDuckGoTopic[];
}

interface DuckDuckGoSourceOptions {
  fetchImpl?: typeof fetch;
}

export class DuckDuckGoSource implements SearchSource {
  readonly name = "duckduckgo-instant";
  readonly enabled = true;
  readonly description = "DuckDuckGo Instant Answer API with related topics fallback";
  readonly #fetchImpl: typeof fetch;

  constructor(options: DuckDuckGoSourceOptions = {}) {
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(request: SearchQueryRequest): Promise<SearchSourceResult> {
    const url = new URL("https://api.duckduckgo.com/");
    url.searchParams.set("q", buildQuery(request));
    url.searchParams.set("format", "json");
    url.searchParams.set("no_html", "1");
    url.searchParams.set("skip_disambig", "0");
    url.searchParams.set("no_redirect", "1");

    const response = await this.#fetchImpl(url, {
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(4_000),
    });

    const payload = await response.json() as DuckDuckGoResponse;
    const results = normalizeDuckDuckGoResults(payload, request.limit ?? 10);

    return {
      source: this.name,
      results,
      raw: payload,
    };
  }
}

function normalizeDuckDuckGoResults(payload: DuckDuckGoResponse, limit: number): SearchResult[] {
  const items: SearchResult[] = [];

  if (payload.AbstractURL && payload.Heading) {
    items.push(createResult(payload.AbstractURL, payload.Heading, payload.AbstractText, 1));
  }

  const topics = [
    ...(payload.Results ?? []),
    ...(payload.RelatedTopics ?? []),
  ];

  flattenTopics(topics).forEach((topic, index) => {
    if (!topic.FirstURL || !topic.Text) {
      return;
    }

    const { title, snippet } = splitText(topic.Text);
    items.push(createResult(topic.FirstURL, title, snippet, items.length + index + 1));
  });

  return items.slice(0, limit);
}

function flattenTopics(topics: DuckDuckGoTopic[]): DuckDuckGoTopic[] {
  return topics.flatMap((topic) => (Array.isArray(topic.Topics) ? flattenTopics(topic.Topics) : [topic]));
}

function splitText(text: string): { title: string; snippet?: string } {
  const separator = text.indexOf(" - ");
  if (separator < 0) {
    return { title: text };
  }

  return {
    title: text.slice(0, separator).trim(),
    snippet: text.slice(separator + 3).trim(),
  };
}

function createResult(url: string, title: string, snippet: string | undefined, rank: number): SearchResult {
  return {
    url,
    normalizedUrl: normalizeUrl(url),
    title,
    ...(snippet ? { snippet } : {}),
    source: "duckduckgo-instant",
    rank,
  };
}

function buildQuery(request: SearchQueryRequest): string {
  if (request.site) {
    return `${request.query} site:${request.site}`;
  }

  return request.query;
}
