import { getSupportedRequestFields } from "./requests.js";
import { SearchInfoResponse } from "./types.js";

export function createInfoResponse(requestId: string, responder: string, sources: SearchInfoResponse["sources"]): SearchInfoResponse {
  return {
    requestId,
    responder,
    status: "ok",
    type: "info",
    module: "web-search",
    capabilities: ["web-search", "search", "info"],
    requestTypes: ["search", "info"],
    requestFields: getSupportedRequestFields(),
    sources,
    dedupe: {
      strategy: "normalized-url",
      normalization: [
        "forces https scheme",
        "lowercases host",
        "removes www prefix",
        "drops hash fragments",
        "removes tracking query parameters",
        "trims trailing slashes",
        "sorts remaining query parameters",
      ],
    },
  };
}
