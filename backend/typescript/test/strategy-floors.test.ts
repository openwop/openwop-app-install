/**
 * Planning floors (ADR 0235) — ROUTE coverage:
 *   D1 scenarios: add/resolve (maxItems + maxBudget lines over intake
 *      estimatedValue), compare (idea movements only), select (single plan of
 *      record), agent-proposed inertness (surface verb stamps proposedBy)
 *   D2 plan blocks: initiative plan sums surface in /strategy/health signals
 *   D3 parent lens: write-time validation (self / grandparent / cross-org),
 *      health rows carry parentStrategyId; CSV objective import
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, type Client } from './planningHarness.js';
import { buildPriorityMatrixSurface } from '../src/features/priority-matrix/surface.js';

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
const PM = '/v1/host/openwop-app/priority-matrix';

async function login(): Promise<{ c: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const tenantId = `org:fl-${Date.now()}-${n++}`;
  const c = client();
  expect((await c.post('/v1/host/openwop-app/test/login', { email: `fl-${Date.now()}-${n++}@acme.test`, tenantId })).status).toBe(201);
  const orgId = (await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  return { c, orgId, tenantId };
}

describe('D1 — planning-session scenarios', () => {
  it('resolves budget/item lines, compares, and selects exactly one plan of record', async () => {
    const { c, orgId, tenantId } = await login();
    const listId = (await c.post(`${PM}/lists`, { orgId, name: 'Bets', presetId: 'weighted' })).body.id;
    for (const t of ['Alpha', 'Beta', 'Gamma']) await c.post(`${PM}/lists/${listId}/ideas`, { title: t });
    const ideas = (await c.get(`${PM}/lists/${listId}/ideas`)).body.ideas;
    const idOf = (t: string): string => ideas.find((r: any) => r.card.title === t).card.id;
    // Estimated values: Alpha 100, Beta 80, Gamma 50 (ranks are score-equal ⇒ stable ordering).
    await c.patch(`${PM}/lists/${listId}/ideas/${idOf('Alpha')}/intake`, { estimatedValue: 100 });
    await c.patch(`${PM}/lists/${listId}/ideas/${idOf('Beta')}/intake`, { estimatedValue: 80 });
    await c.patch(`${PM}/lists/${listId}/ideas/${idOf('Gamma')}/intake`, { estimatedValue: 50 });
    const sessionId = (await c.post(`${PM}/lists/${listId}/sessions`, { mode: 'top-n', n: 3 })).body.id;

    const a = await c.post(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios`, {
      name: 'Everything', selection: { mode: 'top-n', n: 3 },
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await c.post(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios`, {
      name: 'Tight budget', selection: { mode: 'top-n', n: 3 }, constraints: { maxBudget: 150 },
    });
    expect(b.status).toBe(201);
    expect((await c.post(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios`, { name: 'Bad', selection: { mode: 'top-n', n: 0 } })).status).toBe(400);

    const resolved = await c.get(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios`);
    expect(resolved.status).toBe(200);
    const tight = resolved.body.scenarios.find((s: any) => s.scenarioId === b.body.scenarioId);
    expect(tight.aboveLine.length + tight.belowLine.length).toBe(3);
    expect(tight.belowLine.length).toBeGreaterThan(0);
    expect(tight.belowLine.every((x: any) => x.droppedBy === 'maxBudget')).toBe(true);
    expect(tight.totalEstimatedValue).toBeLessThanOrEqual(150);

    const cmp = await c.get(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios/compare?a=${a.body.scenarioId}&b=${b.body.scenarioId}`);
    expect(cmp.status).toBe(200);
    expect(cmp.body.droppedInB.length).toBe(tight.belowLine.length);
    expect(cmp.body.gainedInB).toHaveLength(0);

    // Select B; then A — exactly one plan of record survives.
    expect((await c.post(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios/${b.body.scenarioId}/select`)).body.planOfRecord).toBe(true);
    await c.post(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios/${a.body.scenarioId}/select`);
    const after = await c.get(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios`);
    const pors = after.body.scenarios.filter((s: any) => s.planOfRecord);
    expect(pors).toHaveLength(1);
    expect(pors[0].scenarioId).toBe(a.body.scenarioId);

    // The agent surface verb stamps proposedBy and never selects.
    const surface = buildPriorityMatrixSurface({ tenantId });
    const proposed = JSON.parse(JSON.stringify(await surface.proposeScenario({
      listId, sessionId, name: 'Analyst pick', selection: { mode: 'top-n', n: 2 },
    })));
    expect(proposed.scenario.proposedBy).toBe('agent');
    expect(proposed.scenario.planOfRecord).toBeUndefined();
  });

  it('PM2 — concurrent scenario adds all survive under the guarded CAS writer (no lost update)', async () => {
    const { c, orgId } = await login();
    const listId = (await c.post(`${PM}/lists`, { orgId, name: 'Race', presetId: 'weighted' })).body.id;
    await c.post(`${PM}/lists/${listId}/ideas`, { title: 'Only' });
    const sessionId = (await c.post(`${PM}/lists/${listId}/sessions`, { mode: 'top-n', n: 1 })).body.id;

    // Six concurrent adds — a naive read-modify-write would lose most to the
    // last writer; the CAS retry loop must land all six (cap is 8).
    const adds = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      c.post(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios`, { name: `S${i}`, selection: { mode: 'top-n', n: 1 } }),
    ));
    expect(adds.every((r) => r.status === 201)).toBe(true);
    const resolved = await c.get(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios`);
    expect(resolved.body.scenarios).toHaveLength(6);
    // The cap is enforced against the FRESH row inside the mutator: a 7th+8th
    // fit, a 9th is refused.
    for (let i = 6; i < 8; i++) expect((await c.post(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios`, { name: `S${i}`, selection: { mode: 'top-n', n: 1 } })).status).toBe(201);
    expect((await c.post(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios`, { name: 'over', selection: { mode: 'top-n', n: 1 } })).status).toBe(400);
  });
});

describe('D2 — initiative plan sums in health', () => {
  it('rolls budget/capacity plan-vs-actual into signals', async () => {
    const { c, orgId } = await login();
    const s = (await c.post(S, {
      orgId, title: 'Funded plan',
      initiatives: [
        { title: 'Build', plan: { budgetAmount: 100000, budgetCurrency: 'USD', capacityPoints: 40, actualAmount: 25000, actualPoints: 10 } },
        { title: 'Launch', plan: { budgetAmount: 50000, capacityPoints: 20 } },
        { title: 'Unplanned' },
      ],
    })).body;
    expect(s.id, JSON.stringify(s)).toBeTruthy();
    expect((await c.post(S, { orgId, title: 'Bad', initiatives: [{ title: 'X', plan: { budgetAmount: -5 } }] })).status).toBe(400);

    const health = await c.get(`${S}/health`);
    const row = health.body.strategies.find((x: any) => x.id === s.id);
    expect(row.signals.budgetPlanned).toBe(150000);
    expect(row.signals.budgetActual).toBe(25000);
    expect(row.signals.capacityPlanned).toBe(60);
    expect(row.signals.capacityActual).toBe(10);
    expect(row.signals.budgetCurrency).toBe('USD');
  });
});

describe('D3 — parent lens + CSV import', () => {
  it('validates the one-level parent and carries it on health rows', async () => {
    const { c, orgId } = await login();
    const parent = (await c.post(S, { orgId, title: 'Annual plan' })).body;
    const child = (await c.post(S, { orgId, title: 'Q1 slice', parentStrategyId: parent.id })).body;
    expect(child.parentStrategyId).toBe(parent.id);

    // One level only: a child cannot become a parent; self is refused; a
    // missing parent 404s.
    expect((await c.post(S, { orgId, title: 'Grandchild', parentStrategyId: child.id })).status).toBe(400);
    expect((await c.patch(`${S}/${parent.id}`, { parentStrategyId: parent.id })).status).toBe(400);
    expect((await c.post(S, { orgId, title: 'Orphan', parentStrategyId: 'ghost' })).status).toBe(404);

    const health = await c.get(`${S}/health`);
    expect(health.body.strategies.find((x: any) => x.id === child.id).parentStrategyId).toBe(parent.id);
    // Clearing via null.
    expect((await c.patch(`${S}/${child.id}`, { parentStrategyId: null })).body.parentStrategyId).toBeUndefined();
  });

  it('imports objectives/KRs from CSV, merging by objective title', async () => {
    const { c, orgId } = await login();
    const s = (await c.post(S, { orgId, title: 'Imported', objectives: [{ title: 'Grow ARR', keyResults: [] }] })).body;
    const csv = [
      'objective,keyResult,target,unit',
      'Grow ARR,ARR to 10M,10M,USD',
      'Grow ARR,Churn under 3%,3,%',
      'Delight customers,NPS 60,60,',
      ',orphan kr,,',
    ].join('\n');
    const r = await c.post(`${S}/${s.id}/import-objectives`, { csv });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.imported).toBe(3);
    expect(r.body.skipped).toHaveLength(1);
    const titles = r.body.strategy.objectives.map((o: any) => o.title);
    expect(titles).toEqual(['Grow ARR', 'Delight customers']); // merged, not duplicated
    expect(r.body.strategy.objectives[0].keyResults.map((k: any) => k.title)).toEqual(['ARR to 10M', 'Churn under 3%']);
    expect((await c.post(`${S}/${s.id}/import-objectives`, { csv: '' })).status).toBe(400);
  });
});

// CHAT-FIRST-PORT-AUDIT D3 — an AGENT-proposed scenario adopted as plan of record
// is decided on ONE shared approval record (reviews inbox), and deciding from the
// inbox and from the page are the SAME CAS operation. A HUMAN scenario stays a
// plain select (no approval).
describe('D3 — scenario select ↔ shared approval', () => {
  const APPR = '/v1/host/openwop-app/approvals';

  async function sessionWithIdeas(): Promise<{ c: Client; orgId: string; tenantId: string; listId: string; sessionId: string }> {
    const { c, orgId, tenantId } = await login();
    const listId = (await c.post(`${PM}/lists`, { orgId, name: 'Bets', presetId: 'weighted' })).body.id;
    for (const t of ['Alpha', 'Beta']) await c.post(`${PM}/lists/${listId}/ideas`, { title: t });
    const sessionId = (await c.post(`${PM}/lists/${listId}/sessions`, { mode: 'top-n', n: 2 })).body.id;
    return { c, orgId, tenantId, listId, sessionId };
  }

  it('an agent-proposed scenario raises a pm-scenario-select approval; a HUMAN scenario does not', async () => {
    const { c, tenantId, listId, sessionId } = await sessionWithIdeas();
    const surface = buildPriorityMatrixSurface({ tenantId });
    const proposed = JSON.parse(JSON.stringify(await surface.proposeScenario({ listId, sessionId, name: 'Analyst pick', selection: { mode: 'top-n', n: 2 } })));
    // A plain human-added scenario — must NOT create an approval.
    const human = (await c.post(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios`, { name: 'Mine', selection: { mode: 'top-n', n: 1 } })).body;

    const items = (await c.get(`${APPR}?status=pending`)).body.items.filter((a: any) => a.kind === 'pm-scenario-select');
    expect(items).toHaveLength(1);
    expect(items[0].scenarioSelect.scenarioId).toBe(proposed.scenario.scenarioId);
    expect(items.some((a: any) => a.scenarioSelect?.scenarioId === human.scenarioId)).toBe(false);
  });

  it('page select of an agent scenario resolves the approval; a second select 409s', async () => {
    const { c, tenantId, listId, sessionId } = await sessionWithIdeas();
    const surface = buildPriorityMatrixSurface({ tenantId });
    const proposed = JSON.parse(JSON.stringify(await surface.proposeScenario({ listId, sessionId, name: 'Analyst pick', selection: { mode: 'top-n', n: 2 } })));
    const scenarioId = proposed.scenario.scenarioId;

    const sel = await c.post(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios/${scenarioId}/select`);
    expect(sel.status, JSON.stringify(sel.body)).toBe(200);
    expect(sel.body.planOfRecord).toBe(true);

    // The shared approval left the pending inbox (recorded approved).
    expect((await c.get(`${APPR}?status=pending`)).body.items.filter((a: any) => a.scenarioSelect?.scenarioId === scenarioId)).toHaveLength(0);
    expect((await c.get(`${APPR}?status=approved`)).body.items.some((a: any) => a.scenarioSelect?.scenarioId === scenarioId)).toBe(true);

    // A second page select can no longer mint a decision (already decided).
    expect((await c.post(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios/${scenarioId}/select`)).status).toBe(409);
  });

  it('inbox-decide and page-decide converge: claiming in the inbox selects the scenario; the page then 409s', async () => {
    const { c, tenantId, listId, sessionId } = await sessionWithIdeas();
    const surface = buildPriorityMatrixSurface({ tenantId });
    const proposed = JSON.parse(JSON.stringify(await surface.proposeScenario({ listId, sessionId, name: 'Analyst pick', selection: { mode: 'top-n', n: 2 } })));
    const scenarioId = proposed.scenario.scenarioId;

    const row = (await c.get(`${APPR}?status=pending`)).body.items.find((a: any) => a.scenarioSelect?.scenarioId === scenarioId);
    expect((await c.post(`${APPR}/${row.approvalId}/claim`)).status).toBe(200);

    // The scenario reflects the inbox decision — ONE durable record.
    const after = await c.get(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios`);
    expect(after.body.scenarios.find((s: any) => s.scenarioId === scenarioId).planOfRecord).toBe(true);

    // The page select refuses (same record, already decided).
    expect((await c.post(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios/${scenarioId}/select`)).status).toBe(409);
  });
});

/**
 * PMX-6 / PMXU-2 / PMXWF-2 (ADR 0590) — the REJECT seam of the scenario gate,
 * witnessed against the REAL resolve path with real HTTP payloads (the D3
 * suite's bar). Pre-fix: rejecting wrote nothing the scenario surface could
 * see, the page still offered "Set as plan of record", the select route's
 * any-status finder let the raw core "Approval already rejected." fire instead
 * of the well-worded 409, and neither the reject arm, the 403 decide arm, nor
 * the compensating reopen was tested anywhere.
 */
describe('ADR 0590 — scenario reject seam (reject / 403 / compensating reopen)', () => {
  const APPR = '/v1/host/openwop-app/approvals';

  async function agentProposed(): Promise<{ c: Client; tenantId: string; listId: string; sessionId: string; scenarioId: string; approvalId: string }> {
    const { c, orgId, tenantId } = await login();
    const listId = (await c.post(`${PM}/lists`, { orgId, name: 'Bets', presetId: 'weighted' })).body.id;
    for (const t of ['Alpha', 'Beta']) await c.post(`${PM}/lists/${listId}/ideas`, { title: t });
    const sessionId = (await c.post(`${PM}/lists/${listId}/sessions`, { mode: 'top-n', n: 2 })).body.id;
    const surface = buildPriorityMatrixSurface({ tenantId });
    const proposed = JSON.parse(JSON.stringify(await surface.proposeScenario({ listId, sessionId, name: 'Analyst pick', selection: { mode: 'top-n', n: 2 } })));
    const scenarioId = proposed.scenario.scenarioId as string;
    const row = (await c.get(`${APPR}?status=pending`)).body.items.find((a: any) => a.scenarioSelect?.scenarioId === scenarioId);
    return { c, tenantId, listId, sessionId, scenarioId, approvalId: row.approvalId };
  }

  it('INBOX reject: scenario stays un-adopted, GET /scenarios surfaces approvalStatus, page select 409s with the decided message', async () => {
    const { c, listId, sessionId, scenarioId, approvalId } = await agentProposed();
    expect((await c.post(`${APPR}/${approvalId}/reject`)).status).toBe(200);

    const after = (await c.get(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios`)).body.scenarios;
    const s = after.find((x: any) => x.scenarioId === scenarioId);
    expect(s.planOfRecord).toBeUndefined();
    expect(s.approvalStatus).toBe('rejected');

    const sel = await c.post(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios/${scenarioId}/select`);
    expect(sel.status).toBe(409);
    expect(JSON.stringify(sel.body)).toMatch(/already been decided/i);
  });

  it('PAGE reject: the feature route rejects the SHARED row; the inbox can no longer decide it', async () => {
    const { c, listId, sessionId, scenarioId, approvalId } = await agentProposed();
    const rej = await c.post(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios/${scenarioId}/reject`);
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body.approvalStatus).toBe('rejected');

    // ONE durable record: the inbox claim refuses the already-decided row.
    expect((await c.post(`${APPR}/${approvalId}/claim`)).status).toBe(409);
    // A human scenario (no approval) has nothing to reject — typed refusal.
    const human = (await c.post(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios`, { name: 'Mine', selection: { mode: 'top-n', n: 1 } })).body;
    expect((await c.post(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios/${human.scenarioId}/reject`)).status).toBe(409);
  });

  it('403 arm: a signed-in member WITHOUT workspace:write in the list org cannot decide (either outcome)', async () => {
    const { c, tenantId, approvalId } = await agentProposed();
    const stranger = client();
    // Co-tenant user (the seam mints the session only — no owner row, no org
    // membership), so they hold NO workspace:write in the list's org. NOTE:
    // `sharedWorkspace:true` would bounce a non-member to their personal tenant
    // (cross-tenant → 404, the no-existence-leak arm, not this one).
    expect((await stranger.post('/v1/host/openwop-app/test/login', { email: `fl-stranger-${Date.now()}-${n++}@acme.test`, tenantId })).status).toBe(201);
    expect((await stranger.post(`${APPR}/${approvalId}/claim`)).status).toBe(403);
    expect((await stranger.post(`${APPR}/${approvalId}/reject`)).status).toBe(403);
    // The no-existence-leak LIST gate also hides the row from the non-decider…
    expect((await stranger.get(`${APPR}?status=pending`)).body.items.some((a: any) => a.approvalId === approvalId)).toBe(false);
    // …while the OWNER still sees it pending — the refusals decided nothing.
    const stillPending = (await c.get(`${APPR}?status=pending`)).body.items.some((a: any) => a.approvalId === approvalId);
    expect(stillPending).toBe(true);
  });

  it('COMPENSATING REOPEN: an approve whose select cannot apply re-opens the approval instead of stranding it decided', async () => {
    const { c, listId, scenarioId, approvalId } = await agentProposed();
    void scenarioId;
    // Destroy the session (list delete cascades sessions) so the select's
    // effect cannot apply.
    expect((await c.del(`${PM}/lists/${listId}`)).status).toBe(204);
    const claim = await c.post(`${APPR}/${approvalId}/claim`);
    expect(claim.status).toBeGreaterThanOrEqual(400);
    // The ADR 0066 HIGH-1 pattern: resolve-then-compensate — the row is PENDING again.
    const pending = (await c.get(`${APPR}?status=pending`)).body.items.some((a: any) => a.approvalId === approvalId);
    expect(pending, 'the approval must be re-opened, not stranded decided with no effect').toBe(true);
  });
});

/**
 * PMXWF-6 (ADR 0590, architect option (c)) — fork hygiene for the
 * run-reachable propose writer. `scn-${randomUUID()}` is replay-safe (the node
 * is role:action) but a `:fork` RE-EXECUTES the propose node with a fresh
 * runId, minting a duplicate scenario + a SECOND pending approval for the same
 * intent (fork ≠ resume: run-identity-derived ids cannot collapse this — the
 * tracker's prescribed fix (a) is a no-op for the named defect). The chosen
 * cure is CONTENT-KEYED, PENDING-GATED idempotency on the agent lane only: an
 * identical {sessionId,name,selection,constraints} re-propose while the prior
 * proposal's approval is still pending returns the existing scenario.
 */
describe('PMXWF-6 — fork-minted duplicate proposals collapse (content-keyed, pending-gated)', () => {
  const APPR = '/v1/host/openwop-app/approvals';
  const args = { name: 'Fork pick', selection: { mode: 'top-n', n: 2 } } as const;

  it('1) an IDENTICAL agent re-propose (the fork simulation) is idempotent: one scenario, one pending approval, same id', async () => {
    const { c, orgId, tenantId } = await login();
    const listId = (await c.post(`${PM}/lists`, { orgId, name: 'Bets', presetId: 'weighted' })).body.id;
    for (const t of ['Alpha', 'Beta']) await c.post(`${PM}/lists/${listId}/ideas`, { title: t });
    const sessionId = (await c.post(`${PM}/lists/${listId}/sessions`, { mode: 'top-n', n: 2 })).body.id;
    const surface = buildPriorityMatrixSurface({ tenantId });

    const first = JSON.parse(JSON.stringify(await surface.proposeScenario({ listId, sessionId, ...args })));
    const second = JSON.parse(JSON.stringify(await surface.proposeScenario({ listId, sessionId, ...args })));
    expect(second.scenario.scenarioId).toBe(first.scenario.scenarioId);

    const scenarios = (await c.get(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios`)).body.scenarios;
    expect(scenarios.filter((s: any) => s.name === 'Fork pick')).toHaveLength(1);
    const pending = (await c.get(`${APPR}?status=pending`)).body.items.filter((a: any) => a.kind === 'pm-scenario-select');
    expect(pending).toHaveLength(1);

    // 2) a DIFFERENT proposal still mints (dedup is content-keyed, not lane-keyed).
    await surface.proposeScenario({ listId, sessionId, name: 'Other pick', selection: { mode: 'top-n', n: 1 } });
    expect((await c.get(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios`)).body.scenarios).toHaveLength(2);
    expect((await c.get(`${APPR}?status=pending`)).body.items.filter((a: any) => a.kind === 'pm-scenario-select')).toHaveLength(2);
  });

  it('3) after the approval is DECIDED, an identical re-propose is a fresh ask (finality never resurrected)', async () => {
    const { c, orgId, tenantId } = await login();
    const listId = (await c.post(`${PM}/lists`, { orgId, name: 'Bets', presetId: 'weighted' })).body.id;
    for (const t of ['Alpha', 'Beta']) await c.post(`${PM}/lists/${listId}/ideas`, { title: t });
    const sessionId = (await c.post(`${PM}/lists/${listId}/sessions`, { mode: 'top-n', n: 2 })).body.id;
    const surface = buildPriorityMatrixSurface({ tenantId });

    const first = JSON.parse(JSON.stringify(await surface.proposeScenario({ listId, sessionId, ...args })));
    const row = (await c.get(`${APPR}?status=pending`)).body.items.find((a: any) => a.scenarioSelect?.scenarioId === first.scenario.scenarioId);
    expect((await c.post(`${APPR}/${row.approvalId}/reject`)).status).toBe(200);

    const again = JSON.parse(JSON.stringify(await surface.proposeScenario({ listId, sessionId, ...args })));
    expect(again.scenario.scenarioId).not.toBe(first.scenario.scenarioId);
    expect((await c.get(`${APPR}?status=pending`)).body.items.filter((a: any) => a.kind === 'pm-scenario-select')).toHaveLength(1);
  });

  it('4) the HUMAN lane is untouched: two same-named human adds mint two scenarios', async () => {
    const { c, orgId } = await login();
    const listId = (await c.post(`${PM}/lists`, { orgId, name: 'Bets', presetId: 'weighted' })).body.id;
    await c.post(`${PM}/lists/${listId}/ideas`, { title: 'Alpha' });
    const sessionId = (await c.post(`${PM}/lists/${listId}/sessions`, { mode: 'top-n', n: 1 })).body.id;
    for (let i = 0; i < 2; i++) {
      expect((await c.post(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios`, { name: 'Mine', selection: { mode: 'top-n', n: 1 } })).status).toBe(201);
    }
    expect((await c.get(`${PM}/lists/${listId}/sessions/${sessionId}/scenarios`)).body.scenarios).toHaveLength(2);
  });
});
