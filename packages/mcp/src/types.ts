/**
 * The engine behind the MCP tools, injected so this package stays transport- and
 * deployment-agnostic. Two implementations exist:
 *   - in-process (the API server wires core `ask()` + retrieval directly)
 *   - HTTP proxy (`httpEngine`, used by the stdio binary to reach the hosted API)
 */
export interface AskEngine {
  ask(question: string, opts?: AskCallOptions): Promise<AskEngineResult>;
  search(query: string, opts?: SearchCallOptions): Promise<SearchHit[]>;
}

export interface AskCallOptions {
  /** Prior conversation / extra context handed to the model. */
  context?: string;
  /** Max grounding sources to consult. */
  limit?: number;
}

export interface SearchCallOptions {
  limit?: number;
}

export interface Citation {
  id: string;
  title?: string;
  url?: string;
}

export interface AskEngineResult {
  /** Canonical Markdown answer. */
  answer: string;
  citations: Citation[];
  /** True when the engine declined to answer (no confident grounding). */
  abstained: boolean;
  model?: string;
}

export interface SearchHit {
  id: string;
  title?: string;
  url?: string;
  body: string;
  source: string;
  confidence?: number;
  /** Cross-source rerank relevance 0-1, when a reranker ran. */
  score?: number;
}
