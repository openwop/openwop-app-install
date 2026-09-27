/**
 * CFP-1 — the assistant personas' restored chat agency (ADR 0308 seam).
 *
 * The exchange contract under test: the three assistant personas
 * (chief-of-staff / extractor / drafter) allowlist tool ids that now RESOLVE to
 * real registered chat tools — reads that fail EMPTY without an acting user,
 * actions that fail TYPED and SUBMIT into the existing approval pipeline (never
 * send), gated on the SAME workspace:write authority the routes use. Boots the
 * REAL app (the `registerFeatureAgentTool` registration seam is what's under test).
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  ASSISTANT_LIST_COMMITMENTS_TOOL_ID,
  ASSISTANT_LIST_PENDING_ACTIONS_TOOL_ID,
  ASSISTANT_COMPOSE_BRIEFING_TOOL_ID,
  ASSISTANT_UPSERT_COMMITMENT_TOOL_ID,
  ASSISTANT_POPULATE_BOARD_TOOL_ID,
  ASSISTANT_ENQUEUE_ACTION_TOOL_ID,
} from '../src/features/assistant/agentTools.js';

// A personal workspace: the tenantId IS the owner's subject id, so the acting
// user is the implicit workspace owner and holds workspace:write (the same
// short-circuit `requireTenantScope`/`hasAssistantWriteAuthority` grant).
const TENANT = 'user:cfp-a1-tester';

const ALL_IDS = [
  ASSISTANT_LIST_COMMITMENTS_TOOL_ID,
  ASSISTANT_LIST_PENDING_ACTIONS_TOOL_ID,
  ASSISTANT_COMPOSE_BRIEFING_TOOL_ID,
  ASSISTANT_UPSERT_COMMITMENT_TOOL_ID,
  ASSISTANT_POPULATE_BOARD_TOOL_ID,
  ASSISTANT_ENQUEUE_ACTION_TOOL_ID,
];

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function provider(scope: { actingUserId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}
const parse = (out: { content: string }) => JSON.parse(out.content) as Record<string, unknown>;

describe('CFP-1 — registration + pack allowlist honesty', () => {
  it('all six assistant tools register into the builtin surface', () => {
    const ids = builtinAgentToolIds();
    for (const id of ALL_IDS) expect(ids).toContain(id);
  });

  it('every toolAllowlist entry in the assistant.agents pack resolves to a real chat tool', () => {
    const universe = new Set(builtinAgentToolIds());
    const manifest = JSON.parse(
      readFileSync(new URL('../../../packs/feature.assistant.agents/pack.json', import.meta.url), 'utf8'),
    ) as { agents: { toolAllowlist: string[] }[] };
    const unresolved: string[] = [];
    for (const agent of manifest.agents) {
      for (const entry of agent.toolAllowlist) if (!universe.has(entry)) unresolved.push(entry);
    }
    expect(unresolved, `allowlist entries that resolve to nothing:\n${unresolved.join('\n')}`).toEqual([]);
  });

  it('the pruned node-typeId + egress ids are gone from every allowlist', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../packs/feature.assistant.agents/pack.json', import.meta.url), 'utf8'),
    ) as { agents: { toolAllowlist: string[] }[] };
    const all = manifest.agents.flatMap((a) => a.toolAllowlist);
    for (const gone of [
      'openwop:feature.assistant.nodes.upsert-commitment',
      'openwop:feature.kb.nodes.rag',
      'openwop:feature.strategy.nodes.get-strategy',
      'openwop:core.openwop.mcp.invoke-tool',
      'openwop:core.openwop.http.openapi-call',
    ]) {
      expect(all).not.toContain(gone);
    }
    // The pure `prioritize` node IS projected — it stays.
    expect(all).toContain('openwop:feature.assistant.nodes.prioritize');
  });
});

describe('CFP-1 — reads fail EMPTY without an acting user', () => {
  it('list-commitments returns empty for a system turn', async () => {
    const out = await provider().executeTool({ name: ASSISTANT_LIST_COMMITMENTS_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(parse(out)).toEqual({ commitments: [] });
  });

  it('list-pending-actions returns empty for a system turn', async () => {
    const out = await provider().executeTool({ name: ASSISTANT_LIST_PENDING_ACTIONS_TOOL_ID, input: {} });
    expect(parse(out)).toEqual({ pendingActions: [] });
  });

  it('compose-briefing returns a null brief for a system turn', async () => {
    const out = await provider().executeTool({ name: ASSISTANT_COMPOSE_BRIEFING_TOOL_ID, input: {} });
    expect(parse(out).brief).toBeNull();
  });
});

describe('CFP-1 — actions fail TYPED without an acting user', () => {
  it('upsert-commitment refuses a system turn', async () => {
    const out = await provider().executeTool({ name: ASSISTANT_UPSERT_COMMITMENT_TOOL_ID, input: { description: 'x' } });
    expect(out.isError).toBe(true);
    expect(parse(out)).toMatchObject({ error: 'acting_user_required' });
  });

  it('enqueue-action refuses a system turn', async () => {
    const out = await provider().executeTool({ name: ASSISTANT_ENQUEUE_ACTION_TOOL_ID, input: { kind: 'email.send', draft: 'hi' } });
    expect(out.isError).toBe(true);
    expect(parse(out)).toMatchObject({ error: 'acting_user_required' });
  });

  it('populate-board refuses a system turn', async () => {
    const out = await provider().executeTool({ name: ASSISTANT_POPULATE_BOARD_TOOL_ID, input: { commitmentId: 'c1' } });
    expect(out.isError).toBe(true);
    expect(parse(out)).toMatchObject({ error: 'acting_user_required' });
  });
});

describe('CFP-1 — validation + happy path (workspace owner)', () => {
  const owner = provider({ actingUserId: TENANT, runId: 'run-cfp-a1' });

  it('upsert-commitment rejects a blank description with a typed error', async () => {
    const out = await owner.executeTool({ name: ASSISTANT_UPSERT_COMMITMENT_TOOL_ID, input: { description: '   ' } });
    expect(out.isError).toBe(true);
    expect(parse(out)).toMatchObject({ error: 'validation_error' });
  });

  it('upsert-commitment records a commitment the read tool then returns', async () => {
    const created = await owner.executeTool({
      name: ASSISTANT_UPSERT_COMMITMENT_TOOL_ID,
      input: {
        description: 'Send the Q3 board deck',
        owner: { kind: 'self' },
        source: { kind: 'gmail', externalId: 'msg-1' },
        confidence: 0.9,
      },
    });
    expect(created.isError).toBeFalsy();
    const c = parse(created).commitment as { commitmentId: string; description: string };
    expect(c.description).toBe('Send the Q3 board deck');

    const listed = await owner.executeTool({ name: ASSISTANT_LIST_COMMITMENTS_TOOL_ID, input: {} });
    const commitments = parse(listed).commitments as { commitmentId: string }[];
    expect(commitments.some((x) => x.commitmentId === c.commitmentId)).toBe(true);
  });

  it('enqueue-action rejects an unknown kind and submits a valid one for approval', async () => {
    const bad = await owner.executeTool({ name: ASSISTANT_ENQUEUE_ACTION_TOOL_ID, input: { kind: 'launch.rocket', draft: 'go' } });
    expect(bad.isError).toBe(true);
    expect(parse(bad)).toMatchObject({ error: 'validation_error' });

    const good = await owner.executeTool({
      name: ASSISTANT_ENQUEUE_ACTION_TOOL_ID,
      input: { kind: 'email.send', draft: 'Thanks — sending the deck now.', payload: { to: 'chair@example.com', subject: 'Board deck' } },
    });
    expect(good.isError).toBeFalsy();
    const queued = parse(good).queued as { actionId?: string; status?: string };
    expect(typeof queued.actionId).toBe('string');
    expect(queued.status).toBe('pending');

    // The submitted draft now shows up in the approval queue read.
    const pending = await owner.executeTool({ name: ASSISTANT_LIST_PENDING_ACTIONS_TOOL_ID, input: {} });
    const actions = parse(pending).pendingActions as { actionId: string }[];
    expect(actions.some((a) => a.actionId === queued.actionId)).toBe(true);
  });

  it('populate-board no-ops safely on an unknown commitment (no throw)', async () => {
    const out = await owner.executeTool({ name: ASSISTANT_POPULATE_BOARD_TOOL_ID, input: { commitmentId: 'nope' } });
    expect(out.isError).toBeFalsy();
    expect(parse(out)).toMatchObject({ card: null, created: false });
  });
});
