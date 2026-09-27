/**
 * ADR 0597 — strategy cross-org isolation. Three Blockers, one file, because
 * they are ONE mistake at three seams: a gate that was written on the door that
 * got audited and not on its siblings.
 *
 *   SPC-2  `GET /strategy/:id/timeline` gated a priority link on EXISTENCE
 *          while the canonical resolver required `readable(list.orgId)`, so the
 *          timeline leaked org-B idea titles / target dates / schedule states
 *          to an org-A-only reader — and `/:id/context` over the SAME links
 *          correctly withheld them.
 *   SPC-3  `POST /:id/initiatives/from-idea` gated the target board on
 *          `workspace:read` and then performed TWO writes on it (the intake
 *          stamp + the completion-lane move). Priority Matrix's own mirror
 *          routes require `workspace:write` for exactly those operations.
 *   SPC-4  `PATCH /strategy/:id {orgId}` checked authority in the OLD org only.
 *          Creation is gated on the destination; relocation was not — and the
 *          strategy landed in the target org's AI knowledge base as
 *          `contentTrust:'trusted'`.
 *
 * Every case carries a MATCHED POSITIVE CONTROL. A cross-org assertion that
 * only ever checks for absence passes just as happily against a projection that
 * returns nothing at all, and that is how a gate ends up looking enforced while
 * the feature is broken.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as strategyService from '../src/features/strategy/strategyService.js';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  // The de-facto-owner bypass in `resolveEffectiveAccess` hands OWNER scopes to
  // any subject with NO member row at all. It would make every refusal below
  // pass vacuously — as an owner.
  delete process.env.OPENWOP_DEMO_MODE;
  await enableToggle('strategy', 'on');
  await enableToggle('priority-matrix', 'on');
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);
const S = '/v1/host/openwop-app/strategy';
const PM = '/v1/host/openwop-app/priority-matrix';

const mkOrg = (c: Client, name: string) => c.post('/v1/host/openwop-app/orgs', { name });
const addMember = (owner: Client, orgId: string, subject: string, roles: string[]) =>
  owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject, roles });

async function signup(c: Client, tenantId: string): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('xorg'), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

/**
 * One tenant, two orgs. `owner` holds scope in both (they created both);
 * `member` is an editor in org A ONLY. That asymmetry is the whole fixture:
 * every finding here is about which org gets checked, never about whether the
 * check itself works.
 */
async function twoOrgTenant(): Promise<{ owner: Client; member: Client; memberId: string; ownerId: string; tenantId: string; orgA: string; orgB: string }> {
  const tenantId = `org:xorg-${Date.now()}-${n++}`;
  const owner = client(); const ownerUser = await signup(owner, tenantId);
  const member = client(); const memberUser = await signup(member, tenantId);
  const orgA = (await mkOrg(owner, 'Alpha')).body.orgId;
  const orgB = (await mkOrg(owner, 'Bravo')).body.orgId;
  await addMember(owner, orgA, memberUser.userId, ['editor']);
  return { owner, member, memberId: memberUser.userId, ownerId: ownerUser.userId, tenantId, orgA, orgB };
}

/** A priority list with one scheduled idea, owned by `orgId`. */
async function scheduledIdea(owner: Client, orgId: string, listName: string, ideaTitle: string): Promise<{ listId: string; cardId: string }> {
  const listId = (await owner.post(`${PM}/lists`, { orgId, name: listName, presetId: 'weighted' })).body.id;
  expect(listId, `list create failed for ${listName}`).toBeTruthy();
  await owner.post(`${PM}/lists/${listId}/ideas`, { title: ideaTitle });
  const cardId = (await owner.get(`${PM}/lists/${listId}/ideas`)).body.ideas[0].card.id;
  const sched = await owner.put(`${PM}/lists/${listId}/ideas/${cardId}/schedule`, { targetDate: '2031-03-01' });
  expect(sched.status, JSON.stringify(sched.body)).toBe(200);
  return { listId, cardId };
}

interface TlItem { kind: string; title: string; source: { listId?: string } }

describe('SPC-2 — /timeline must not out-read /context', () => {
  it('withholds a priority link whose org the caller cannot read, and keeps the one it can', async () => {
    const { owner, member, orgA, orgB } = await twoOrgTenant();
    const near = await scheduledIdea(owner, orgA, 'A-bets', 'Readable idea');
    const far = await scheduledIdea(owner, orgB, 'B-bets', 'Org-B secret idea');

    // Workspace scope so the MEMBER can read the strategy itself — the leak is
    // about the LINK TARGETS, not the strategy. The owner may link both
    // (`requireLinkTargetReadable` checks the LINKER's read, not the reader's).
    const s = (await owner.post(S, { orgId: orgA, title: 'Portfolio', scope: 'workspace' })).body;
    const links = await owner.put(`${S}/${s.id}/links`, {
      links: [
        { kind: 'priority-idea', listId: near.listId, cardId: near.cardId },
        { kind: 'priority-idea', listId: far.listId, cardId: far.cardId },
      ],
    });
    expect(links.status, JSON.stringify(links.body)).toBe(200);

    // The OWNER sees both — the positive control that proves the projection works.
    const ownerTl = await owner.get(`${S}/${s.id}/timeline`);
    expect(ownerTl.status, JSON.stringify(ownerTl.body)).toBe(200);
    const ownerTitles = (ownerTl.body.items as TlItem[]).map((i) => i.title);
    expect(ownerTitles).toContain('Readable idea');
    expect(ownerTitles).toContain('Org-B secret idea');

    // The MEMBER sees only org A's. Both halves matter: the absence is the
    // fix, the presence is what stops the absence being vacuous.
    const tl = await member.get(`${S}/${s.id}/timeline`);
    expect(tl.status, JSON.stringify(tl.body)).toBe(200);
    const titles = (tl.body.items as TlItem[]).map((i) => i.title);
    expect(titles, 'org-A link must still project').toContain('Readable idea');
    expect(titles, 'org-B idea title/targetDate/state leaked across orgs').not.toContain('Org-B secret idea');

    // The PORTFOLIO route fans the same projection across everything readable.
    const port = await member.get(`${S}/timeline`);
    expect(port.status).toBe(200);
    expect((port.body.items as TlItem[]).map((i) => i.title)).not.toContain('Org-B secret idea');

    // …and /context, the lane that was ALREADY right, still agrees with it.
    const ctx = await member.get(`${S}/${s.id}/context`);
    expect(ctx.status).toBe(200);
    const linked = (ctx.body.strategy.linkedPriorities as Array<{ listId: string }>).map((p) => p.listId);
    expect(linked).toContain(near.listId);
    expect(linked).not.toContain(far.listId);
  });
});

/**
 * ADR 0597 §Correction 1 (HIGH-1) — the SIXTH reader, the one §2's lane table
 * waved through. `surface.ts` passed `async () => true` for the org predicate on
 * BOTH `getStrategyContext` and `getHealth`, and the ADR justified it with
 * *"a run has no acting human to scope to."* That premise is false:
 * `executor.ts` stamps `run.metadata.actingUserId` onto the `BundleScope`
 * (`inMemorySurfaces.ts` documents it as present for human runs and ABSENT for
 * system runs — the fail-closed signal), and this feature's OWN `agentTools.ts`
 * already keys on it. Two lanes of one feature disagreeing is the identical
 * shape SPC-2 closed one file away.
 *
 * The fallback is load-bearing and stays: a cadence fire registers no
 * `metadata.actingUserId`, so a scheduled digest is genuinely subjectless and
 * MUST still see the tenant's shared data (the `listPortfolio` precedent). Both
 * halves are witnessed below — the narrowing AND the fallback — because a
 * narrowing whose fallback nobody checked is how a digest silently goes empty.
 */
describe('ADR 0597 §Correction 1 — the run/agent surface scopes to the run\'s acting human when it has one', () => {
  async function linkedAcrossOrgs() {
    const t = await twoOrgTenant();
    const near = await scheduledIdea(t.owner, t.orgA, 'A-bets-surf', 'Readable idea');
    const far = await scheduledIdea(t.owner, t.orgB, 'B-bets-surf', 'Org-B secret idea');
    const s = (await t.owner.post(S, { orgId: t.orgA, title: 'Surface portfolio', scope: 'workspace' })).body;
    const links = await t.owner.put(`${S}/${s.id}/links`, {
      links: [
        { kind: 'priority-idea', listId: near.listId, cardId: near.cardId },
        { kind: 'priority-idea', listId: far.listId, cardId: far.cardId },
      ],
    });
    expect(links.status, JSON.stringify(links.body)).toBe(200);
    return { ...t, near, far, strategyId: s.id as string };
  }

  interface CtxOut { strategies: Array<{ id: string; linkedPriorities: Array<{ listId: string; title?: string }> }> }
  interface HealthOut { strategies: Array<{ id: string; signals?: { linkedPriorityCount?: number } }> }
  const as = <T>(v: unknown): T => JSON.parse(JSON.stringify(v)) as T;

  it('getStrategyContext withholds an org the RUN OWNER cannot read, and still projects the one they can', async () => {
    const { tenantId, memberId, near, far, strategyId } = await linkedAcrossOrgs();
    const { buildStrategySurface } = await import('../src/features/strategy/surface.js');

    const surface = buildStrategySurface({ tenantId, actingUserId: memberId });
    const out = as<CtxOut>(await surface.getStrategyContext({ priorityListId: near.listId }));
    const entry = out.strategies.find((e) => e.id === strategyId);
    expect(entry, 'the strategy itself must still resolve').toBeTruthy();
    const listIds = entry!.linkedPriorities.map((p) => p.listId);
    expect(listIds, 'the org the run owner CAN read must still project').toContain(near.listId);
    expect(listIds, 'org-B idea title/computedPriority/rank leaked to a run owned by an org-A-only member').not.toContain(far.listId);
  });

  it('getHealth withholds the same org from the same run owner', async () => {
    const { tenantId, memberId, strategyId } = await linkedAcrossOrgs();
    const { buildStrategySurface } = await import('../src/features/strategy/surface.js');

    const rows = as<HealthOut>(await buildStrategySurface({ tenantId, actingUserId: memberId }).getHealth({}));
    const row = rows.strategies.find((r) => r.id === strategyId);
    expect(row, 'the health row must still be produced').toBeTruthy();
    expect(row!.signals?.linkedPriorityCount, 'the org-B link was counted for a reader who cannot read org B').toBe(1);
  });

  it('a SYSTEM run (no acting human — what a cadence fire is) still sees the whole tenant', async () => {
    const { tenantId, near, far, strategyId } = await linkedAcrossOrgs();
    const { buildStrategySurface } = await import('../src/features/strategy/surface.js');

    // The fallback the narrowing above must NOT have eaten. `registerJob` in
    // cadence.ts carries no `metadata.actingUserId`, so every scheduled
    // weekly-checkin / board-pack fire lands here with `actingUserId` undefined.
    const out = as<CtxOut>(await buildStrategySurface({ tenantId }).getStrategyContext({ priorityListId: near.listId }));
    const listIds = out.strategies.find((e) => e.id === strategyId)!.linkedPriorities.map((p) => p.listId);
    expect(listIds, 'a subjectless run lost the near org').toContain(near.listId);
    expect(listIds, 'a subjectless run must still project the tenant — a cadence digest would go empty').toContain(far.listId);

    const rows = as<HealthOut>(await buildStrategySurface({ tenantId }).getHealth({}));
    expect(rows.strategies.find((r) => r.id === strategyId)!.signals?.linkedPriorityCount).toBe(2);
  });

  it('the OWNER of both orgs, driving a run, still sees both — the narrowing is a gate, not a blanket', async () => {
    const { tenantId, ownerId, near, far, strategyId } = await linkedAcrossOrgs();
    const { buildStrategySurface } = await import('../src/features/strategy/surface.js');

    const out = as<CtxOut>(await buildStrategySurface({ tenantId, actingUserId: ownerId }).getStrategyContext({ priorityListId: near.listId }));
    const listIds = out.strategies.find((e) => e.id === strategyId)!.linkedPriorities.map((p) => p.listId);
    expect(listIds).toContain(near.listId);
    expect(listIds).toContain(far.listId);
  });
});

describe('SPC-3 — from-idea writes, so it must gate on write', () => {
  it('refuses to promote an idea off a board the caller may only read, and still promotes on a writable one', async () => {
    const { owner, member, memberId, orgA, orgB } = await twoOrgTenant();
    // The member must be able to READ org B for this to be the write-vs-read
    // case rather than the (already-closed) read case.
    await addMember(owner, orgB, memberId, ['viewer']);

    const readOnly = await scheduledIdea(owner, orgB, 'B-board', 'Org-B idea');
    const writable = await scheduledIdea(owner, orgA, 'A-board', 'Org-A idea');
    const s = (await owner.post(S, { orgId: orgA, title: 'Promoting plan', scope: 'workspace' })).body;

    const refused = await member.post(`${S}/${s.id}/initiatives/from-idea`, { listId: readOnly.listId, cardId: readOnly.cardId });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    // Nothing was written: the idea is still unpromoted and still where it was.
    const ideasB = (await owner.get(`${PM}/lists/${readOnly.listId}/ideas`)).body.ideas as Array<{ card: { id: string }; intake?: { promotedTo?: unknown } }>;
    expect(ideasB.find((i) => i.card.id === readOnly.cardId)?.intake?.promotedTo).toBeFalsy();

    // Positive control: the same call on a board the member CAN write succeeds.
    const ok = await member.post(`${S}/${s.id}/initiatives/from-idea`, { listId: writable.listId, cardId: writable.cardId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });
});

describe('SPC-4 — relocating a strategy is gated on the DESTINATION, like creating one', () => {
  it('refuses a move into an org the caller has no write in, and allows one where they do', async () => {
    const { owner, member, orgA, orgB } = await twoOrgTenant();
    // The member creates the strategy in org A, so `requireConfigAuthority`
    // passes on creator-status alone — which is exactly what made the old
    // old-org-only check a no-op.
    const s = (await member.post(S, { orgId: orgA, title: 'Movable', scope: 'org' })).body;
    expect(s.id, JSON.stringify(s)).toBeTruthy();

    const refused = await member.patch(`${S}/${s.id}`, { orgId: orgB });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect((await member.get(`${S}/${s.id}`)).body.orgId, 'the move landed anyway').toBe(orgA);

    // A nonexistent destination is refused too — `updateStrategy` used to take
    // any string at all.
    expect((await member.patch(`${S}/${s.id}`, { orgId: 'org:does-not-exist' })).status).toBe(403);

    // Positive control: the OWNER holds write in org B, so the same move works.
    const moved = await owner.patch(`${S}/${s.id}`, { orgId: orgB });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.orgId).toBe(orgB);
  });

  /**
   * SPC-4B — the OTHER half. `indexStrategy` reconciles the strategy's CURRENT
   * org, so a move left a frozen, still-`contentTrust:'trusted'` copy in the
   * PREVIOUS org's managed Strategy KB that no later edit updated and no
   * archive removed. Asserted against the KB service directly, because the
   * indexer is best-effort and reports nothing.
   */
  it('evicts the strategy from the OLD org Strategy KB when it moves', async () => {
    const { owner, orgA, orgB } = await twoOrgTenant();
    const s = (await owner.post(S, { orgId: orgA, title: 'Indexed plan', scope: 'org' })).body;
    const { getDocument } = await import('../src/features/kb/kbService.js');
    const tid = s.tenantId as string;
    const colOf = (orgId: string) => `mgd-strategy-${orgId}`;

    // Positive control: it IS in org A's KB before the move. Without this the
    // absence assertion below would pass against an indexer that never ran.
    expect(await getDocument(tid, orgA, colOf(orgA), s.id), 'never indexed ⇒ the eviction assertion is vacuous').toBeTruthy();

    expect((await owner.patch(`${S}/${s.id}`, { orgId: orgB })).status).toBe(200);
    expect(await getDocument(tid, orgB, colOf(orgB), s.id), 'not indexed into the destination org').toBeTruthy();
    expect(await getDocument(tid, orgA, colOf(orgA), s.id), 'a trusted copy was stranded in the old org KB').toBeFalsy();
  });
});

/**
 * ADR 0597 §Correction 10 — a guarantee the ADR CLAIMED and no test covered.
 *
 * §4 Decision 2 names the "privatizing variant" specifically: `PATCH {orgId,
 * scope:'user'}` used to remove from the NEW org (where nothing was ever
 * written, because `shouldIndex` is false for a user-scoped row) and leave the
 * now-PRIVATE strategy fully readable in the OLD org's shared KB — "the inverse
 * of the ADR 0100 §CRITICAL carve-out". `SPC-4B` above only exercises a plain
 * move; nothing exercised the combination, so the claim rested on reading the
 * code. Sabotage cannot invent an assertion nobody wrote.
 */
describe('ADR 0597 §Correction 10 — the PRIVATIZING relocation variant, claimed closed and now witnessed', () => {
  it('a move that also goes private leaves NO shared copy in either org', async () => {
    const { owner, orgA, orgB } = await twoOrgTenant();
    const s = (await owner.post(S, { orgId: orgA, title: 'Going private', scope: 'org' })).body;
    const { getDocument } = await import('../src/features/kb/kbService.js');
    const tid = s.tenantId as string;
    const colOf = (orgId: string) => `mgd-strategy-${orgId}`;

    // Positive control — it IS shared and indexed in org A first, or the two
    // absence assertions below pass against a KB that was never written.
    expect(await getDocument(tid, orgA, colOf(orgA), s.id), 'never indexed ⇒ vacuous').toBeTruthy();

    const moved = await owner.patch(`${S}/${s.id}`, { orgId: orgB, scope: 'user' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.orgId).toBe(orgB);
    expect(moved.body.scope).toBe('user');

    expect(await getDocument(tid, orgA, colOf(orgA), s.id),
      'a now-PRIVATE strategy stayed readable in the old org shared KB').toBeFalsy();
    expect(await getDocument(tid, orgB, colOf(orgB), s.id),
      'a user-scoped strategy must never reach a shared collection').toBeFalsy();
  });
});

/**
 * ADR 0597 §Correction 5 (MEDIUM-5) — the SPC-2 fix's cost.
 *
 * Closing SPC-2 turned a branch that made ZERO access calls into one that calls
 * `canReadOrg` per (strategy × priority link), and each call is
 * `subjectHasOrgScope → resolveEffectiveAccess → members.list()` — a full
 * member-table scan with no cache anywhere on the path. `GET /strategy/timeline`
 * fans that across the whole readable portfolio, over an org id set that repeats
 * almost entirely, on a route the deploy notes already flag for read-budget
 * fan-out.
 *
 * Two independent halves, so two independent witnesses: the predicate must
 * MEMOIZE, and the portfolio route must build exactly ONE of them (building it
 * inside the `.map` gives every strategy a fresh empty cache, which is a
 * perfectly working memo that buys nothing where the fan-out actually is).
 */
describe('ADR 0597 §Correction 5 — the org-read predicate is memoized, and the portfolio builds ONE', () => {
  it('returns the SAME in-flight read per org id, and still answers per-org correctly', async () => {
    const { tenantId, memberId, orgA, orgB } = await twoOrgTenant();
    const p = strategyService.orgReadPredicate(tenantId, memberId);

    // Promise IDENTITY is the memo: a second ask for an org already asked about
    // is the same single member-table scan, not a second one. Distinct orgs are
    // distinct reads (a memo that collapsed them would be an authz bug, not a
    // cache).
    const first = p(orgA);
    expect(p(orgA), 'a repeat org read started a second member-table scan').toBe(first);
    expect(p(orgB), 'two different orgs collapsed onto one read').not.toBe(first);

    // …and the rule it memoizes is still the right rule.
    expect(await p(orgA)).toBe(true);
    expect(await p(orgB)).toBe(false);
  });

  it('GET /strategy/timeline builds ONE predicate for the whole fan-out', async () => {
    const { owner, orgA } = await twoOrgTenant();
    const idea = await scheduledIdea(owner, orgA, 'A-fanout', 'Fanned idea');
    // Three strategies, each linking the same list — the portfolio shape.
    for (const title of ['Fan A', 'Fan B', 'Fan C']) {
      const s = (await owner.post(S, { orgId: orgA, title, scope: 'workspace' })).body;
      const r = await owner.put(`${S}/${s.id}/links`, { links: [{ kind: 'priority-idea', listId: idea.listId, cardId: idea.cardId }] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }

    const spy = vi.spyOn(strategyService, 'orgReadPredicate');
    try {
      const port = await owner.get(`${S}/timeline`);
      expect(port.status, JSON.stringify(port.body)).toBe(200);
      expect((port.body.items as TlItem[]).some((i) => i.title === 'Fanned idea'), 'the fan-out must still project').toBe(true);
      expect(spy.mock.calls.length, 'the predicate was rebuilt per strategy — every one starts with an empty cache').toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
