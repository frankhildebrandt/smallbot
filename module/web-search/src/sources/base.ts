import { SearchQueryRequest, SearchSourceResult } from "../types.js";

export interface SearchSource {
  readonly name: string;
  readonly enabled: boolean;
  readonly description: string;
  search(request: SearchQueryRequest): Promise<SearchSourceResult>;
}
