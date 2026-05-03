import type { IndexEntry, SearchResult } from "../types";

export interface VectorEngine {
  upsert(entries: IndexEntry[]): Promise<void>;
  deleteByFile(filePaths: string[]): Promise<void>;
  search(query: string, topK?: number): Promise<SearchResult[]>;
  hasIndex(simhash: string): Promise<boolean>;
}
