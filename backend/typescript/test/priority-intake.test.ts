/**
 * PM intake + evidence + merge + promotion (ADR 0232) — ROUTE harness:
 *   - intake overlay upsert + read; validation (bad sourceChannel/value → 400)
 *   - evidence add/list/remove; url scheme guard
 *   - merge: overlays union onto the canonical, duplicate marked + moved wont-do
 *   - promote-to-project (PM side) + promote-to-initiative (strategy side, with
 *     the canonical priority-idea link + intake promotedTo stamp + done lane)
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, type Client } from './planningHarness.js';
import { buildPriorityMatrixSurface } from '../src/features/priority-matrix/surface.js';

/** The surface contract returns `Record<string, unknown>`; the JSON round-trip
 *  narrows it to the test's expected shape without a type assertion. */
function as<T>(v: unknown): T { return JSON.parse(JSON.stringify(v)); }

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  await enableToggle('priority-matrix', 'on');
  await enableToggle('strategy', 'on');
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);

const PM = '/v1/host/openwop-app/priority-matrix';
const S = '/v1/host/openwop-app/strategy';

async function setup(): Promise<{ c: ReturnType<typeof client>; orgId: string; tenantId: string; listId: string; cardA: string; cardB: string }> {
  const tenantId = `org:intake-${Date.now()}-${n++}`;
  const c = client();
  expect((await c.post('/v1/host/openwop-app/test/login', { email: `in-${Date.now()}-${n++}@acme.test`, tenantId })).status).toBe(201);
  const orgId = (await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  const listId = (await c.post(`${PM}/lists`, { orgId, name: 'Bets', presetId: 'weighted' })).body.id;
  await c.post(`${PM}/lists/${encodeURIComponent(listId)}/ideas`, { title: 'Expand to EU', description: 'The EU push' });
  await c.post(`${PM}/lists/${encodeURIComponent(listId)}/ideas`, { title: 'EU expansion (dupe)' });
  const ideas = (await c.get(`${PM}/lists/${encodeURIComponent(listId)}/ideas`)).body.ideas;
  const cardA = ideas.find((r: any) => r.card.title === 'Expand to EU').card.id;
  const cardB = ideas.find((r: any) => r.card.title === 'EU expansion (dupe)').card.id;
  return { c, orgId, tenantId, listId, cardA, cardB };
}

describe('idea intake + evidence (ADR 0232)', () => {
  it('upserts intake, validates, and manages evidence links', async () => {
    const { c, listId, cardA } = await setup();
    const up = await c.patch(`${PM}/lists/${listId}/ideas/${cardA}/intake`, { requester: 'dana@acme', sourceChannel: 'form', estimatedValue: 250000, estimatedValueUnit: 'USD' });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.estimatedValue).toBe(250000);
    expect((await c.patch(`${PM}/lists/${listId}/ideas/${cardA}/intake`, { sourceChannel: 'carrier-pigeon' })).status).toBe(400);
    expect((await c.patch(`${PM}/lists/${listId}/ideas/${cardA}/intake`, { estimatedValue: 'lots' })).status).toBe(400);

    const ev = await c.post(`${PM}/lists/${listId}/ideas/${cardA}/evidence`, { kind: 'url', ref: 'https://example.com/research', label: 'Market study' });
    expect(ev.status, JSON.stringify(ev.body)).toBe(201);
    expect((await c.post(`${PM}/lists/${listId}/ideas/${cardA}/evidence`, { kind: 'url', ref: 'javascript:alert(1)' })).status).toBe(400);

    const read = await c.get(`${PM}/lists/${listId}/ideas/${cardA}/intake`);
    expect(read.body.intake.requester).toBe('dana@acme');
    expect(read.body.evidence).toHaveLength(1);

    expect((await c.del(`${PM}/lists/${listId}/ideas/${cardA}/evidence/${ev.body.evidenceId}`)).status).toBe(204);
    expect((await c.get(`${PM}/lists/${listId}/ideas/${cardA}/intake`)).body.evidence).toHaveLength(0);
  });

  it('merges a duplicate: overlays union, duplicate marked + moved to wont-do', async () => {
    const { c, listId, cardA, cardB } = await setup();
    await c.patch(`${PM}/lists/${listId}/ideas/${cardB}/intake`, { requester: 'lee@acme', notes: 'from the dupe' });
    await c.post(`${PM}/lists/${listId}/ideas/${cardB}/evidence`, { kind: 'url', ref: 'https://example.com/dupe-evidence' });

    const merged = await c.post(`${PM}/lists/${listId}/ideas/${cardA}/merge`, { duplicateCardId: cardB });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect((await c.post(`${PM}/lists/${listId}/ideas/${cardA}/merge`, { duplicateCardId: cardA })).status).toBe(400);

    const canonical = await c.get(`${PM}/lists/${listId}/ideas/${cardA}/intake`);
    expect(canonical.body.intake.requester).toBe('lee@acme'); // unioned from the dupe
    expect(canonical.body.evidence).toHaveLength(1);          // evidence moved over
    const dupe = await c.get(`${PM}/lists/${listId}/ideas/${cardB}/intake`);
    expect(dupe.body.intake.mergedInto).toBe(cardA);
    const ideas = (await c.get(`${PM}/lists/${listId}/ideas`)).body.ideas;
    expect(ideas.find((r: any) => r.card.id === cardB).card.columnId).toBe('wont-do');
  });

  it('rejects a merge whose canonical or duplicate card is not on the list — no ghost overlay written (grade-code F1)', async () => {
    const { c, listId, cardA, cardB } = await setup();
    // A bogus CANONICAL card id: must 404 BEFORE any write, not write a ghost
    // overlay + re-key evidence onto a non-existent idea.
    const ghost = await c.post(`${PM}/lists/${listId}/ideas/not-a-real-card/merge`, { duplicateCardId: cardB });
    expect(ghost.status, JSON.stringify(ghost.body)).toBe(404);
    // The ghost canonical must have NO intake overlay (the write was refused).
    expect((await c.get(`${PM}/lists/${listId}/ideas/not-a-real-card/intake`)).body.intake).toBeNull();
    // A bogus DUPLICATE id is rejected the same way.
    expect((await c.post(`${PM}/lists/${listId}/ideas/${cardA}/merge`, { duplicateCardId: 'nope' })).status).toBe(404);
    // The real duplicate was never touched (still a live idea, not mergedInto).
    expect((await c.get(`${PM}/lists/${listId}/ideas/${cardB}/intake`)).body.intake).toBeNull();
  });
});

describe('promotion (ADR 0232 §5)', () => {
  it('promotes to a project (PM side): project created, intake stamped, card done', async () => {
    const { c, listId, cardA } = await setup();
    const r = await c.post(`${PM}/lists/${listId}/ideas/${cardA}/promote-to-project`);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.projectId).toBeTruthy();
    const intake = await c.get(`${PM}/lists/${listId}/ideas/${cardA}/intake`);
    expect(intake.body.intake.promotedTo).toEqual({ kind: 'project', id: r.body.projectId });
    const proj = await c.get(`/v1/host/openwop-app/projects/${r.body.projectId}`);
    expect(proj.status).toBe(200);
    expect(proj.body.name).toBe('Expand to EU');
  });

  it('promotes to an initiative (strategy side): initiative + link + stamp + done lane', async () => {
    const { c, orgId, listId, cardA } = await setup();
    const s = (await c.post(S, { orgId, title: 'Growth 2027', scope: 'org' })).body;
    const r = await c.post(`${S}/${s.id}/initiatives/from-idea`, { listId, cardId: cardA });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.initiativeId).toBeTruthy();
    expect(r.body.strategy.initiatives.map((i: any) => i.title)).toContain('Expand to EU');
    expect(r.body.strategy.links.some((l: any) => l.kind === 'priority-idea' && l.cardId === cardA)).toBe(true);
    const intake = await c.get(`${PM}/lists/${listId}/ideas/${cardA}/intake`);
    expect(intake.body.intake.promotedTo.kind).toBe('initiative');
    expect(intake.body.intake.promotedTo.strategyId).toBe(s.id);
    const ideas = (await c.get(`${PM}/lists/${listId}/ideas`)).body.ideas;
    expect(ideas.find((x: any) => x.card.id === cardA).card.columnId).toBe('done');
  });
});

describe('intake node verbs (ADR 0232 §7 / STRAT-PM1)', () => {
  it('get/update-intake + add-evidence run over the surface; NO promote verb exists', async () => {
    const { tenantId, listId, cardA } = await setup();
    const surface = buildPriorityMatrixSurface({ tenantId });

    // update-intake writes the same content class as submit-idea (actor = run).
    const up = as<{ intake: { requester?: string; estimatedValue?: number } | null }>(
      await surface.updateIntake({ listId, cardId: cardA, patch: { requester: 'analyst', estimatedValue: 90000 }, actor: 'run:x' }));
    expect(up.intake?.requester).toBe('analyst');
    expect(up.intake?.estimatedValue).toBe(90000);

    const ev = as<{ evidence: { kind: string; ref: string } | null }>(
      await surface.addEvidence({ listId, cardId: cardA, kind: 'url', ref: 'https://example.com/research', label: 'study' }));
    expect(ev.evidence?.kind).toBe('url');

    const got = as<{ intake: { requester?: string } | null; evidence: unknown[] }>(
      await surface.getIntake({ listId, cardId: cardA }));
    expect(got.intake?.requester).toBe('analyst');
    expect(got.evidence).toHaveLength(1);

    // The architect ruling: NO promote verb on the surface (authority-granting
    // action stays human/route-only).
    expect((surface as Record<string, unknown>).promoteIdea).toBeUndefined();
    expect((surface as Record<string, unknown>).promoteToProject).toBeUndefined();

    // code-review STRAT-PM1: the card-exists guard lives in the service, so a
    // run-driven write to a GHOST card fails closed (no orphaned overlay row).
    await expect(surface.updateIntake({ listId, cardId: 'ghost-card', patch: { requester: 'x' } }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(surface.addEvidence({ listId, cardId: 'ghost-card', kind: 'url', ref: 'https://e.com' }))
      .rejects.toMatchObject({ code: 'not_found' });
  });
});

/**
 * PMX-5 (ADR 0590) — evidence REFS and the forms-bridge submission id are
 * REFERENCE lanes, not free text: they must never ride the secret-shaped scrub
 * (`cleanString` replaced any bare `[A-Za-z0-9_-]{40,}` run — e.g. every
 * Google Docs/Drive id segment — with `[REDACTED:secret-shaped]`, corrupting
 * the pointer forever while the POST returned 201). Free-TEXT fields (label,
 * notes, requester) keep the scrub — that boundary is pinned below.
 */
describe('PMX-5 — reference lanes survive verbatim; free-text lanes stay scrubbed', () => {
  const DOC_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'; // 44-char drive-id shape

  it('a Google-Docs-style URL (≥40-char id segment) round-trips byte-identical', async () => {
    const { c, listId, cardA } = await setup();
    const ref = `https://docs.google.com/document/d/${DOC_ID}/edit`;
    const ev = await c.post(`${PM}/lists/${listId}/ideas/${cardA}/evidence`, { kind: 'url', ref });
    expect(ev.status, JSON.stringify(ev.body)).toBe(201);
    expect(ev.body.ref).toBe(ref);
    const read = await c.get(`${PM}/lists/${listId}/ideas/${cardA}/intake`);
    expect(read.body.evidence[0].ref).toBe(ref);
  });

  it('a document/kb evidence ref that is a long opaque id round-trips; a non-token ref is refused loudly', async () => {
    const { c, listId, cardA } = await setup();
    const docRef = `doc:${DOC_ID}`;
    const ev = await c.post(`${PM}/lists/${listId}/ideas/${cardA}/evidence`, { kind: 'document', ref: docRef });
    expect(ev.status, JSON.stringify(ev.body)).toBe(201);
    expect(ev.body.ref).toBe(docRef);
    // An id-lane value that is not token-shaped is a 400, never a silent mangle.
    expect((await c.post(`${PM}/lists/${listId}/ideas/${cardA}/evidence`, { kind: 'document', ref: 'doc id with spaces' })).status).toBe(400);
  });

  it('sourceSubmissionId (forms→intake provenance) round-trips through the intake patch', async () => {
    const { c, listId, cardA } = await setup();
    const sub = `sub:${DOC_ID}`;
    const up = await c.patch(`${PM}/lists/${listId}/ideas/${cardA}/intake`, { sourceSubmissionId: sub });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.sourceSubmissionId).toBe(sub);
    expect((await c.patch(`${PM}/lists/${listId}/ideas/${cardA}/intake`, { sourceSubmissionId: 'not a token!' })).status).toBe(400);
  });

  it('NEGATIVE CONTROL — free-text lanes (evidence label) still scrub a secret-shaped blob', async () => {
    const { c, listId, cardA } = await setup();
    const blob = 'A'.repeat(44); // secret-shaped: bare 40+-char run
    const ev = await c.post(`${PM}/lists/${listId}/ideas/${cardA}/evidence`, { kind: 'url', ref: 'https://example.com/x', label: `key ${blob} end` });
    expect(ev.status).toBe(201);
    expect(ev.body.label).toContain('[REDACTED:secret-shaped]');
    expect(ev.body.label).not.toContain(blob);
  });
});

/**
 * PMX-2 (ADR 0590) — the promote route resolves the completion lane BEFORE
 * minting, REPORTS the move outcome instead of swallowing a null move, and a
 * lost stamp race COMPENSATES the freshly-minted project (no orphan).
 */
describe('PMX-2 — promote reports its move + the double-promote window leaves no orphan project', () => {
  it('a promote lands the card in the resolved completion lane and says so', async () => {
    const { c, listId, cardA } = await setup();
    const res = await c.post(`${PM}/lists/${listId}/ideas/${cardA}/promote-to-project`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.moved).toBe(true);
    expect(res.body.movedToColumnId).toBe('done');
    const idea = (await c.get(`${PM}/lists/${listId}/ideas`)).body.ideas.find((r: any) => r.card.id === cardA);
    expect(idea.status.columnId).toBe('done');
    expect(idea.status.terminal).toBe(true);
  });

  it('two CONCURRENT promotes: exactly one 201, one 409, and exactly ONE project exists', async () => {
    const { c, orgId, listId, cardB } = await setup();
    const before = (await c.get(`/v1/host/openwop-app/projects?orgId=${encodeURIComponent(orgId)}`)).body.projects.length;
    const [r1, r2] = await Promise.all([
      c.post(`${PM}/lists/${listId}/ideas/${cardB}/promote-to-project`),
      c.post(`${PM}/lists/${listId}/ideas/${cardB}/promote-to-project`),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const after = (await c.get(`/v1/host/openwop-app/projects?orgId=${encodeURIComponent(orgId)}`)).body.projects.length;
    expect(after - before, 'the losing promote must compensate its minted project').toBe(1);
  });
});

/**
 * F1 + F2 (ADR 0590 correction note) — DETERMINISTIC compensation witnesses.
 *
 * The first "two concurrent promotes" witness was VACUOUS for the compensation
 * block: under memory:// storage the two route handlers never interleave
 * mid-request, so the loser 409s at `assertNotPromoted` BEFORE minting and the
 * one-project assertion held with the compensation deleted (sabotage-proved by
 * the adversarial review). These witnesses force the exact failure the
 * compensation exists for: `markPromoted`'s CAS loses (twice → the ADR 0590
 * double-CAS-loss 409) AFTER the target was minted, via a prototype spy that
 * fails the swap only for rows carrying `promotedTo`.
 */
describe('F1/F2 — a lost promote stamp AFTER minting compensates the target (deterministic)', () => {
  const failPromoteStamp = async (): Promise<{ restore: () => void }> => {
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const original = DurableCollection.prototype.compareAndSwap;
    const spy = vi.spyOn(DurableCollection.prototype, 'compareAndSwap').mockImplementation(
      async function (this: unknown, expected: unknown, next: unknown) {
        if (next && typeof next === 'object' && 'promotedTo' in (next as Record<string, unknown>)) return false;
        return original.call(this as never, expected as never, next as never);
      },
    );
    return { restore: () => spy.mockRestore() };
  };

  it('PM route: the freshly-minted PROJECT is deleted, the 409 surfaces, the idea stays unstamped', async () => {
    const { c, orgId, listId, cardA } = await setup();
    const before = (await c.get(`/v1/host/openwop-app/projects?orgId=${encodeURIComponent(orgId)}`)).body.projects.length;
    const { restore } = await failPromoteStamp();
    try {
      const r = await c.post(`${PM}/lists/${listId}/ideas/${cardA}/promote-to-project`);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
    } finally { restore(); }
    const after = (await c.get(`/v1/host/openwop-app/projects?orgId=${encodeURIComponent(orgId)}`)).body.projects.length;
    expect(after - before, 'the minted project must be compensated away').toBe(0);
    expect((await c.get(`${PM}/lists/${listId}/ideas/${cardA}/intake`)).body.intake?.promotedTo).toBeUndefined();
    // Recovery: with the fault gone the same promote succeeds.
    expect((await c.post(`${PM}/lists/${listId}/ideas/${cardA}/promote-to-project`)).status).toBe(201);
  });

  it('STRATEGY route (the F2 sibling): the initiative AND the link are compensated, the cap slot is returned', async () => {
    const { c, orgId, listId, cardA } = await setup();
    const s = (await c.post(S, { orgId, title: 'Growth 2027', scope: 'org' })).body;
    const { restore } = await failPromoteStamp();
    try {
      const r = await c.post(`${S}/${s.id}/initiatives/from-idea`, { listId, cardId: cardA });
      expect(r.status, JSON.stringify(r.body)).toBe(409);
    } finally { restore(); }
    const after = (await c.get(`${S}/${s.id}`)).body;
    expect(after.initiatives, 'the minted initiative must be compensated away').toHaveLength(0);
    expect(after.links.some((l: any) => l.kind === 'priority-idea' && l.cardId === cardA), 'the link must be compensated away').toBe(false);
    expect((await c.get(`${PM}/lists/${listId}/ideas/${cardA}/intake`)).body.intake?.promotedTo).toBeUndefined();
    // Recovery: the cap slot came back — the same promote now succeeds and reports its move.
    const ok = await c.post(`${S}/${s.id}/initiatives/from-idea`, { listId, cardId: cardA });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.moved).toBe(true);
    expect(ok.body.movedToColumnId).toBe('done');
  });
});

/**
 * F3 (ADR 0590 correction note) — the enumerate-the-class sweep found FIVE
 * pre-check-then-create cap sites (addPeer, createList, submitIdea, cloneIdea,
 * addIdeaEvidence); the review's probe drove cloneIdea to 1001/1000. All five
 * now carry the fail-closed post-write re-check. The mechanism is witnessed
 * end-to-end here at the EVIDENCE lane (cap 50 — the one cheap enough to seed
 * to its boundary); the clone lane shares the identical guard shape.
 */
describe('F3 — concurrent evidence adds cannot exceed the per-idea cap', () => {
  it('at cap−1, two concurrent adds never exceed 50 and converge to exactly the cap', async () => {
    const { tenantId, listId, cardA } = await setup();
    const { addIdeaEvidence, listIdeaEvidence } = await import('../src/features/priority-matrix/intake.js');
    const orgIdOf = (await import('../src/features/priority-matrix/priorityMatrixService.js')).getList;
    const list = await orgIdOf(tenantId, listId);
    const add = (i: number) => addIdeaEvidence({
      tenantId, orgId: list!.orgId, listId, cardId: cardA, actor: 'u-cap',
      kind: 'url', ref: `https://ev.example.test/${i}`,
    });
    for (let i = 0; i < 49; i++) await add(i);
    const results = await Promise.all([
      add(100).then(() => 'ok' as const, () => 'refused' as const),
      add(101).then(() => 'ok' as const, () => 'refused' as const),
    ]);
    expect(results).toContain('refused');
    expect((await listIdeaEvidence(listId, cardA)).length).toBeLessThanOrEqual(50);
    await add(102).catch(() => undefined);
    expect((await listIdeaEvidence(listId, cardA)).length).toBe(50);
  });
});
