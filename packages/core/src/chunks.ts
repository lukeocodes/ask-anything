import { and, asc, db, eq, knowledgeChunks, sql, type KnowledgeChunk } from "@ask/db";

/**
 * Read side of the chunk tree (ADR-0025). Relatives are a join, never a
 * re-parse: siblings share `parent_id`, children point at a row, the enclosing
 * section is one hop up. Embeddings are never returned — they are retrieval
 * internals and a thousand floats per row.
 */
export type ChunkRow = Omit<KnowledgeChunk, "embedding">;

export interface ChunkTreeNode {
  chunk: ChunkRow;
  children: ChunkTreeNode[];
}

export interface ChunkContext {
  chunk: ChunkRow;
  parent: ChunkRow | null;
  /** Rows sharing this chunk's parent (self excluded), in document order. */
  siblings: ChunkRow[];
  children: ChunkRow[];
}

const chunkColumns = {
  id: knowledgeChunks.id,
  itemId: knowledgeChunks.itemId,
  ord: knowledgeChunks.ord,
  parentId: knowledgeChunks.parentId,
  depth: knowledgeChunks.depth,
  heading: knowledgeChunks.heading,
  headingPath: knowledgeChunks.headingPath,
  path: knowledgeChunks.path,
  kind: knowledgeChunks.kind,
  startLine: knowledgeChunks.startLine,
  endLine: knowledgeChunks.endLine,
  body: knowledgeChunks.body,
  createdAt: knowledgeChunks.createdAt,
};

/**
 * Nest flat rows by `parentId`. Rows must be in document order (`ord`), which
 * puts every parent before its children; a row whose parent is missing from the
 * input is treated as a root so a partial list still shapes into a forest.
 */
export function buildChunkTree(rows: ChunkRow[]): ChunkTreeNode[] {
  const nodes = new Map<string, ChunkTreeNode>();
  const roots: ChunkTreeNode[] = [];
  for (const chunk of rows) nodes.set(chunk.id, { chunk, children: [] });
  for (const node of nodes.values()) {
    const parent = node.chunk.parentId ? nodes.get(node.chunk.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** An item's whole chunk tree: flat rows in document order plus the nested shape. */
export async function getItemChunkTree(
  itemId: string,
): Promise<{ chunks: ChunkRow[]; tree: ChunkTreeNode[] }> {
  const chunks = await db()
    .select(chunkColumns)
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.itemId, itemId))
    .orderBy(asc(knowledgeChunks.ord));
  return { chunks, tree: buildChunkTree(chunks) };
}

/** One chunk with its parent, siblings, and children; null when it does not exist. */
export async function getChunkContext(chunkId: string): Promise<ChunkContext | null> {
  const [chunk] = await db()
    .select(chunkColumns)
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.id, chunkId))
    .limit(1);
  if (!chunk) return null;

  const sameParent = chunk.parentId
    ? eq(knowledgeChunks.parentId, chunk.parentId)
    : sql`${knowledgeChunks.parentId} is null`;

  const [parentRows, siblings, children] = await Promise.all([
    chunk.parentId
      ? db().select(chunkColumns).from(knowledgeChunks).where(eq(knowledgeChunks.id, chunk.parentId)).limit(1)
      : Promise.resolve([] as ChunkRow[]),
    db()
      .select(chunkColumns)
      .from(knowledgeChunks)
      .where(and(eq(knowledgeChunks.itemId, chunk.itemId), sameParent, sql`${knowledgeChunks.id} <> ${chunk.id}`))
      .orderBy(asc(knowledgeChunks.ord)),
    db()
      .select(chunkColumns)
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.parentId, chunk.id))
      .orderBy(asc(knowledgeChunks.ord)),
  ]);

  return { chunk, parent: parentRows[0] ?? null, siblings, children };
}
