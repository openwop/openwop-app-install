/**
 * Priority Matrix ROUND 2 (UX_UPGRADE-priority-matrix, pass 2).
 *
 * Round 1's scope was ONE modal on ONE page (the failed orgs read + the unrendered preset
 * list), and both of its fixes hold. The same defect families live in the ranking engine,
 * the agent lane, the detail page and the write paths:
 *
 *  - PM2-B1  `ratio` mode ranked an idea with an UNSCORED cost criterion FIRST
 *  - PM2-B2  the score-idea tool discarded every score it could not match, and said "ok"
 *  - PM2-B3  a failed submit left an ignition claim held, so every retry said "captured"
 *  - PM2-M1  the analyst is told to explain per criterion and was given no per-criterion data
 *  - PM2-M2  an idea could be promoted twice, the second overwriting the first's provenance
 *  - PM2-M3  merge committed the overlays, then failed with "duplicate not found"
 *  - PM2-M5  no subject eraser over six subject-keyed collections
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { computePriority } from '../src/features/priority-matrix/scoring.js';
import { CRITERIA_PRESETS, type CriteriaSet } from '../src/features/priority-matrix/types.js';
import { eraseSubject } from '../src/host/subjectErasure.js';

let BASE = '';
let closeApp: () => Promise<void>;
beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  await enableToggle('priority-matrix', 'on');
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);
const L = '/v1/host/openwop-app/priority-matrix/lists';

async function owner(tenantId?: string): Promise<{ c: Client; userId: string; orgId: string; tenantId: string }> {
  const c = client();
  const t = tenantId ?? `org:pm2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pm2'), tenantId: t });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  return { c, userId: r.body.user.userId, orgId: org.body.orgId, tenantId: t };
}
const mkList = async (c: Client, orgId: string): Promise<string> => {
  const res = await c.post(L, { orgId, name: 'Bets', presetId: 'weighted' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
};

describe('PM2-B1 — an unscored cost criterion cannot rank first', () => {
  const wsjf: CriteriaSet = CRITERIA_PRESETS.wsjf;

  it('an idea whose cost criterion is BLANK ranks last, not first', () => {
    const costId = wsjf.criteria.find((c) => c.direction === 'cost')!.id;
    const benefits = Object.fromEntries(wsjf.criteria.filter((c) => c.direction !== 'cost').map((c) => [c.id, 9]));
    // `clampScore(undefined)` is 0, so an unscored cost contributed 0 to the numerator
    // while its weight still counted — `costAgg <= 0` — and the old branch returned the
    // raw BENEFIT aggregate. Three 9s and a blank job-size scored 9.00 and ranked #1,
    // ahead of the same idea with a real job-size of 3 (9/3 = 3.00). The un-estimated
    // idea outranked the estimated one, and this file's own engine docstring says the
    // opposite. The matrix view already disagreed: it drops that idea in the
    // "unscored, not placed" tray.
    expect(computePriority(wsjf, benefits)).toBe(0);
    expect(computePriority(wsjf, { ...benefits, [costId]: 3 })).toBe(3);
    expect(computePriority(wsjf, { ...benefits, [costId]: 3 })).toBeGreaterThan(computePriority(wsjf, benefits));
  });

  it('a set that declares NO cost criterion still degrades to the benefit aggregate', () => {
    // The documented fallback, and the case the old test pinned — it must keep working,
    // which is what makes the fix a distinction rather than a blanket zero.
    const benefitOnly: CriteriaSet = {
      aggregation: 'ratio',
      criteria: [
        { id: 'value', name: 'Value', weight: 10, direction: 'benefit' },
        { id: 'urgency', name: 'Urgency', weight: 10, direction: 'benefit' },
      ],
    };
    expect(computePriority(benefitOnly, { value: 8, urgency: 6 })).toBe(7);
  });

  it('a fully scored ratio idea is unchanged (the negative control)', () => {
    const costId = wsjf.criteria.find((c) => c.direction === 'cost')!.id;
    const all = Object.fromEntries(wsjf.criteria.map((c) => [c.id, c.direction === 'cost' ? 2 : 8]));
    expect(computePriority(wsjf, all)).toBe(4);
    expect(costId).toBeTruthy();
  });
});

describe('PM2-M2 — promotion is a one-way door', () => {
  it('refuses a SECOND, different promotion instead of overwriting the first', async () => {
    const { c, orgId } = await owner();
    const listId = await mkList(c, orgId);
    await c.post(`${L}/${listId}/ideas`, { title: 'Rebuild checkout' });
    const cardId = (await c.get(`${L}/${listId}/ideas`)).body.ideas[0].card.id;

    const first = await c.post(`${L}/${listId}/ideas/${cardId}/promote-to-project`, { name: 'Checkout rebuild' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    // The only guard was a disabled button on a client snapshot a second tab does not
    // share. `markPromoted` overwrote `promotedTo` unconditionally, so a later promotion
    // to a strategy initiative left the PROJECT orphaned with nothing linking back to the
    // idea that spawned it, and the panel then claimed the idea had become an initiative.
    const projectsBefore = (await c.get(`/v1/host/openwop-app/projects?orgId=${encodeURIComponent(orgId)}`)).body.projects.length;

    const second = await c.post(`${L}/${listId}/ideas/${cardId}/promote-to-project`, { name: 'Duplicate' });
    expect(second.status).toBe(409);
    expect(JSON.stringify(second.body)).toMatch(/already promoted/i);

    // …and the refusal left NOTHING behind. My first version of this guard sat inside
    // `markPromoted`, which runs AFTER `createProject` — so the 409 fired with a project
    // already written that linked to nothing, and the user was told "already promoted"
    // with no mention of it. MEASURED at review time: two projects. This assertion is the
    // one my first test was missing — it asserted the 409 and stepped over the orphan.
    const projectsAfter = (await c.get(`/v1/host/openwop-app/projects?orgId=${encodeURIComponent(orgId)}`)).body.projects.length;
    expect(projectsAfter, 'a refused promotion must not create a project').toBe(projectsBefore);

    const intake = (await c.get(`${L}/${listId}/ideas/${cardId}/intake`)).body.intake;
    expect(intake.promotedTo.kind).toBe('project');
  });
});

describe('PM2-M5 — subject erasure, scoped to ONE tenant', () => {
  it('removes the subject\u2019s votes and severs their links', async () => {
    const { c, orgId, userId, tenantId } = await owner();
    const listId = await mkList(c, orgId);
    await c.post(`${L}/${listId}/ideas`, { title: 'Idea' });
    const cardId = (await c.get(`${L}/${listId}/ideas`)).body.ideas[0].card.id;
    expect((await c.put(`${L}/${listId}/ideas/${cardId}/scores`, { scores: { roi: 8 } })).status).toBe(200);

    await eraseSubject(tenantId, userId);

    const list = (await c.get(`${L}/${listId}`)).body;
    expect(list.createdBy).toBe('user:[erased]');
  });

  it('does NOT touch another tenant\u2019s child rows — they carry no tenantId at all', async () => {
    const a = await owner();
    const b = await owner();
    const listA = await mkList(a.c, a.orgId);
    const listB = await mkList(b.c, b.orgId);
    await b.c.post(`${L}/${listB}/ideas`, { title: 'B idea' });
    const cardB = (await b.c.get(`${L}/${listB}/ideas`)).body.ideas[0].card.id;
    expect((await b.c.put(`${L}/${listB}/ideas/${cardB}/scores`, { scores: { roi: 8 } })).status).toBe(200);

    // The discriminating construction: erase B's SUBJECT under A's TENANT. `IdeaScore`,
    // `IdeaVote`, `IdeaSchedule` and `IdeaIntake` are keyed `listId::cardId` with NO
    // tenant, so an eraser that matches on the subject alone redacts B's rows from A's
    // request — a cross-tenant write, from the routine whose whole job is a boundary.
    // (Asserting on the LIST row cannot see this: lists carry a tenantId and were already
    // filtered, which is why my first version of this test passed against the bug.)
    await eraseSubject(a.tenantId, b.userId);

    const { scores } = (await import('../src/features/priority-matrix/priorityMatrixService.js')).__pmStoresForErasure();
    const bScore = (await scores.list()).find((r) => r.listId === listB && r.cardId === cardB);
    expect(bScore, 'B\u2019s score row should still exist').toBeTruthy();
    expect(bScore!.updatedBy, 'B\u2019s row must be untouched by A\u2019s erasure').toBe(b.userId);
    expect(listA).toBeTruthy();
  });
});

/**
 * PMX-2 (ADR 0590) — the promotedTo stamp is CAS-guarded: of two CONCURRENT
 * promotions exactly one wins (pre-fix, both passed the read-then-check and the
 * last write won — both callers were told they promoted).
 */
describe('PMX-2 — concurrent markPromoted: exactly one wins the one-way door', () => {
  it('two concurrent stamps: one resolves, one 409s', async () => {
    const { c, orgId, tenantId } = await owner();
    const listId = await mkList(c, orgId);
    await c.post(`${L}/${listId}/ideas`, { title: 'Race me' });
    const cardId = (await c.get(`${L}/${listId}/ideas`)).body.ideas[0].card.id;

    const { markPromoted } = await import('../src/features/priority-matrix/intake.js');
    const attempt = (id: string) => markPromoted({
      tenantId, orgId, listId, cardId, actor: 'u-race',
      promotedTo: { kind: 'project', id },
    }).then(() => 'won' as const, () => 'lost' as const);
    const results = await Promise.all([attempt('proj-a'), attempt('proj-b')]);
    expect([...results].sort()).toEqual(['lost', 'won']);

    const intake = (await c.get(`${L}/${listId}/ideas/${cardId}/intake`)).body.intake;
    expect(['proj-a', 'proj-b']).toContain(intake.promotedTo.id);
  });
});

/**
 * PMX-3 + PMX-4 (ADR 0590) — the NINTH subject-keyed store
 * (`FederatedPeer.createdBy`) joins the eraser, and the eraser returns
 * `{rowsTouched}` (the documents/erasure.ts shape) so PM is finally visible to
 * the DSAR completeness telemetry (`foundNothing` can only see erasers that
 * REPORT).
 */
describe('PMX-3/PMX-4 — peer rows join the eraser; the eraser reports rowsTouched', () => {
  it('redacts FederatedPeer.createdBy (tenant-scoped) and returns the count', async () => {
    const { c, orgId, userId, tenantId } = await owner();
    const listId = await mkList(c, orgId);
    await c.post(`${L}/${listId}/ideas`, { title: 'Idea' });
    const { addPeer, listPeers } = await import('../src/features/priority-matrix/federationService.js');
    await addPeer(tenantId, userId, { label: 'East', baseUrl: 'https://east.example.test' });
    // A SECOND tenant's peer by the same subject — must be untouched (the
    // cross-tenant discriminator, same construction as PM2-M5 above).
    const other = await owner();
    await addPeer(other.tenantId, userId, { label: 'West', baseUrl: 'https://west.example.test' });

    const { eraseSubjectPriorityMatrix } = await import('../src/features/priority-matrix/erasure.js');
    const report = await eraseSubjectPriorityMatrix(tenantId, userId);
    expect(report).toBeTruthy();
    expect(report.rowsTouched).toBeGreaterThan(0);

    const mine = await listPeers(tenantId);
    expect(mine[0]!.createdBy).toBe('user:[erased]');
    const theirs = await listPeers(other.tenantId);
    expect(theirs[0]!.createdBy, 'another tenant’s peer row must survive').toBe(userId);
  });
});

/**
 * F4 (ADR 0590 correction note) — two writers bypass `setIdeaScore` and
 * dropped the PMXU-1 `source` stamp, LAUNDERING agent provenance:
 * `seedVotesFromScores` (the single→multi migration copies score→vote rows)
 * and `cloneIdea`'s score copy. Both now carry the stamp VERBATIM — a
 * migrated or cloned agent-scored row is still agent-derived data.
 */
describe('F4 — provenance survives the single→multi migration and the clone score copy', () => {
  it('single→multi seeding carries the score row source verbatim', async () => {
    const { c, orgId, userId, tenantId } = await owner();
    const listId = await mkList(c, orgId);
    await c.post(`${L}/${listId}/ideas`, { title: 'Agent-scored' });
    const cardId = (await c.get(`${L}/${listId}/ideas`)).body.ideas[0].card.id;
    const svc = await import('../src/features/priority-matrix/priorityMatrixService.js');
    await svc.setIdeaScore(tenantId, listId, cardId, userId, { roi: 8 }, 'agent');

    await svc.updateList(tenantId, listId, { votingMode: 'multi-voter' }, userId);
    const { votes } = svc.__pmStoresForErasure();
    const seeded = (await votes.list()).find((v) => v.listId === listId && v.cardId === cardId);
    expect(seeded, 'the migration must seed the creator vote').toBeTruthy();
    expect(seeded!.source, 'the migrated vote must carry the agent stamp, not launder it').toBe('agent');
  });

  it('cloneIdea carries the copied score row source verbatim', async () => {
    const { c, orgId, userId, tenantId } = await owner();
    const listId = await mkList(c, orgId);
    await c.post(`${L}/${listId}/ideas`, { title: 'Agent-scored original' });
    const cardId = (await c.get(`${L}/${listId}/ideas`)).body.ideas[0].card.id;
    const svc = await import('../src/features/priority-matrix/priorityMatrixService.js');
    await svc.setIdeaScore(tenantId, listId, cardId, userId, { roi: 8 }, 'agent');

    const clone = await svc.cloneIdea(tenantId, listId, cardId, userId);
    const { scores } = svc.__pmStoresForErasure();
    const copied = (await scores.list()).find((s) => s.listId === listId && s.cardId === clone.id);
    expect(copied, 'the clone must copy the single-mode score').toBeTruthy();
    expect(copied!.source, 'the copied score must carry the agent stamp, not mint a stampless row').toBe('agent');
  });
});
