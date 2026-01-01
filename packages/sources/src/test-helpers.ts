import { logger } from "@ask/config";
import type { IndexContext, IngestInput, SourcePersistence } from "@ask/core";
import type { KnowledgeSource } from "@ask/db";

/** An in-memory stand-in for the DB layer: hash-gated refresh, ref-set prune. */
export function memoryPersistence() {
  const items = new Map<string, IngestInput & { sourceRef: string }>();
  const calls: { prune: string[][]; removed: string[] } = { prune: [], removed: [] };
  const p: SourcePersistence = {
    async refresh(input) {
      const prev = items.get(input.sourceRef);
      items.set(input.sourceRef, input);
      if (!prev) return { created: true, changed: true };
      return { created: false, changed: prev.body.trim() !== input.body.trim() };
    },
    async prune(_sourceId, keepRefs) {
      calls.prune.push(keepRefs);
      let n = 0;
      for (const ref of [...items.keys()]) {
        if (!keepRefs.includes(ref)) {
          items.delete(ref);
          n += 1;
        }
      }
      return n;
    },
    async remove(itemId) {
      calls.removed.push(itemId);
    },
  };
  return { p, items, calls };
}

/** An IndexContext over the memory seam with a silent logger and test-sized caps. */
export function testContext(
  source: KnowledgeSource,
  p: SourcePersistence,
  env: Partial<IndexContext["env"]> = {},
): IndexContext {
  return {
    source,
    persistence: p,
    log: logger("test").child({}, { level: "silent" }),
    config: source.config ?? {},
    env: { workdir: "/nonexistent", maxFileKb: 512, maxPages: 500, ...env },
  };
}
