/**
 * Standing agent roster — host extension (non-normative).
 *
 * The reference implementation of RFCS/0086: a named, tenant-scoped agent
 * INSTANCE (the "digital-twin employee", e.g. "Sally") that references a
 * manifest agent (`agentRef.agentId`) and OWNS a workflow portfolio
 * (`workflows[]`) — the workflows it is responsible for by role. A board
 * (host/kanbanService.ts) can be bound to a roster member; when a card
 * fires a portfolio workflow, the run is attributed to the member (the
 * RFC 0086 §C `roster.run.initiated` attribution — emitted here via the
 * Kanban route as a content-free `kanban.card.moved` carrying the
 * rosterId + persona).
 *
 * `rosterId` is a `host:<id>` form — the runtime-synthesis namespace RFC
 * 0002 reserves for host-internal agents that don't ship as packs (RFC
 * 0086 §A: a roster entry IS a dispatchable `host:<id>` AgentRef, not a
 * parallel id space). The store is now a read-through, per-entity durable
 * collection (host/hostExtPersistence.ts) — every read/write hits storage,
 * so the roster is consistent across instances and survives restarts. A
 * production host scopes by the RFC 0048 owner triple.
 *
 * Scope note (reference impl): a board-triggered run is dispatched by its
 * `workflowId`; the bound member's `agentRef` is recorded for ATTRIBUTION
 * only (persona + agentId in the run's `kanban` metadata), not yet used to
 * execute the workflow *as* that agent. Full RFC 0086 dispatch-as-agent is
 * deferred to the Draft→Active wire surface. `enabled: false` makes a
 * member's board triggers inert (enforced in routes/kanban.ts).
 *
 * @see RFCS/0086-standing-agent-roster-and-workflow-portfolio.md §A/§B/§C
 * @see src/host/kanbanService.ts — the board surface a roster member owns
 */

import { randomUUID } from 'node:crypto';
import { OpenwopError } from '../types.js';
import { DurableCollection } from './hostExtPersistence.js';
import { onWorkflowForked } from './workflowsRegistry.js';
import { casRepoint, repointList } from './forkRepoint.js';
import { CAS_RETRIES, entityEtag, staleWriteError } from './entityVersion.js';

/** The manifest/deployment a roster member instantiates (a trimmed
 *  AgentRef — RFC 0002). `version` XOR `channel` per RFC 0082 §A. */
export interface RosterAgentRef {
  agentId: string;
  version?: string;
  channel?: string;
}

/** A standing named agent instance (RFC 0086 §A). */
export interface RosterEntry {
  /** `host:<slug>` — a dispatchable AgentRef agentId (RFC 0086 §A). */
  rosterId: string;
  /** Human display name, projected onto AgentRef.persona (RFC 0002). */
  persona: string;
  agentRef: RosterAgentRef;
  /** The standing portfolio — workflows this member owns by role. */
  workflows: string[];
  tenantId: string;
  enabled: boolean;
  label?: string;
  description?: string;
  /** Profile picture as a small `data:image/*;base64,…` URI (host-extension
   *  only; never crosses the normative RFC 0072 manifest inventory). The
   *  reference impl stores the cropped 256×256 thumbnail inline on the durable
   *  roster row — multi-instance safe + restart-durable, unlike the in-memory
   *  media-asset store. Absent ⇒ the UI renders the persona initials. */
  avatarUrl?: string;
  /** ISO-8601 timestamp of the last "Check now" heartbeat that actually ran
   *  (set in routes/agentOps.ts). Absent ⇒ never checked. Surfaced in the UI
   *  as "last checked …"; the heartbeat is a manual pull in this sample, so
   *  there is no persisted "next check" beyond any enabled scheduler job. */
  lastHeartbeatAt?: string;
  /** Autonomous heartbeat cadence in milliseconds. ADR 0313 D1 — three states,
   *  resolved by `effectiveHeartbeatIntervalMs`: `> 0` = this explicit cadence;
   *  absent or `0` = "not configured" ⇒ the HOST DEFAULT cadence applies
   *  (`OPENWOP_HEARTBEAT_DEFAULT_MS`, default 10 min — the daemon DOES run it);
   *  `-1` (`HEARTBEAT_OFF`) = explicit opt-out ⇒ the daemon never touches it.
   *  (Pre-0313 this was opt-in: absent/0 meant manual-only.) */
  heartbeatIntervalMs?: number;
  /** How much autonomy this member has when its heartbeat picks up work.
   *  `auto` (default) — start the proposed run immediately (today's behavior).
   *  `review` — "agents propose, humans dispose": the heartbeat does NOT start
   *  the run; it queues a pending approval (host/approvalService.ts) that a
   *  human must affirmatively claim before the run starts. Host-extension only;
   *  the normative manifest inventory is unaffected. Absent ⇒ `auto`. */
  autonomyLevel?: 'auto' | 'guided' | 'review';
  /** The seed role template this member was created from (e.g. `sales-ops`,
   *  `chief-of-staff`). Set by the demo seed from `exampleAgents.json`; absent for
   *  hand-created agents. Persisting it makes role identity + theming EXACT
   *  (the frontend no longer heuristically infers the theme from the workflow
   *  portfolio), and lets a feature find its system agent by role regardless of
   *  a user-renamed persona/label — e.g. the assistant's `chief-of-staff`. */
  roleKey?: string;
  createdAt: string;
  updatedAt: string;
}

/** The effective autonomy of an entry (the field is optional; absent ⇒ auto).
 *  `guided` (2026-06-05): routine heartbeat picks run immediately; HIGH-
 *  priority picks queue as proposals — the only middle level composable from
 *  data the host actually has (card.priority + the approval path).
 *  TRIPWIRE: this host-ext field MUST NEVER be serialized onto a normative
 *  /v1/agents/roster response (agent-roster-entry.schema.json is
 *  additionalProperties:false — any host that leaks it fails conformance). */
/** `agent-roster-entry.schema.json` — the normative wire shape. CLOSED: the
 *  schema is `additionalProperties: false`, so this is an allowlist, never a
 *  spread of the stored row (which carries host-ext fields such as
 *  `autonomyLevel`, `roleKey`, heartbeat state). */
export interface NormativeRosterEntry {
  rosterId: string;
  persona: string;
  agentRef: RosterAgentRef;
  workflows: string[];
  owner: { tenantId: string };
  enabled: boolean;
  label?: string;
  description?: string;
}

const NORMATIVE_ROSTER_ID = /^host:[a-z0-9][a-z0-9._-]*$/;

/**
 * RFC 0086 (Accepted) / `agent-roster.md` §B — project the tenant's roster onto
 * `GET /v1/agents/roster`. ONE projection, owned here beside the store, so the
 * normative read cannot drift from the host-extension one.
 *
 * Advisor-subject entries (`roleKey: 'advisor'`, ADR 0040) are excluded for the
 * same reason the host-ext roster excludes them by default: they are persona-only
 * Board-of-Advisors subjects, not standing members with a portfolio. An entry
 * whose id cannot be expressed in the normative grammar (a pre-ADR 0379 legacy
 * row that was never rekeyed) is omitted rather than rewritten — renaming it on
 * the wire would hand clients an id the host-ext API does not know.
 */
export async function listNormativeRoster(tenantId: string): Promise<NormativeRosterEntry[]> {
  const all = await listRoster(tenantId);
  return all
    .filter((e) => e.roleKey !== 'advisor' && NORMATIVE_ROSTER_ID.test(e.rosterId))
    .map((e) => ({
      rosterId: e.rosterId,
      persona: e.persona,
      agentRef: {
        agentId: e.agentRef.agentId,
        // RFC 0082 §A — version XOR channel; the write path already refuses both.
        ...(e.agentRef.version !== undefined ? { version: e.agentRef.version }
          : e.agentRef.channel !== undefined ? { channel: e.agentRef.channel } : {}),
      },
      workflows: [...e.workflows],
      owner: { tenantId: e.tenantId },
      enabled: e.enabled,
      ...(e.label !== undefined ? { label: e.label } : {}),
      ...(e.description !== undefined ? { description: e.description } : {}),
    }));
}

export function autonomyOf(entry: RosterEntry): 'auto' | 'guided' | 'review' {
  if (entry.autonomyLevel === 'review') return 'review';
  if (entry.autonomyLevel === 'guided') return 'guided';
  return 'auto';
}

// ADR 0379 P2 (PR-A) — TENANT-QUALIFIED key: deterministic per-persona
// rosterIds (`host:<slug>`, Phase 2 new-mint) repeat across tenants, so the
// row key carries the tenant. Existing rows are rekeyed in-place by
// app-migrations v5/v6/v8 (old shape `hostext:roster:host:…` → `…:<tenant>:host:…`).
// All external access rides the four tenant-scoped accessors (Phase 1), so
// the key scheme is an internal detail of this module.
const rosterKey = (tenantId: string, rosterId: string): string => `${tenantId}:${rosterId}`;
const roster = new DurableCollection<RosterEntry>('roster', (e) => rosterKey(e.tenantId, e.rosterId));

/**
 * EVID-5 (heartbeat half; the schedule daemon's change-token pattern) — a one-row "roster changed"
 * token, so the heartbeat daemon can skip re-listing every tenant's roster on
 * each 30 s tick when nothing changed. Every successful roster write sets the
 * row FIRST and the token SECOND; the daemon reads the token FIRST and lists
 * SECOND, so a reader that sees an old token can only re-list late (bounded by
 * its backstop), never miss a change it already observed.
 */
interface RosterVersion { id: string; token: string }
const rosterVersion = new DurableCollection<RosterVersion>('roster-version', (v) => v.id);
const ROSTER_VERSION_ID = 'v';
async function bumpRosterVersion(): Promise<void> {
  await rosterVersion.put({ id: ROSTER_VERSION_ID, token: randomUUID() });
}
/** The current roster-change token, or null before the first write. */
export async function readRosterVersion(): Promise<string | null> {
  return (await rosterVersion.get(ROSTER_VERSION_ID))?.token ?? null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(persona: string): string {
  const base = persona
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
  return base.length > 0 ? base : 'agent';
}

export async function createRosterEntry(input: {
  tenantId: string;
  persona: string;
  agentRef: RosterAgentRef;
  workflows?: string[];
  label?: string;
  description?: string;
  enabled?: boolean;
  avatarUrl?: string;
  heartbeatIntervalMs?: number;
  autonomyLevel?: 'auto' | 'guided' | 'review';
  roleKey?: string;
}): Promise<RosterEntry> {
  // ADR 0379 P2 (PR-B) — DETERMINISTIC per-persona id (`host:<slug>`), no
  // random suffix: the same persona folds/reseeds onto the SAME row instead of
  // duplicating (the fold-idempotency invariant, by construction). Within a
  // tenant a duplicate persona is a 409 — the user-agent create's semantics.
  const rosterId = `host:${slugify(input.persona)}`;
  if (await getRosterEntry(input.tenantId, rosterId)) {
    // 'conflict' mirrors the user-agent duplicate-persona 409 semantics.
    throw new OpenwopError('conflict', `A roster member for persona "${input.persona}" already exists.`, 409, { rosterId });
  }
  const now = nowIso();
  const entry: RosterEntry = {
    rosterId,
    persona: input.persona,
    agentRef: { ...input.agentRef },
    workflows: input.workflows ? [...input.workflows] : [],
    tenantId: input.tenantId,
    enabled: input.enabled ?? true,
    label: input.label,
    description: input.description,
    avatarUrl: input.avatarUrl,
    ...(input.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: input.heartbeatIntervalMs } : {}),
    // Persist non-default levels; `auto`/absent normalize to undefined (the
    // default) so stock entries stay shape-stable.
    autonomyLevel: input.autonomyLevel === 'review' || input.autonomyLevel === 'guided' ? input.autonomyLevel : undefined,
    ...(input.roleKey !== undefined ? { roleKey: input.roleKey } : {}),
    createdAt: now,
    updatedAt: now,
  };
  // Grade-pass fix: insert-if-absent CAS, not a plain put — two concurrent
  // same-persona creates (cross-instance; the check above is not a lock) would
  // otherwise BOTH pass the 409 check and the loser's row would be silently
  // clobbered while both callers got a 201.
  if (!(await roster.compareAndSwap(null, entry))) {
    throw new OpenwopError('conflict', `A roster member for persona "${input.persona}" already exists.`, 409, { rosterId });
  }
  await bumpRosterVersion();
  return entry;
}

export async function listRoster(tenantId: string): Promise<RosterEntry[]> {
  // ADR 0379 P2 — the tenant-qualified key makes this a prefix scan instead
  // of the previous full cross-tenant list+filter.
  return (await roster.listByPrefix(`${tenantId}:`))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** ADR 0379 P1 — tenant-scoped fail-closed (mirrors `getAgentProfile`): a
 *  cross-tenant rosterId returns null, indistinguishable from absent. Since
 *  P2 the tenant is part of the ROW KEY, so the scoping is structural. */
export async function getRosterEntry(tenantId: string, rosterId: string): Promise<RosterEntry | null> {
  return roster.get(rosterKey(tenantId, rosterId));
}


/** Distinct tenant ids that own at least one roster member. The background
 *  heartbeat daemon uses this to scope its per-tenant scan (the store lists
 *  per tenant). Prefix-scan posture, like the rest of the host-ext surfaces. */
export async function listRosterTenants(): Promise<string[]> {
  const tenants = new Set<string>();
  for (const e of await roster.list()) tenants.add(e.tenantId);
  return [...tenants];
}

/** ADR 0414 M3-2 (KickTodo B2) — a persona rename that collides with another
 *  same-tenant roster entry's mention handle is refused. The chat @-mention
 *  picker keys on persona text, so two entries sharing a (case-insensitive)
 *  persona make mentions ambiguous — and a user-renamed agent (KickBot) must
 *  not be able to impersonate an existing coworker by taking its name. Rename
 *  continuity itself stays structural: `rosterId`/`roleKey` are never touched
 *  by any patch. */
export class PersonaCollisionError extends Error {
  constructor(public readonly persona: string) {
    super(`Persona \`${persona}\` is already used by another agent in this workspace.`);
  }
}

const personaKey = (p: string): string => p.trim().toLowerCase();

export async function updateRosterEntry(
  tenantId: string,
  rosterId: string,
  patch: {
    persona?: string;
    workflows?: string[];
    enabled?: boolean;
    label?: string;
    description?: string;
    /** `string` sets the photo, `null` clears it, `undefined` leaves it. */
    avatarUrl?: string | null;
    /** Autonomous heartbeat cadence (ms). 0 or negative disables it. */
    heartbeatIntervalMs?: number;
    autonomyLevel?: 'auto' | 'guided' | 'review';
  },
  opts: { ifMatch?: string } = {},
): Promise<RosterEntry | null> {
  // ADR 0775 P4 (`ARWF-11`) — read, check the caller's version, apply, then
  // compare-and-swap against the row that was read. A lost swap re-reads and
  // re-applies the patch, so a concurrent write (another field's PATCH, a
  // heartbeat stamp) is kept rather than overwritten; with `ifMatch` the re-read
  // version no longer matches and the write is refused instead.
  for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
    const current = await getRosterEntry(tenantId, rosterId); // ADR 0379 P1 — fail-closed
    if (!current) return null;
    if (opts.ifMatch !== undefined && rosterEtag(current) !== opts.ifMatch) {
      throw staleWriteError('agent', rosterEtag(current));
    }
    const entry = applyRosterPatch(structuredClone(current), patch, patch.persona !== undefined ? await listRoster(tenantId) : []);
    if (await roster.compareAndSwap(current, entry)) {
      await bumpRosterVersion();
      return entry;
    }
  }
  throw staleWriteError('agent', undefined);
}

/** The roster row's content version (ADR 0775 P4). `lastHeartbeatAt` is an
 *  activity stamp, not an edit, so it does not change the version. */
export function rosterEtag(entry: RosterEntry): string {
  return entityEtag(entry, ['lastHeartbeatAt']);
}

function applyRosterPatch(
  entry: RosterEntry,
  patch: Parameters<typeof updateRosterEntry>[2],
  siblingsList: readonly RosterEntry[],
): RosterEntry {
  const rosterId = entry.rosterId;
  if (patch.persona !== undefined && personaKey(patch.persona) !== personaKey(entry.persona)) {
    // ADR 0414 M3-2 — collision-checked mention handle on the rename path.
    const siblings = siblingsList;
    if (siblings.some((s) => s.rosterId !== rosterId && personaKey(s.persona) === personaKey(patch.persona as string))) {
      throw new PersonaCollisionError(patch.persona);
    }
  }
  if (patch.persona !== undefined) entry.persona = patch.persona;
  if (patch.workflows !== undefined) entry.workflows = [...patch.workflows];
  if (patch.enabled !== undefined) entry.enabled = patch.enabled;
  if (patch.label !== undefined) entry.label = patch.label;
  if (patch.description !== undefined) entry.description = patch.description;
  if (patch.heartbeatIntervalMs !== undefined) {
    // ADR 0313 D1 — three storable states: a positive cadence, the -1 OFF
    // sentinel (explicit opt-out of the host default), or cleared (0 ⇒ follow
    // the host default). Deleting -1 here would silently re-enroll the agent.
    if (patch.heartbeatIntervalMs > 0 || patch.heartbeatIntervalMs === -1) entry.heartbeatIntervalMs = patch.heartbeatIntervalMs;
    else delete entry.heartbeatIntervalMs;
  }
  if (patch.avatarUrl !== undefined) {
    if (patch.avatarUrl === null) delete entry.avatarUrl;
    else entry.avatarUrl = patch.avatarUrl;
  }
  if (patch.autonomyLevel !== undefined) {
    // Normalize: non-default levels persist; 'auto' is the absent default.
    if (patch.autonomyLevel === 'review' || patch.autonomyLevel === 'guided') entry.autonomyLevel = patch.autonomyLevel;
    else delete entry.autonomyLevel;
  }
  entry.updatedAt = nowIso();
  return entry;
}

/** Stamp the last-heartbeat time on an entry (called when a "Check now"
 *  heartbeat actually runs). Returns the updated entry, or null if missing.
 *  Does not touch `updatedAt` — a heartbeat is an activity marker, not an
 *  edit to the agent's definition. */
export async function recordHeartbeat(tenantId: string, rosterId: string): Promise<RosterEntry | null> {
  // ADR 0775 P4 (`ARWF-11`) — compare-and-swap, so a pause (or any edit) that
  // lands between this read and write is re-read and kept, never overwritten
  // with the pre-pause row.
  for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
    const current = await getRosterEntry(tenantId, rosterId); // ADR 0379 P1 — fail-closed
    if (!current) return null;
    const entry = { ...current, lastHeartbeatAt: nowIso() };
    // ADR 0963 D5 — no roster-token bump: `lastHeartbeatAt` is pass state, not
    // membership or config. Bumping here made every pass that heartbeat anyone
    // force the daemon's next tick to re-list every tenant (ADR 0804 defeated);
    // the daemon now corrects its cached listing from the pass itself.
    if (await roster.compareAndSwap(current, entry)) return entry;
  }
  throw staleWriteError('agent', undefined);
}

export async function deleteRosterEntry(tenantId: string, rosterId: string): Promise<boolean> {
  // ADR 0379 P2 — the tenant-qualified key IS the scope (no read needed).
  const deleted = await roster.delete(rosterKey(tenantId, rosterId));
  if (deleted) await bumpRosterVersion();
  return deleted;
}

/** Test-only: drop all roster entries. */
export async function __resetRosterStore(): Promise<void> {
  await roster.__clear();
  await rosterVersion.__clear();
}

// ADR 0789 — a roster member's standing portfolio follows this tenant's fork of a
// shared workflow (the member owns "the workflow", which is now the tenant's copy).
onWorkflowForked('roster', async (tenantId, from, to) => {
  let n = 0;
  for (const e of await roster.listByPrefix(`${tenantId}:`)) {
    if (e.tenantId !== tenantId || !e.workflows.includes(from)) continue;
    if (await casRepoint(roster, rosterKey(e.tenantId, e.rosterId), (r) => {
      const next = repointList(r.workflows, from, to);
      return next ? { ...r, workflows: next, updatedAt: nowIso() } : null;
    })) n += 1;
  }
  if (n > 0) await bumpRosterVersion();
  return n;
});
