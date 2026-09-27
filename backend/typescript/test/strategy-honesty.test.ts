/**
 * Strategy ROUND 2 (UX_UPGRADE-strategy, pass 2) — the seams round 1 did not reach.
 *
 * Round 1 fixed two silent `catch(() => {})` reads on the strategy detail's Overview and
 * Alignment tabs. Its scope line says so. Every other read on the feature carried the
 * identical shape, and the write paths were untouched:
 *
 *  - STR2-B4  CSV import SLICED past the caps and reported the dropped rows as imported
 *  - STR2-B5  promoting an idea at the initiative cap stamped the WRONG initiative id
 *  - STR2-M1  the budget rollup summed across currencies and labelled it first-wins
 *  - STR2-M2  a source currency matching nothing wrote a CONFIRMED revenue = 0, nightly
 *  - STR2-M3  archive/delete stranded an activation card that no action could clear
 *  - STR2-M4  approving activation on a non-draft reported "approved" and changed nothing
 *  - STR2-M7  no subject eraser over six subject-keyed fields
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, type Client } from './planningHarness.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { listApprovals } from '../src/host/approvalService.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  await enableToggle('strategy', 'on');
  await enableToggle('priority-matrix', 'on');
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);
const S = '/v1/host/openwop-app/strategy';

async function login(): Promise<{ c: Client; orgId: string; tenantId: string; userId: string }> {
  const tenantId = `org:str2-${Date.now()}-${n++}`;
  const c = client();
  const res = await c.post('/v1/host/openwop-app/test/login', { email: `s2-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(res.status).toBe(201);
  const orgId = (await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  return { c, orgId, tenantId, userId: res.body.user.userId };
}

const mkStrategy = async (c: Client, orgId: string, over: Record<string, unknown> = {}): Promise<any> => {
  const res = await c.post(S, { orgId, title: 'Grow', scope: 'org', planningHorizon: 'annual', ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};

describe('STR2-B4 — a CSV import cannot report dropped rows as imported', () => {
  it('names the over-cap rows in `skipped`, and does not count them', async () => {
    const { c, orgId } = await login();
    // Fill to one below the cap, then import three more objectives: one lands, two are
    // sliced away by `parseObjectives`. The route's own comment claimed "the shared
    // parse/caps re-validate everything (a too-large import 400s)" — they slice, nothing
    // throws, and `imported` was counted from the CSV rows BEFORE persistence. So the
    // panel said "3 rows imported, 0 skipped" while two vanished.
    const objectives = Array.from({ length: 49 }, (_, i) => ({ id: `o${i}`, title: `Existing ${i}`, keyResults: [] }));
    const s = await mkStrategy(c, orgId, { objectives });
    const csv = 'objective,keyResult,target,unit\nNew A,,,\nNew B,,,\nNew C,,,';
    const res = await c.post(`${S}/${s.id}/import-objectives`, { csv });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toHaveLength(2);
    expect(JSON.stringify(res.body.skipped)).toMatch(/objective limit/i);
    expect(res.body.strategy.objectives).toHaveLength(50);
  });

  it('an import inside the caps still reports every row imported (the negative control)', async () => {
    const { c, orgId } = await login();
    const s = await mkStrategy(c, orgId);
    const res = await c.post(`${S}/${s.id}/import-objectives`, { csv: 'objective,keyResult,target,unit\nA,KR1,10,%\nB,KR2,20,%' });
    expect(res.body.imported).toBe(2);
    expect(res.body.skipped).toHaveLength(0);
  });
});

describe('STR2-M1 — a budget total is denominated, or it is withheld', () => {
  it('withholds the sums when the initiatives disagree, and says which currencies', async () => {
    const { c, orgId } = await login();
    // First-wins labelling turned {100000 USD} + {50000 JPY} into "150000 USD" — a number
    // that is not a quantity of anything, on a row served by BOTH the health route and
    // the `openwop:strategy.get-health` agent tool, whose prompt tells the model to report
    // the signals verbatim. It reaches a board memo as "$150,000 planned".
    const s = await mkStrategy(c, orgId, {
      initiatives: [
        { title: 'A', plan: { budgetAmount: 100_000, budgetCurrency: 'USD' } },
        { title: 'B', plan: { budgetAmount: 50_000, budgetCurrency: 'JPY' } },
      ],
    });
    const row = (await c.get(`${S}/health`)).body.strategies.find((r: any) => r.id === s.id);
    expect(row.signals.budgetPlanned).toBeUndefined();
    expect(row.signals.budgetCurrency).toBeUndefined();
    expect(row.signals.budgetMixedCurrency).toBe(true);
    expect(row.signals.budgetCurrencies).toEqual(['JPY', 'USD']);
  });

  it('a single currency still reports its total (the negative control)', async () => {
    const { c, orgId } = await login();
    const s = await mkStrategy(c, orgId, {
      initiatives: [
        { title: 'A', plan: { budgetAmount: 100_000, budgetCurrency: 'USD' } },
        { title: 'B', plan: { budgetAmount: 50_000, budgetCurrency: 'usd' } },   // case-normalised
      ],
    });
    const row = (await c.get(`${S}/health`)).body.strategies.find((r: any) => r.id === s.id);
    expect(row.signals.budgetPlanned).toBe(150_000);
    expect(row.signals.budgetCurrency).toBe('USD');
    expect(row.signals.budgetMixedCurrency).toBeUndefined();
  });
});

describe('STR2-M3/M4 — an activation card must not outlive, or misreport, its decision', () => {
  const queueActivation = async (c: Client, tenantId: string, id: string): Promise<string> => {
    await enableToggle('strategy-approval-gate', 'on');
    const res = await c.patch(`${S}/${id}`, { status: 'active' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { listApprovals: list } = await import('../src/host/approvalService.js');
    const card = (await list(tenantId, 'pending')).find((a) => a.kind === 'strategy-activation' && a.strategyId === id);
    expect(card, 'an activation card should be queued').toBeTruthy();
    return card!.approvalId;
  };

  it('approving a strategy that is no longer a draft is refused, not reported as approved', async () => {
    const { c, orgId, tenantId } = await login();
    const s = await mkStrategy(c, orgId);
    const approvalId = await queueActivation(c, tenantId, s.id);
    // The author archives it while the card waits. The `if (s.status === 'draft')` had no
    // `else`: the CAS consumed the approval, the audit recorded `activation-approved`, the
    // handler returned changed:true — and the strategy stayed archived. The inbox said
    // Approved and the strategy disagreed, with nobody told.
    expect((await c.patch(`${S}/${s.id}`, { status: 'archived' })).status).toBe(200);
    const decide = await c.post(`/v1/host/openwop-app/reviews/approval:${approvalId}/actions/approve`);
    expect(decide.status).toBe(409);
    expect((await c.get(`${S}/${s.id}`)).body.status).toBe('archived');
    // …and the card is back to pending, so it can still be rejected deliberately.
    expect((await listApprovals(tenantId, 'pending')).some((a) => a.approvalId === approvalId)).toBe(true);
    await enableToggle('strategy-approval-gate', 'off');
  });

  it('a draft still activates through the card (the negative control)', async () => {
    const { c, orgId, tenantId } = await login();
    const s = await mkStrategy(c, orgId);
    const approvalId = await queueActivation(c, tenantId, s.id);
    expect((await c.post(`/v1/host/openwop-app/reviews/approval:${approvalId}/actions/approve`)).status).toBe(200);
    expect((await c.get(`${S}/${s.id}`)).body.status).toBe('active');
    await enableToggle('strategy-approval-gate', 'off');
  });
});

describe('STR2-M5 — a save that DEACTIVATES the strategy says so', () => {
  it('returns the auto-revert marker and the field that caused it', async () => {
    const { c, orgId } = await login();
    const s = await mkStrategy(c, orgId);
    await enableToggle('strategy-approval-gate', 'off');
    expect((await c.patch(`${S}/${s.id}`, { status: 'active' })).status).toBe(200);
    await enableToggle('strategy-approval-gate', 'on');
    // Editing a protected field on an ACTIVE strategy reverts it to draft. The marker rode
    // the event and the audit and never reached the client, so on screen the status chip
    // simply changed: the strategy was deactivated and nothing explained it.
    const res = await c.patch(`${S}/${s.id}`, { objectives: [{ id: 'o1', title: 'New objective', keyResults: [] }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('draft');
    expect(res.body.autoRevertedToDraft).toBe(true);
    expect(res.body.autoRevertedFields).toContain('objectives');
    await enableToggle('strategy-approval-gate', 'off');
  });

  it('an unprotected edit carries no marker (the negative control)', async () => {
    const { c, orgId } = await login();
    const s = await mkStrategy(c, orgId);
    const res = await c.patch(`${S}/${s.id}`, { title: 'Renamed' });
    expect(res.body.autoRevertedToDraft).toBeUndefined();
  });
});

describe('review fold-in — the four findings that shipped untested, and two that were wrong', () => {
  it('B5: promoting an idea at the initiative cap is REFUSED, not mis-attributed', async () => {
    const { c, orgId } = await login();
    const initiatives = Array.from({ length: 50 }, (_, i) => ({ title: `Existing ${i}` }));
    const s = await mkStrategy(c, orgId, { initiatives });
    const listId = (await c.post('/v1/host/openwop-app/priority-matrix/lists', { orgId, name: 'Ideas', presetId: 'weighted' })).body.id;
    await c.post(`/v1/host/openwop-app/priority-matrix/lists/${listId}/ideas`, { title: 'Rebuild onboarding' });
    const card = (await c.get(`/v1/host/openwop-app/priority-matrix/lists/${listId}/ideas`)).body.ideas[0].card;
    // `parseInitiatives` slices the append away, and the code took `initiatives[length-1]`
    // — a pre-existing, unrelated initiative — stamped its id onto the idea's intake
    // overlay, moved the card to the terminal `done` lane, and returned 201 naming it.
    const res = await c.post(`${S}/${s.id}/initiatives/from-idea`, { listId, cardId: card.id });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    // Assert WHICH guard fired: a bare 409 cannot tell the cap refusal apart from the
    // "could not be created" fallback, and my first version of this test passed with the
    // cap check deleted because the fallback caught it. The cap is the one that keeps the
    // idea promotable; the fallback would still have consumed nothing, but says nothing
    // actionable either.
    expect(res.body.details?.max).toBe(50);
    // …and the idea is untouched: still promotable once the operator makes room.
    const after = (await c.get(`/v1/host/openwop-app/priority-matrix/lists/${listId}/ideas`)).body.ideas[0];
    expect(after.card.status).not.toBe('done');
  });

  it('B5: below the cap it promotes, and names the initiative it MINTED', async () => {
    const { c, orgId } = await login();
    const s = await mkStrategy(c, orgId, { initiatives: [{ title: 'Existing' }] });
    const listId = (await c.post('/v1/host/openwop-app/priority-matrix/lists', { orgId, name: 'Ideas', presetId: 'weighted' })).body.id;
    await c.post(`/v1/host/openwop-app/priority-matrix/lists/${listId}/ideas`, { title: 'Rebuild onboarding' });
    const card = (await c.get(`/v1/host/openwop-app/priority-matrix/lists/${listId}/ideas`)).body.ideas[0].card;
    const res = await c.post(`${S}/${s.id}/initiatives/from-idea`, { listId, cardId: card.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const minted = res.body.strategy.initiatives.find((i: any) => i.title === 'Rebuild onboarding');
    expect(minted).toBeTruthy();
    expect(res.body.initiativeId).toBe(minted.id);
    // NOTE — this does NOT discriminate the id-vs-position lookup: with the append not
    // sliced, `initiatives[length - 1]` IS the minted row, so both spellings agree. The
    // only shape where they diverge is a sliced append, which the cap refusal above now
    // makes unreachable. The id lookup is therefore belt-and-braces, carried on reasoning
    // rather than on a probe — said plainly instead of implied by a passing test.
  });

  it('M3: a card for a DELETED strategy closes as rejected — and does not record "approved"', async () => {
    const { c, orgId, tenantId } = await login();
    await enableToggle('strategy-approval-gate', 'on');
    const s = await mkStrategy(c, orgId);
    expect((await c.patch(`${S}/${s.id}`, { status: 'active' })).status).toBe(200);
    const { listApprovals: list } = await import('../src/host/approvalService.js');
    const card = (await list(tenantId, 'pending')).find((a) => a.kind === 'strategy-activation' && a.strategyId === s.id)!;
    expect([200, 204]).toContain((await c.del(`${S}/${s.id}?hard=true`)).status);

    // My first fix called `resolveApproval(..., 'rejected')` AFTER the CAS had already
    // flipped the row to `approved` — a no-op, since resolveApproval early-returns unless
    // the row is pending. So the reviewer got a 404 while the card was consumed as
    // APPROVED, with a governance audit entry saying so for a strategy that is gone.
    const decide = await c.post(`/v1/host/openwop-app/reviews/approval:${card.approvalId}/actions/approve`);
    expect(decide.status).toBe(409);
    const { getApproval } = await import('../src/host/approvalService.js');
    const closed = await getApproval(card.approvalId);
    expect(closed, 'the card should still exist').toBeTruthy();
    expect(closed!.status, 'closed as rejected, never recorded as approved').toBe('rejected');
    expect(closed!.note).toMatch(/no longer exists/i);
    await enableToggle('strategy-approval-gate', 'off');
  });

  it('the gate fires when the editor posts an UNCHANGED status alongside a protected field', async () => {
    const { c, orgId } = await login();
    const s = await mkStrategy(c, orgId);
    await enableToggle('strategy-approval-gate', 'off');
    expect((await c.patch(`${S}/${s.id}`, { status: 'active' })).status).toBe(200);
    await enableToggle('strategy-approval-gate', 'on');
    // The app's OWN Overview editor posts the whole form, including the unchanged status.
    // `body.status === undefined` was therefore false and NEITHER gate branch fired: the
    // three protected fields it edits could be changed on a live, approved strategy with
    // no revert, no approval and no marker — while ObjectivesEditor, which posts only
    // `objectives`, did revert. The gate was unenforced from the primary editor.
    const res = await c.patch(`${S}/${s.id}`, { status: 'active', planningHorizon: 'quarter', accountableExecutive: 'Jane Doe' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('draft');
    expect(res.body.autoRevertedToDraft).toBe(true);
    expect(res.body.autoRevertedFields).toContain('planningHorizon');
    await enableToggle('strategy-approval-gate', 'off');
  });

  it('M2: a source currency with NO captured orders skips instead of writing a confirmed 0', async () => {
    const { c, orgId, tenantId } = await login();
    // A measured KR whose source names a currency the org has never captured.
    const s = await mkStrategy(c, orgId, {
      objectives: [{
        id: 'o1', title: 'Revenue', keyResults: [{
          id: 'k1', title: 'ARR', measure: { kind: 'currency', target: 1_000_000, unit: 'USD', source: { kind: 'commerce-revenue', orgId, query: 'USD' } },
        }],
      }],
    });
    // `syncSourcedKrs` only walks ACTIVE, non-user-scope strategies.
    await enableToggle('strategy-approval-gate', 'off');
    expect((await c.patch(`${S}/${s.id}`, { status: 'active' })).status).toBe(200);
    const { syncSourcedKrs } = await import('../src/features/strategy/metricSync.js');
    // Zero is the one value indistinguishable from a correct measurement: it reads as 0%
    // progress and flips the verdict to at-risk, nightly, confirmed. My first fix guarded
    // `captured.length > 0`, so the org with NO orders — the commonest shape of this bug —
    // still wrote the zero.
    const out = await syncSourcedKrs(tenantId, 'test');
    expect(out.synced).toHaveLength(0);
    // Name WHICH skip: with no orders at all, `present` is empty, so the "not present"
    // guard also fires — my first assertion matched either and could not tell them apart.
    // The no-orders case is the commonest shape of this bug (a KR wired up before the
    // first sale), and it is the one the earlier fix left writing a confirmed zero.
    expect(JSON.stringify(out.skipped)).toMatch(/no_captured_orders/);
    expect(s.id).toBeTruthy();
  });

  it('M7: the erased id does not survive in a revision snapshot', async () => {
    const { c, orgId, tenantId, userId } = await login();
    const s = await mkStrategy(c, orgId, { ownerUserId: userId });
    expect((await c.patch(`${S}/${s.id}`, { title: 'Renamed once' })).status).toBe(200);
    await eraseSubject(tenantId, userId);
    // `snapshot` is a FULL clone of the strategy — up to 50 per strategy — so anonymising
    // the live row while leaving the history reported a DSAR success the data contradicts,
    // and a version restore would write the id straight back.
    // The LIST route returns metadata only (n/actor/title/status), so it cannot see a
    // snapshot at all — my first version of this assertion read that list and passed with
    // the snapshot redaction reverted. Read the snapshot itself.
    const list = (await c.get(`${S}/${s.id}/versions`)).body.versions;
    expect(list.length).toBeGreaterThan(0);
    for (const v of list) {
      const snap = (await c.get(`${S}/${s.id}/versions/${v.n}`)).body;
      expect(JSON.stringify(snap), `version ${v.n} still names the erased subject`).not.toContain(userId);
    }
  });
});

describe('STR2-M7 — subject erasure reaches the strategy rows', () => {
  it('severs the person-link on the strategy and its initiative owner', async () => {
    const { c, orgId, tenantId, userId } = await login();
    const s = await mkStrategy(c, orgId, {
      ownerUserId: userId,
      initiatives: [{ title: 'A', ownerUserId: userId }],
    });
    expect((await c.get(`${S}/${s.id}`)).body.createdBy).toBe(userId);

    await eraseSubject(tenantId, userId);

    const after = (await c.get(`${S}/${s.id}`)).body;
    expect(after.createdBy).toBe('user:[erased]');
    expect(after.ownerUserId).toBe('user:[erased]');
    expect(after.initiatives[0].ownerUserId).toBe('user:[erased]');
    expect(after.title).toBe('Grow');                     // the business record survives
  });

  it('leaves another subject alone (the negative control)', async () => {
    const { c, orgId, tenantId, userId } = await login();
    const s = await mkStrategy(c, orgId, { ownerUserId: userId });
    await eraseSubject(tenantId, 'user:somebody-else');
    expect((await c.get(`${S}/${s.id}`)).body.ownerUserId).toBe(userId);
  });
});
