/**
 * Challenge Author provisioning saga (ADR 0458 §2.1; P1).
 *
 * The Challenge Author is ONE persistent named roster instance per workspace —
 * the agent a creator converses with in the ONE chat to ignite the Challenge
 * Factory. Composed entirely from existing owners (roster/profile); the agent
 * PERSONA + prompt + tool allowlist live in the `feature.kicktodo.agents` pack
 * (resolved tenant-less via the agent registry), so — unlike KickBot — no
 * host-side user-agent record is created here.
 *
 * Invariants (mirrors `kicktodo-core/kickbotService.ts`, each test-asserted):
 *  - FIXED identity: created with persona `Challenge Author` so the
 *    deterministic roster id is `host:challenge-author` (ADR 0379; a rename
 *    never changes it — identity fields are structural).
 *  - Stable semantic role `kicktodo-challenge-author` — the name-independent
 *    handle every lookup uses (never the display name).
 *  - The factory workflow in ASSIGNED workflows (`workflows: [...]`), so the
 *    chat's existing run-mention/assigned-workflow dispatch is the ignition
 *    path — no bespoke trigger surface (ADR 0458 §2.1).
 *  - EXPLICIT heartbeat OFF (`heartbeatIntervalMs: -1`) + `autonomyLevel:
 *    'review'` — an absent heartbeat would INHERIT the host default and run
 *    autonomously; a fresh Challenge Author must not.
 *  - `challenge-authoring` capability at the CORE level, activated on the
 *    PROFILE (never fused to `roleKey` — David's law).
 *  - Idempotent + forward-repairable: every step is get-or-create with a
 *    deterministic id (re-invocation converges; a missing piece is repaired).
 */

import { createLogger } from '../../observability/logger.js';
import { listRoster, createRosterEntry, updateRosterEntry, type RosterEntry } from '../../host/rosterService.js';
import { activateAgentCapability } from '../../host/agentProfileService.js';
import { getAgentRegistry } from '../../executor/agentRegistry.js';
import { CHALLENGE_AUTHORING_CAPABILITY } from './challengeAuthoringCapability.js';
import { CHALLENGE_FACTORY_WORKFLOW_ID } from './builtinWorkflows.js';

const log = createLogger('kicktodo.challenge-author');

/** The Challenge Author's stable semantic role — the name-independent handle. */
export const CHALLENGE_AUTHOR_ROLE_KEY = 'kicktodo-challenge-author';

/** The default persona at creation (user-renameable; identity stays fixed). */
export const CHALLENGE_AUTHOR_DEFAULT_PERSONA = 'Challenge Author';

/** DETERMINISTIC roster id — `host:${slugify('Challenge Author')}` (ADR 0379). */
export const CHALLENGE_AUTHOR_ROSTER_ID = 'host:challenge-author';

/** The PACK agent persona the roster entry points at (resolved tenant-less via
 *  the agent registry — the `feature.kicktodo.agents` pack owns the prompt +
 *  tool allowlist). FIXED by the ADR 0458 P1 prompt-parity test. */
export const CHALLENGE_AUTHOR_AGENT_ID = 'feature.kicktodo.agents.challenge-author';

export interface ChallengeAuthorInstance {
  rosterId: string;
  roleKey: string;
  persona: string;
  label?: string;
  enabled: boolean;
  workflows: string[];
  heartbeatIntervalMs?: number;
  autonomyLevel?: string;
}

async function findAuthor(tenantId: string): Promise<RosterEntry | undefined> {
  return (await listRoster(tenantId)).find((e) => e.roleKey === CHALLENGE_AUTHOR_ROLE_KEY);
}

/** The pack version to pin on the roster's agentRef — read from the RESOLVED
 *  manifest (no hand-held version to drift from the pin). Falls back when the
 *  agents pack is not loaded (e.g. a unit test that never installs packs). */
function authorPackVersion(): string {
  return getAgentRegistry().get(CHALLENGE_AUTHOR_AGENT_ID)?.packVersion ?? '1.0.0';
}

/** In-process single-flight per tenant (the ensureKickBot pattern — the roster
 *  store has no unique-role index, so two concurrent provisions must converge). */
const ensuring = new Map<string, Promise<ChallengeAuthorInstance>>();

export async function ensureChallengeAuthor(tenantId: string): Promise<ChallengeAuthorInstance> {
  const inflight = ensuring.get(tenantId);
  if (inflight) return inflight;
  const work = provision(tenantId).finally(() => ensuring.delete(tenantId));
  ensuring.set(tenantId, work);
  return work;
}

async function provision(tenantId: string): Promise<ChallengeAuthorInstance> {
  const description =
    'The KickTodo Challenge Author — talks a creator through a concept and runs the Challenge Factory (deep research → outline → gated build). An AI agent provided by KickTodo.';

  // 1. Roster identity — get-or-create by the stable ROLE (never the name).
  let entry = await findAuthor(tenantId);
  if (!entry) {
    try {
      entry = await createRosterEntry({
        tenantId,
        persona: CHALLENGE_AUTHOR_DEFAULT_PERSONA, // ⇒ deterministic rosterId host:challenge-author
        agentRef: { agentId: CHALLENGE_AUTHOR_AGENT_ID, version: authorPackVersion() },
        // The factory workflow in ASSIGNED workflows is the ignition path.
        workflows: [CHALLENGE_FACTORY_WORKFLOW_ID],
        roleKey: CHALLENGE_AUTHOR_ROLE_KEY,
        label: CHALLENGE_AUTHOR_DEFAULT_PERSONA,
        description,
        enabled: true,
        heartbeatIntervalMs: -1, // EXPLICIT off — never inherit the host default
        autonomyLevel: 'review',
      });
      log.info('challenge_author_provisioned', { tenantId, rosterId: entry.rosterId });
    } catch (err) {
      // Persona already taken (a concurrent provision won, or host:challenge-author
      // exists without our role key) — converge on the existing author; anything
      // else is a real failure.
      entry = await findAuthor(tenantId);
      if (!entry) throw err;
    }
  }

  // ADR 0461 OQ1 heal — the saga PINS autonomy to 'review', but a converged
  // entry (concurrent-provision loser, or an author minted before the pin
  // existed) can lack it. The read reports roster TRUTH, so heal the roster row
  // rather than paper over it in the response. Never overwrites a user's
  // explicit edit — only fills the absent field.
  if (entry.autonomyLevel === undefined) {
    const healed = await updateRosterEntry(tenantId, entry.rosterId, { autonomyLevel: 'review' });
    if (healed) {
      entry = healed;
      log.info('challenge_author_autonomy_healed', { tenantId, rosterId: entry.rosterId });
    }
  }

  // 2. The governance PROFILE with the challenge-authoring capability.
  //    `activateAgentCapability` is get-or-create + capability-heal: it creates
  //    the profile from `init` when absent (carrying the capability), and only
  //    ADDS the capability to an existing profile — never clobbering a user's
  //    autonomy/HITL/permission edits (the KickBot heal invariant).
  await activateAgentCapability(tenantId, entry.rosterId, CHALLENGE_AUTHORING_CAPABILITY, {
    roleKey: CHALLENGE_AUTHOR_ROLE_KEY,
    autonomy: { specLevel: 'recommend' }, // ⇒ roster level 'review'
  });

  return {
    rosterId: entry.rosterId,
    roleKey: entry.roleKey ?? CHALLENGE_AUTHOR_ROLE_KEY,
    persona: entry.persona,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    enabled: entry.enabled,
    workflows: entry.workflows ?? [CHALLENGE_FACTORY_WORKFLOW_ID],
    ...(entry.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: entry.heartbeatIntervalMs } : {}),
    ...(entry.autonomyLevel !== undefined ? { autonomyLevel: entry.autonomyLevel } : {}),
  };
}
