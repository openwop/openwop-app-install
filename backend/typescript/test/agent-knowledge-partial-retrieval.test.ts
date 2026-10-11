/**
 * KB-UX-3 / ADR 0583 — a swallowed per-source fault must be REPORTED, not
 * silently rendered as an empty corpus.
 *
 * `resolveSubjectKnowledgeRetrieve` / `resolveAgentKnowledgeRetrieve` catch a KB
 * backend or memory-port fault and contribute nothing. That is right for a LIVE
 * AGENT TURN — a knowledge fault must not fail the run — and it is exactly wrong
 * for the three human-facing retrieval PREVIEWS, which turned the swallowed
 * error into `{chunks: [], hasResults: false}` at HTTP 200. `hasResults:false`
 * is the SAME value an empty corpus produces, so the SPA had no way to tell
 * them apart and all three panels rendered an internal error as the confident
 * "No matches". The `.catch` in each panel was unreachable for the entire class.
 *
 * The retriever now takes an optional `onSourceError` sink. Dispatch and chat
 * still call `retrieve(query)` and are unchanged; the previews pass the sink and
 * surface `failedSources`. These tests pin BOTH halves — that a fault is
 * reported, and that a healthy-but-empty retrieval reports NOTHING, because an
 * over-eager flag would be the same defect with the opposite sign.
 *
 * Sabotage that turns this red (grade-tests w11 probes): dropping the KB catch's or the
 * memory catch's `onSourceError` (THROWS / MEMORY / BOTH / node lane); not reporting an
 * ABSENT backend (NO backend); reporting absence for a memory-only binding; reporting `kb`
 * whenever a backend exists (both HEALTHY arms + PER CALL + node-lane healthy); capturing the
 * backend at resolve time (PER CALL); calling the sink non-optionally (OPTIONAL); dropping
 * `failedSources` from `surface.ts` (both node-lane cases).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveSubjectKnowledgeRetrieve } from '../src/host/agentKnowledgeComposition.js';
import { setKnowledgeBackend, type KnowledgeBackend, type KnowledgeResult, type KnowledgeResultChunk } from '../src/host/knowledgeSurface.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { upsertAgentProfile } from '../src/host/agentProfileService.js';
import { buildAgentKnowledgeSurface } from '../src/features/agent-knowledge/surface.js';
import type { AgentMemoryPort } from '../src/host/agentDispatch.js';

const TENANT = 'org:kb-partial';
const TENANT_SURFACE = 'org:kb-partial-surface';
const BINDING = { collectionIds: ['c1'] };

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kb-partial-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

/** A real, knowledge-capable agent profile with a KB collection bound — what
 *  `retrieveForAgent` (and so the workflow surface) needs to resolve at all. */
let seeded = 0;
async function seedBoundAgent(): Promise<string> {
  const agentId = `agent-kb-${seeded++}`;
  await upsertAgentProfile(TENANT_SURFACE, agentId, {
    roleKey: 'kb-agent',
    autonomy: { specLevel: 'recommend' },
    capabilities: ['knowledge'],
    knowledge: { collectionIds: ['c1'] },
  });
  return agentId;
}

function memoryPort(over: Partial<AgentMemoryPort> = {}): AgentMemoryPort {
  return {
    read: async () => [],
    write: async () => undefined,
    ...over,
  };
}

/** Production-shaped KB fixtures (`KnowledgeBackend` has ONE method; the result chunks are
 *  full `KnowledgeResultChunk`s, so no cast hides a missing field). */
const backend = (retrieve: KnowledgeBackend['retrieve']): KnowledgeBackend => ({ retrieve });
const result = (chunks: KnowledgeResultChunk[]): KnowledgeResult => ({ chunks, sources: [], latencyMs: chunks.length ? 1 : 0, hasResults: chunks.length > 0 });
const EMPTY = (): Promise<KnowledgeResult> => Promise.resolve(result([]));
const THROWS = (msg: string) => async (): Promise<KnowledgeResult> => { throw new Error(msg); };
const chunk = (content: string, documentTitle: string): KnowledgeResultChunk => ({
  chunkId: `${documentTitle}-1`, content, headingPath: [], pageNumber: null, documentTitle,
  assetId: 'd1', collectionId: 'c1', relevanceScore: 1, contentTrust: 'trusted',
});

/** Collect what the retriever reports, the way the preview services do. */
async function retrieveWithReport(
  memory: AgentMemoryPort,
): Promise<{ chunks: number; failedSources: string[] }> {
  const retrieve = resolveSubjectKnowledgeRetrieve(TENANT, BINDING, memory, 'user:u1');
  expect(retrieve, 'the binding must resolve a retriever').toBeTruthy();
  const failedSources: string[] = [];
  const out = await retrieve!('anything', (s) => { if (!failedSources.includes(s)) failedSources.push(s); });
  return { chunks: out.length, failedSources };
}

afterEach(() => { setKnowledgeBackend(null); });
beforeEach(() => { setKnowledgeBackend(null); });

describe('KB-UX-3 — a faulted retrieval source is reported', () => {
  it('a KB backend that THROWS is reported as a failed source, not as an empty corpus', async () => {
    setKnowledgeBackend(backend(THROWS('vector store unavailable')));

    const { chunks, failedSources } = await retrieveWithReport(memoryPort());

    // The run still survives — that property is deliberate and must not regress.
    expect(chunks).toBe(0);
    // …and the caller can now tell WHY it is empty.
    expect(failedSources).toEqual(['kb']);
  });

  it('a MEMORY port that throws is reported the same way', async () => {
    setKnowledgeBackend(backend(EMPTY));

    const { chunks, failedSources } = await retrieveWithReport(
      memoryPort({ read: async () => { throw new Error('memory store unavailable'); } }),
    );

    expect(chunks).toBe(0);
    expect(failedSources).toEqual(['memory']);
  });

  it('BOTH faulting reports both — the sink is per-source, not a single boolean', async () => {
    setKnowledgeBackend(backend(THROWS('down')));

    const { failedSources } = await retrieveWithReport(
      memoryPort({ read: async () => { throw new Error('down'); } }),
    );

    expect(failedSources.sort()).toEqual(['kb', 'memory']);
  });

  it('a HEALTHY but genuinely empty retrieval reports NOTHING (the other polarity)', async () => {
    // Without this arm, a fix that reported "failed" unconditionally would pass
    // every assertion above while making "no matches" unreachable — the same
    // defect with the sign flipped.
    setKnowledgeBackend(backend(EMPTY));

    const { chunks, failedSources } = await retrieveWithReport(memoryPort());

    expect(chunks).toBe(0);
    expect(failedSources).toEqual([]);
  });

  it('a HEALTHY non-empty retrieval reports nothing and still returns its chunks', async () => {
    setKnowledgeBackend(backend(async () => result([chunk('a policy passage', 'PTO Policy')])));

    const { chunks, failedSources } = await retrieveWithReport(memoryPort());

    expect(chunks).toBe(1);
    expect(failedSources).toEqual([]);
  });

  /**
   * L6 — the ABSENT backend, which the first cut of this fix left uncovered.
   *
   * The KB leg was `if (wantKb && backend)`, so when NO backend resolved the
   * whole leg was skipped: `onSourceError('kb')` never fired and a binding that
   * names collections reported the same `{chunks:[], hasResults:false}` an empty
   * corpus produces — the exact class the sink was added to close, surviving on
   * the path the sink did not reach. Only the THROW path was covered above.
   */
  it('NO backend at all is reported as a failed source — a never-searched corpus is not an empty one', async () => {
    setKnowledgeBackend(null);

    const { chunks, failedSources } = await retrieveWithReport(memoryPort());

    expect(chunks).toBe(0);
    expect(failedSources).toEqual(['kb']);
  });

  it('a binding that does NOT want kb reports nothing when no backend resolves', async () => {
    // The opposite polarity for L6: absence is only a fault for a binding that
    // actually asked for the KB. A `sources:['memory']` binding must not be told
    // its KB failed — it never had one.
    setKnowledgeBackend(null);
    const retrieve = resolveSubjectKnowledgeRetrieve(
      TENANT, { collectionIds: [], retrieval: { sources: ['memory'] } }, memoryPort(), 'user:u1',
    );
    expect(retrieve).toBeTruthy();
    const failedSources: string[] = [];
    await retrieve!('anything', (s) => failedSources.push(s));
    expect(failedSources).toEqual([]);
  });

  it('the backend is read PER CALL, not captured at resolve time', async () => {
    // Same line, second defect: `getKnowledgeBackend()` was read outside the
    // closure, so a retriever built before the backend registered stayed
    // permanently backendless for its entire lifetime.
    setKnowledgeBackend(null);
    const retrieve = resolveSubjectKnowledgeRetrieve(TENANT, BINDING, memoryPort(), 'user:u1');
    expect(retrieve).toBeTruthy();

    setKnowledgeBackend(backend(async () => result([chunk('late-bound passage', 'D')])));

    const failedSources: string[] = [];
    const out = await retrieve!('anything', (s) => failedSources.push(s));
    expect(out).toHaveLength(1);
    expect(failedSources).toEqual([]);
  });

  it('the sink is OPTIONAL — dispatch/chat still call retrieve(query) and a fault stays swallowed', async () => {
    // The live-turn contract this composition exists to protect. If passing no
    // sink ever threw, every agent turn would fail on a KB blip.
    setKnowledgeBackend(backend(THROWS('down')));
    const retrieve = resolveSubjectKnowledgeRetrieve(TENANT, BINDING, memoryPort(), 'user:u1');
    await expect(retrieve!('anything')).resolves.toEqual([]);
  });
});

/**
 * L7 — the WORKFLOW-NODE / agent-tool lane, which the first cut of this fix left
 * lying.
 *
 * `retrieveForAgent` returns `failedSources`; the two REST previews render it.
 * `features/agent-knowledge/surface.ts` — the `ctx.features.agentKnowledge` a
 * workflow node calls — projected only `{chunks, hasResults}` and DROPPED it. So
 * on the one lane whose consumer is usually a MODEL, a faulted KB backend still
 * arrived as `hasResults:false`: indistinguishable from an empty corpus, and the
 * model then confidently answers "there is nothing in your knowledge base".
 */
describe('KB-UX-3 / L7 — the workflow-node surface projects failedSources', () => {
  it('a faulted backend reaches the node as a failed SOURCE, not as an empty corpus', async () => {
    setKnowledgeBackend(backend(THROWS('vector store unavailable')));
    const agentId = await seedBoundAgent();

    const surface = buildAgentKnowledgeSurface({ tenantId: TENANT_SURFACE, runId: 'run:1' });
    const out = await surface.retrieve!({ agentId, query: 'anything' }) as {
      chunks: unknown[]; hasResults: boolean; failedSources: string[];
    };

    expect(out.hasResults).toBe(false);
    expect(out.failedSources, 'the node lane must be told WHY it is empty').toEqual(['kb']);
  });

  it('a healthy empty retrieval still reports NO failed sources on the node lane', async () => {
    setKnowledgeBackend(backend(EMPTY));
    const agentId = await seedBoundAgent();

    const surface = buildAgentKnowledgeSurface({ tenantId: TENANT_SURFACE, runId: 'run:2' });
    const out = await surface.retrieve!({ agentId, query: 'anything' }) as {
      hasResults: boolean; failedSources: string[];
    };

    expect(out.hasResults).toBe(false);
    expect(out.failedSources).toEqual([]);
  });
});
