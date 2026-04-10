import { SearchResult } from "./types.js";

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "mkt_tok",
  "ref",
  "spm",
  "utm_campaign",
  "utm_content",
  "utm_id",
  "utm_medium",
  "utm_name",
  "utm_reader",
  "utm_source",
  "utm_term",
]);

export function normalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);

  url.protocol = "https:";
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();

  if (url.hostname.startsWith("www.")) {
    url.hostname = url.hostname.slice(4);
  }

  const cleanedParams = Array.from(url.searchParams.entries())
    .filter(([key]) => {
      const lowerKey = key.toLowerCase();
      return !TRACKING_PARAMS.has(lowerKey) && !lowerKey.startsWith("utm_");
    })
    .sort(([left], [right]) => left.localeCompare(right));

  url.search = "";
  for (const [key, value] of cleanedParams) {
    url.searchParams.append(key, value);
  }

  if (url.pathname !== "/") {
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  }

  return url.toString();
}

export function mergeAndDedupeResults(results: SearchResult[], limit: number): {
  results: SearchResult[];
  dedupe: {
    inputCount: number;
    uniqueCount: number;
    removedCount: number;
  };
} {
  const merged = new Map<string, SearchResult>();

  for (const result of results) {
    const existing = merged.get(result.normalizedUrl);
    if (!existing) {
      merged.set(result.normalizedUrl, result);
      continue;
    }

    merged.set(result.normalizedUrl, pickPreferredResult(existing, result));
  }

  const unique = Array.from(merged.values())
    .sort(compareResults)
    .slice(0, limit);

  return {
    results: unique,
    dedupe: {
      inputCount: results.length,
      uniqueCount: merged.size,
      removedCount: results.length - merged.size,
    },
  };
}

function pickPreferredResult(left: SearchResult, right: SearchResult): SearchResult {
  const leftScore = scoreResult(left);
  const rightScore = scoreResult(right);
  return rightScore > leftScore ? right : left;
}

function scoreResult(result: SearchResult): number {
  return [
    result.title.trim().length > 0 ? 3 : 0,
    result.snippet?.trim().length ? 2 : 0,
    result.publishedAt ? 1 : 0,
    typeof result.rank === "number" ? Math.max(0, 1000 - result.rank) / 1000 : 0,
  ].reduce((sum, value) => sum + value, 0);
}

function compareResults(left: SearchResult, right: SearchResult): number {
  const leftRank = left.rank ?? Number.MAX_SAFE_INTEGER;
  const rightRank = right.rank ?? Number.MAX_SAFE_INTEGER;

  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return left.title.localeCompare(right.title);
}
