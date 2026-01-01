/**
 * Compact human renderings, one per command that benefits from it. Everything
 * else falls back to pretty JSON (and `--json` always prints raw JSON).
 */

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const list = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec) : []);
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function keyValues(data: unknown): string {
  const r = rec(data);
  const keys = Object.keys(r);
  if (keys.length === 0) return JSON.stringify(data);
  const width = Math.max(...keys.map((k) => k.length));
  return keys.map((k) => `${k.padEnd(width)}  ${fmt(r[k])}`).join("\n");
}

function sources(citations: unknown): string {
  const cs = list(citations);
  if (cs.length === 0) return "";
  return (
    "\n\nSources:\n" +
    cs.map((c, i) => `  ${i + 1}. ${str(c.title) || str(c.id)}${c.url ? ` — ${str(c.url)}` : ""}`).join("\n")
  );
}

export function ask(data: unknown): string {
  const r = rec(data);
  const head = r.abstained ? "(abstained)\n" : "";
  const meta = [r.answerId && `answer ${str(r.answerId)}`, r.model && str(r.model), r.visibility && str(r.visibility)]
    .filter(Boolean)
    .join(" · ");
  return `${head}${str(r.answer)}${sources(r.citations)}${meta ? `\n\n${meta}` : ""}`;
}

/** After `ask stream` has already written the answer, print only the trailer. */
export function askStreamTail(data: unknown): string {
  const r = rec(data);
  const meta = r.answerId ? `\nanswer ${str(r.answerId)}` : "";
  return `${sources(r.citations).replace(/^\n+/, "")}${meta}`.trim();
}

export function search(data: unknown): string {
  const hits = list(rec(data).hits);
  if (hits.length === 0) return "No results.";
  return hits
    .map((h, i) => {
      const title = str(h.title) || str(h.id);
      const url = h.url ? ` (${str(h.url)})` : "";
      const score = typeof h.score === "number" ? ` [${h.score.toFixed(2)}]` : "";
      const body = str(h.body).replace(/\s+/g, " ").slice(0, 200);
      return `[${i + 1}] ${title}${url}${score}\n    ${body}`;
    })
    .join("\n");
}

export function knowledgeAdd(data: unknown): string {
  const r = rec(data);
  return `added ${str(r.id)}  ${str(r.visibility)}  ${str(r.status)}  ${str(r.title)}`.trim();
}

export function knowledgeReviews(data: unknown): string {
  const rows = list(rec(data).reviews);
  if (rows.length === 0) return "No reviews pending.";
  return rows
    .map((r) => `${str(r.id)}  ${str(r.visibility)}  ${str(r.sourceType)}  ${str(r.title)}`)
    .join("\n");
}

export function knowledgeGaps(data: unknown): string {
  const rows = list(rec(data).gaps);
  if (rows.length === 0) return "No gaps.";
  return rows
    .map((g) => {
      const count = g.count ?? g.askCount ?? g.hits;
      const q = str(g.question ?? g.canonicalQuestion ?? g.text ?? g.id);
      return count !== undefined ? `${fmt(count).padStart(4)}  ${q}` : q;
    })
    .join("\n");
}

export function proposalsList(data: unknown): string {
  const rows = list(rec(data).proposals);
  if (rows.length === 0) return "No pending proposals.";
  return rows
    .map((p) => {
      const kind = str(rec(p.diff).kind ?? p.kind ?? p.status);
      const target = str(p.itemTitle ?? p.title ?? p.itemId ?? p.knowledgeItemId);
      return `${str(p.id)}  ${kind}  ${target}`.trim();
    })
    .join("\n");
}

export function questionsTop(data: unknown): string {
  const rows = list(rec(data).questions);
  if (rows.length === 0) return "No questions yet.";
  return rows
    .map((q) => {
      const count = q.count ?? q.askCount ?? q.total;
      const text = str(q.question ?? q.canonicalQuestion ?? q.text ?? q.id);
      return `${fmt(count).padStart(4)}  ${text}`;
    })
    .join("\n");
}

export function sourcesList(data: unknown): string {
  const rows = list(rec(data).sources);
  if (rows.length === 0) return "No sources registered.";
  return rows
    .map((s) => {
      const state = s.enabled === false ? "disabled" : str(s.status);
      const last = s.lastIndexedAt ? str(s.lastIndexedAt).slice(0, 16).replace("T", " ") : "never";
      return `${str(s.id)}  ${str(s.kind).padEnd(3)}  ${state.padEnd(8)}  ${fmt(s.itemCount).padStart(5)}  ${last.padEnd(16)}  ${str(s.name)}  ${str(s.locator)}`;
    })
    .join("\n");
}

export const renderers = {
  keyValues,
  sourcesList,
  ask,
  askStreamTail,
  search,
  knowledgeAdd,
  knowledgeReviews,
  knowledgeGaps,
  proposalsList,
  questionsTop,
};
