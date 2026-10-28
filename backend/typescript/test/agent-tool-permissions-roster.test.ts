/**
 * ADR 0775 D3/D4 — the ADR 0102 per-tool gate reaches a ROSTER agent, on the
 * real run path and the voice lane, and voice resolves an agent within its tenant.
 *
 * `ARWF-4`: `resolveAgentToolPermissions` only answers a `host:` id, and every
 * dispatch passed the REGISTRY id — so a roster member's `never` list never
 * reached the gate, not even its shadow log, with enforcement ON. The existing
 * gate tests (`agent-tool-permissions.test.ts`) inject `toolPermissions`
 * directly, which is why they could not see it (GEN-AR-2). These drive the real
 * resolver from a real roster entry + profile, through `runAgentDispatchLive` and
 * `executeRealtimeToolCall`, including two members that SHARE one agent.
 *
 * `ARWF-5`: voice looked its agent up across every tenant, so a session could be
 * offered and run another tenant's same-named `user.<slug>` agent's tools.
 *
 * Refusals are pinned by the exact guardrails line the loop feeds back to the
 * model (six branches share `status:'forbidden'`).
 *
 * TST-BLT-2. Red when: `never` stops denying, the enforcing branch is skipped, a
 * `host:` addressed id stops naming exactly one member, dispatch drops the
 * addressed id, the legacy-spelling match is a raw `===`, or voice skips the
 * permission set (w65 probes).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getAgentRegistry, type ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import { runAgentDispatchLive, type AgentToolDef, type LiveDispatchDeps } from '../src/host/agentDispatch.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import { upsertAgentProfile } from '../src/host/agentProfileService.js';
import { executeRealtimeToolCall } from '../src/features/voice/realtime/toolBridge.js';
import { resolveAgentIdentity, __clearAgentIdentityCache } from '../src/host/agentIdentity.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';

const FLAG = 'OPENWOP_AGENT_TOOL_PERMISSIONS_ENABLED';
const T = 'ws-perm-roster';
const AGENT = 'perm.shared-agent';

const SEARCH: AgentToolDef = { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {}, additionalProperties: true } };
const resolveTool: LiveDispatchDeps['resolveTool'] = (n) => (n === 'search' ? SEARCH : undefined);

let guarded: string;
let open: string;

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  getAgentRegistry().register({
    agentId: AGENT, persona: 'Shared', modelClass: 'general', systemPrompt: 'Use tools.',
    packName: 'test', packVersion: '0', toolAllowlist: ['search'], confidence: { defaultThreshold: 0.5 },
  });
  // Two roster members built on the SAME agent: only one carries a guardrail.
  guarded = (await createRosterEntry({ tenantId: T, persona: 'Guarded Member', agentRef: { agentId: AGENT } })).rosterId;
  open = (await createRosterEntry({ tenantId: T, persona: 'Open Member', agentRef: { agentId: AGENT } })).rosterId;
  await upsertAgentProfile(T, guarded, {
    roleKey: 'analyst',
    permissions: { read: [], write: [], never: ['search'] },
    autonomy: { specLevel: 'draft-only' },
  });
  process.env[FLAG] = 'true';
});
afterEach(() => { process.env[FLAG] = 'true'; });
afterAll(() => {
  delete process.env[FLAG];
  getAgentRegistry()._resetForTest();
  __resetHostExtPersistence();
});

async function dispatch(addressed: string | undefined): Promise<{ executed: string[]; forbidden: boolean; feedback: string }> {
  let round = 0;
  const seen: AiToolCallRequest[] = [];
  const callAIWithTools = async (req: AiToolCallRequest): Promise<AiToolCallResult> => {
    seen.push(req);
    round += 1;
    return round === 1
      ? { toolCalls: [{ id: 'c1', name: 'search', input: {} }], finishReason: 'tool-call' }
      : { content: 'done', toolCalls: [], finishReason: 'stop' };
  };
  const executed: string[] = [];
  const res = await runAgentDispatchLive(
    { agentId: AGENT, task: 'look it up', availableTools: ['search'] },
    {
      callAI: async () => { throw new Error('single completion not expected'); },
      callAIWithTools,
      resolveTool,
      executeTool: async (c) => { executed.push(c.name); return { content: 'r' }; },
      tenantId: T,
      ...(addressed ? { agentAddressedId: addressed } : {}),
    },
  );
  const forbidden = res.events.some((e) => e.type === 'agent.toolReturned' && (e as { status?: string }).status === 'forbidden');
  const msgs = seen[1]?.messages ?? [];
  const last = msgs[msgs.length - 1];
  return { executed, forbidden, feedback: typeof last?.content === 'string' ? last.content : '' };
}

/** The line the loop feeds back when a member's never-list refuses `search`. */
const NEVER_LINE = /^Tool "search" is blocked by .+'s guardrails \(never\)\.$/;

describe('ADR 0775 D3 — the per-tool gate sees roster agents (run path)', () => {
  it('addressed by the REGISTRY id: every member sharing the agent binds, so the guarded member’s never-list refuses', async () => {
    const r = await dispatch(undefined);
    expect(r.executed, 'the never-listed tool must not run').toEqual([]);
    expect(r.forbidden).toBe(true);
    expect(r.feedback).toMatch(NEVER_LINE);
  });

  it('addressed by the GUARDED member’s roster id: refused', async () => {
    const r = await dispatch(guarded);
    expect(r.executed).toEqual([]);
    expect(r.forbidden).toBe(true);
    expect(r.feedback).toMatch(NEVER_LINE);
  });

  it('addressed by the OPEN member’s roster id: exactly that member binds — it runs', async () => {
    const r = await dispatch(open);
    expect(r.executed).toEqual(['search']);
    expect(r.forbidden).toBe(false);
  });

  it('enforcement OFF: shadow only — the call runs', async () => {
    delete process.env[FLAG];
    const r = await dispatch(guarded);
    expect(r.executed).toEqual(['search']);
  });
});

describe('grade-code ARCD-1 — a LEGACY-spelled roster member binds too', () => {
  it('a member stored under the pre-rename `feature.*.agents.*` id is refused on the canonical dispatch', async () => {
    const canonical = 'vendor.openwop-app.permprobe.agents.x';
    const legacy = 'feature.permprobe.agents.x';
    getAgentRegistry().register({
      agentId: canonical, persona: 'Renamed', modelClass: 'general', systemPrompt: 'Use tools.',
      packName: 'test', packVersion: '0', toolAllowlist: ['search'], confidence: { defaultThreshold: 0.5 },
    });
    // ADR 0763 left roster rows unmigrated: this row keeps the LEGACY spelling.
    const m = (await createRosterEntry({ tenantId: T, persona: 'Legacy Member', agentRef: { agentId: legacy } })).rosterId;
    await upsertAgentProfile(T, m, { roleKey: 'analyst', permissions: { read: [], write: [], never: ['search'] }, autonomy: { specLevel: 'draft-only' } });
    // The identity reverse index is a 30 s TTL cache per tenant (agentIdentity.ts);
    // an earlier case in this tenant may have filled it before this member
    // existed. Drop it so the case does not depend on run order.
    __clearAgentIdentityCache();
    let round = 0;
    const executed: string[] = [];
    const seen: AiToolCallRequest[] = [];
    const res = await runAgentDispatchLive(
      { agentId: canonical, task: 'look it up', availableTools: ['search'] },
      {
        callAI: async () => { throw new Error('single completion not expected'); },
        callAIWithTools: async (req) => (seen.push(req), ++round === 1
          ? { toolCalls: [{ id: 'c1', name: 'search', input: {} }], finishReason: 'tool-call' }
          : { content: 'done', toolCalls: [], finishReason: 'stop' }),
        resolveTool,
        executeTool: async (c) => { executed.push(c.name); return { content: 'r' }; },
        tenantId: T,
      },
    );
    expect(executed, 'the legacy-spelled member’s never-list must bind').toEqual([]);
    expect(res.events.some((e) => e.type === 'agent.toolReturned' && (e as { status?: string }).status === 'forbidden')).toBe(true);
    const fed = seen[1]?.messages.at(-1)?.content;
    expect(typeof fed === 'string' ? fed : '').toMatch(NEVER_LINE);

    // Voice, addressed by the canonical registry id: the same member binds.
    const voice = await executeRealtimeToolCall({ tenantId: T, agentId: canonical, sessionId: `s-legacy-${Date.now()}`, name: 'search', args: {} });
    expect(voice.status).toBe('denied');
    expect(voice.status === 'denied' ? voice.reason : '').toMatch(/guardrails \(never\)/);
    // The chat + voice identity resolver finds the legacy-spelled member (its
    // profile, knowledge and memory ride this) — the raw-keyed reverse index missed it.
    expect((await resolveAgentIdentity(T, canonical, { allowReverseScan: true })).profileId).toBe(m);
  });
});

describe('ADR 0775 D3/D4 — voice', () => {
  it('voice evaluates the roster member’s never-list (it never did)', async () => {
    const out = await executeRealtimeToolCall({ tenantId: T, agentId: guarded, sessionId: `s-${Date.now()}`, name: 'search', args: {} });
    expect(out.status).toBe('denied');
    expect(out.status === 'denied' ? out.reason : '').toMatch(/guardrails/);
  });

  it('voice resolves a user agent within ITS tenant, never a same-named agent of another tenant', async () => {
    const reg = getAgentRegistry();
    const base: Pick<ResolvedAgentManifest, 'persona' | 'modelClass' | 'systemPrompt' | 'packName' | 'packVersion'> = { persona: 'Dup', modelClass: 'general', systemPrompt: 'x', packName: 'user', packVersion: '0' };
    // Registered FIRST, so a cross-tenant `find` over the registry returns it.
    reg.register({ ...base, agentId: 'user.dup', toolAllowlist: ['foreign.only-tool'], ownerTenant: 'ws-other-tenant' });
    reg.register({ ...base, agentId: 'user.dup', toolAllowlist: [], ownerTenant: T });
    const out = await executeRealtimeToolCall({ tenantId: T, agentId: 'user.dup', sessionId: `s2-${Date.now()}`, name: 'foreign.only-tool', args: {} });
    expect(out.status).toBe('denied');
    expect(out.status === 'denied' ? out.reason : '').toMatch(/not in this agent's allowlist/);
  });
});
