/** ADR 0904 D9: authoritative documents, cross-replica invalidation and late-write
 * fences. The SQL engine itself is exercised in kb-pg-lexical-live.test.ts.
 *
 * The `sharedIndex()` double carries the ADAPTER half of each fence (generation
 * compare, pending refusal), so these cases assert the KB SERVICE half: that it
 * begins a mutation before a primary write, retires an owner on collection delete,
 * never consults a pending index, takes text and trust from the primary document,
 * and falls back to authoritative BM25 on any index failure. Where the double also
 * refuses (pending, a resurrected row dropped on read by currentIndexedMetadata),
 * the case asserts a counter the service alone moves (`log.searches`,
 * `log.replacements`) or the row store itself.
 *
 * Sabotage witnesses (features/kb/kbService.ts, host/vector/pgLexical.ts): merging
 * index metadata over the primary reds case 1; rebuilding a ready index reds case 1;
 * skipping the ingest/delete mutation reds cases 2/3/7/8; skipping or swallowing the
 * lexical delete reds 7/8; not retiring the owner reds 4; rethrowing index errors
 * reds 5; ignoring `pending` reds 6; ignoring the size trigger reds 9; the
 * maintenance index following reads reds 8; tsquery operators or duplicates red the
 * input-boundary case.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lexicalQueryString, setLexicalIndex, type LexicalIndex, type LexicalItem } from '../src/host/vector/pgLexical.js';
import { createCollection, deleteCollection, deleteDocument, ingestDocument, resolveRetrievalMode, searchDetailed, HYBRID_DEFAULT_MAX_CHUNKS } from '../src/features/kb/kbService.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openwop-kblex-'));
  initInMemorySurfaces({ dataDir: dir });
  initHostExtPersistence(await openStorage(`sqlite://${join(dir, 'primary.db')}`));
});
afterEach(() => { setLexicalIndex(null); delete process.env.OPENWOP_KB_LEXICAL_PERSIST_MIN_CHUNKS; delete process.env.OPENWOP_KB_RETRIEVAL_MODE; });

/** Shared adapter fixture: two independently installed clients see the same
 * durable generation. Hooks pause publication without sleeps or fake clocks. */
function sharedIndex() {
  const rows = new Map<string, LexicalItem & { tenant: string; ns: string }>();
  const owners = new Map<string, { generation: string; namespace: string; sourceRevision: string; ready: boolean; pending: Set<string>; retired: boolean }>();
  const retiredTenants = new Set<string>();
  const key = (t: string, owner: string) => `${t}|${owner}`;
  const log = { searches: 0, replacements: 0, failReplace: false, failDelete: false, failRead: false };
  let beforeReplace: (() => Promise<void>) | undefined;
  const client = (): LexicalIndex => ({
    async ensureOwner(t, owner, ns) {
      if (!retiredTenants.has(t) && !owners.has(key(t, owner))) owners.set(key(t, owner), { generation: randomUUID(), namespace: ns, sourceRevision: '', ready: false, pending: new Set(), retired: false });
    },
    async beginMutation(t, owner, ns, op) {
      await this.ensureOwner(t, owner, ns);
      const s = owners.get(key(t, owner));
      if (!s || s.retired || retiredTenants.has(t)) throw new Error('retired');
      s.generation = randomUUID(); s.ready = false; s.pending.add(op);
    },
    async finishMutation(t, owner, op) { owners.get(key(t, owner))?.pending.delete(op); },
    async ownerSnapshot(t, owner) {
      const s = owners.get(key(t, owner));
      return s && !s.retired && !retiredTenants.has(t) ? { generation: s.generation, namespace: s.namespace, pending: s.pending.size > 0, ready: s.ready, sourceRevision: s.sourceRevision } : null;
    },
    async admitNamespace(t, owner, gen, ns, revision = '') {
      const s = owners.get(key(t, owner));
      if (!s || s.retired || retiredTenants.has(t) || s.generation !== gen || s.pending.size) return null;
      if (s.namespace !== ns || s.sourceRevision !== revision) { s.namespace = ns; s.sourceRevision = revision; s.generation = randomUUID(); s.ready = false; }
      return s.generation;
    },
    async replaceNamespace(t, owner, ns, gen, items) {
      log.replacements++;
      if (log.failReplace) throw new Error('private SQL text must not escape');
      const hook = beforeReplace; beforeReplace = undefined; await hook?.();
      const s = owners.get(key(t, owner));
      if (!s || s.retired || retiredTenants.has(t) || s.generation !== gen || s.namespace !== ns || s.pending.size) return false;
      for (const [k, r] of rows) if (r.tenant === t && r.ns === ns) rows.delete(k);
      for (const r of items) rows.set(`${t}|${ns}|${r.id}`, { ...r, tenant: t, ns });
      s.ready = true; return true;
    },
    async searchReady(t, owner, ns, terms, k, revision = '') {
      log.searches++;
      if (log.failRead) throw new Error('private query bytes');
      const s = owners.get(key(t, owner));
      if (!s?.ready || s.retired || retiredTenants.has(t) || s.pending.size || s.namespace !== ns || s.sourceRevision !== revision) return null;
      const want = new Set(terms);
      return [...rows.values()].filter(r => r.tenant === t && r.ns === ns)
        .map(r => ({ id: r.id, score: r.terms.split(' ').filter(w => want.has(w)).length / 10, metadata: r.metadata }))
        .filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);
    },
    async deleteDocument(t, owner, op, ns, id) {
      if (log.failDelete) throw new Error('lexical delete unavailable');
      if (!owners.get(key(t, owner))?.pending.has(op)) throw new Error('missing mutation');
      for (const [k, r] of rows) if (r.tenant === t && r.ns === ns && r.metadata.documentId === id) rows.delete(k);
    },
    async retireOwner(t, owner) {
      await this.ensureOwner(t, owner, '');
      const s = owners.get(key(t, owner));
      if (s) { s.retired = true; s.ready = false; s.generation = randomUUID(); }
    },
    async purgeNamespace(t, ns) {
      let n = 0;
      for (const s of owners.values()) if (s.namespace === ns) { s.ready = false; s.generation = randomUUID(); }
      for (const [k, r] of rows) if (r.tenant === t && r.ns === ns) { rows.delete(k); n++; }
      return n;
    },
    async purgeTenant(t) {
      retiredTenants.add(t); let n = 0;
      for (const [k, r] of rows) if (r.tenant === t) { rows.delete(k); n++; }
      return n;
    },
  });
  return { rows, owners, log, client, onReplace: (f: () => Promise<void>) => { beforeReplace = f; } };
}

async function seeded(t: string, internal: { contentTrust?: 'trusted' | 'untrusted' } = {}) {
  const c = await createCollection(t, 'o', 'u', { name: 'manuals' });
  await ingestDocument(t, 'o', 'u', c.collectionId, { title: 'Safety', text: 'Forklift pallet recertification safety manual.' }, { documentId: 'd', ...internal });
  return c.collectionId;
}
const query = (t: string, col: string, q = 'forklift') => searchDetailed(t, 'o', col, q, 5, 'hybrid');

describe('persisted lexical channel with real durable KB primaries', () => {
  it('uses a ready index across client replacement, but source documents remain text/trust authority', async () => {
    const f = sharedIndex(); setLexicalIndex(f.client()); process.env.OPENWOP_KB_LEXICAL_PERSIST_MIN_CHUNKS = '0';
    // The primary is UNTRUSTED, so a forged `trusted` in the index is distinguishable.
    const col = await seeded('lex-ready', { contentTrust: 'untrusted' }); await query('lex-ready', col);
    const replacements = f.log.replacements;
    setLexicalIndex(f.client());
    expect((await query('lex-ready', col)).hits[0]?.documentId).toBe('d');
    expect(f.log.replacements).toBe(replacements);
    for (const row of f.rows.values()) row.metadata = { ...row.metadata, text: 'FORGED PRIVATE INDEX TEXT', contentTrust: 'trusted' };
    const result = await query('lex-ready', col);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.find(h => h.chunkId === 'd:0')?.text).toBe('Forklift pallet recertification safety manual.');
    expect(result.hits.map(h => h.contentTrust)).toEqual(result.hits.map(() => 'untrusted'));
    expect(JSON.stringify(result)).not.toContain('FORGED PRIVATE INDEX TEXT');
  });
  it('another replica invalidates readiness before publishing a new primary document', async () => {
    const f = sharedIndex(); setLexicalIndex(f.client()); process.env.OPENWOP_KB_LEXICAL_PERSIST_MIN_CHUNKS = '0';
    const col = await seeded('lex-new'); await query('lex-new', col);
    setLexicalIndex(f.client());
    const before = f.log.replacements;
    await ingestDocument('lex-new', 'o', 'u', col, { title: 'New', text: 'Zebracrane operating instructions.' }, { documentId: 'new' });
    expect((await query('lex-new', col, 'zebracrane')).hits.some(h => h.documentId === 'new')).toBe(true);
    // The hit alone can come from the dense channel; the invalidation's own
    // observable is that the other replica REBUILT before searching.
    expect(f.log.replacements).toBe(before + 1);
  });
  it('a document delete crossing a paused rebuild cannot resurrect its chunk text', async () => {
    const f = sharedIndex(); setLexicalIndex(f.client()); process.env.OPENWOP_KB_LEXICAL_PERSIST_MIN_CHUNKS = '0';
    const col = await seeded('lex-delete-race');
    f.onReplace(() => deleteDocument('lex-delete-race', 'o', col, 'd'));
    expect((await query('lex-delete-race', col)).hits).toEqual([]);
    expect([...f.rows.values()].some(r => r.metadata.documentId === 'd')).toBe(false);
  });
  it('a collection delete fences even the first rebuild before any index row existed', async () => {
    const f = sharedIndex(); setLexicalIndex(f.client()); process.env.OPENWOP_KB_LEXICAL_PERSIST_MIN_CHUNKS = '0';
    const col = await seeded('lex-col-race');
    f.onReplace(() => deleteCollection('lex-col-race', 'o', col));
    expect((await query('lex-col-race', col)).hits).toEqual([]);
    expect(f.rows.size).toBe(0);
    expect(f.owners.get(`lex-col-race|o/${col}`)?.retired).toBe(true);
  });
  it('an unavailable index read or publication retains a useful authoritative fallback', async () => {
    const f = sharedIndex(); setLexicalIndex(f.client()); process.env.OPENWOP_KB_LEXICAL_PERSIST_MIN_CHUNKS = '0';
    const col = await seeded('lex-down'); f.log.failReplace = true;
    const replacements = f.log.replacements;
    expect((await query('lex-down', col)).hits.some(h => h.documentId === 'd')).toBe(true);
    expect(f.log.replacements, 'the publication was attempted, and failed').toBe(replacements + 1);
    f.log.failReplace = false; await query('lex-down', col); f.log.failRead = true;
    const searches = f.log.searches;
    expect((await query('lex-down', col)).hits.some(h => h.documentId === 'd')).toBe(true);
    expect(f.log.searches, 'the index read was attempted, and failed').toBe(searches + 1);
  });
  it('an uncertain primary operation keeps the index unavailable to other replicas', async () => {
    const f = sharedIndex(); const a = f.client(); setLexicalIndex(a); process.env.OPENWOP_KB_LEXICAL_PERSIST_MIN_CHUNKS = '0';
    const col = await seeded('lex-pending'); await query('lex-pending', col);
    await a.beginMutation('lex-pending', `o/${col}`, `o/${col}`, 'uncertain');
    setLexicalIndex(f.client());
    const searches = f.log.searches;
    const replacements = f.log.replacements;
    expect((await query('lex-pending', col)).hits.some(h => h.documentId === 'd')).toBe(true);
    // The service never consults (or rebuilds) a pending index: it answers from
    // authoritative BM25. (The double would also refuse a pending owner — a second
    // guard — so the counters are the service's own observable.)
    expect(f.log.searches).toBe(searches);
    expect(f.log.replacements).toBe(replacements);
  });
  it('a failed lexical delete refuses completion and does not silently lose the primary', async () => {
    const f = sharedIndex(); setLexicalIndex(f.client()); const col = await seeded('lex-delete-fail'); f.log.failDelete = true;
    await expect(deleteDocument('lex-delete-fail', 'o', col, 'd')).rejects.toThrow('lexical delete unavailable');
    expect((await query('lex-delete-fail', col)).hits.some(h => h.documentId === 'd')).toBe(true);
  });
  it('maintenance deletes still reach a configured index after changing vector backends', async () => {
    const f = sharedIndex(); setLexicalIndex(f.client()); process.env.OPENWOP_KB_LEXICAL_PERSIST_MIN_CHUNKS = '0';
    const col = await seeded('lex-switched'); await query('lex-switched', col); expect(f.rows.size).toBeGreaterThan(0);
    setLexicalIndex(f.client(), false);
    await deleteDocument('lex-switched', 'o', col, 'd'); expect(f.rows.size).toBe(0);
  });
  it('does not consult or populate the persisted index below the size trigger', async () => {
    const f = sharedIndex(); setLexicalIndex(f.client()); process.env.OPENWOP_KB_LEXICAL_PERSIST_MIN_CHUNKS = '100000';
    const col = await seeded('lex-small'); expect((await query('lex-small', col)).hits.length).toBeGreaterThan(0);
    expect(f.log.searches).toBe(0); expect(f.log.replacements).toBe(0);
  });
});

describe('hybrid default and query input boundary', () => {
  it('uses the eval-selected hybrid default with the bounded fallback and explicit overrides', () => {
    expect(resolveRetrievalMode({ chunkCount: 10 })).toBe('hybrid');
    expect(resolveRetrievalMode({ chunkCount: HYBRID_DEFAULT_MAX_CHUNKS + 1 })).toBe('dense');
    setLexicalIndex(sharedIndex().client()); expect(resolveRetrievalMode({ chunkCount: HYBRID_DEFAULT_MAX_CHUNKS + 1 })).toBe('hybrid');
    expect(resolveRetrievalMode({ chunkCount: 10, retrievalConfig: { mode: 'dense' } })).toBe('dense');
    process.env.OPENWOP_KB_RETRIEVAL_MODE = 'dense'; expect(resolveRetrievalMode({ chunkCount: 10 })).toBe('dense');
  });
  it('accepts Unicode terms but no tsquery operators', () => {
    expect(lexicalQueryString(['café', 'pallet', 'pallet', 'x:*', 'a&b', '!'])).toBe('café | pallet');
    expect(lexicalQueryString([])).toBeNull();
  });
});
