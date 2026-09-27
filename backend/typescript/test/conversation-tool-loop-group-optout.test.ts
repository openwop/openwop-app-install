/**
 * Group rooms skip the tool loop (product call 2026-07-15): a cadence of
 * tool-looping advisors fires maxRounds×N model calls in tight succession and
 * bombards the provider (free tiers die mid-board), while advisor grounding
 * rides prompt-side knowledge injection (ADR 0043 Phase 5B). Pins the gate:
 * `tier.conversationType === 'group'` ⇒ immediate null (single completion)
 * BEFORE any dependency is touched — the policyResolver trap proves the gate
 * fires first. (The OPENWOP_GROUP_ROOM_TOOL_LOOP=true escape hatch and the
 * non-group path proceed to the eligibility gates, which need live host
 * services — covered by the conversation-exchange integration tests.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  runConversationAgentToolTurn,
  groupRoomToolLoopOptedOut,
  applyGroupRoomScaffoldNotice,
  GROUP_ROOM_NO_TOOLS_NOTICE,
} from '../src/host/conversationToolLoop.js';
import type { RunRecord } from '../src/types.js';

const run: RunRecord = {
  runId: 'r1', workflowId: 'openwop-app.conversation', tenantId: 't1', status: 'waiting-input',
  inputs: { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'byok:google:1' },
  metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x',
};

const trap = new Proxy({}, { get() { throw new Error('deps must not be touched for a group-room turn'); } });

const params = (conversationType: string) => ({
  run,
  agent: trap,
  systemPrompt: 's', history: [], runId: 'r1', nodeId: 'gate', conversationId: 'c1',
  policyResolver: trap,
  tier: { conversationType, agentModelClass: 'reasoning' },
}) as unknown as Parameters<typeof runConversationAgentToolTurn>[0];

afterEach(() => { delete process.env.OPENWOP_GROUP_ROOM_TOOL_LOOP; });

describe('group-room tool-loop opt-out', () => {
  it('the OPENWOP_GROUP_ROOM_TOOL_LOOP=true escape hatch proceeds past the gate (RESIL-4)', async () => {
    process.env.OPENWOP_GROUP_ROOM_TOOL_LOOP = 'true';
    // Past the gate, the deps trap fires — distinguishable from the immediate
    // null the gate returns when the hatch is off.
    await expect(runConversationAgentToolTurn(params('group'))).rejects.toThrow('deps must not be touched');
  });

  it('a group conversation returns null immediately — no dependency is touched', async () => {
    await expect(runConversationAgentToolTurn(params('group'))).resolves.toBeNull();
  });

  it('a non-group conversation proceeds past the gate (the trap fires)', async () => {
    await expect(runConversationAgentToolTurn(params('channel'))).rejects.toThrow('deps must not be touched');
  });
});

/**
 * XCH-GRP-1 — the capability-honesty notice and the gate share ONE predicate.
 * The scaffold line must appear exactly when the tool loop is skipped: present
 * on group turns, absent under the OPENWOP_GROUP_ROOM_TOOL_LOOP escape hatch
 * (tools return, so the notice would become the new lie), absent on
 * channel/1:1 turns.
 */
describe('group-room scaffold notice (XCH-GRP-1)', () => {
  afterEach(() => { delete process.env.OPENWOP_GROUP_ROOM_TOOL_LOOP; });

  it('a group turn gets the no-tools notice appended', () => {
    expect(groupRoomToolLoopOptedOut({ conversationType: 'group' })).toBe(true);
    const out = applyGroupRoomScaffoldNotice('PERSONA', { conversationType: 'group' });
    expect(out).toBe(`PERSONA\n\n${GROUP_ROOM_NO_TOOLS_NOTICE}`);
  });

  it('the escape hatch restores tools AND removes the notice — they can never disagree', () => {
    process.env.OPENWOP_GROUP_ROOM_TOOL_LOOP = 'true';
    expect(groupRoomToolLoopOptedOut({ conversationType: 'group' })).toBe(false);
    expect(applyGroupRoomScaffoldNotice('PERSONA', { conversationType: 'group' })).toBe('PERSONA');
  });

  it('channel and 1:1 (undefined tier) turns are untouched', () => {
    expect(applyGroupRoomScaffoldNotice('PERSONA', { conversationType: 'channel' })).toBe('PERSONA');
    expect(applyGroupRoomScaffoldNotice('PERSONA', undefined)).toBe('PERSONA');
  });

  it('the notice never denies SEARCH — group turns can still carry provider-native web search', () => {
    // resolveWebSearchPreference has no conversation-type gate, so a group
    // single-completion turn may hold a live web-search tool. The notice is
    // scoped to WORKSPACE tools; claiming "no search" would be the new lie
    // (grade-pass finding, 2026-07-15).
    expect(GROUP_ROOM_NO_TOOLS_NOTICE.toLowerCase()).not.toContain('search');
    expect(GROUP_ROOM_NO_TOOLS_NOTICE).toContain('Workspace tools');
  });

  it('conversationExchange threads the notice-bearing scaffold to BOTH model entry points (source tripwire)', async () => {
    // The unit tests above pin the helpers; this pins the WIRING — a revert
    // of either call site back to the raw `scaffold` would otherwise stay
    // green (the repo's inverted-tripwire pattern, cf. catalogParity tests).
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../src/host/conversationExchange.ts', import.meta.url), 'utf8');
    // UPDATED by ADR 0588 D4 (WF-BOA-4): a SECOND notice now composes into the
    // same threaded scaffold (the grounding-honesty line derived from
    // `composed.degraded`), so the group notice lands on `groupNotedScaffold`
    // and `effectiveScaffold` is the composition of both. The tripwire's
    // discriminating power is preserved and extended — a revert of EITHER notice
    // to the raw `scaffold`, at EITHER model entry point, still reddens.
    expect(src).toContain('const groupNotedScaffold = applyGroupRoomScaffoldNotice(scaffold, modelTier)');
    expect(src).toContain('groundingHonestyNotice(composed.degraded)');
    expect(src).toMatch(/const effectiveScaffold = groundingNotice \? `\$\{groupNotedScaffold\}/);
    expect(src).toMatch(/turnsToMessages\(\[\.\.\.budgetedExisting, userTurn\], effectiveScaffold/);
    expect(src).toMatch(/systemPrompt: effectiveScaffold/);
  });
});
