/**
 * The one HTTP client the CLI uses. Every command goes through here: Bearer
 * auth, JSON in/out, and a thrown `ApiError` (status + body) on any non-2xx.
 * The SSE reader backs the two streaming commands (`ask stream`, `events tail`).
 */
export interface ApiConfig {
  apiUrl: string;
  apiKey: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    method: string,
    path: string,
  ) {
    super(`${method} ${path} failed: HTTP ${status}${body ? ` — ${body}` : ""}`);
    this.name = "ApiError";
  }
}

export interface SseEvent {
  event: string;
  data: string;
}

type Query = Record<string, string | number | boolean | undefined>;

function buildUrl(base: string, path: string, query?: Query): string {
  const url = new URL(path, base.replace(/\/?$/, "/"));
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export class ApiClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;

  constructor(cfg: ApiConfig) {
    this.base = cfg.apiUrl.replace(/\/$/, "");
    this.headers = {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    };
  }

  async request<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: { body?: unknown; query?: Query } = {},
  ): Promise<T> {
    const res = await fetch(buildUrl(this.base, path.replace(/^\//, ""), opts.query), {
      method,
      headers: this.headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (!res.ok) throw new ApiError(res.status, await res.text(), method, path);
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  /** Open an SSE stream and yield each `event:`/`data:` frame as it arrives. */
  async *sse(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; query?: Query; signal?: AbortSignal } = {},
  ): AsyncGenerator<SseEvent> {
    const res = await fetch(buildUrl(this.base, path.replace(/^\//, ""), opts.query), {
      method,
      headers: { ...this.headers, accept: "text/event-stream" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
    if (!res.ok) throw new ApiError(res.status, await res.text(), method, path);
    if (!res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const ev = parseSseFrame(frame);
          if (ev) yield ev;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/** Parse one SSE frame (the text between blank lines). Comments yield nothing. */
export function parseSseFrame(frame: string): SseEvent | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join("\n") };
}
