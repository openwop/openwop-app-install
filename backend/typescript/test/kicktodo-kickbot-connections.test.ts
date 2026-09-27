/**
 * ADR 0442 P4 — KickBot connections are CONSENT-GATED and fail-closed.
 *
 * The architecture settles P4 without inventing a consent record: in this host a
 * user granting a Connection (BYOK) IS the consent, and the fail-closed
 * enforcement already exists generically —
 *   `resolveConnectionReadiness` (unmet `requiredConnections` ⇒ `missing`)
 *   composed with `gateAutonomyByReadiness` (`allConfigured ? level : 'review'`).
 * A twin never autonomously acts on an integration it cannot reach (ADR 0033).
 *
 * KickBot is already fail-closed by construction: NO required connections,
 * read-only tools (today/progress — no connection/egress/write tool), heartbeat
 * OFF, autonomy `review`. It uses zero connections and never acts autonomously.
 * Actual calendar/messaging BINDING is Wave-3 (no provider tool is wired for
 * KickBot, and wiring one would contradict its read-only / propose-not-act
 * posture — see the ADR P4 correction note).
 *
 * These are the TRIPWIRES that lock that posture so a later phase (P5 dispatch /
 * P6 teardown) cannot silently give KickBot a connection or a hidden cadence,
 * plus a positive proof that the generic gate WOULD force-review KickBot the
 * moment it ever declared a connection it can't reach.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence, __resetHostExtPersistence, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { getRosterEntry } from '../src/host/rosterService.js';
import { getAgentProfile, upsertAgentProfile } from '../src/host/agentProfileService.js';
import { resolveConnectionReadiness, gateAutonomyByReadiness } from '../src/host/connectionReadiness.js';
import { ensureKickBot, KICKBOT_ROSTER_ID, KICKBOT_AGENT_ID, KICKBOT_READ_TOOLS, KICKBOT_TOOL_ALLOWLIST, KICKBOT_ROLE_KEY } from '../src/features/kicktodo-core/kickbotService.js';
// SSoT for the two chat-first-port reads KickBot inlines (to avoid a module
// cycle) — pinned here so the inlined literal can never drift from the owner.
import { KICKTODO_ENGAGEMENT_SUMMARY_TOOL_ID } from '../src/features/kicktodo-engagement/agentTools.js';
import { KICKTODO_COMMUNITY_REVIEWS_TOOL_ID } from '../src/features/kicktodo-community/agentTools.js';
import { KICKTODO_INTEGRATIONS_STATUS_TOOL_ID } from '../src/features/kicktodo-integrations/agentTools.js';
import { KICKTODO_LOG_CHECKIN_TOOL_ID } from '../src/features/kicktodo-core/agentTools.js';
import { SENSITIVE_APPROVAL_TOOLS } from '../src/features/capability-firewall/firewallHook.js';

const T = 'tenant-kickbot-conn';

/** The KNOWN-SAFE tool set as LITERALS (not the SSoT constants themselves) — so
 *  ADDING any tool FAILS these assertions and forces a conscious review, instead
 *  of a self-referential sync check that moves in lockstep with the constant.
 *  READS = the participant reads that ground KickBot's coaching. The chat-first-port
 *  added engagement-summary/community-reviews/integrations-status; the ADR 0442 Guide
 *  wave added journal, forward plan, accountability circles, and coach proposals
 *  (engagement standing + awards ride the engagement-summary tool — the Guide wave
 *  deliberately adds NO separate achievements/leaderboard tool, which would duplicate
 *  it). Every one is a READ-ONLY projection that fails empty without a human
 *  principal; NONE is a connection/egress/write tool. The FULL allowlist adds the P5
 *  `convene` handoff dispatch and the ADR 0459 `replan` ACTION tool. NEITHER is a
 *  connection/egress tool: `convene` dispatches a bounded read-only specialist, and
 *  `replan` dispatches the `openwop-app.kicktodo.replan` workflow whose PARTICIPANT
 *  approval gate + core.fail branch decide — KickBot writes no domain state directly,
 *  so the P4 no-unconsented-connection posture holds. */
const READ_ONLY_TOOLS = [
  'openwop:kicktodo.today',
  'openwop:kicktodo.progress',
  'openwop:kicktodo.engagement-summary',
  'openwop:kicktodo.community-reviews',
  // chat-first-port G5 — integration setup-state read (own consents/wearables +
  // calendar-transport readiness). A pure READ, so the P4 posture below holds.
  'openwop:kicktodo.integrations-status',
  'openwop:kicktodo.journal',
  'openwop:kicktodo.plan',
  'openwop:kicktodo.circles',
  'openwop:kicktodo.proposals',
];
// KickBot's ONE direct write (ADR 0442 Guide wave / Wave 2): logging the
// participant's OWN check-in. It is the FIRST write KickBot gets — and it MUST
// stay behind the `interrupt.approval` card (in SENSITIVE_APPROVAL_TOOLS), so the
// "you propose; the user decides" doctrine holds. A SECOND write, or dropping the
// gate on this one, fails the assertions below.
const WRITE_TOOLS = ['openwop:kicktodo.log-checkin'];
const NON_READ_TOOLS = ['openwop:kicktodo.convene', 'openwop:kicktodo.replan', ...WRITE_TOOLS];
const EXPECTED_ALLOWLIST = [...READ_ONLY_TOOLS, ...NON_READ_TOOLS];

let storage: Storage;

beforeEach(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kickbot-conn-')) });
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

afterEach(async () => {
  __resetHostExtPersistence();
  const { getAgentRegistry } = await import('../src/executor/agentRegistry.js');
  getAgentRegistry()._resetForTest();
});

describe('KickBot fail-closed connection posture (ADR 0442 P4 tripwires)', () => {
  it('declares NO required connections and carries NO connection/egress tool (reads + the convene dispatch + the ADR 0459 replan action)', async () => {
    await ensureKickBot(T);
    const profile = await getAgentProfile(T, KICKBOT_ROSTER_ID);
    // No integration is required to run KickBot — so nothing to consent to, and
    // nothing that could be used without consent.
    expect(profile?.requiredConnections ?? []).toEqual([]);
    // The inlined KickBot literals must equal the OWNING features' SSoT exports
    // (kickbotService inlines the strings to avoid a module cycle) — this pins
    // them so a rename in the owner can't silently leave KickBot dropping an
    // unresolvable id (the exact CFP-1 failure mode).
    expect(READ_ONLY_TOOLS).toContain(KICKTODO_ENGAGEMENT_SUMMARY_TOOL_ID);
    expect(READ_ONLY_TOOLS).toContain(KICKTODO_COMMUNITY_REVIEWS_TOOL_ID);
    expect(READ_ONLY_TOOLS).toContain(KICKTODO_INTEGRATIONS_STATUS_TOOL_ID);
    // The SSoT constants are pinned to known-safe LITERALS, so adding ANY tool
    // fails HERE (a true tripwire, not a self-referential sync check).
    expect([...KICKBOT_READ_TOOLS]).toEqual(READ_ONLY_TOOLS);
    expect([...KICKBOT_TOOL_ALLOWLIST]).toEqual(EXPECTED_ALLOWLIST);
    // No connection/egress tool. The non-read tools are the P5 `convene` handoff
    // dispatch, the ADR 0459 `replan` action (dispatches a workflow gated on the
    // participant's own approval — writes nothing directly), and the Wave-2
    // `log-checkin` write. NONE is a connection/egress tool, so the P4
    // no-unconsented-connection posture holds.
    expect(profile?.permissions?.never ?? []).toEqual([]);
    expect(profile?.permissions?.read ?? []).toEqual(EXPECTED_ALLOWLIST);
    const nonRead = (profile?.permissions?.read ?? []).filter((t) => !READ_ONLY_TOOLS.includes(t));
    expect(nonRead).toEqual(NON_READ_TOOLS); // convene (handoff) + replan (gated dispatch) + log-checkin (gated write)

    // ── The load-bearing Wave-2 gate ─────────────────────────────────────────
    // KickBot's ONE direct write MUST be approval-gated, and there must be EXACTLY
    // one. `log-checkin` is in the allowlist AND in SENSITIVE_APPROVAL_TOOLS (the
    // `interrupt.approval` card fires in `safe` mode, KickBot's default). A later
    // phase that adds a second write, or removes this one from the approval set,
    // turns this red — the fail-closed guarantee the "no write" tripwire used to
    // give, now expressed as "exactly one, approval-gated, self-only".
    expect(WRITE_TOOLS).toEqual([KICKTODO_LOG_CHECKIN_TOOL_ID]); // the id pin (SSoT)
    for (const w of WRITE_TOOLS) {
      expect(EXPECTED_ALLOWLIST, `${w} must be in KickBot's allowlist`).toContain(w);
      expect(SENSITIVE_APPROVAL_TOOLS.has(w), `${w} must stay approval-gated (in SENSITIVE_APPROVAL_TOOLS)`).toBe(true);
    }
    // convene + replan are NOT direct writes, so they are NOT in the approval set
    // (replan's write happens inside its workflow behind that workflow's own gate).
    expect(SENSITIVE_APPROVAL_TOOLS.has('openwop:kicktodo.convene')).toBe(false);
    expect(SENSITIVE_APPROVAL_TOOLS.has('openwop:kicktodo.replan')).toBe(false);
    // The branded agent's tool allowlist matches.
    const agent = await hostExtStorage().getUserAgent(T, KICKBOT_AGENT_ID);
    expect(agent?.toolAllowlist ?? []).toEqual(EXPECTED_ALLOWLIST);
  });

  it('never runs autonomously — heartbeat OFF + autonomy review', async () => {
    await ensureKickBot(T);
    const entry = await getRosterEntry(T, KICKBOT_ROSTER_ID);
    expect(entry?.heartbeatIntervalMs).toBe(-1); // no inherited cadence
    expect(entry?.autonomyLevel).toBe('review'); // proposes; never auto-acts
  });

  it('is trivially connection-READY because it requires none (uses no connection)', async () => {
    await ensureKickBot(T);
    const readiness = await resolveConnectionReadiness(T, KICKBOT_ROSTER_ID);
    expect(readiness.required).toEqual([]);
    expect(readiness.allConfigured).toBe(true); // ready with nothing required
    expect(readiness.missing).toEqual([]);
  });
});

describe('the consent gate that WOULD protect KickBot if a connection were ever added', () => {
  it('an unmet required connection reports missing → gate forces review (no autonomous use)', async () => {
    await ensureKickBot(T);
    // Simulate a future build declaring a calendar requirement WITHOUT the user
    // having granted (consented to) that connection.
    const existing = await getAgentProfile(T, KICKBOT_ROSTER_ID);
    await upsertAgentProfile(T, KICKBOT_ROSTER_ID, {
      roleKey: KICKBOT_ROLE_KEY,
      requiredConnections: ['capability:calendar'],
      autonomy: { specLevel: existing!.autonomy.specLevel },
    });
    const readiness = await resolveConnectionReadiness(T, KICKBOT_ROSTER_ID);
    expect(readiness.missing).toContain('capability:calendar'); // fail-closed: not consented
    // Even at the most permissive autonomy, an unmet connection forces review —
    // the twin proposes; it never autonomously acts on an integration it cannot reach.
    expect(gateAutonomyByReadiness('auto', readiness)).toBe('review');
  });

  it('the gate is a pure consent switch: consented (allConfigured) keeps the level, unconsented forces review', () => {
    const ready = { required: ['capability:calendar'], entries: [], allConfigured: true, missing: [] };
    const notReady = { required: ['capability:calendar'], entries: [], allConfigured: false, missing: ['capability:calendar'] };
    expect(gateAutonomyByReadiness('auto', ready)).toBe('auto');       // consent granted ⇒ unchanged
    expect(gateAutonomyByReadiness('guided', ready)).toBe('guided');   // consent granted ⇒ unchanged
    expect(gateAutonomyByReadiness('auto', notReady)).toBe('review');  // no consent ⇒ fail-closed
    expect(gateAutonomyByReadiness('guided', notReady)).toBe('review');
  });
});
