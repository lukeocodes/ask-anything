import { answerQuestion, answerQuestionStream, embed, estimateCostUsd, type GroundingChunk } from "@ask/ai";
import { loadEnv } from "@ask/config";
import { and, answers, db, inArray, knowledgeItems, lt } from "@ask/db";
import { agentAnswer, type AgentResult } from "./agent.js";
import { lookupAnswerCache, storeAnswerCache } from "./cache.js";
import { reinforce } from "./decay.js";
import { emitEvent } from "./events.js";
import { fuseAndRank, gatherPool, isSufficient } from "./pipeline.js";
import { clusterQuestionEvent, logQuestionEvent } from "./questions.js";
import { recordUsage } from "./telemetry.js";
import { isMachineSurface, type AskOptions, type AskResult, type Citation, type StepFn, type Visibility } from "./types.js";

/**
 * Non-streaming answer. Pipeline: cache → confident index hit answers
 * deterministically → otherwise the tool-calling agent (see prepareContext).
 */
export async function ask(rawText: string, opts: AskOptions): Promise<AskResult> {
  const prepared = await prepareContext(rawText, opts);
  const result =
    prepared.kind === "done"
      ? await finalize(prepared.args)
      : prepared.kind === "agent"
        ? await finalize(fromAgent(prepared.base, await agentAnswer(rawText, opts, undefined, { seed: prepared.seed })))
        : await finalize(
            fromGeneration(
              prepared,
              await answerQuestion(prepared.question, prepared.chunks, {
                context: prepared.context,
                callerVisibility: prepared.base.visibility,
              }),
            ),
          );
  await maybeScheduleReverify(result.citedIds, opts);
  return result;
}

/**
 * Age-triggered reactive re-verify: any cited item last verified more than
 * REVERIFY_AGE_HOURS ago is handed to the injected `scheduleReverify` sink so a
 * targeted source re-check can run out of band — independent of confidence, so a
 * still-high-confidence-but-old item still gets refreshed. Fire-and-forget; only
 * the (cheap) age query is awaited, never the re-verify itself.
 */
async function maybeScheduleReverify(citedIds: string[], opts: AskOptions): Promise<void> {
  if (!opts.scheduleReverify) return;
  const hours = loadEnv().REVERIFY_AGE_HOURS;
  if (hours <= 0 || citedIds.length === 0) return;
  const cutoff = new Date(Date.now() - hours * 3_600_000);
  const rows = await db()
    .select({ id: knowledgeItems.id })
    .from(knowledgeItems)
    .where(and(inArray(knowledgeItems.id, citedIds), lt(knowledgeItems.lastVerifiedAt, cutoff)))
    .catch(() => [] as { id: string }[]);
  if (rows.length > 0) opts.scheduleReverify(rows.map((r) => r.id));
}

/**
 * Streaming answer. `onDelta` receives text as it's produced; `onStep` receives
 * pipeline/agent progress (which searches ran). The agent streams its tool-call
 * steps live, then emits the composed answer. Same AskResult as ask().
 */
export async function askStream(
  rawText: string,
  opts: AskOptions,
  onDelta: (text: string) => void,
  onStep?: StepFn,
): Promise<AskResult> {
  const prepared = await prepareContext(rawText, opts, onStep);
  let result: AskResult;
  if (prepared.kind === "done") {
    if (prepared.args.text) onDelta(prepared.args.text);
    result = await finalize(prepared.args);
  } else if (prepared.kind === "agent") {
    const r = await agentAnswer(rawText, opts, onStep, { seed: prepared.seed });
    if (r.text) onDelta(r.text);
    result = await finalize(fromAgent(prepared.base, r));
  } else {
    const r = await answerQuestionStream(prepared.question, prepared.chunks, onDelta, {
      context: prepared.context,
      callerVisibility: prepared.base.visibility,
    });
    result = await finalize(fromGeneration(prepared, r));
  }
  await maybeScheduleReverify(result.citedIds, opts);
  return result;
}

interface GenerateBase {
  questionEventId: string;
  visibility: Visibility;
  startedAt: number;
  surface: AskOptions["surface"];
  actorRef?: string;
  rawText: string;
  cache: { queryVector: number[]; queryText: string } | null;
}

type Prepared =
  | { kind: "done"; args: FinalizeArgs }
  | { kind: "generate"; question: string; chunks: GroundingChunk[]; context?: string; base: GenerateBase }
  | { kind: "agent"; base: GenerateBase; seed?: GroundingChunk[] };

/**
 * Shared pipeline for both ask() and askStream():
 *  log question → governance gate → embed once → cache lookup →
 *  gather from the index → rerank → sufficient? deterministic answer : agent.
 *
 * The engine answers from its own index only; sources are indexed ahead of
 * time. There is NO zero-grounding short-circuit: an empty or insufficient pool
 * falls through to the tool-calling agent, which can reformulate and search
 * again before it abstains in text.
 */
async function prepareContext(
  rawText: string,
  opts: AskOptions,
  onStep?: StepFn,
): Promise<Prepared> {
  const startedAt = Date.now();
  const env = loadEnv();
  const limit = opts.limit ?? 8;
  const visibility: Visibility = opts.visibility ?? "public";
  const step: StepFn = onStep ?? (() => {});

  const { questionEventId } = await logQuestionEvent(rawText, {
    surface: opts.surface,
    actorRef: opts.actorRef,
  });

  const doneBase = { questionEventId, visibility, startedAt, surface: opts.surface, actorRef: opts.actorRef, rawText, chunks: [] as GroundingChunk[], cache: null };

  // Governance: never send private content to third-party APIs unless allowed.
  // A refusal is not a knowledge gap — `refused` keeps it out of the ledger.
  if (visibility === "private" && !env.PRIVATE_EGRESS_ALLOWED) {
    return { kind: "done", args: { ...doneBase, text:
      "Private mode is disabled on this deployment (PRIVATE_EGRESS_ALLOWED=false). Ask a public question, or enable private egress / self-host the models.",
      model: "none", citedIds: [], abstained: true, refused: true, inputTokens: 0, outputTokens: 0 } };
  }

  // Embeddings power retrieval + cache. If they're unavailable (rate limit,
  // outage), retrieval re-embeds per call (and may fail) rather than aborting
  // the whole ask here.
  let queryVec: number[] | undefined;
  const embedStartedAt = Date.now();
  try {
    const embedded = await embed([rawText], { inputType: "query" });
    queryVec = embedded.vectors[0];
    void recordUsage({
      kind: "embed", surface: opts.surface, actor: opts.actorRef, model: embedded.model,
      tokensIn: embedded.tokens, costUsd: estimateCostUsd(embedded.model, embedded.tokens ?? 0, 0),
      latencyMs: Date.now() - embedStartedAt, metadata: { op: "query" },
    }).catch(() => {});
  } catch {
    queryVec = undefined;
  }

  const hitsLabel = (n: number): string => (n === 1 ? "1 hit" : `${n} hits`);

  // Cache lookup — skipped when caller context is present (context-specific).
  if (queryVec && !opts.context) {
    step({ id: "recall", title: "Checking answer cache", status: "in_progress" });
    const cached = await lookupAnswerCache(queryVec, visibility);
    if (cached) {
      step({ id: "recall", title: "Recalled a recent answer", status: "complete", output: "from cache" });
      return { kind: "done", args: { ...doneBase, text: cached.answerText, model: cached.model,
        citedIds: cached.citedItemIds, abstained: false,
        inputTokens: 0, outputTokens: 0, cacheHit: true } };
    }
    step({ id: "recall", title: "Checking answer cache", status: "complete", output: "no match" });
  }

  const base: GenerateBase = {
    questionEventId, visibility, startedAt, surface: opts.surface, actorRef: opts.actorRef, rawText,
    cache: queryVec && !opts.context ? { queryVector: queryVec, queryText: rawText } : null,
  };

  // Gather from the index and rank. A fresh, clearly-relevant hit answers
  // deterministically (one model call). "Relevant" is the reranked
  // answerability score (isSufficient), not decayed authority — so an
  // authoritative-but-off-topic item no longer answers; it escalates to the
  // agent, which starts seeded with the ranked pool so it never searches blind.
  step({ id: "kb", title: "Searching knowledge base", status: "in_progress" });
  const pool = await gatherPool(rawText, { visibility, limit, queryVector: queryVec, tags: opts.tags });
  const ranked = await fuseAndRank(rawText, pool, limit);
  const sufficient = isSufficient(ranked, env);
  step({ id: "kb", title: sufficient ? "Answering from knowledge base" : "Reasoning over knowledge base", status: "complete",
    output: ranked.length ? `${hitsLabel(ranked.length)}${sufficient ? "" : " — reasoning"}` : "no match — reasoning" });
  if (sufficient) {
    return { kind: "generate", question: rawText, chunks: ranked, context: opts.context, base };
  }
  return { kind: "agent", base, seed: ranked };
}

function fromAgent(base: GenerateBase, r: AgentResult): FinalizeArgs {
  return {
    ...base,
    text: r.text,
    model: r.model,
    citedIds: r.citedIds,
    abstained: r.abstained,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUsd: r.costUsd,
    chunks: r.chunks,
    cache: r.abstained ? null : base.cache,
  };
}

function fromGeneration(
  prepared: Extract<Prepared, { kind: "generate" }>,
  result: Awaited<ReturnType<typeof answerQuestion>>,
): FinalizeArgs {
  // Grounded-only guarantee on the deterministic path (mirrors the agent): an
  // answer that cites nothing with no caller context to draw from is ungrounded
  // prose — never serve it. The hedge-regex abstain (isAbstain) stays as the
  // other signal. Caller-context answers may legitimately cite nothing.
  const ungrounded = !result.abstained && result.citedIds.length === 0 && !prepared.context;
  const abstained = result.abstained || ungrounded;
  return {
    ...prepared.base,
    text: ungrounded ? "I don't have that yet." : result.text,
    model: result.model,
    citedIds: ungrounded ? [] : result.citedIds,
    abstained,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    chunks: prepared.chunks,
    cache: abstained ? null : prepared.base.cache,
  };
}

interface FinalizeArgs {
  questionEventId: string;
  visibility: Visibility;
  text: string;
  model: string;
  citedIds: string[];
  abstained: boolean;
  /** A governance refusal (private egress disabled) — abstained, but not a knowledge gap. */
  refused?: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  startedAt: number;
  surface: AskOptions["surface"];
  actorRef?: string;
  rawText: string;
  chunks: GroundingChunk[];
  cache: { queryVector: number[]; queryText: string } | null;
  cacheHit?: boolean;
  /** Pre-resolved citations. Otherwise derived from chunks. */
  citations?: Citation[];
}

/**
 * Resolve cited ids to {title, url}: from the grounding chunks when present,
 * else looked up from the knowledge items (covers the answer-cache path, which
 * has ids but no chunks).
 */
async function resolveCitations(
  citedIds: string[],
  chunks: GroundingChunk[],
  provided?: Citation[],
): Promise<Citation[]> {
  if (provided) return provided;
  const byId = new Map<string, { title?: string; url?: string }>(
    chunks.map((c) => [c.id, { title: c.title, url: c.url }]),
  );
  const missing = citedIds.filter((id) => !byId.has(id));
  if (missing.length) {
    const rows = await db()
      .select({ id: knowledgeItems.id, title: knowledgeItems.title, metadata: knowledgeItems.metadata })
      .from(knowledgeItems)
      .where(inArray(knowledgeItems.id, missing))
      .catch(() => []);
    for (const r of rows) {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      byId.set(r.id, { title: r.title, url: typeof meta.url === "string" ? meta.url : undefined });
    }
  }
  return citedIds.map((id) => ({ id, ...(byId.get(id) ?? {}) }));
}

async function finalize(a: FinalizeArgs): Promise<AskResult> {
  // Citation ids are knowledge item ids: the rewriter only ever records ids
  // present in the grounding, so they are real rows to store and reinforce.
  const [answerRow] = await db()
    .insert(answers)
    .values({
      questionEventId: a.questionEventId,
      text: a.text,
      model: a.model,
      itemIds: a.citedIds,
      visibility: a.visibility,
      latencyMs: Date.now() - a.startedAt,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
    })
    .returning({ id: answers.id });

  // Being cited reinforces an item (resists decay via retrievalCount) but does
  // NOT bump lastVerifiedAt — citation is not source verification. Faking the
  // verify timestamp here would keep popular items looking permanently fresh and
  // hide genuine staleness. Real re-verification happens via source indexing /
  // the age-triggered reverify.
  await Promise.all(a.citedIds.map((id) => reinforce(id, { verify: false }).catch(() => {})));

  // Cache at the standard TTL; revisions and `down` invalidate entries early.
  if (a.cache && !a.abstained) {
    void storeAnswerCache({
      queryVector: a.cache.queryVector, queryText: a.cache.queryText, visibility: a.visibility,
      answerText: a.text, citedItemIds: a.citedIds, model: a.model,
      answerId: answerRow!.id,
    }).catch(() => {});
  }

  // The engine's own cron traffic (backfill, warm) is not demand: it neither
  // clusters (askCount) nor re-opens a gap it was re-asking in the first place.
  const machine = isMachineSurface(a.surface);
  if (!machine) {
    void clusterQuestionEvent(a.questionEventId, a.rawText, { surface: a.surface }).catch(() => {});
  }

  // A genuine abstain is a knowledge gap — record it (filtering obvious junk) so
  // operators can see what people ask that we can't answer. A governance refusal
  // (`refused`) is not a gap.
  const q = a.rawText.trim();
  if (a.abstained && !a.refused && !machine && q.length >= 12 && /[a-z]{3,}/i.test(q)) {
    void emitEvent("question.unanswered", { question: q, surface: a.surface });
  }

  await recordUsage({
    kind: a.cacheHit ? "answer_cache_hit" : "answer",
    surface: a.surface, actor: a.actorRef, model: a.model,
    tokensIn: a.inputTokens, tokensOut: a.outputTokens, costUsd: a.costUsd,
    latencyMs: Date.now() - a.startedAt,
    metadata: { visibility: a.visibility, cited: a.citedIds.length, abstained: a.abstained, cacheHit: Boolean(a.cacheHit) },
  });

  const citations = await resolveCitations(a.citedIds, a.chunks, a.citations);

  return {
    answer: a.text,
    citedIds: a.citedIds,
    citations,
    abstained: a.abstained,
    visibility: a.visibility,
    questionEventId: a.questionEventId,
    answerId: answerRow!.id,
    model: a.model,
  };
}
