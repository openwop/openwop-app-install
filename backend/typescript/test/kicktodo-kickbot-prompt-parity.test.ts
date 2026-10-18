/**
 * XCH-KB-1 / XCH-KB-2 — KickBot prompt ↔ allowlist parity, and the agent-record
 * heal (the promptCatalogParity precedent, modelled on
 * `kicktodo-challenge-author-prompt-parity.test.ts`).
 *
 * XCH-KB-1: KickBot's allowlist granted `convene` and `replan`, but its in-code
 * prompt never taught either — only the tool descriptions did. A tool the prompt
 * never names, or a name the model cannot call, is a lie to the model. Pinned
 * both ways: every allowlisted `openwop:` id is named verbatim, and the prompt
 * names no id outside the allowlist.
 *
 * XCH-KB-2: the agent record was create-on-absent with no heal, so a tenant
 * provisioned earlier kept that build's allowlist + prompt forever. The next
 * `ensureKickBot` now heals the HOST-owned fields (allowlist always; prompt only
 * when it is a prior host default; memoryShape), keeps every user-owned field and
 * a user-edited prompt, and writes nothing when the record is current.
 * Sabotage-witnessed: deleting a tool mention reds the parity case; making the
 * heal a no-op reds the heal cases.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import {
  ensureKickBot,
  KICKBOT_AGENT_ID,
  KICKBOT_GUIDE_PROMPT,
  KICKBOT_PRIOR_PROMPT_SHA256,
  KICKBOT_TOOL_ALLOWLIST,
} from '../src/features/kicktodo-core/kickbotService.js';

const ID_RE = /openwop:[A-Za-z0-9._-]*[A-Za-z0-9_-]/g;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('KickBot prompt ↔ allowlist parity (XCH-KB-1)', () => {
  it('the allowlist carries convene + replan (the two tools the prompt used to omit)', () => {
    expect(KICKBOT_TOOL_ALLOWLIST).toContain('openwop:kicktodo.convene');
    expect(KICKBOT_TOOL_ALLOWLIST).toContain('openwop:kicktodo.replan');
  });

  it('the prompt names EVERY allowlisted openwop: tool id verbatim', () => {
    for (const id of KICKBOT_TOOL_ALLOWLIST) {
      expect(KICKBOT_GUIDE_PROMPT.includes(`\`${id}\``), `prompt must name ${id} verbatim`).toBe(true);
    }
  });

  it('the prompt names NO openwop: id outside the allowlist', () => {
    const mentioned = [...new Set(Array.from(KICKBOT_GUIDE_PROMPT.matchAll(ID_RE), (m) => m[0]))].sort();
    expect(mentioned).toEqual([...new Set(KICKBOT_TOOL_ALLOWLIST)].sort());
  });

  it('the prompt says when NOT to use convene and replan', () => {
    expect(KICKBOT_GUIDE_PROMPT).toMatch(/Do NOT use it to add new activities/);
    expect(KICKBOT_GUIDE_PROMPT).toMatch(/Do NOT convene for something your\s+read tools already answer/);
    // convene is async — the prompt must not let the model fabricate the answer.
    expect(KICKBOT_GUIDE_PROMPT).toMatch(/never invent its answer/);
  });

  it('the current prompt is pinned, and is NOT in the prior-default set (append the old hash when you change it)', () => {
    // If this reds because you edited the prompt: append the OLD hash printed by
    // the previous pin to KICKBOT_PRIOR_PROMPT_SHA256, then update this literal.
    expect(sha(KICKBOT_GUIDE_PROMPT)).toBe(CURRENT_PROMPT_SHA256);
    expect(KICKBOT_PRIOR_PROMPT_SHA256).not.toContain(CURRENT_PROMPT_SHA256);
  });
});

const CURRENT_PROMPT_SHA256 = '94bf66b0c369fea4c600e993b520b3db75df3f27e65f30114b0fd5144e8f8772';

// ── XCH-KB-2 heal ──────────────────────────────────────────────────────────

const TENANT = 'tenant-kickbot-heal';
/** An older build's allowlist (pre-convene/replan) — the old-shape record. */
const OLD_ALLOWLIST = ['openwop:kicktodo.today', 'openwop:kicktodo.progress'];

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});
afterEach(() => {
  __resetHostExtPersistence();
  getAgentRegistry()._resetForTest();
  vi.restoreAllMocks();
});

async function seedOldShape(systemPrompt: string) {
  await storage.insertUserAgent({
    agentId: KICKBOT_AGENT_ID,
    tenantId: TENANT,
    persona: 'Coach Nova', // user-owned (rename)
    label: 'Coach Nova',
    description: 'My own coach',
    modelClass: 'reasoning',
    systemPrompt,
    toolAllowlist: OLD_ALLOWLIST,
    memoryShape: { scratchpad: true, conversation: false, longTerm: true },
    confidenceThreshold: 0.7,
    createdAt: '2026-07-20T00:00:00.000Z',
  });
}

describe('KickBot agent-record heal (XCH-KB-2)', () => {
  it('heals a stale host-default prompt + old allowlist + memoryShape to current, keeping user-owned fields', async () => {
    await seedOldShape(PRIOR_HOST_PROMPT);
    expect(KICKBOT_PRIOR_PROMPT_SHA256).toContain(sha(PRIOR_HOST_PROMPT)); // positive control: a real prior default

    await ensureKickBot(TENANT);

    const rec = await storage.getUserAgent(TENANT, KICKBOT_AGENT_ID);
    expect(rec?.systemPrompt).toBe(KICKBOT_GUIDE_PROMPT);
    expect(rec?.toolAllowlist).toEqual(KICKBOT_TOOL_ALLOWLIST);
    expect(rec?.memoryShape).toEqual({ scratchpad: true, conversation: true, longTerm: false });
    // user-owned + immutable fields survive byte-identical
    expect(rec).toMatchObject({
      persona: 'Coach Nova',
      label: 'Coach Nova',
      description: 'My own coach',
      modelClass: 'reasoning',
      confidenceThreshold: 0.7,
      createdAt: '2026-07-20T00:00:00.000Z',
    });
    // and the live registry serves the healed prompt on this instance
    expect(getAgentRegistry().get(KICKBOT_AGENT_ID, TENANT)?.systemPrompt).toBe(KICKBOT_GUIDE_PROMPT);
  });

  it('preserves a USER-edited prompt while still healing the host-owned allowlist', async () => {
    await seedOldShape('My custom coaching voice.');
    await ensureKickBot(TENANT);
    const rec = await storage.getUserAgent(TENANT, KICKBOT_AGENT_ID);
    expect(rec?.systemPrompt).toBe('My custom coaching voice.');
    expect(rec?.toolAllowlist).toEqual(KICKBOT_TOOL_ALLOWLIST);
  });

  it('does NOT write a current record (no write when equal)', async () => {
    await ensureKickBot(TENANT); // fresh provision = current definition
    const spy = vi.spyOn(storage, 'updateUserAgent');
    await ensureKickBot(TENANT);
    await ensureKickBot(TENANT);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a healed record converges: the next ensure writes nothing', async () => {
    await seedOldShape(PRIOR_HOST_PROMPT);
    await ensureKickBot(TENANT);
    const spy = vi.spyOn(storage, 'updateUserAgent');
    await ensureKickBot(TENANT);
    expect(spy).not.toHaveBeenCalled();
  });
});

/** The pre-XCH-KB-1 prompt (afd118cc9..fb7a2e689), verbatim — the stale host
 *  default every tenant provisioned before this change still carries. */
const PRIOR_HOST_PROMPT = [
  'You are KickBot, the user\'s persistent KickTodo guide.',
  'You coordinate their plan, explain the next step in plain language, notice when',
  'the plan is no longer working, and help them recover WITHOUT shame. You never',
  'invent anything: before you coach, GROUND yourself in their real state with your',
  'read tools — today\'s due actions, progress on each challenge, what\'s coming up on',
  'their plan, their own journal notes, their engagement standing and the awards',
  'they\'ve earned, a challenge\'s reviews, their accountability circles, any coach',
  'plan-change proposals awaiting their decision, and their integration setup (which',
  'calendar/wearable connections are active) — and speak only to what is there. You',
  'celebrate real wins from their earned awards. You propose; the user decides. Domain',
  'changes (enrolling, plan revisions, connecting a calendar/wearable) go through the',
  'governed surfaces and are confirmed by the user on an inline card — you never change',
  'anything silently. When they tell you they finished an action, you can log the',
  'check-in for them: FIRST read `today`, find the EXACT action they mean, NAME it back',
  '("I\'ll mark your morning run done — okay?"), and only call log-checkin with that',
  'card\'s id — never guess a card, and pass their own words as the note. They approve',
  'it on a card before anything is recorded, and a check-in can\'t be undone. Keep it',
  'short, kind, and concrete.',
].join(' ');
