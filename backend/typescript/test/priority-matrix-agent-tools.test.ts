/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT #1) — the Prioritization Analyst's REAL
 * conversational tools resolve + enforce the same per-org RBAC as the
 * priority-matrix routes. Boots the REAL app (the ADR 0308 D2 registration seam
 * under test), mirroring app-builder-agent-tools.test.ts.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  PM_LIST_LISTS_TOOL_ID, PM_RANKED_IDEAS_TOOL_ID, PM_SCHEDULE_STATUS_TOOL_ID,
  PM_SUBMIT_IDEA_TOOL_ID, PM_SCORE_IDEA_TOOL_ID, PM_GENERATE_AGENDA_TOOL_ID,
} from '../src/features/priority-matrix/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';
import { createList } from '../src/features/priority-matrix/priorityMatrixService.js';
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
  const packDir = new URL('../../../packs/feature.priority-matrix.agents/', import.meta.url);
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
    const out = await provider().executeTool({ name: PM_LIST_LISTS_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toEqual({ lists: [] });
  });

  it('read tools fail closed (typed) when the toggle is off', async () => {
    await setPm('off');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: PM_LIST_LISTS_TOOL_ID, input: {} });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setPm('on');
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
    const { getCard } = await import('../src/host/kanbanService.js');
    expect((await getCard(cardId))?.source).toBe('agent');

    const score = await p.executeTool({ name: PM_SCORE_IDEA_TOOL_ID, input: { listId: list.id, cardId, scores: { roi: 8, urgency: 3, cost: 7 } } });
    expect(score.isError, score.content).toBeFalsy();
    const { getVoteBreakdown } = await import('../src/features/priority-matrix/priorityMatrixService.js');
    const votes = await getVoteBreakdown(TENANT, list.id, cardId);
    expect(votes).toHaveLength(1);
    expect(votes[0]!.voterId).toBe('u-1');
    expect(votes[0]!.source).toBe('agent');
  });

  it('an idea submitted by the RUN SURFACE is source:workflow; a route/service write stays source:human', async () => {
    await setPm('on');
    const list = await createList(TENANT, orgId, 'u-1', { name: 'Provenance 2' });
    const { buildPriorityMatrixSurface } = await import('../src/features/priority-matrix/surface.js');
    const surface = buildPriorityMatrixSurface({ tenantId: TENANT });
    const out = JSON.parse(JSON.stringify(await surface.submitIdea({ listId: list.id, title: 'Run-filed idea' }))) as { cardId: string };
    const { getCard } = await import('../src/host/kanbanService.js');
    expect((await getCard(out.cardId))?.source).toBe('workflow');

    const { submitIdea } = await import('../src/features/priority-matrix/priorityMatrixService.js');
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
    const { SCHEMA_READ_EXEMPT_TOOLS } = await import('../src/host/toolResultTransform.js');
    expect(SCHEMA_READ_EXEMPT_TOOLS).toContain(PM_LIST_LISTS_TOOL_ID);
    expect(SCHEMA_READ_EXEMPT_TOOLS).toContain(PM_RANKED_IDEAS_TOOL_ID);
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

    // ... and the ranked-ideas tool over that list does not leak it either.
    const rankedOut = await provider({ actingUserId: 'u-2' }).executeTool({ name: PM_RANKED_IDEAS_TOOL_ID, input: { listId: list.id } });
    expect(rankedOut.content).not.toContain('Secret backlog xyzzy');
  });
});
