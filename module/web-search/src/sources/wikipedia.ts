import { normalizeUrl } from "../normalize.js";
import { SearchQueryRequest, SearchSourceResult } from "../types.js";
import { SearchSource } from "./base.js";

type WikipediaOpenSearchResponse = [string, string[], string[], string[]];

interface WikipediaSourceOptions {
  fetchImpl?: typeof fetch;
}

export class WikipediaSource implements SearchSource {
  readonly name = "wikipedia-opensearch";
  readonly enabled = true;
  readonly description = "Wikipedia OpenSearch API for encyclopedic query matches";
  readonly #fetchImpl: typeof fetch;

  constructor(options: WikipediaSourceOptions = {}) {
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(request: SearchQueryRequest): Promise<SearchSourceResult> {
    const url = new URL("https://en.wikipedia.org/w/api.php");
    url.searchParams.set("action", "opensearch");
    url.searchParams.set("search", request.query);
    url.searchParams.set("limit", String(request.limit ?? 10));
    url.searchParams.set("namespace", "0");
    url.searchParams.set("format", "json");
    url.searchParams.set("origin", "*");

    const response = await this.#fetchImpl(url, {
      headers: {
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(4_000),
    });

    const payload = await response.json() as WikipediaOpenSearchResponse;
    const [, titles = [], snippets = [], urls = []] = payload;

    return {
      source: this.name,
      results: urls.map((entryUrl, index) => ({
        url: entryUrl,
        normalizedUrl: normalizeUrl(entryUrl),
        title: titles[index] ?? entryUrl,
        ...(snippets[index] ? { snippet: snippets[index] } : {}),
        source: this.name,
        rank: index + 1,
      })),
      raw: payload,
    };
  }
}
