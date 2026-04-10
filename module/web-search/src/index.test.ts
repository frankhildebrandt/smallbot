import assert from "node:assert/strict";
import test from "node:test";

import { ModuleRuntime } from "@smallbot/framework";

import { mergeAndDedupeResults, normalizeUrl } from "./normalize.js";
import { parseSearchRequest } from "./requests.js";
import { SearchAggregator } from "./searchAggregator.js";
import { SearchSource } from "./sources/base.js";
import { WebSearchService } from "./service.js";
import { SearchQueryRequest, SearchResult, SearchSourceResult } from "./types.js";

class RuntimeStub {
  readonly sent: any[] = [];
  readonly states: Array<"free" | "busy" | "stopped"> = [];

  async updateState(state: "free" | "busy" | "stopped"): Promise<void> {
    this.states.push(state);
  }

  async send(message: unknown): Promise<void> {
    this.sent.push(message);
  }
}

class SearchSourceStub implements SearchSource {
  constructor(
    readonly name: string,
    readonly enabled: boolean,
    readonly description: string,
    private readonly resultFactory: (request: SearchQueryRequest) => Promise<SearchSourceResult>,
  ) {}

  async search(request: SearchQueryRequest): Promise<SearchSourceResult> {
    return this.resultFactory(request);
  }
}

test("parseSearchRequest accepts structured search requests", () => {
  const parsed = parseSearchRequest({
    type: "search",
    query: "smallbot",
    limit: 5,
    language: "de",
    includeRaw: true,
  });

  assert.equal(parsed.type, "search");
  assert.equal(parsed.query, "smallbot");
  assert.equal(parsed.limit, 5);
  assert.equal(parsed.language, "de");
  assert.equal(parsed.includeRaw, true);
});

test("parseSearchRequest treats string payloads as query requests", () => {
  const parsed = parseSearchRequest("smallbot");
  assert.deepEqual(parsed, {
    type: "search",
    query: "smallbot",
  });
});

test("parseSearchRequest rejects invalid filters", () => {
  assert.throws(
    () => parseSearchRequest({
      query: "smallbot",
      limit: 0,
    }),
    /positive integer/,
  );
});

test("parseSearchRequest accepts info requests", () => {
  const parsed = parseSearchRequest({ type: "info" });
  assert.deepEqual(parsed, { type: "info" });
});

test("normalizeUrl removes tracking parameters and normalizes host/path", () => {
  assert.equal(
    normalizeUrl("http://www.Example.com/path/?utm_source=test&b=2&a=1#frag"),
    "https://example.com/path?a=1&b=2",
  );
});

test("mergeAndDedupeResults prefers more complete duplicate entries", () => {
  const duplicateUrl = normalizeUrl("https://example.com/article?utm_source=test");
  const results: SearchResult[] = [
    {
      url: "https://example.com/article?utm_source=test",
      normalizedUrl: duplicateUrl,
      title: "Example",
      source: "one",
      rank: 5,
    },
    {
      url: "https://example.com/article",
      normalizedUrl: duplicateUrl,
      title: "Example",
      snippet: "Better snippet",
      source: "two",
      rank: 2,
    },
  ];

  const merged = mergeAndDedupeResults(results, 10);
  assert.equal(merged.results.length, 1);
  assert.equal(merged.results[0]?.snippet, "Better snippet");
  assert.equal(merged.dedupe.removedCount, 1);
});

test("SearchAggregator merges sources, dedupes and applies limit", async () => {
  const aggregator = new SearchAggregator([
    new SearchSourceStub("source-a", true, "A", async () => ({
      source: "source-a",
      results: [
        createResult("https://example.com/one?utm_source=ad", "One", "First", "source-a", 2),
        createResult("https://example.com/two", "Two", "Second", "source-a", 3),
      ],
      raw: { source: "a" },
    })),
    new SearchSourceStub("source-b", true, "B", async () => ({
      source: "source-b",
      results: [
        createResult("https://example.com/one", "One", "Richer", "source-b", 1),
        createResult("https://example.com/three", "Three", "Third", "source-b", 4),
      ],
      raw: { source: "b" },
    })),
  ], "search:1");

  const response = await aggregator.search("req-1", {
    type: "search",
    query: "smallbot",
    limit: 2,
    includeRaw: true,
  });

  assert.equal(response.results.length, 2);
  assert.equal(response.results[0]?.snippet, "Richer");
  assert.deepEqual(response.sourcesSucceeded, ["source-a", "source-b"]);
  assert.equal(response.dedupe.inputCount, 4);
  assert.equal(response.dedupe.uniqueCount, 3);
  assert.deepEqual(Object.keys(response.raw ?? {}), ["source-a", "source-b"]);
});

test("SearchAggregator reports source failures without aborting successful searches", async () => {
  const aggregator = new SearchAggregator([
    new SearchSourceStub("source-a", true, "A", async () => {
      throw new Error("boom");
    }),
    new SearchSourceStub("source-b", true, "B", async () => ({
      source: "source-b",
      results: [createResult("https://example.com/ok", "OK", "Fine", "source-b", 1)],
    })),
  ], "search:1");

  const response = await aggregator.search("req-2", {
    type: "search",
    query: "smallbot",
  });

  assert.equal(response.results.length, 1);
  assert.equal(response.sourcesFailed.length, 1);
  assert.equal(response.sourcesFailed[0]?.source, "source-a");
});

test("WebSearchService returns results for search requests", async () => {
  const runtime = new RuntimeStub();
  const aggregator = new SearchAggregator([
    new SearchSourceStub("source-a", true, "A", async () => ({
      source: "source-a",
      results: [createResult("https://example.com", "Example", "Snippet", "source-a", 1)],
    })),
  ], "search:1");
  const service = new WebSearchService(runtime as unknown as ModuleRuntime, aggregator, "search:1");

  await service.onMessage({
    s: "worker:1",
    t: "search:1",
    c: "tool",
    i: "req-3",
    m: {
      type: "search",
      query: "smallbot",
    },
  });

  assert.deepEqual(runtime.states, ["busy", "free"]);
  assert.equal(runtime.sent[0]?.c, "result");
  assert.equal(runtime.sent[0]?.m?.type, "search");
  assert.equal(runtime.sent[0]?.m?.results?.length, 1);
});

test("WebSearchService logs search queries to the console", async () => {
  const runtime = new RuntimeStub();
  const aggregator = new SearchAggregator([
    new SearchSourceStub("source-a", true, "A", async () => ({
      source: "source-a",
      results: [createResult("https://example.com", "Example", "Snippet", "source-a", 1)],
    })),
  ], "search:1");
  const service = new WebSearchService(runtime as unknown as ModuleRuntime, aggregator, "search:1");
  const originalConsoleLog = console.log;
  const messages: string[] = [];

  console.log = (...args: unknown[]) => {
    messages.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    await service.onMessage({
      s: "worker:1",
      t: "search:1",
      c: "tool",
      i: "req-logged",
      m: {
        type: "search",
        query: "smallbot",
        limit: 3,
        language: "de",
      },
    });
  } finally {
    console.log = originalConsoleLog;
  }

  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? "", /\[module:search:1\] search request=req-logged query="smallbot"/);
  assert.match(messages[0] ?? "", /limit=3/);
  assert.match(messages[0] ?? "", /language=de/);
});

test("WebSearchService returns module info", async () => {
  const runtime = new RuntimeStub();
  const aggregator = new SearchAggregator([], "search:1");
  const service = new WebSearchService(runtime as unknown as ModuleRuntime, aggregator, "search:1");

  await service.onMessage({
    s: "worker:1",
    t: "search:1",
    c: "tool",
    i: "req-4",
    m: {
      type: "info",
    },
  });

  assert.equal(runtime.sent[0]?.c, "result");
  assert.equal(runtime.sent[0]?.m?.type, "info");
  assert.equal(runtime.sent[0]?.m?.module, "web-search");
});

test("WebSearchService returns errors for invalid requests", async () => {
  const runtime = new RuntimeStub();
  const aggregator = new SearchAggregator([], "search:1");
  const service = new WebSearchService(runtime as unknown as ModuleRuntime, aggregator, "search:1");

  await service.onMessage({
    s: "worker:1",
    t: "search:1",
    c: "tool",
    i: "req-5",
    m: {
      type: "search",
      query: "",
    },
  });

  assert.deepEqual(runtime.states, ["busy", "free"]);
  assert.equal(runtime.sent[0]?.c, "error");
  assert.match(String(runtime.sent[0]?.m?.reason), /non-empty string/);
});

function createResult(url: string, title: string, snippet: string, source: string, rank: number): SearchResult {
  return {
    url,
    normalizedUrl: normalizeUrl(url),
    title,
    snippet,
    source,
    rank,
  };
}
