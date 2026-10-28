/**
 * ADR 0120 Phase 2b + ADR 0587 (AGMEM-2 / AGMEM-13) — the extraction BINDING over the real
 * consent gate and the real note store.
 *
 * Guards: (1) no grant ⇒ no LLM call and no note (fail-closed at the binding, not only the op);
 * the run shape the lane accepts (ADR 0982 D1) comes from `helpers/personalChatRun.ts`;
 * (2) every fact the binding writes is `source:'auto-extract'` ⇒ `contentTrust:'untrusted'` at
 * all three read altitudes (durable projection, recall recency, RAG vector metadata), while a
 * user-typed note in the same scope stays trusted; (3) the legacy `[auto-extracted] ` prefix is
 * honoured as untrusted, and ONLY when present.
 *
 * Witnessed (wave 12 probes): `isGranted: async () => true` reds case 1; dropping
 * `{ source: 'auto-extract' }` in `extractionBinding.ts`, or the `contentTrust` derivation in
 * `addSubjectNote`, reds the AGMEM-2 cases; `const legacy = r.source === undefined` reds the
 * legacy ANTI-ROT case. The real `User.userId` key contract and the positive extraction path
 * live in `memory-extraction-grant-key.test.ts` (`BORN RED`).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces, writeMemoryEntry } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { setExtractionGrant } from '../src/features/memory-auto-extract/grantService.js';
import { extractConversationMemory } from '../src/features/memory-auto-extract/extractionBinding.js';
import {
  countSubjectNotes,
  listSubjectNotes,
  addSubjectNote,
  createSubjectMemoryPort,
  subjectMemoryScope,
  LEGACY_AUTO_EXTRACTED_PREFIX,
  NOTE_TAG,
} from '../src/host/subjectMemory.js';
import { personSubject } from '../src/host/subject.js';
import { personalChat } from './helpers/personalChatRun.js';
import type { ExtractorResult } from '../src/features/memory-auto-extract/memoryExtractor.js';

const facts = (...f: string[]) => async (): Promise<ExtractorResult> => ({ status: 'ok', facts: f.map((fact) => ({ fact, category: 'other' as const })), rejected: 0 });

const T = 'mxb-tenant';
beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-mxb-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

describe('extractConversationMemory', () => {
  it('FAIL-CLOSED: no grant ⇒ no LLM call, no note stored', async () => {
    const p = await personalChat('mxb-nogrant');
    const extract = vi.fn(facts('the user prefers dark mode'));
    const r = await extractConversationMemory(await p.run(), ['chat'], extract);
    expect(r).toEqual({ status: 'skipped', reason: 'no-consent' });
    expect(extract).not.toHaveBeenCalled();
    expect(await countSubjectNotes(p.home, personSubject(p.userId))).toBe(0);
  });
});

/**
 * AGMEM-2 / MEM-UX-3 (ADR 0587). The positive case that used to sit above (cut in wave 12, see
 * the note there) was named for the trust semantics and asserted only a COUNT — it passed over
 * the live prompt-injection path for the whole life of the defect (AGMEM-13). These assert the
 * semantics themselves, at
 * every altitude the label is read: the durable projection, the recall recency
 * projection, and the RAG/vector projection.
 */
describe('AGMEM-2 — auto-extracted facts are UNTRUSTED at every read altitude', () => {
  // ADR 0982 D1 — the lane writes only in the person's own tenant, keyed on the canonical id.
  let T2 = '';
  let subj = personSubject('unset');

  beforeAll(async () => {
    const p = await personalChat('mxb-trust');
    T2 = p.home;
    subj = personSubject(p.userId);
    await setExtractionGrant(p.home, p.userId, true, p.userId);
    await extractConversationMemory(await p.run(), ['transcript'], facts('the deploy token is rotated weekly'));
    // A fact the PERSON typed, in the same scope, for the discrimination arm.
    await addSubjectNote(p.home, subj, 'I prefer concise briefings');
  });

  it('the durable projection labels the model-authored fact untrusted + auto-extract', async () => {
    const notes = await listSubjectNotes(T2, subj);
    const auto = notes.find((n) => n.content.includes('deploy token'));
    const typed = notes.find((n) => n.content.includes('concise briefings'));
    expect(auto?.contentTrust).toBe('untrusted');
    expect(auto?.source).toBe('auto-extract');
    // ANTI-ROT: the fix must not degenerate into "everything is untrusted" — a
    // user-typed note in the SAME scope stays trusted and user-sourced.
    expect(typed?.contentTrust).toBe('trusted');
    expect(typed?.source).toBe('user');
  });

  it('provenance is DATA, not an English prefix glued into the content', async () => {
    const notes = await listSubjectNotes(T2, subj);
    // The scope holds exactly the auto-extracted fact + the typed note; without this the loop
    // below asserts nothing over an empty list.
    expect(notes).toHaveLength(2);
    for (const n of notes) expect(n.content.startsWith(LEGACY_AUTO_EXTRACTED_PREFIX)).toBe(false);
  });

  it('the recall port fences it — recency AND RAG both report untrusted', async () => {
    const port = createSubjectMemoryPort(T2);
    const scope = subjectMemoryScope(subj);
    const recency = await port.read(scope);
    const autoR = recency.find((e) => e.content.includes('deploy token'));
    const typedR = recency.find((e) => e.content.includes('concise briefings'));
    expect(autoR?.contentTrust).toBe('untrusted');
    expect(typedR?.contentTrust).toBe('trusted'); // anti-rot

    const rag = await port.read(scope, 'deploy token rotated');
    const autoV = rag.find((e) => e.content.includes('deploy token'));
    expect(autoV).toBeDefined();
    expect(autoV?.contentTrust).toBe('untrusted');
  });
});

/**
 * The AGMEM-2 BACKLOG. Rows written before this fix carry no tag, no field and no
 * metadata — only the English `[auto-extracted] ` prefix. This is a HEURISTIC read
 * and is deliberately fail-closed; it is NOT a backfill and cannot be complete.
 * See ADR 0587 § "The AGMEM-2 backlog".
 */
describe('AGMEM-2 backlog — the legacy prefix is honoured as untrusted (heuristic)', () => {
  const U = 'legacy-user';
  const subj = personSubject(U);

  it('a pre-fix `[auto-extracted] ` row reads untrusted on both projections', async () => {
    const scope = subjectMemoryScope(subj);
    // A row EXACTLY as the pre-ADR-0587 binding wrote it: the prefix glued into the
    // content, `contentTrust:'trusted'`, and NO `source` field. Written through the
    // same collection + key shape the module uses, because that is what a legacy row
    // literally is — there is no seam that produces one any more.
    const legacy = new DurableCollection<Record<string, unknown>>('subject-memory:note', (r) => String(r.key));
    const id = 'mem_legacy00001';
    await legacy.put({
      key: `${T}:${scope}:${id}`,
      id,
      tenantId: T,
      scope,
      content: `${LEGACY_AUTO_EXTRACTED_PREFIX}the user banks with Acme`,
      contentTrust: 'trusted',
      createdAt: new Date().toISOString(),
    });
    // …and its recall row, tagged exactly as the old path tagged it (no fence tag).
    await writeMemoryEntry(T, scope, {
      content: `${LEGACY_AUTO_EXTRACTED_PREFIX}the user banks with Acme`,
      tags: [NOTE_TAG, subj.id],
      id,
    });

    const notes = await listSubjectNotes(T, subj);
    expect(notes[0]?.contentTrust).toBe('untrusted');
    expect(notes[0]?.source).toBe('auto-extract');

    const port = createSubjectMemoryPort(T);
    const recency = await port.read(scope);
    expect(recency.find((e) => e.content.includes('Acme'))?.contentTrust).toBe('untrusted');
  });

  it('ANTI-ROT: a legacy row WITHOUT the prefix is still trusted (the heuristic is not "always deny")', async () => {
    const other = personSubject('legacy-user-2');
    const scope = subjectMemoryScope(other);
    const legacy = new DurableCollection<Record<string, unknown>>('subject-memory:note', (r) => String(r.key));
    const id = 'mem_legacy00002';
    await legacy.put({
      key: `${T}:${scope}:${id}`,
      id,
      tenantId: T,
      scope,
      content: 'a fact the person typed before the fix',
      contentTrust: 'trusted',
      createdAt: new Date().toISOString(),
    });
    const notes = await listSubjectNotes(T, other);
    expect(notes[0]?.contentTrust).toBe('trusted');
    expect(notes[0]?.source).toBe('user');
  });
});

/**
 * ADR 0982 D6 / architect A4 — two closes that learn the same fact concurrently converge on ONE
 * row. Each read the scope before the other wrote, so only the idempotency key stands between
 * them; a case-variant twin hits `addSubjectNote`'s 409, which the binding counts as a duplicate
 * instead of failing the close. Witnessed: rethrowing the `conflict` reds it.
 */
describe('ADR 0982 A4 — concurrent closes, one row', () => {
  it('"Keeps bees" and "keeps bees." racing each other store one note, and neither close fails', async () => {
    const p = await personalChat('mxb-race');
    await setExtractionGrant(p.home, p.userId, true, p.userId);
    const [a, b] = await Promise.all([
      extractConversationMemory(await p.run(), ['I keep bees'], facts('Keeps bees')),
      extractConversationMemory(await p.run(), ['I keep bees'], facts('keeps bees.')),
    ]);
    expect([a.status, b.status].sort()).toEqual(['nothing-new', 'written']);
    expect([a, b].find((o) => o.status === 'nothing-new')).toEqual({ status: 'nothing-new', duplicates: 1, suppressed: 0, budgetFull: false });
    expect(await listSubjectNotes(p.home, personSubject(p.userId))).toHaveLength(1);
  });
});
