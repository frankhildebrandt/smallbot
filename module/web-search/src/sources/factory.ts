import { SearchSource } from "./base.js";
import { DuckDuckGoSource } from "./duckduckgo.js";
import { SearxngSource } from "./searxng.js";
import { WikipediaSource } from "./wikipedia.js";

interface CreateSourcesOptions {
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export function createSources(options: CreateSourcesOptions): SearchSource[] {
  return [
    new SearxngSource({
      baseUrl: options.env.SEARCH_SEARXNG_BASE_URL,
      fetchImpl: options.fetchImpl,
    }),
    new DuckDuckGoSource({
      fetchImpl: options.fetchImpl,
    }),
    new WikipediaSource({
      fetchImpl: options.fetchImpl,
    }),
  ];
}
