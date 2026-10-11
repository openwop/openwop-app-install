/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT #1) — the Prioritization Analyst's REAL
 * conversational tools resolve + enforce the same per-org RBAC as the
 * priority-matrix routes. Boots the REAL app (the ADR 0308 D2 registration seam
 * under test), mirroring app-builder-agent-tools.test.ts.
 *
 * Sabotage map (wave 15, `w15g1-at-*`): a renamed tool id / an allowlist drift, the
 * subjectless FAIL-EMPTY arm, the toggle refusal, the acting-user + not-found gates,
 * the ranked read, numeric-string coercion vs the range refusal, the D1c `unscored` /
 * `partiallyScored` keying (re-keyed on priority 0, it reds the WSJF case), the PMXU-1
 * `agent` / `workflow` / `human` stamps, and the ADR 0610 D3′ project gate on BOTH read
 * tools each turn a case red.
 * CEILING (PMX-15): the static SCHEMA_READ_EXEMPT_TOOLS entries are a rename tripwire —
 * `schemaCarrying: true` exempts these tools anyway, so dropping an entry changes no
 * behaviour; the completeness ratchet (schema-read-exemption-completeness) owns that.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getCard } from '../src/host/kanbanService.js';
import { SCHEMA_READ_EXEMPT_TOOLS, isSchemaReadExempt } from '../src/host/toolResultTransform.js';
import { buildPriorityMatrixSurface } from '../src/features/priority-matrix/surface.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  PM_LIST_LISTS_TOOL_ID, PM_RANKED_IDEAS_TOOL_ID, PM_SCHEDULE_STATUS_TOOL_ID,
  PM_SUBMIT_IDEA_TOOL_ID, PM_SCORE_IDEA_TOOL_ID, PM_GENERATE_AGENDA_TOOL_ID,
} from '../src/features/priority-matrix/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';
import { createList, submitIdea, getVoteBreakdown } from '../src/features/priority-matrix/priorityMatrixService.js';
import { createProject, setProjectVisibility } from '../src/features/projects/projectsService.js';

const TENANT = 'default';
const ALL_IDS = [
  PM_LIST_LISTS_TOOL_ID, PM_RANKED_IDEAS_TOOL_ID, PM_SCHEDULE_STATUS_TOOL_ID,
  PM_SUBMIT_IDEA_TOOL_ID, PM_SCORE_IDEA_TOOL_ID, PM_GENERATE_AGENDA_TOOL_ID,
];

let server: http.Server;
let orgId: string;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  const org = await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  orgId = org.orgId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setPm = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('priority-matrix');
  if (d) await saveConfig({ ...d, status }, 'test');
};

function provider(scope: { actingUserId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

describe('CFP-1 — priority-matrix agent tools register + the pack rides exactly them', () => {
  const packDir = new URL('../../../packs/vendor.openwop-app.priority-matrix.agents/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('pack.json', packDir), 'utf8')) as { agents: { toolAllowlist: string[] }[] };

  it('all six tools register into the builtin surface', () => {
    const ids = builtinAgentToolIds();
    for (const id of ALL_IDS) expect(ids).toContain(id);
  });

  it('the allowlist is exactly the six registered tool ids', () => {
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual([...ALL_IDS].sort());
  });
});

describe('CFP-1 — priority-matrix read tools: toggle + acting-user gates', () => {
  it('list-lists returns the readable lists for an acting user', async () => {
    await setPm('on');
    const list = await createList(TENANT, orgId, 'u-1', { name: 'Roadmap' });
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: PM_LIST_LISTS_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { lists: { listId: string; name: string }[] };
    expect(parsed.lists.some((l) => l.listId === list.id && l.name === 'Roadmap')).toBe(true);
  });

  it('read tools FAIL EMPTY without an acting user', async () => {
    await setPm('on');
    // A list that EXISTS, so the empty answer is a refusal and not an empty tenant
    // (this case used to pass vacuously when it ran first).
    const list = await createList(TENANT, orgId, 'u-1', { name: 'Exists for fail-empty' });
    const control = await provider({ actingUserId: 'u-1' }).executeTool({ name: PM_LIST_LISTS_TOOL_ID, input: {} });
    expect(control.content).toContain(list.id);
    const out = await provider().executeTool({ name: PM_LIST_LISTS_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toEqual({ lists: [] });
  });

  it('read tools fail closed (typed) when the toggle is off', async () => {
    await setPm('off');
    try {
      const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: PM_LIST_LISTS_TOOL_ID, input: {} });
      expect(out.isError).toBe(true);
      expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    } finally { await setPm('on'); }
  });
});

describe('CFP-1 — priority-matrix action tools: RBAC parity + real writes', () => {
  it('submit-idea requires a human-initiated turn (typed)', async () => {
    await setPm('on');
    const list = await createList(TENANT, orgId, 'u-1', { name: 'Backlog' });
    const out = await provider().executeTool({ name: PM_SUBMIT_IDEA_TOOL_ID, input: { listId: list.id, title: 'Idea' } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('submit-idea captures a real card the ranked-ideas read then returns', async () => {
    await setPm('on');
    const list = await createList(TENANT, orgId, 'u-1', { name: 'Intake' });
    const p = provider({ actingUserId: 'u-1' });
    const sub = await p.executeTool({ name: PM_SUBMIT_IDEA_TOOL_ID, input: { listId: list.id, title: 'Ship dark mode' } });
    expect(sub.isError).toBeFalsy();
    const { cardId } = JSON.parse(sub.content) as { cardId: string };
    expect(cardId).toBeTruthy();
    const ranked = await p.executeTool({ name: PM_RANKED_IDEAS_TOOL_ID, input: { listId: list.id } });
    const parsed = JSON.parse(ranked.content) as { ideas: { cardId: string; title: string }[] };
    expect(parsed.ideas.some((i) => i.cardId === cardId && i.title === 'Ship dark mode')).toBe(true);
  });

  it('a missing/unreadable list is a uniform not-found for a write', async () => {
    await setPm('on');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: PM_SUBMIT_IDEA_TOOL_ID, input: { listId: 'nope', title: 'x' } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'not_found' });
  });
});

describe('R3 — score-idea takes numeric strings; ranked-ideas marks the unscored sentinel', () => {
  it('a numeric STRING score is coerced and recorded (the service always took it; the tool refused it)', async () => {
    await setPm('on');
    const list = await createList(TENANT, orgId, 'u-1', { name: 'R3 strings', presetId: 'weighted' });
    const p = provider({ actingUserId: 'u-1' });
    const sub = await p.executeTool({ name: PM_SUBMIT_IDEA_TOOL_ID, input: { listId: list.id, title: 'Stringly scored' } });
    const { cardId } = JSON.parse(sub.content) as { cardId: string };
    const scores = Object.fromEntries(list.criteriaSet.criteria.map((c) => [c.id, '7']));
    const out = await p.executeTool({ name: PM_SCORE_IDEA_TOOL_ID, input: { listId: list.id, cardId, scores } });
    expect(out.isError, out.content).toBeFalsy();
    expect((JSON.parse(out.content) as { computedPriority: number }).computedPriority).toBeGreaterThan(0);
  });

  it('a NON-numeric string is still a typed refusal, not a silent drop', async () => {
    await setPm('on');
    const list = await createList(TENANT, orgId, 'u-1', { name: 'R3 refuse', presetId: 'weighted' });
    const p = provider({ actingUserId: 'u-1' });
    const sub = await p.executeTool({ name: PM_SUBMIT_IDEA_TOOL_ID, input: { listId: list.id, title: 'Vibes scored' } });
    const { cardId } = JSON.parse(sub.content) as { cardId: string };
    const scores = { [list.criteriaSet.criteria[0]!.id]: 'high' };
    const out = await p.executeTool({ name: PM_SCORE_IDEA_TOOL_ID, input: { listId: list.id, cardId, scores } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'validation_error' });
  });

  it('ranked-ideas flags priority 0 as `unscored: true`, and never flags a scored idea', async () => {
    await setPm('on');
    const list = await createList(TENANT, orgId, 'u-1', { name: 'R3 sentinel', presetId: 'weighted' });
    const p = provider({ actingUserId: 'u-1' });
    const s1 = await p.executeTool({ name: PM_SUBMIT_IDEA_TOOL_ID, input: { listId: list.id, title: 'Scored' } });
    const s2 = await p.executeTool({ name: PM_SUBMIT_IDEA_TOOL_ID, input: { listId: list.id, title: 'Blank' } });
    const scoredId = (JSON.parse(s1.content) as { cardId: string }).cardId;
    const blankId = (JSON.parse(s2.content) as { cardId: string }).cardId;
    const scores = Object.fromEntries(list.criteriaSet.criteria.map((c) => [c.id, 6]));
    await p.executeTool({ name: PM_SCORE_IDEA_TOOL_ID, input: { listId: list.id, cardId: scoredId, scores } });
    const ranked = await p.executeTool({ name: PM_RANKED_IDEAS_TOOL_ID, input: { listId: list.id } });
    const ideas = (JSON.parse(ranked.content) as { ideas: { cardId: string; priority: number; unscored?: boolean }[] }).ideas;
    const blank = ideas.find((i) => i.cardId === blankId)!;
    const scored = ideas.find((i) => i.cardId === scoredId)!;
    expect(blank.priority).toBe(0);
    expect(blank.unscored).toBe(true);          // the sentinel is DISCLOSED
    expect(scored.priority).toBeGreaterThan(0);
    expect(scored.unscored).toBeUndefined();    // …and never smeared onto a scored idea
  });

  // ADR 0667 D1c — on a `weighted` list "priority 0" and "nothing scored" coincide, so the
  // case above cannot tell the old keying from the new. A WSJF (ratio) list separates them:
  // a blank job-size makes a 3-of-4-scored idea priority 0, and a partially scored idea
  // can still carry a non-zero priority.
  it('D1c — on a WSJF list, ranked-ideas keys unscored / partiallyScored on completeness, not on priority 0', async () => {
    await setPm('on');
    const list = await createList(TENANT, orgId, 'u-1', { name: 'D1c wsjf', presetId: 'wsjf' });
    expect(list.criteriaSet.criteria.map((c) => c.id)).toEqual(['user-business-value', 'time-criticality', 'risk-reduction', 'job-size']);
    const p = provider({ actingUserId: 'u-1' });
    const capture = async (title: string): Promise<string> =>
      (JSON.parse((await p.executeTool({ name: PM_SUBMIT_IDEA_TOOL_ID, input: { listId: list.id, title } })).content) as { cardId: string }).cardId;
    const score = async (cardId: string, scores: Record<string, number>): Promise<void> => {
      const out = await p.executeTool({ name: PM_SCORE_IDEA_TOOL_ID, input: { listId: list.id, cardId, scores } });
      expect(out.isError, out.content).toBeFalsy();
    };
    const noJobSize = await capture('Cost of delay, no job size');
    const partialNonZero = await capture('Partly scored, non-zero');
    const complete = await capture('Fully scored');
    const blank = await capture('Not scored');
    await score(noJobSize, { 'user-business-value': 10, 'time-criticality': 10, 'risk-reduction': 10 });
    await score(partialNonZero, { 'user-business-value': 8, 'time-criticality': 6, 'job-size': 3 });
    await score(complete, { 'user-business-value': 8, 'time-criticality': 6, 'risk-reduction': 4, 'job-size': 3 });

    type Row = { cardId: string; priority: number; unscored?: boolean; partiallyScored?: { scored: number; declared: number; missing: string[] } };
    const ranked = await p.executeTool({ name: PM_RANKED_IDEAS_TOOL_ID, input: { listId: list.id } });
    const ideas = (JSON.parse(ranked.content) as { ideas: Row[] }).ideas;
    const row = (id: string): Row => ideas.find((i) => i.cardId === id)!;

    // 3 of 4 scored, priority exactly 0 — NOT unscored (priority-0 keying lied here).
    expect(row(noJobSize).priority).toBe(0);
    expect(row(noJobSize).unscored).toBeUndefined();
    expect(row(noJobSize).partiallyScored).toEqual({ scored: 3, declared: 4, missing: ['job-size'] });
    // Partially scored with a NON-zero priority — still disclosed as partial.
    expect(row(partialNonZero).priority).toBeGreaterThan(0);
    expect(row(partialNonZero).unscored).toBeUndefined();
    expect(row(partialNonZero).partiallyScored).toEqual({ scored: 3, declared: 4, missing: ['risk-reduction'] });
    // Complete: neither flag.
    expect(row(complete).unscored).toBeUndefined();
    expect(row(complete).partiallyScored).toBeUndefined();
    // Nothing scored: both.
    expect(row(blank).unscored).toBe(true);
    expect(row(blank).partiallyScored).toEqual({ scored: 0, declared: 4, missing: ['user-business-value', 'time-criticality', 'risk-reduction', 'job-size'] });
  });
});

/**
 * PMXU-1 (ADR 0590, Blocker) — AI-written ideas and AI-cast scores must be
 * DISTINGUISHABLE from a human's at the write. `card.source` was hard-coded
 * 'human' for every idea regardless of writer (despite KanbanCardSource
 * supporting workflow/agent), and score/vote rows carried no source at all —
 * so provenance was unbackfillable. The writer now stamps truthfully: chat
 * tools = 'agent', run-surface verbs = 'workflow', routes default 'human'.
 * Existing rows are untouched (absence of a stamp = pre-fix row, ADR 0590).
 */
describe('PMXU-1 — AI provenance stamped at the writer', () => {
  it('an idea captured by the CHAT TOOL is source:agent; its score-row is stamped agent', async () => {
    await setPm('on');
    const list = await createList(TENANT, orgId, 'u-1', { name: 'Provenance', votingMode: 'multi-voter' });
    const p = provider({ actingUserId: 'u-1' });
    const sub = await p.executeTool({ name: PM_SUBMIT_IDEA_TOOL_ID, input: { listId: list.id, title: 'Agent-captured idea' } });
    expect(sub.isError).toBeFalsy();
    const { cardId } = JSON.parse(sub.content) as { cardId: string };
    expect((await getCard(cardId))?.source).toBe('agent');

    const score = await p.executeTool({ name: PM_SCORE_IDEA_TOOL_ID, input: { listId: list.id, cardId, scores: { roi: 8, urgency: 3, cost: 7 } } });
    expect(score.isError, score.content).toBeFalsy();
    const votes = await getVoteBreakdown(TENANT, list.id, cardId);
    expect(votes).toHaveLength(1);
    expect(votes[0]!.voterId).toBe('u-1');
    expect(votes[0]!.source).toBe('agent');
  });

  it('an idea submitted by the RUN SURFACE is source:workflow; a route/service write stays source:human', async () => {
    await setPm('on');
    const list = await createList(TENANT, orgId, 'u-1', { name: 'Provenance 2' });
    const surface = buildPriorityMatrixSurface({ tenantId: TENANT });
    const out = JSON.parse(JSON.stringify(await surface.submitIdea({ listId: list.id, title: 'Run-filed idea' }))) as { cardId: string };
    expect((await getCard(out.cardId))?.source).toBe('workflow');

    const humanCard = await submitIdea(TENANT, list.id, 'u-1', { title: 'Human idea' });
    expect((await getCard(humanCard.id))?.source).toBe('human');
  });
});

/**
 * PMX-15 (ADR 0590) — schema-carrying tool outputs are NEVER compacted (the
 * CLAUDE.md non-negotiable): with tool-output-compaction ON, a truncated
 * criteria array feeds the model wrong scoring ids. Parity is asserted against
 * the EXPORTED tool-id constants so a renamed id breaks this test, not the
 * exemption.
 */
describe('PMX-15 — the two schema-carrying tool ids are compaction-exempt', () => {
  it('SCHEMA_READ_EXEMPT_TOOLS carries list-lists and list-ranked-ideas by their exported ids', async () => {
    expect(SCHEMA_READ_EXEMPT_TOOLS).toContain(PM_LIST_LISTS_TOOL_ID);
    expect(SCHEMA_READ_EXEMPT_TOOLS).toContain(PM_RANKED_IDEAS_TOOL_ID);
    // The behaviour the entries exist for: compaction skips both tools.
    expect(isSchemaReadExempt(PM_LIST_LISTS_TOOL_ID)).toBe(true);
    expect(isSchemaReadExempt(PM_RANKED_IDEAS_TOOL_ID)).toBe(true);
  });
});

// ADR 0610 D3′ / CPC-14 — the agent-tool read doors must honor the SAME project
// membership gate the REST `loadListScoped` uses (ADR 0308/0610 D2: routes and
// tools cannot drift). Adversarial-review finding: they gated on org scope only.
describe("ADR 0610 D3' — pm agent read tools honor the project membership gate", () => {
  it('a non-member org reader does not see a private project-bound list; the owner does', async () => {
    await setPm('on');
    // u-1 is the org owner (createOrg ownerSubject). A PRIVATE project owned by u-1,
    // and a project-bound list on it.
    const project = await createProject(TENANT, orgId, { name: 'Secret' });
    await setProjectVisibility(TENANT, project.id, 'private');
    const list = await createList(TENANT, orgId, 'u-1', { name: 'Secret backlog xyzzy', projectId: project.id });
    // An idea on the private list, so a leaked ranked read is OBSERVABLE (the tool never
    // emits the list name, and an empty list reads `{ ideas: [] }` either way).
    await submitIdea(TENANT, list.id, 'u-1', { title: 'Hidden idea plover' });
    // A different org member with workspace:read who is NOT a project member.
    await createMember({ orgId, tenantId: TENANT, displayName: 'V', subject: 'u-2', roles: ['viewer'] });

    // Positive control: the OWNER's list-lists includes the project list.
    const ownerOut = await provider({ actingUserId: 'u-1' }).executeTool({ name: PM_LIST_LISTS_TOOL_ID, input: {} });
    const ownerLists = (JSON.parse(ownerOut.content) as { lists: { listId: string }[] }).lists;
    expect(ownerLists.some((l) => l.listId === list.id)).toBe(true);

    // The non-member does NOT see it in list-lists ...
    const viewerOut = await provider({ actingUserId: 'u-2' }).executeTool({ name: PM_LIST_LISTS_TOOL_ID, input: {} });
    expect(viewerOut.isError).toBeFalsy();
    const viewerLists = (JSON.parse(viewerOut.content) as { lists: { listId: string }[] }).lists;
    expect(viewerLists.some((l) => l.listId === list.id)).toBe(false);
    expect(viewerOut.content).not.toContain('Secret backlog xyzzy');

    // ... and the ranked-ideas tool over that list does not leak its ideas either
    // (positive control: the owner's ranked read carries the idea).
    const ownerRanked = await provider({ actingUserId: 'u-1' }).executeTool({ name: PM_RANKED_IDEAS_TOOL_ID, input: { listId: list.id } });
    expect(ownerRanked.content).toContain('plover');
    const rankedOut = await provider({ actingUserId: 'u-2' }).executeTool({ name: PM_RANKED_IDEAS_TOOL_ID, input: { listId: list.id } });
    expect(rankedOut.isError).toBeFalsy();
    expect((JSON.parse(rankedOut.content) as { ideas: unknown[] }).ideas).toEqual([]);
    expect(rankedOut.content).not.toContain('plover');
  });
});
