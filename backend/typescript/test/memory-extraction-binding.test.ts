/**
 * ADR 0120 Phase 2b — extraction binding (real consent gate + real note store).
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

const T = 'mxb-tenant';
beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-mxb-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

describe('extractConversationMemory', () => {
  it('FAIL-CLOSED: no grant ⇒ no LLM call, no note stored', async () => {
    const extract = vi.fn(async () => ['the user prefers dark mode']);
    const r = await extractConversationMemory(T, 'nogrant-user', 'chat', extract);
    expect(r.skipped).toBe('no-consent');
    expect(extract).not.toHaveBeenCalled();
    expect(await countSubjectNotes(T, personSubject('nogrant-user'))).toBe(0);
  });

  it('with consent, extracts + stores notes on the user subject (auto-extracted)', async () => {
    // ADR 0666 D1 — the grant subject is the subject the binding is CALLED with, verbatim.
    // This fixture used to file it at `'user:alice'` while calling the binding with `'alice'`,
    // and it passed because the binding then re-prefixed — the very defect D1 fixed. It is kept
    // as a BARE-ID unit case (it exercises the extractor + note plumbing, not the key contract)
    // with the shapes now agreeing. NOTE: no production caller passes a bare id; every one
    // passes a `User.userId` (`user:<hash>`). The real id shape is pinned in
    // `memory-extraction-grant-key.test.ts`, which is why this suite could never see the defect.
    await setExtractionGrant(T, 'alice', true, 'alice');
    const r = await extractConversationMemory(T, 'alice', 'I work in Berlin and love cats', async () => ['lives in Berlin', 'likes cats']);
    expect(r.extracted).toBe(2);
    expect(await countSubjectNotes(T, personSubject('alice'))).toBe(2);
  });
});

/**
 * AGMEM-2 / MEM-UX-3 (ADR 0587). The test above is named for the trust semantics
 * and asserts only a COUNT — it passed over the live prompt-injection path for the
 * whole life of the defect (AGMEM-13). These assert the semantics themselves, at
 * every altitude the label is read: the durable projection, the recall recency
 * projection, and the RAG/vector projection.
 */
describe('AGMEM-2 — auto-extracted facts are UNTRUSTED at every read altitude', () => {
  const U = 'trust-user';
  const subj = personSubject(U);

  beforeAll(async () => {
    // ADR 0666 D1 — file it at the subject the binding is called with (see the note above).
    await setExtractionGrant(T, U, true, U);
    await extractConversationMemory(T, U, 'transcript', async () => ['the deploy token is rotated weekly']);
    // A fact the PERSON typed, in the same scope, for the discrimination arm.
    await addSubjectNote(T, subj, 'I prefer concise briefings');
  });

  it('the durable projection labels the model-authored fact untrusted + auto-extract', async () => {
    const notes = await listSubjectNotes(T, subj);
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
    const notes = await listSubjectNotes(T, subj);
    for (const n of notes) expect(n.content.startsWith(LEGACY_AUTO_EXTRACTED_PREFIX)).toBe(false);
  });

  it('the recall port fences it — recency AND RAG both report untrusted', async () => {
    const port = createSubjectMemoryPort(T);
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
