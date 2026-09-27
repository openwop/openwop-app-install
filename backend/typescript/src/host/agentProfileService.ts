/**
 * Agent profile — host extension (non-normative).
 *
 * The reference implementation of ADR 0031's `agentProfile`: a host-local,
 * tenant-scoped record carrying the full "enterprise digital work twin"
 * property set (config parameters, permissions, HITL/escalation, channels,
 * admin controls, risk/compliance, required connections, metrics, and the
 * four-level autonomy model) for a standing agent.
 *
 * Persistence rides the existing `DurableCollection` seam — NO new database,
 * table family, or store (ADR 0031 §1). The collection is read-through (every
 * read/write hits storage), keyed by `profileId` = the owning `rosterId`
 * (standing agents) or `agentId` (definition-level). Tenant isolation lives at
 * this service + the route layer, mirroring `host/rosterService.ts`.
 *
 * Explicitly NOT a field on the RFC 0003 agent manifest: product config no
 * OpenWOP client needs stays host-local under `/v1/host/openwop-app/*`
 * (ARCHITECTURE.md "do not fork the protocol"). Therefore no OpenWOP RFC.
 *
 * @see docs/adr/0031-agent-profile-and-seeding.md
 * @see src/host/rosterService.ts — the patterns this mirrors
 */

import type { AgentProfile, AgentCapabilityId } from '../types.js';
import { DurableCollection } from './hostExtPersistence.js';
import { registerCredentialRefConsumer } from './credentialRefRegistry.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { ERASED, subjectKeyForms } from './subjectErasureRedaction.js';

// ADR 0379 P2 — TENANT-QUALIFIED key: profileId equals the rosterId for
// standing agents, and deterministic rosterIds (`host:<slug>`) repeat across
// tenants, so a bare-profileId key would let one tenant's upsert OVERWRITE
// another's row. Every public accessor already takes (tenantId, profileId)
// fail-closed, so the key scheme is internal. App-migration v7 rekeys
// existing rows.
const profileKey = (tenantId: string, profileId: string): string => `${tenantId}:${profileId}`;
const profiles = new DurableCollection<AgentProfile>('agent-profile', (p) => profileKey(p.tenantId, p.profileId));

function nowIso(): string {
  return new Date().toISOString();
}

// ADR 0499 — a per-agent voice may pin its own BYOK key at
// `configParameters.voice.credentialRef` (see `features/voice/voiceSession.ts`).
// Deleting that secret silently drops the agent back to the host default voice,
// which reads as a cosmetic regression rather than a broken binding. Keys are
// `${tenantId}:${profileId}`, so the prefix scan stays bounded to the tenant.
registerCredentialRefConsumer({
  id: 'agent-profile:voice',
  async describe(tenantId, ref) {
    const rows = await profiles.listByPrefix(`${tenantId}:`);
    return rows
      .filter((p) => {
        const voice = (p.configParameters as { voice?: { credentialRef?: unknown } } | undefined)?.voice;
        return voice?.credentialRef === ref;
      })
      .map((p) => `agent "${p.profileId}" voice key`);
  },
});

type SpecLevel = AgentProfile['autonomy']['specLevel'];
type RosterLevel = AgentProfile['autonomy']['level'];

/**
 * ADR 0031 autonomy mapping (four-level spec → three-level roster). Used to
 * DERIVE the enforced `level` from `specLevel` when the level is not set
 * explicitly. `specLevel` is provenance/display; `level` is enforcement.
 *
 * | spec `specLevel`          | roster `level` |
 * |---------------------------|----------------|
 * | draft-only                | review         |
 * | recommend                 | review         |
 * | execute-with-approval     | guided         |
 * | autonomous-within-policy  | auto           |
 */
export function levelForSpecLevel(specLevel: SpecLevel): RosterLevel {
  switch (specLevel) {
    case 'draft-only':
    case 'recommend':
      return 'review';
    case 'execute-with-approval':
      return 'guided';
    case 'autonomous-within-policy':
      return 'auto';
  }
}

/**
 * Inverse of {@link levelForSpecLevel} (ADR 0493). `roster.autonomyLevel` is the
 * single autonomy source of truth (owned by the Edit-details modal, read by the
 * heartbeat); the profile's `specLevel` is derived from it so the two can never
 * disagree. `review` has two spec levels (`draft-only`, `recommend`); we keep an
 * existing review-class `specLevel` when it already maps to `review`, else default
 * to `recommend`.
 */
export function specLevelForLevel(level: RosterLevel, existing?: SpecLevel): SpecLevel {
  switch (level) {
    case 'guided':
      return 'execute-with-approval';
    case 'auto':
      return 'autonomous-within-policy';
    case 'review':
      return existing === 'draft-only' ? 'draft-only' : 'recommend';
  }
}

/**
 * Keep a standing agent's profile autonomy in lockstep with `roster.autonomyLevel`
 * (ADR 0101). Called when the roster level changes (the Edit-details modal) so the
 * stored `profile.autonomy.{level,specLevel}` — read by the assistant + knowledge
 * enforcement seams — never goes stale. No-op when no profile exists or the level
 * already matches. Tenant-guarded (fail-closed cross-tenant).
 */
export async function syncAgentProfileAutonomy(
  tenantId: string,
  profileId: string,
  level: RosterLevel,
): Promise<void> {
  // Grade-pass F-4 — CAS + re-read-merge (the heal-family discipline).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await getAgentProfile(tenantId, profileId);
    if (!existing || existing.autonomy.level === level) return;
    const specLevel = specLevelForLevel(level, existing.autonomy.specLevel);
    if (await profiles.compareAndSwap(existing, {
      ...existing,
      autonomy: { ...existing.autonomy, level, specLevel },
      updatedAt: nowIso(),
    })) return;
  }
  throw new Error(`agent-profile autonomy sync contention: ${profileId}`);
}

/** Input to {@link upsertAgentProfile}. `autonomy.level` is optional — when
 *  omitted it is derived from `autonomy.specLevel` via {@link levelForSpecLevel}. */
export interface AgentProfileInput {
  roleKey: string;
  /** Core capabilities to ACTIVATE on this agent (e.g. `['assistant']`). The
   *  runtime gates capability behavior on this, never on `roleKey`. */
  capabilities?: AgentProfile['capabilities'];
  /** ADR 0442 P3 — memory-scope mode (`'agent'` shared vs `'per-user'`). Owned
   *  by provisioning, not the governance editor; preserved on an omitting upsert. */
  memoryScope?: AgentProfile['memoryScope'];
  department?: AgentProfile['department'];
  configParameters?: Record<string, unknown>;
  permissions?: AgentProfile['permissions'];
  hitl?: string[];
  escalation?: AgentProfile['escalation'];
  channels?: AgentProfile['channels'];
  adminControls?: string[];
  riskCompliance?: string[];
  requiredConnections?: string[];
  metrics?: string[];
  /** Per-agent knowledge & memory bindings (ADR 0038 — additive). */
  knowledge?: AgentProfile['knowledge'];
  autonomy: {
    level?: RosterLevel;
    specLevel: SpecLevel;
    withinPolicyActions?: string[];
  };
}

/** Read one profile, scoped to `tenantId`. Returns `null` when the profile is
 *  absent OR owned by a different tenant (fail-closed cross-tenant read). */
export async function getAgentProfile(tenantId: string, profileId: string): Promise<AgentProfile | null> {
  const profile = await profiles.get(profileKey(tenantId, profileId));
  if (!profile || profile.tenantId !== tenantId) return null;
  return profile;
}

/**
 * Resolve a standing agent's tool `permissions` for the ADR 0102 per-tool gate.
 * Only a STANDING (roster) agent carries a profile, and its `rosterId` IS its
 * dispatchable `agentId` (the `host:<slug>` form) — so a `host:`-prefixed agentId
 * keys the profile directly. A pack/manifest agent (no `host:` prefix) has no
 * profile ⇒ `undefined`, leaving the per-tool gate correctly ungated. Tenant-
 * scoped + fail-closed (a foreign / unknown / deleted agent ⇒ `undefined`).
 */
export async function resolveAgentToolPermissions(
  tenantId: string,
  agentId: string,
): Promise<AgentProfile['permissions'] | undefined> {
  if (!agentId.startsWith('host:')) return undefined;
  const profile = await getAgentProfile(tenantId, agentId);
  return profile?.permissions;
}

/** Create-or-replace a profile for `profileId` under `tenantId`. Preserves the
 *  original `createdAt` on update; always bumps `updatedAt`. The enforced
 *  autonomy `level` is derived from `specLevel` when not explicitly provided. */
export async function upsertAgentProfile(
  tenantId: string,
  profileId: string,
  input: AgentProfileInput,
): Promise<AgentProfile> {
  const existing = await profiles.get(profileKey(tenantId, profileId));
  // Defensive: never let an upsert silently re-own another tenant's profile.
  const prior = existing && existing.tenantId === tenantId ? existing : undefined;
  const profile = buildAgentProfile(tenantId, profileId, input, prior);
  await profiles.put(profile);
  return profile;
}

/** The ONE profile builder (residue-batch F-8: extracted so the capability
 *  create path can CAS-insert the SAME shape upsert writes — no second
 *  builder to drift). Preserves subsystem-owned fields from `prior`. */
export function buildAgentProfile(
  tenantId: string,
  profileId: string,
  input: AgentProfileInput,
  prior: AgentProfile | undefined,
): AgentProfile {
  const now = nowIso();
  const level = input.autonomy.level ?? levelForSpecLevel(input.autonomy.specLevel);
  // `capabilities`, `knowledge`, and `twin` are owned by OTHER subsystems
  // (capability activation, the ADR 0038 knowledge curator, ADR 0044 twin grants),
  // not the governance/profile editor. A full-replace PUT from that editor doesn't
  // resend them — so PRESERVE the prior values when the input omits them, or a
  // profile edit would silently wipe an agent's activated capabilities / knowledge
  // bindings / twin link (ADR 0101 data-preservation).
  const profile: AgentProfile = {
    profileId,
    tenantId,
    roleKey: input.roleKey,
    ...(input.capabilities !== undefined
      ? { capabilities: input.capabilities }
      : prior?.capabilities !== undefined ? { capabilities: prior.capabilities } : {}),
    // ADR 0442 P3 — `memoryScope` is provisioning-owned (like capabilities); a
    // governance full-replace edit doesn't resend it, so PRESERVE the prior value
    // on an omitting upsert, else a profile edit would silently drop `per-user`
    // and re-open the F1 shared-scope leak.
    ...(input.memoryScope !== undefined
      ? { memoryScope: input.memoryScope }
      : prior?.memoryScope !== undefined ? { memoryScope: prior.memoryScope } : {}),
    ...(input.department !== undefined ? { department: input.department } : {}),
    ...(input.configParameters !== undefined ? { configParameters: input.configParameters } : {}),
    ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
    ...(input.hitl !== undefined ? { hitl: input.hitl } : {}),
    ...(input.escalation !== undefined ? { escalation: input.escalation } : {}),
    ...(input.channels !== undefined ? { channels: input.channels } : {}),
    ...(input.adminControls !== undefined ? { adminControls: input.adminControls } : {}),
    ...(input.riskCompliance !== undefined ? { riskCompliance: input.riskCompliance } : {}),
    ...(input.requiredConnections !== undefined ? { requiredConnections: input.requiredConnections } : {}),
    ...(input.metrics !== undefined ? { metrics: input.metrics } : {}),
    // ADR 0643 R4 (Blocker 1 corollary) — `collectionIds` is the curator's field
    // (`agent-knowledge/service.ts`). A profile write that carries `knowledge` WITHOUT
    // it (the route now refuses it; seeds/import never send it) must not wipe the
    // bindings the curator made — that was a silent lost-update on every profile save.
    ...(input.knowledge !== undefined
      ? { knowledge: { ...input.knowledge, ...(input.knowledge.collectionIds === undefined && prior?.knowledge?.collectionIds !== undefined ? { collectionIds: prior.knowledge.collectionIds } : {}) } }
      : prior?.knowledge !== undefined ? { knowledge: prior.knowledge } : {}),
    ...(prior?.twin !== undefined ? { twin: prior.twin } : {}),
    autonomy: {
      level,
      specLevel: input.autonomy.specLevel,
      ...(input.autonomy.withinPolicyActions !== undefined
        ? { withinPolicyActions: input.autonomy.withinPolicyActions }
        : {}),
    },
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  };
  return profile;
}

/**
 * Activate a core capability on an agent's profile (idempotent). Merges into an
 * existing profile (preserving every other field); if no profile exists yet,
 * creates a minimal one from `init` carrying the capability. The runtime gates
 * capability behavior on `profile.capabilities`, so this is how a capability is
 * turned on per named agent — never via `roleKey`.
 */
export async function activateAgentCapability(
  tenantId: string,
  profileId: string,
  capability: NonNullable<AgentProfile['capabilities']>[number],
  init: { roleKey: string; autonomy: AgentProfileInput['autonomy'] },
): Promise<AgentProfile> {
  // Grade-pass DATA-2: the heal path was read-modify-`put` — a concurrent USER
  // governance edit racing a heal was last-writer-wins (a bounded clobber
  // window on first provision, now that provisioning sagas run two racers per
  // fresh Studio load across Cloud Run instances). CAS + re-read-merge: a lost
  // swap re-reads the winner's row and re-merges ONLY the capability, so a
  // user's autonomy/HITL edits are never overwritten. `expected` is the exact
  // object `get()` returned (the ADR 0447 byte-match rule).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await getAgentProfile(tenantId, profileId);
    if (!existing) {
      // Absent → INSERT-ONLY-IF-ABSENT (residue-batch F-8): CAS(null, built)
      // closes the different-capability lost-write (the loser re-reads and
      // MERGES via the heal path — test-proven). HONEST LIMIT (RES-2): a
      // delete racing an activation can still end with a recreated profile —
      // this only narrows WHAT gets written (a fresh minimal init, never a
      // stale full row); the delete-vs-activate window itself is pre-existing
      // and unchanged.
      const built = buildAgentProfile(tenantId, profileId, { ...init, capabilities: [capability] }, undefined);
      if (await profiles.compareAndSwap(null, built)) return built;
      continue; // lost the insert — re-read and merge
    }
    if ((existing.capabilities ?? []).includes(capability)) return existing;
    const updated: AgentProfile = {
      ...existing,
      capabilities: [...(existing.capabilities ?? []), capability],
      updatedAt: nowIso(),
    };
    if (await profiles.compareAndSwap(existing, updated)) return updated;
    // Lost the swap — loop re-reads the current row and re-merges.
  }
  // Three straight losses is pathological contention; one final read decides
  // honestly (someone else may have activated it meanwhile) — never a blind put.
  const final = await getAgentProfile(tenantId, profileId);
  if (final && (final.capabilities ?? []).includes(capability)) return final;
  throw new Error(`agent-profile capability activation contention: ${profileId}`);
}

/**
 * ADR 0442 P3 — set an agent's memory-scope mode (idempotent, merge-only). The
 * David's-law-clean way to turn on `per-user` memory for a standing agent
 * WITHOUT re-sending its whole profile (which would risk clobbering a governance
 * edit) and WITHOUT any agent-id special-case in the memory path — the runtime
 * keys off this field. Preserves every other field; a matching mode is a no-op.
 * Creates a minimal profile from `init` when none exists. Tenant-scoped.
 */
export async function setAgentMemoryScope(
  tenantId: string,
  profileId: string,
  memoryScope: NonNullable<AgentProfile['memoryScope']>,
  init: { roleKey: string; autonomy: AgentProfileInput['autonomy'] },
): Promise<AgentProfile> {
  const existing = await getAgentProfile(tenantId, profileId);
  if (!existing) return upsertAgentProfile(tenantId, profileId, { ...init, memoryScope });
  if (existing.memoryScope === memoryScope) return existing;
  const updated: AgentProfile = { ...existing, memoryScope, updatedAt: nowIso() };
  await profiles.put(updated);
  return updated;
}

/** ADR 0373 — capabilities a TENANT may elect on their OWN agent.
 *
 *  Everything else in `AgentCapabilityId` is FEATURE-OWNED and deliberately NOT
 *  here: `'assistant'` is bootstrapped onto the SEEDED holder by
 *  `ensureAssistantAgent`, which resolves the assistant BY capability — so a
 *  hand-activated second holder would make `findAssistantAgent` ambiguous and
 *  break that invariant from a plain tenant request. Closed-world by design:
 *  adding a member is a deliberate product decision, never a default.
 *
 *  @see src/routes/agentProfile.ts — the tenant-facing election surface */
export const TENANT_ELECTABLE_CAPABILITIES: readonly AgentCapabilityId[] = ['deep-investigation'];

/** ADR 0373 — REVOKE a capability from an agent's profile (idempotent, and the
 *  mirror of `activateAgentCapability`). A grant that cannot be revoked is a
 *  governance defect — the same reasoning ADR 0104 used to choose full-replace
 *  over additive ("additive could not revoke"). Preserves every other field; a
 *  missing profile or an already-absent capability is a no-op (returns the
 *  profile or null), never an error. */
export async function deactivateAgentCapability(
  tenantId: string,
  profileId: string,
  capability: NonNullable<AgentProfile['capabilities']>[number],
): Promise<AgentProfile | null> {
  // Grade-pass F-4 — same CAS discipline as activateAgentCapability: a lost
  // swap re-reads and re-applies ONLY the capability removal, never clobbering
  // a concurrent governance edit.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await getAgentProfile(tenantId, profileId);
    if (!existing) return null;
    if (!(existing.capabilities ?? []).includes(capability)) return existing;
    const updated: AgentProfile = {
      ...existing,
      capabilities: (existing.capabilities ?? []).filter((c) => c !== capability),
      updatedAt: nowIso(),
    };
    if (await profiles.compareAndSwap(existing, updated)) return updated;
  }
  const final = await getAgentProfile(tenantId, profileId);
  if (!final || !(final.capabilities ?? []).includes(capability)) return final;
  throw new Error(`agent-profile capability deactivation contention: ${profileId}`);
}

/**
 * Merge a `knowledge` binding patch into an agent's profile (ADR 0038),
 * idempotently activating the `knowledge` capability at the same time. Used by
 * the `agent-knowledge` feature's curation service to bind/unbind a collection
 * or toggle `memoryWritable` WITHOUT requiring the caller to re-send the whole
 * profile. Fail-closed cross-tenant: a profile owned by another tenant is not
 * found → a fresh minimal profile is created under the CALLER's tenant. When no
 * profile exists yet, a minimal one is created from `init`.
 *
 * `patch` is shallow-merged onto the existing `knowledge` block; an explicit
 * `undefined` field in `patch` is ignored (use the dedicated array operations in
 * the feature service to remove a collection id).
 */
/**
 * ADR 0664 D4 — `activateCapability` is a decision the CALL SITE makes, never inferred
 * from the shape of `patch`.
 *
 * This function used to union `knowledge` onto the profile on EVERY write, so ADR 0373's
 * `DELETE …/capabilities/knowledge` was undone by the next unbind, the next
 * `setMemoryWritable(false)` — a privacy action re-granting the very capability it was
 * exercised to remove — and even by a plain `GET …/knowledge`, because the dangling-binding
 * self-heal (`agent-knowledge/service.ts:160`) is a durable write on a read path. Merely
 * OPENING the panel re-granted it.
 *
 * Inferring the answer from the patch (e.g. "union only when `collectionIds` grows") was
 * the first draft and is wrong: `kickbotService.ts:323` seeds with `{retrieval:…}` and NO
 * `collectionIds` when KB is unavailable, and under that rule KickBot would silently lose
 * memory recall — `resolveAgentKnowledgeRetrieve` fails closed without the capability.
 * A seed is a grant; an unbind is not. Only the caller knows which it is.
 */
export async function setAgentKnowledge(
  tenantId: string,
  profileId: string,
  patch: NonNullable<AgentProfile['knowledge']>,
  init: { roleKey: string; autonomy: AgentProfileInput['autonomy'] },
  opts: { activateCapability: boolean } = { activateCapability: true },
): Promise<AgentProfile> {
  const existing = await getAgentProfile(tenantId, profileId);
  if (!existing) {
    // A first write on a profile-less agent is a grant by construction: without the
    // capability the binding it is creating would retrieve nothing.
    return upsertAgentProfile(tenantId, profileId, {
      ...init,
      capabilities: ['knowledge'],
      knowledge: patch,
    });
  }
  const merged: NonNullable<AgentProfile['knowledge']> = { ...(existing.knowledge ?? {}), ...patch };
  const capabilities = !opts.activateCapability || (existing.capabilities ?? []).includes('knowledge')
    ? existing.capabilities
    : [...(existing.capabilities ?? []), 'knowledge' as const];
  const updated: AgentProfile = {
    ...existing,
    ...(capabilities !== undefined ? { capabilities } : {}),
    knowledge: merged,
    updatedAt: nowIso(),
  };
  await profiles.put(updated);
  return updated;
}

/** Set or clear the digital-twin LINK on an agent's profile (ADR 0044) — `twin`
 *  set ⇒ this agent is a twin of that user; `null` ⇒ unlinked. Creates a minimal
 *  profile from `init` if none exists. The link grants NO memory access by itself
 *  (a user-issued `TwinGrant` is the authorization — `twinService`). Tenant-scoped. */
export async function setAgentTwin(
  tenantId: string,
  profileId: string,
  twin: AgentProfile['twin'] | null,
  init: { roleKey: string; autonomy: AgentProfileInput['autonomy'] },
): Promise<AgentProfile> {
  let existing = await getAgentProfile(tenantId, profileId);
  if (!existing) existing = await upsertAgentProfile(tenantId, profileId, init);
  const updated: AgentProfile = { ...existing, updatedAt: nowIso() };
  if (twin) updated.twin = twin; else delete updated.twin;
  await profiles.put(updated);
  return updated;
}

/** Delete an agent's profile (incl. its capability activations + ADR 0038
 *  knowledge bindings, which live on the profile). Tenant-guarded (fail-closed:
 *  a cross-tenant profile is not deleted). Used by the roster cascade so a
 *  removed agent's profile + bindings don't orphan. Returns true when removed. */
export async function deleteAgentProfile(tenantId: string, profileId: string): Promise<boolean> {
  const existing = await profiles.get(profileKey(tenantId, profileId));
  if (!existing) return false;
  return profiles.delete(profileKey(tenantId, profileId));
}

/**
 * One-shot backfill (ADR 0102): ensure every EXISTING profile that already
 * carries a tool `permissions` allowlist also permits the given read tokens
 * (the host's builtin tool namespaces), so flipping the per-tool gate on doesn't
 * block legitimate builtin tool calls. Adds only the MISSING tokens to
 * `permissions.read` (idempotent set-union — safe under concurrent migration
 * runners + a no-op on re-run). Profiles with NO `permissions` block stay
 * ungated (untouched). Returns the number of profiles updated.
 */
export async function backfillProfileReadPermissions(readTokens: readonly string[]): Promise<number> {
  const all = await profiles.list();
  let updated = 0;
  for (const p of all) {
    if (!p.permissions) continue;
    const read = p.permissions.read ?? [];
    const missing = readTokens.filter((tok) => !read.includes(tok));
    if (missing.length === 0) continue;
    await profiles.put({
      ...p,
      permissions: { ...p.permissions, read: [...read, ...missing] },
      updatedAt: nowIso(),
    });
    updated += 1;
  }
  return updated;
}

// ── ADR 0464 P2 — DSAR subject erasure ───────────────────────────────────────
// The agent profile is an AGENT-structural row (never deleted), but its ADR 0044
// twin LINK carries two human references: `twin.userId` (the person this agent is
// a twin OF) and `twin.linkedBy` (the admin who set the link). A DSAR ANONYMIZES
// whichever of those references the erased subject — the link's SHAPE survives so
// the agent's structure is unchanged, but the person's id is overwritten with the
// sentinel. (The user-issued authorization `TwinGrant` is a separate store,
// erased by `twinService`.) Every other profile is untouched. Written via a
// direct `profiles.put` (no autonomy/knowledge upsert side effects). Idempotent;
// tenant-scoped; fail-closed on falsy input.

/** DSAR eraser — anonymize the subject's references on any agent twin LINK. */
export async function eraseSubjectAgentTwinLinks(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const p of (await profiles.list()).filter((p) => p.tenantId === tenantId)) {
    if (!p.twin) continue;
    const userHit = forms.has(p.twin.userId);
    const byHit = forms.has(p.twin.linkedBy);
    if (!userHit && !byHit) continue;
    await profiles.put({
      ...p,
      twin: {
        ...p.twin,
        ...(userHit ? { userId: ERASED } : {}),
        ...(byHit ? { linkedBy: ERASED } : {}),
      },
      updatedAt: nowIso(),
    });
  }
}

/** Register the agent-profile twin-link DSAR eraser (idempotent — the seam
 *  dedupes by reference). Called from the host-erasers boot step. */
export function registerAgentProfileTwinErasure(): void {
  registerSubjectEraser(eraseSubjectAgentTwinLinks);
}

/** Test-only: drop all profiles. */
export async function __resetAgentProfileStore(): Promise<void> {
  await profiles.__clear();
}
