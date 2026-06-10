/**
 * Pure query helpers shared by the durable data-plane adapters (vector/search/
 * nosql). Re-implemented here (rather than imported from inMemorySurfaces) so
 * the durable adapters stay decoupled from the in-memory module. Behaviour
 * matches the in-memory impls method-for-method.
 */

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const L = Math.min(a.length, b.length);
  for (let i = 0; i < L; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[\s,.!?;:\-_/\\()[\]{}<>"']+/).filter((t) => t.length > 0);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function matchesFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.keys(filter).every((k) => deepEqual(doc[k], filter[k]));
}

/** Reject `$`-prefixed keys ANYWHERE in a filter (injection guard,
 *  §host.db.nosql). The Mongo operator form is nested, so the guard recurses. */
export function assertSafeFilter(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(assertSafeFilter); return; }
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith('$')) {
      throw Object.assign(
        new Error(`nosql filter operator '${k}' is not supported (exact-match filters only)`),
        { code: 'nosql_filter_unsupported' },
      );
    }
    assertSafeFilter(v);
  }
}

export function project(doc: Record<string, unknown>, projection: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!projection || Object.keys(projection).length === 0) return doc;
  const includes = Object.entries(projection).filter(([, v]) => v).map(([k]) => k);
  if (includes.length > 0) {
    const out: Record<string, unknown> = {};
    if ('_id' in doc) out._id = doc._id;
    for (const k of includes) if (k in doc) out[k] = doc[k];
    return out;
  }
  const out: Record<string, unknown> = { ...doc };
  for (const k of Object.keys(projection)) delete out[k];
  return out;
}

export function applySort(docs: Record<string, unknown>[], sort: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (!sort || Object.keys(sort).length === 0) return docs;
  const keys = Object.entries(sort).map(([k, v]) => ({ k, dir: Number(v) < 0 ? -1 : 1 }));
  return [...docs].sort((a, b) => {
    for (const { k, dir } of keys) {
      const av = a[k], bv = b[k];
      if (av === bv) continue;
      if (av === undefined || av === null) return -dir;
      if (bv === undefined || bv === null) return dir;
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv));
      if (cmp !== 0) return cmp * dir;
    }
    return 0;
  });
}
