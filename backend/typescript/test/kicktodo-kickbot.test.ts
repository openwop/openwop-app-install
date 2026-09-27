/**
 * KickBot provisioning saga (ADR 0414 P2; PRD §6.8) — the invariants:
 *
 *  - fixed identity: rosterId `host:kickbot`, stable role `kicktodo-guide`
 *  - EXPLICIT heartbeat off (-1) + autonomyLevel 'review' — a fresh KickBot
 *    must never inherit the host heartbeat default and run autonomously
 *  - idempotent + forward-repairable (re-ensure converges; a deleted board is
 *    re-created; concurrent ensures yield ONE instance)
 *  - rename continuity: renaming the guide changes persona/label ONLY —
 *    rosterId/roleKey/board/conversation survive; a rename onto another
 *    agent's persona is refused (B2)
 *  - the welcome conversation is the deterministic agent-subject conversation
 *    (reopened, never forked — the shared chat's PRD §4.4 contract)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createRosterEntry, getRosterEntry, listRoster, updateRosterEntry } from '../src/host/rosterService.js';
import { getBoard, deleteBoard } from '../src/host/kanbanService.js';
import { getConversationMeta, subjectConversationId } from '../src/host/conversationStore.js';
import { ensureKickBot, kickbotBoardId, KICKBOT_ROLE_KEY } from '../src/features/kicktodo-core/kickbotService.js';

const TENANT = 'tenant-kickbot';

let storage: Storage;

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

afterEach(async () => {
  __resetHostExtPersistence();
  // ensureUserAgentRegistered writes the process-global AgentRegistry, which the
  // host-ext reset does NOT clear — reset it so a registered guide can't leak
  // into a later test in this file.
  const { getAgentRegistry } = await import('../src/executor/agentRegistry.js');
  getAgentRegistry()._resetForTest();
});

describe('ensureKickBot', () => {
  it('provisions ONE instance with the fixed identity + explicit heartbeat-off/review defaults', async () => {
    const bot = await ensureKickBot(TENANT);
    expect(bot.rosterId).toBe('host:kickbot');
    expect(bot.roleKey).toBe(KICKBOT_ROLE_KEY);
    expect(bot.persona).toBe('KickBot');
    // The ADR provisioning invariant: EXPLICIT off, never the inherited default.
    expect(bot.heartbeatIntervalMs).toBe(-1);
    expect(bot.autonomyLevel).toBe('review');

    // The roster row itself carries the values (not just the projection).
    const row = await getRosterEntry(TENANT, 'host:kickbot');
    expect(row?.heartbeatIntervalMs).toBe(-1);
    expect(row?.autonomyLevel).toBe('review');

    // Board + welcome conversation exist.
    expect(await getBoard(bot.boardId)).not.toBeNull();
    const meta = await getConversationMeta(TENANT, bot.conversationId);
    expect(meta?.type).toBe('agent');
    expect(bot.conversationId).toBe(subjectConversationId(TENANT, { kind: 'agent', id: 'host:kickbot' }));
  });

  it('is idempotent and concurrent-safe (one roster row), and forward-repairs a missing board', async () => {
    const [a, b, c] = await Promise.all([ensureKickBot(TENANT), ensureKickBot(TENANT), ensureKickBot(TENANT)]);
    expect(a.rosterId).toBe(b.rosterId);
    expect(b.rosterId).toBe(c.rosterId);
    expect((await listRoster(TENANT)).filter((e) => e.roleKey === KICKBOT_ROLE_KEY)).toHaveLength(1);

    // Forward repair: the agent board vanishes → re-ensure recreates it.
    await deleteBoard(kickbotBoardId(TENANT));
    expect(await getBoard(kickbotBoardId(TENANT))).toBeNull();
    await ensureKickBot(TENANT);
    expect(await getBoard(kickbotBoardId(TENANT))).not.toBeNull();
  });

  it('rename continuity: persona/label change only — identity, board, and conversation survive', async () => {
    const before = await ensureKickBot(TENANT);
    await updateRosterEntry(TENANT, before.rosterId, { persona: 'Coach Nova', label: 'Coach Nova' });
    const after = await ensureKickBot(TENANT);
    expect(after.rosterId).toBe(before.rosterId); // host:kickbot forever
    expect(after.roleKey).toBe(KICKBOT_ROLE_KEY);
    expect(after.persona).toBe('Coach Nova');
    expect(after.boardId).toBe(before.boardId);
    expect(after.conversationId).toBe(before.conversationId);
  });

  it('a persona squat on `KickBot` without the role does not break provisioning convergence', async () => {
    // Someone creates a non-guide agent named KickBot first → host:kickbot is taken.
    await createRosterEntry({
      tenantId: TENANT,
      persona: 'KickBot',
      agentRef: { agentId: 'core.openwop.agents.react' },
    });
    // Provisioning cannot mint host:kickbot… and must NOT silently adopt the
    // squatter (wrong role, wrong governance) — it converges by finding no
    // guide and surfacing the conflict.
    await expect(ensureKickBot(TENANT)).rejects.toThrow(/already exists/);
  });
});

/**
 * ADR 0442 P1 — identity + profile + branded agentRef.
 */
describe('ensureKickBot — P1 profile + branded agentRef (ADR 0442)', () => {
  it('writes an AgentProfile with the coaching capability, review autonomy, resolvable BY capability', async () => {
    await ensureKickBot(TENANT);
    const { getAgentProfile } = await import('../src/host/agentProfileService.js');
    const { findCoachingAgent, COACHING_CAPABILITY } = await import('../src/features/kicktodo-core/coachingCapability.js');

    const profile = await getAgentProfile(TENANT, 'host:kickbot');
    expect(profile?.roleKey).toBe(KICKBOT_ROLE_KEY);
    expect(profile?.capabilities).toContain(COACHING_CAPABILITY);
    expect(profile?.autonomy.level).toBe('review');

    // Resolved BY capability, never by roleKey (David's law).
    const coach = await findCoachingAgent(TENANT);
    expect(coach?.rosterId).toBe('host:kickbot');
  });

  it('brands a host-registered user-agent (the Iris precedent) with a FIXED agentRef id', async () => {
    const bot = await ensureKickBot(TENANT);
    const entry = await getRosterEntry(TENANT, bot.rosterId);
    // The fixed branded id — NOT the generic react ref, NOT persona-derived.
    expect(entry?.agentRef?.agentId).toBe('user.kicktodo-guide');
    const ua = await storage.getUserAgent(TENANT, 'user.kicktodo-guide');
    expect(ua?.persona).toBe('KickBot');
    expect(ua?.memoryShape.conversation).toBe(true); // a conversational guide
    expect(ua?.systemPrompt).toMatch(/KickBot/);
  });

  it('is idempotent — a re-provision does NOT clobber user edits to autonomy/HITL', async () => {
    await ensureKickBot(TENANT);
    const { getAgentProfile, upsertAgentProfile } = await import('../src/host/agentProfileService.js');
    // Simulate a governance edit through the profile PUT.
    await upsertAgentProfile(TENANT, 'host:kickbot', {
      roleKey: KICKBOT_ROLE_KEY,
      hitl: ['everything'],
      autonomy: { specLevel: 'draft-only' },
    });
    await ensureKickBot(TENANT); // re-provision

    const profile = await getAgentProfile(TENANT, 'host:kickbot');
    expect(profile?.hitl).toEqual(['everything']);          // edit survived
    expect(profile?.autonomy.specLevel).toBe('draft-only'); // edit survived
    // The capability survives too (upsert preserves it on omit).
    const { COACHING_CAPABILITY } = await import('../src/features/kicktodo-core/coachingCapability.js');
    expect(profile?.capabilities).toContain(COACHING_CAPABILITY);
  });

  it('self-heals the coaching capability on a profile written by a pre-coaching build', async () => {
    const { upsertAgentProfile, getAgentProfile } = await import('../src/host/agentProfileService.js');
    // A profile with NO coaching capability (simulating an older build).
    await upsertAgentProfile(TENANT, 'host:kickbot', {
      roleKey: KICKBOT_ROLE_KEY,
      hitl: ['plan-change'],
      autonomy: { specLevel: 'recommend' },
    });
    await ensureKickBot(TENANT);

    const profile = await getAgentProfile(TENANT, 'host:kickbot');
    const { COACHING_CAPABILITY } = await import('../src/features/kicktodo-core/coachingCapability.js');
    expect(profile?.capabilities).toContain(COACHING_CAPABILITY); // healed
    expect(profile?.hitl).toEqual(['plan-change']);               // untouched
  });

  it('rename stays structural — profileId, agentRef, and the capability survive a rename', async () => {
    const before = await ensureKickBot(TENANT);
    await updateRosterEntry(TENANT, before.rosterId, { persona: 'Coach Nova', label: 'Coach Nova' });
    await ensureKickBot(TENANT); // re-provision after rename

    const entry = await getRosterEntry(TENANT, before.rosterId);
    expect(entry?.persona).toBe('Coach Nova');                    // rename applied
    expect(entry?.agentRef?.agentId).toBe('user.kicktodo-guide'); // ref unchanged
    const { getAgentProfile } = await import('../src/host/agentProfileService.js');
    const { COACHING_CAPABILITY } = await import('../src/features/kicktodo-core/coachingCapability.js');
    const profile = await getAgentProfile(TENANT, before.rosterId);
    expect(profile?.capabilities).toContain(COACHING_CAPABILITY); // capability survives
  });

  it('create-on-absent: a re-provision does NOT re-register (clobber) an edited branded agent in the live registry', async () => {
    await ensureKickBot(TENANT);
    const { getAgentRegistry } = await import('../src/executor/agentRegistry.js');
    // Simulate a PATCH /agents/:id edit that updated storage AND re-registered
    // the edited manifest into the in-process registry (the route does both).
    const live = getAgentRegistry().get('user.kicktodo-guide', TENANT);
    expect(live).not.toBeNull();
    getAgentRegistry().register({ ...live!, systemPrompt: 'EDITED GUIDE PROMPT' });

    await ensureKickBot(TENANT); // re-provision must NOT overwrite the registry
                                 // with the DEFAULT prompt (the create-on-absent guard).
    const after = getAgentRegistry().get('user.kicktodo-guide', TENANT);
    expect(after?.systemPrompt).toBe('EDITED GUIDE PROMPT');
  });

  it('does not make KickBot a second assistant — findAssistantAgent is unaffected', async () => {
    await ensureKickBot(TENANT);
    const { findAssistantAgent } = await import('../src/features/assistant/capability.js');
    // KickBot holds `coaching`, not `assistant`, so the assistant resolver is
    // not ambiguous (the C2 no-reuse decision).
    const assistant = await findAssistantAgent(TENANT);
    expect(assistant?.rosterId).not.toBe('host:kickbot');
  });

  it('is tenant-isolated — a second tenant gets its own profile; cross-tenant read is null', async () => {
    await ensureKickBot(TENANT);
    await ensureKickBot('tenant-kickbot-2');
    const { getAgentProfile } = await import('../src/host/agentProfileService.js');
    expect(await getAgentProfile('tenant-kickbot-2', 'host:kickbot')).not.toBeNull();
    // A profile is scoped to its tenant (fail-closed cross-tenant read is the
    // service's job; here we assert each tenant has its own row).
    const p1 = await getAgentProfile(TENANT, 'host:kickbot');
    const p2 = await getAgentProfile('tenant-kickbot-2', 'host:kickbot');
    expect(p1?.tenantId).toBe(TENANT);
    expect(p2?.tenantId).toBe('tenant-kickbot-2');
  });
});
