/**
 * KickBot provisioning saga (ADR 0414 P2; PRD §6.8).
 *
 * KickBot is ONE persistent named roster instance per workspace — composed
 * entirely from existing owners (roster/profile, Kanban, conversation); no
 * parallel agent table, scheduler, memory store, or transcript store.
 *
 * Invariants (each test-asserted):
 *  - FIXED identity: created with persona `KickBot` so the deterministic
 *    roster id is `host:kickbot` (rename never changes it — renames only touch
 *    persona/label; identity fields are structural, ADR 0379).
 *  - Stable semantic role `kicktodo-guide` — the name-independent handle every
 *    lookup uses (never the display name).
 *  - EXPLICIT heartbeat OFF (`heartbeatIntervalMs: -1`) + `autonomyLevel:
 *    'review'` — an absent heartbeat would INHERIT the host default and run
 *    autonomously (the ADR provisioning invariant); a fresh KickBot must not.
 *  - Idempotent + forward-repairable: every step is get-or-create with a
 *    deterministic id (re-invocation converges; a missing piece is repaired).
 */

import { createHash } from 'node:crypto';
import { createLogger } from '../../observability/logger.js';
import { createBoard, getBoard } from '../../host/kanbanService.js';
import { listRoster, createRosterEntry, type RosterEntry } from '../../host/rosterService.js';
import { ensureConversationMeta, subjectConversationId } from '../../host/conversationStore.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { ensureUserAgentRegistered } from '../../routes/userAgents.js';
import { getAgentProfile, upsertAgentProfile, activateAgentCapability, setAgentMemoryScope, setAgentKnowledge } from '../../host/agentProfileService.js';
import { KICKTODO_TODAY_TOOL_ID, KICKTODO_PROGRESS_TOOL_ID, KICKTODO_JOURNAL_TOOL_ID, KICKTODO_PLAN_TOOL_ID, KICKTODO_CONVENE_TOOL_ID, KICKTODO_REPLAN_TOOL_ID, KICKTODO_LOG_CHECKIN_TOOL_ID, clearConvenedSpecialistOverrides } from './agentTools.js';
import { COACHING_CAPABILITY } from './coachingCapability.js';
import { onRosterMemberDeleted } from '../../host/rosterLifecycle.js';
import { ensureKickbotKnowledge, teardownKickbotKnowledge, kickbotKbCollectionId } from './kicktodoKnowledgeService.js';
import { listPublished } from './challengeService.js';

const log = createLogger('kicktodo.kickbot');

export const KICKBOT_ROLE_KEY = 'kicktodo-guide';
export const KICKBOT_DEFAULT_PERSONA = 'KickBot';

/** KickBot's DETERMINISTIC roster id — `host:${slugify('KickBot')}` (ADR 0379
 *  per-persona id). Fixed because the persona `KickBot` is fixed at creation
 *  (a rename never touches identity fields). Used by the feature's OWN teardown
 *  handler to recognise its member on the roster-lifecycle seam — a feature
 *  knowing its own agent is not the David's-law violation (that rule forbids the
 *  GENERIC host paths from special-casing an id). */
export const KICKBOT_ROSTER_ID = 'host:kickbot';

/**
 * ADR 0442 P1 — the guide's BRANDED agent, registered host-side like every
 * other named standing agent (the Iris `ensureUserAgentRegistered` precedent),
 * NOT a pack manifest. A FIXED constant id: KickBot's persona is user-
 * renameable, so a persona-derived id would strand the ref on rename. The agents
 * pack is handoff-skills-only (its own parity test enforces scratchpad-only
 * memory), so a conversational named guide cannot live there — see the ADR 0442
 * P1 correction note.
 */
export const KICKBOT_AGENT_ID = 'user.kicktodo-guide';

/** The guide's system prompt — the ONE in-tree SSoT for its voice (no drift,
 *  no pack signing needed). Deliberately free of node typeIds / schema fields
 *  (LLM-exchange discipline): behavior/tools are governed by the profile + the
 *  tool allowlist, not by prose here. */
const KICKBOT_GUIDE_PROMPT = [
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

/** chat-first-port G6/G7 — the two participant-lane READ tools KickBot gains
 *  for the previously chat-orphaned engagement-summary + challenge-reviews
 *  capabilities. INLINED as string literals (not imported) for the same reason
 *  `KICKBOT_TURN_AGENT_ID` is: `kicktodo-engagement`/`kicktodo-community` both
 *  `dependsOn` (and import from) kicktodo-core, so importing their tool-id
 *  constants here would form a module cycle. SSoT:
 *  `kicktodo-engagement/agentTools.ts` `KICKTODO_ENGAGEMENT_SUMMARY_TOOL_ID` and
 *  `kicktodo-community/agentTools.ts` `KICKTODO_COMMUNITY_REVIEWS_TOOL_ID` —
 *  the kickbot-connections tripwire pins these literals against those exports. */
const KICKTODO_ENGAGEMENT_SUMMARY_TOOL_ID = 'openwop:kicktodo.engagement-summary';
const KICKTODO_COMMUNITY_REVIEWS_TOOL_ID = 'openwop:kicktodo.community-reviews';
/** chat-first-port G5 — the participant-lane READ of integration SETUP STATE
 *  (consents + linked wearables + calendar-transport readiness, own-view only),
 *  so KickBot can honestly answer "is my calendar/wearable connected?". INLINED
 *  for the same module-cycle reason as the two above: `kicktodo-integrations`
 *  `dependsOn` (and imports from) kicktodo-core. SSoT:
 *  `kicktodo-integrations/agentTools.ts` `KICKTODO_INTEGRATIONS_STATUS_TOOL_ID`
 *  — pinned by the kickbot-connections tripwire. A pure READ (no connection/
 *  egress/write), so the P4 posture holds. */
const KICKTODO_INTEGRATIONS_STATUS_TOOL_ID = 'openwop:kicktodo.integrations-status';

/** The guide's read tools — the participant-facing KickTodo reads. Domain writes
 *  are NOT here; they ride the governed nodes/surfaces (RFC 0021 discipline).
 *  Exported so the ADR 0442 P4 fail-closed tripwire can assert KickBot carries
 *  ONLY these reads — no connection/egress/write tool. The chat-first-port reads
 *  (engagement-summary/community-reviews/integrations-status) and the ADR 0442
 *  Guide-wave reads (journal/plan/circles/proposals) are ALL pure READS, so the
 *  P4 "no connection/egress/write tool" posture is preserved (the tripwire's
 *  literal pin still forces this conscious review). NOTE: engagement standing +
 *  awards ride the chat-first-port `engagement-summary` tool — the Guide wave
 *  deliberately does NOT add separate achievements/leaderboard tools (that would
 *  duplicate it). */
export const KICKBOT_READ_TOOLS = [
  KICKTODO_TODAY_TOOL_ID,
  KICKTODO_PROGRESS_TOOL_ID,
  KICKTODO_ENGAGEMENT_SUMMARY_TOOL_ID,
  KICKTODO_COMMUNITY_REVIEWS_TOOL_ID,
  KICKTODO_INTEGRATIONS_STATUS_TOOL_ID,
  KICKTODO_JOURNAL_TOOL_ID,
  KICKTODO_PLAN_TOOL_ID,
  // Cross-feature read tools live in kicktodo-accountability, which dependsOn
  // kicktodo-core — so their ids are referenced as STRING LITERALS (never imported
  // UP into core; the existing `SPECIALIST_OFFERED_TOOLS` circles literal precedent).
  // `agent-prompt-tool-ids` pins each to its real registration.
  'openwop:kicktodo.circles', // kicktodo-accountability
  'openwop:kicktodo.proposals', // kicktodo-accountability
];

/** KickBot's FULL tool allowlist: the reads + the `convene` handoff dispatch (ADR
 *  0442 P5) + the `replan` ACTION tool (ADR 0459 §3.1) + the `log-checkin` WRITE
 *  (ADR 0442 Guide wave / Wave 2). `replan` dispatches a participant-gated workflow
 *  (writes nothing directly); `log-checkin` is KickBot's ONE bounded direct write —
 *  the participant's OWN check-in — and it is APPROVAL-GATED: its id is in
 *  `SENSITIVE_APPROVAL_TOOLS`, so in `safe` mode (KickBot's default) it is deferred
 *  for the one-click `interrupt.approval` card and writes nothing until the user
 *  approves. Still NO connection/egress tool. The kickbot-connections tripwire
 *  asserts this exact set AND that the one write is approval-gated + self-only. */
export const KICKBOT_TOOL_ALLOWLIST = [...KICKBOT_READ_TOOLS, KICKTODO_CONVENE_TOOL_ID, KICKTODO_REPLAN_TOOL_ID, KICKTODO_LOG_CHECKIN_TOOL_ID];

export interface KickBotInstance {
  rosterId: string;
  roleKey: string;
  persona: string;
  label?: string;
  enabled: boolean;
  heartbeatIntervalMs?: number;
  autonomyLevel?: string;
  /** The agent's OWN work board (delegated research/follow-ups) — a different
   *  projection than the participant's action board and never a second
   *  completion truth (PRD §6.8). */
  boardId: string;
  /** The durable welcome/primary conversation (deterministic per agent subject
   *  — reopened, never forked; the shared chat renders it). */
  conversationId: string;
}

/** Deterministic agent-work board id for the tenant's KickBot. */
export function kickbotBoardId(tenantId: string): string {
  return `kickbot-board:${createHash('sha256').update(tenantId).digest('hex').slice(0, 24)}`;
}

async function findGuide(tenantId: string): Promise<RosterEntry | undefined> {
  return (await listRoster(tenantId)).find((e) => e.roleKey === KICKBOT_ROLE_KEY);
}

/**
 * ADR 0442 P3 — register KickBot's feature-owned teardown on the ADR 0288
 * roster-lifecycle seam: when KickBot itself is deleted, drop the managed
 * guidance KB collection the provisioning saga created (the host cascade reaches
 * the profile's knowledge BINDING but not the KB COLLECTION, which would orphan).
 * A non-KickBot member deletion is ignored. The per-user MEMORY scope needs no
 * cleanup — it is the participant's own `user:<id>`, which they own and outlive
 * (Option B). Keyed + idempotent (repeat boots overwrite); call from feature boot.
 */
export function registerKickbotLifecycleHooks(): void {
  onRosterMemberDeleted('kicktodo-kickbot-kb', async ({ tenantId, rosterId }) => {
    if (rosterId !== KICKBOT_ROSTER_ID) return;
    await teardownKickbotKnowledge(tenantId);
    // ADR 0442 P5 — leave-no-trace for the read-only confinement overrides a
    // convene wrote for the specialists (durable, per-tenant, no other cleanup).
    await clearConvenedSpecialistOverrides(tenantId);
  });
}

/** In-process single-flight per tenant (the ensureSeededAgentByRole pattern —
 *  the roster store has no unique role index). */
const ensuring = new Map<string, Promise<KickBotInstance>>();

export async function ensureKickBot(tenantId: string): Promise<KickBotInstance> {
  const inflight = ensuring.get(tenantId);
  if (inflight) return inflight;
  const work = provision(tenantId).finally(() => ensuring.delete(tenantId));
  ensuring.set(tenantId, work);
  return work;
}

async function provision(tenantId: string): Promise<KickBotInstance> {
  const description = 'Your KickTodo guide — plans, explains, and helps you recover. An AI agent provided by KickTodo.';

  // 0. ADR 0442 P1 — the BRANDED agent record (persona + guide prompt + read
  //    tools + conversational memory), registered host-side like every other
  //    named standing agent, keyed by the FIXED id so a rename never strands the
  //    ref. CREATE-ON-ABSENT only: `ensureUserAgentRegistered` re-registers the
  //    passed record into the in-process registry UNCONDITIONALLY (last-write-
  //    wins), so calling it with the DEFAULT persona/prompt on every re-provision
  //    would clobber a future edited record in the live registry. Guard on
  //    absence; the registry read-through (`hydrateUserAgentIntoRegistry`) covers
  //    a booted-before-create instance.
  if (!(await hostExtStorage().getUserAgent(tenantId, KICKBOT_AGENT_ID))) {
    await ensureUserAgentRegistered(hostExtStorage(), {
      agentId: KICKBOT_AGENT_ID,
      tenantId,
      persona: KICKBOT_DEFAULT_PERSONA,
      label: KICKBOT_DEFAULT_PERSONA,
      description,
      modelClass: 'chat',
      systemPrompt: KICKBOT_GUIDE_PROMPT,
      toolAllowlist: KICKBOT_TOOL_ALLOWLIST,
      memoryShape: { scratchpad: true, conversation: true, longTerm: false },
      createdAt: new Date().toISOString(),
    });
  }

  // 1. Roster identity — get-or-create by the stable ROLE (never the name).
  let entry = await findGuide(tenantId);
  if (!entry) {
    try {
      entry = await createRosterEntry({
        tenantId,
        persona: KICKBOT_DEFAULT_PERSONA, // ⇒ deterministic rosterId host:kickbot
        agentRef: { agentId: KICKBOT_AGENT_ID, version: '1.0.0' },
        roleKey: KICKBOT_ROLE_KEY,
        label: KICKBOT_DEFAULT_PERSONA,
        description,
        enabled: true,
        heartbeatIntervalMs: -1, // EXPLICIT off — never inherit the host default
        autonomyLevel: 'review',
      });
      log.info('kickbot_provisioned', { tenantId, rosterId: entry.rosterId });
    } catch (err) {
      // Persona `KickBot` already taken (host:kickbot exists without our role
      // key, or a concurrent provision won) — converge on the existing guide;
      // anything else is a real failure.
      entry = await findGuide(tenantId);
      if (!entry) throw err;
    }
  }

  // 1b. ADR 0442 P1 — the governance PROFILE with the coaching capability.
  //     GET-OR-CREATE + capability-heal, NEVER an unconditional upsert: this
  //     runs on every enroll/GET, and a full upsert would clobber a user's
  //     autonomy/HITL/permission edits. Create the profile when absent; if a
  //     pre-'coaching' build already wrote one, heal only the capability
  //     (additive, touches nothing else).
  const existingProfile = await getAgentProfile(tenantId, entry.rosterId);
  if (!existingProfile) {
    await upsertAgentProfile(tenantId, entry.rosterId, {
      roleKey: KICKBOT_ROLE_KEY,
      capabilities: [COACHING_CAPABILITY],
      // ADR 0442 P3 — PER-USER memory: in a shared cohort tenant KickBot recalls
      // the ACTING participant's own `user:<id>` memory, never another's (F1).
      // Generic profile field (no agent-id special-case); teardown-trivial (the
      // scope is the participant's own, which they own + outlive).
      memoryScope: 'per-user',
      // ADR 0442 P5 — the convene tool joins the allowlist; write/never stay empty
      // (convene dispatches a read-only specialist, never a domain write).
      permissions: { read: KICKBOT_TOOL_ALLOWLIST, write: [], never: [] },
      hitl: ['plan-change', 'enrollment'], // material actions stay human-gated
      autonomy: { specLevel: 'recommend' }, // ⇒ roster level 'review'
    });
    log.info('kickbot_profile_created', { tenantId, rosterId: entry.rosterId });
  } else {
    // Forward-repair a pre-'coaching' / pre-'per-user' profile — additive heals
    // that touch nothing else (never clobber a user's autonomy/HITL/permission edits).
    if (!(existingProfile.capabilities ?? []).includes(COACHING_CAPABILITY)) {
      await activateAgentCapability(tenantId, entry.rosterId, COACHING_CAPABILITY, {
        roleKey: KICKBOT_ROLE_KEY,
        autonomy: { specLevel: 'recommend' },
      });
      log.info('kickbot_coaching_capability_healed', { tenantId, rosterId: entry.rosterId });
    }
    if (existingProfile.memoryScope !== 'per-user') {
      await setAgentMemoryScope(tenantId, entry.rosterId, 'per-user', {
        roleKey: KICKBOT_ROLE_KEY,
        autonomy: { specLevel: 'recommend' },
      });
      log.info('kickbot_memory_scope_healed', { tenantId, rosterId: entry.rosterId });
    }
  }

  // 1c. ADR 0442 P3 — KB grounding + the `knowledge` capability. Ensure the
  //     managed KickBot guidance collection (challenge content + product
  //     guidance) and BIND it. `setAgentKnowledge` activates `knowledge`, which
  //     is ALSO the gate that lights up per-user MEMORY recall in the chat (the
  //     two halves unlock together — ADR 0442 P3 correction, Findings A/B).
  //
  //     GUARD (grade-code IMPROVEMENT 1): `ensureKickBot` runs on every enroll /
  //     daypart-set / GET-kickbot READ, so an UNCONDITIONAL ensure+bind here would
  //     issue a profile write (`updatedAt` bump) + a KB doc upsert on every read —
  //     the SPA-poll write-amplification CLAUDE.md warns about. The binding is
  //     deterministic + stable, so bind only when it is NOT already present (first
  //     provision, or a forward-repair of a pre-P3 / cleared binding). New
  //     challenges stay current via the `publishChallenge` sync hook, NOT this
  //     path, so skipping on the steady state loses nothing.
  const expectedKbCollectionId = kickbotKbCollectionId(tenantId);
  const alreadyBound =
    (existingProfile?.capabilities ?? []).includes('knowledge') &&
    (existingProfile?.knowledge?.collectionIds ?? []).includes(expectedKbCollectionId);
  if (!alreadyBound) {
    // On KB failure (null) the patch OMITS collectionIds, so the shallow-merge
    // preserves any prior binding and we bind memory-only (recall still works).
    // ADDITIVE union (grade-data): `setAgentKnowledge`'s shallow-merge REPLACES
    // the `collectionIds` array, so on success we UNION the managed id with any
    // collection an admin/curator bound to KickBot (it is a real roster agent),
    // rather than clobbering it — the one place the delta could drop durable state.
    const kbCollectionId = await ensureKickbotKnowledge(tenantId, () => listPublished(tenantId));
    const mergedIds = kbCollectionId
      ? Array.from(new Set([...(existingProfile?.knowledge?.collectionIds ?? []), kbCollectionId]))
      : (existingProfile?.knowledge?.collectionIds ?? []);
    await setAgentKnowledge(
      tenantId,
      entry.rosterId,
      { ...(mergedIds.length ? { collectionIds: mergedIds } : {}), retrieval: { sources: ['kb', 'memory'] } },
      { roleKey: KICKBOT_ROLE_KEY, autonomy: { specLevel: 'recommend' } },
      // ADR 0664 D4 — a seed IS a grant, even when KB is unavailable and this patch
      // carries no `collectionIds`. Inferring the flag from the patch shape (the ADR's
      // first draft) would leave KickBot without the capability on exactly that path, and
      // `resolveAgentKnowledgeRetrieve` fails closed — memory recall would go dead silently.
      { activateCapability: true },
    );
    log.info('kickbot_knowledge_bound', { tenantId, rosterId: entry.rosterId });
  }

  // 2. Agent-work board (roster-bound; distinct from the participant board).
  const boardId = kickbotBoardId(tenantId);
  if (!(await getBoard(boardId))) {
    await createBoard({
      id: boardId,
      tenantId,
      name: `${entry.persona}'s work`,
      rosterId: entry.rosterId,
      ownerSubject: { kind: 'agent', id: entry.rosterId },
      columns: [
        { id: 'todo', name: 'To Do' },
        { id: 'done', name: 'Done', terminal: true, terminalKind: 'completion' },
      ],
    });
  }

  // 3. Welcome conversation — the deterministic agent-subject conversation the
  //    shared chat reopens (never a second chat system; PRD §4.4).
  const conversationId = subjectConversationId(tenantId, { kind: 'agent', id: entry.rosterId });
  await ensureConversationMeta(tenantId, conversationId, { type: 'agent' });

  return {
    rosterId: entry.rosterId,
    roleKey: entry.roleKey ?? KICKBOT_ROLE_KEY,
    persona: entry.persona,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    enabled: entry.enabled,
    ...(entry.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: entry.heartbeatIntervalMs } : {}),
    ...(entry.autonomyLevel !== undefined ? { autonomyLevel: entry.autonomyLevel } : {}),
    boardId,
    conversationId,
  };
}
