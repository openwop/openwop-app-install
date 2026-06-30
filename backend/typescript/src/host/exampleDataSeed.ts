/**
 * Built-in demo agent seed — host extension (non-normative).
 *
 * Seeds the "AI coworkers" story (PRD §7): five named agents (Sally, Marcus,
 * Priya, Devon, Nora), each with a role, a workflow portfolio, a task board
 * with varied-source sample cards, a couple of schedules, and an org-chart
 * position. Lets a first-time visitor see the digital-coworker concept without
 * building anything.
 *
 * WHITE-LABEL / SEED STRATEGY (mirrors myndhyve's `SEEDING.md`): the seed
 * CONTENT is data, not code. The roster lives in the brand-authoring surface
 * `src/host/seed-data/exampleAgents.json` — a white-label deployer edits that one
 * file (or sets `OPENWOP_DEMO_SEED_ENABLED=false` to ship NO demo data) rather
 * than hand-editing hard-coded personas here. This file holds only the seeding
 * LOGIC.
 *
 * IDEMPOTENT + non-destructive: seeds only when the tenant's roster is EMPTY,
 * so it never fights a user's own edits (PRD §22.3). Re-running is a no-op once
 * any agent exists. Writes go through the durable host-ext stores, so the seed
 * is consistent across instances and survives a restart.
 *
 * @see src/host/seed-data/exampleAgents.json — the seed content (brand surface)
 * @see src/host/exampleWorkflows.ts — the runnable portfolio workflows
 * @see RFCS/0086-standing-agent-roster-and-workflow-portfolio.md
 */

import { createRosterEntry, listRoster, type RosterEntry } from './rosterService.js';
import { upsertAgentProfile, getAgentProfile, type AgentProfileInput } from './agentProfileService.js';
import { createBoard, createCard, listBoards, type KanbanBoard, type KanbanColumn, type KanbanCardSource } from './kanbanService.js';
import { getJob, registerJob } from './schedulingService.js';
import { registerSubscription } from './triggerBridgeService.js';
import { getChart, putChart, type OrgDepartment, type OrgMember } from './orgChartService.js';
import { deleteRosterMemberCascade } from './rosterCascade.js';
import { seedWorkforceEntities, seedWorkforceHistory } from './workforceService.js';
import { exampleWorkflowsForRole, type ExampleRoleKey } from './exampleWorkflows.js';
import { createLogger } from '../observability/logger.js';
import { ensureUserAgentRegistered } from '../routes/userAgents.js';
import type { Storage } from '../storage/storage.js';
import type { UserAgentRecord } from '../types.js';
import demoAgentSeed from './seed-data/exampleAgents.json';

/** Lowercase-kebab slug from a persona name — must match the frontend's
 *  `slugify` in `chat/lib/agentMentions.ts` so the `@`-mention slug a user
 *  types (`@nora`) resolves to the same agent the seed registered. */
function personaSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const log = createLogger('host.exampleDataSeed');

interface SeedCard {
  title: string;
  description?: string;
  source: KanbanCardSource;
  sourceLabel?: string;
  priority?: 'low' | 'normal' | 'high';
  /** Lane to place the card in (defaults to To Do). */
  columnId?: string;
  createdBy?: string;
  assignmentReason?: string;
  blockerNote?: string;
}

interface SeedSchedule {
  slug: string;
  cronExpr: string;
  /** Index into the role's workflow portfolio. */
  workflowIndex: number;
  label: string;
}

/**
 * The seed-authored slice of an {@link AgentProfileInput} (ADR 0031 §1c). The
 * `roleKey` and `department` are NOT re-authored here — they are single-sourced
 * from the enclosing {@link SeedAgent} (`roleKey` / `department`) and injected by
 * {@link profileInputFor}, so the seed never carries two copies that can drift.
 * Everything else (the governance posture: permissions, HITL, escalation,
 * channels, admin controls, risk/compliance, required connections, metrics, and
 * the four-level autonomy model) is authored per twin in `exampleAgents.json`.
 */
type SeedAgentProfile = Omit<AgentProfileInput, 'roleKey' | 'department'> & {
  /** Optional override; defaults to the SeedAgent's own `department`. */
  department?: AgentProfileInput['department'];
};

interface SeedAgent {
  persona: string;
  role: string;
  roleKey: ExampleRoleKey;
  description: string;
  systemPrompt: string;
  /** Rich "work twin" governance profile (ADR 0031). Optional: a persona with
   *  no profile seeds exactly as before (no `agentProfile` row written), so the
   *  schema extension is backward-compatible. When present, persisted to the
   *  `agent-profile` durable store keyed by the new member's `rosterId`. */
  profile?: SeedAgentProfile;
  /** Explicit standing-workflow portfolio — the pinned `tmpl.*` ids from the
   *  shared template pack (ADR 0032 Phase 2.0) this persona owns. When present
   *  it IS the portfolio (and a schedule's `workflowIndex` indexes into it);
   *  when omitted the portfolio falls back to `exampleWorkflowsForRole(roleKey)`
   *  (the legacy EXAMPLE_WORKFLOWS), so pre-work-twin personas seed unchanged. */
  workflows?: string[];
  /** Model class for the persona's chat-callable inventory agent. Optional in
   *  the seed data; defaults to `chat`. One of the host's known classes
   *  (`userAgents.ts` KNOWN_MODEL_CLASSES: chat / reasoning / coding / extraction). */
  modelClass?: string;
  cards: SeedCard[];
  schedules: SeedSchedule[];
  department: { departmentId: string; name: string; roleId: string; roleName: string };
  /** Heartbeat autonomy for this seeded persona (host-extension). Omit for
   *  `auto` (start picks immediately); `review` ships the persona in the
   *  "agents propose, humans dispose" mode — its heartbeat queues a proposal
   *  for the approval inbox instead of running. Lets a white-label operator
   *  author review-mode agents declaratively in the seed (WHITE-LABEL.md §4). */
  autonomyLevel?: 'auto' | 'guided' | 'review';
}

/** The four canonical agent lanes (PRD §7). To Do is the trigger column. */
function exampleColumns(triggerWorkflowId: string | undefined): KanbanColumn[] {
  return [
    { id: 'todo', name: 'To Do', ...(triggerWorkflowId ? { triggerWorkflowId } : {}) },
    { id: 'working', name: 'Working' },
    { id: 'waiting', name: 'Waiting on Human' },
    { id: 'done', name: 'Done' },
  ];
}

/**
 * Demo roster content — loaded from the brand-authoring data file (esbuild
 * inlines it into the bundle). `resolveJsonModule` widens the JSON's string
 * fields to `string`, so we assert the authored shape here; the structure is
 * pinned by `agents-demo.test.ts`, which seeds and asserts the five personas.
 */
const SEED_AGENTS = demoAgentSeed as readonly SeedAgent[];

/**
 * The five legacy demo personas RETIRED by ADR 0032 (superseded by the ten
 * canonical work-twins). They are no longer in `SEED_AGENTS`, so the silent and
 * heal paths never CREATE them — but a tenant seeded before the reconciliation
 * still has them on its roster. Listed here (persona name + the roleKey they
 * were seeded with) so the migration can recognize and prune a *demo-owned*
 * legacy persona without resurrecting one a user deleted, and without touching a
 * persona a user renamed or re-roled (the name+roleKey pair no longer matches).
 *
 * @see docs/adr/0032-work-twin-persona-reconciliation.md §"Migration / idempotency"
 */
const RETIRED_DEMO_PERSONAS: readonly { persona: string; roleKey: ExampleRoleKey }[] = [
  { persona: 'Sally', roleKey: 'sales-ops' },
  { persona: 'Marcus', roleKey: 'support-triage' },
  { persona: 'Priya', roleKey: 'finance-ops' },
  { persona: 'Devon', roleKey: 'engineering-ops' },
  { persona: 'Nora', roleKey: 'marketing-ops' },
];

/**
 * Reconcile away the retired legacy personas (ADR 0032). Cascade-deletes a roster
 * entry whose persona NAME matches a retired one — regardless of `roleKey` drift
 * (an earlier version required name+roleKey, which left a re-roled legacy persona
 * stranded and surfacing in the agent inventory / chat welcome row; 2026-06-15).
 * The retired names (Sally/Marcus/Priya/Devon/Nora) don't collide with the ten
 * work-twins or the advisor personas, so the only thing a name-match can catch
 * besides a demo-owned legacy member is a user who coincidentally used one of
 * those exact names — an accepted trade-off for demo reconciliation. A user who
 * RENAMED a legacy persona (name no longer retired) and a user-deleted one are
 * still left alone. Returns the number pruned. Idempotent.
 */
async function pruneRetiredDemoPersonas(tenantId: string, storage: Storage): Promise<number> {
  const retiredNames = new Set(RETIRED_DEMO_PERSONAS.map((r) => r.persona.toLowerCase()));
  let pruned = 0;
  for (const entry of await listRoster(tenantId)) {
    if (retiredNames.has(entry.persona.toLowerCase())) {
      await deleteRosterMemberCascade(tenantId, storage, entry.rosterId);
      pruned += 1;
    }
  }
  if (pruned > 0) log.info('demo_seed_legacy_pruned', { tenantId, pruned });
  return pruned;
}

/**
 * White-label switch: set `OPENWOP_DEMO_SEED_ENABLED=false` to ship NO demo
 * agents/boards/schedules (a clean tenant for a branded deployment). Defaults
 * on, preserving the reference app's first-use experience.
 */
function exampleDataSeedEnabled(): boolean {
  return process.env.OPENWOP_DEMO_SEED_ENABLED !== 'false';
}

/** Per-tenant "demo data has been initialized once" marker key. Its presence
 *  flips the silent auto-seed from "populate a fresh tenant" to "respect the
 *  user's curation" (deletions stick); the explicit `heal` path ignores it. */
function seedMarkerKey(tenantId: string): string {
  return `demo:seed-claimed:${tenantId}`;
}

/** Test-only: drop a tenant's first-seed marker so a fresh seed re-populates. */
export async function __resetDemoSeedMarker(storage: Storage, tenantId: string): Promise<void> {
  await storage.kvDelete(seedMarkerKey(tenantId));
}

export interface SeedResult {
  seeded: boolean;
  agents: number;
  /** Number of Workforce entities created this call (idempotent). */
  workforces?: number;
  /** Number of synthetic history runs seeded (only on the explicit `heal` path). */
  workforceRuns?: number;
  /** Present when `heal: true` — what an explicit re-seed restored for
   *  EXISTING personas (missing boards / schedule jobs / agent profiles / a
   *  missing chart) plus how many retired legacy personas it pruned (ADR 0032). */
  healed?: { boards: number; schedules: number; profiles: number; prunedLegacy: number; orgChart: boolean };
}

export interface SeedOptions {
  /** Restore missing demo surfaces for personas that already exist.
   *
   *  OFF for the silent auto-seed-on-entry (it must never resurrect a board or
   *  schedule the user deliberately deleted); ON for the explicit "Load demo
   *  data" action — whose whole point is "put the demo back". Healing creates
   *  a missing BOARD (with its sample cards), registers missing schedule
   *  jobIds, and rebuilds the org chart ONLY when none exists. It never
   *  touches an existing board's cards (clearing a board is normal usage). */
  heal?: boolean;
  /** Skip the workforce entity/history seed. Set by the demo-seeder registry's
   *  `agents` step so workforces are owned solely by the `workforces` step
   *  (clean per-step seeding); the legacy `/demo/seed` path leaves it false so
   *  its behaviour is unchanged. */
  skipWorkforces?: boolean;
}

/**
 * Seed the built-in demo agents for a tenant. Per-persona idempotent: each of
 * the five canonical demo personas is created only if it is MISSING, so this
 * both (a) never duplicates on re-run and (b) self-heals a seed that failed
 * partway. It does NOT touch the user's own (non-demo) agents — only the five
 * named demo personas are managed here. `seeded` is true when at least one
 * agent was created this call.
 *
 * The dashboard only auto-seeds when the roster is entirely empty, so a re-seed
 * of a populated tenant happens only via the explicit "Load demo agents"
 * action (which restoring a deleted demo agent is the expected outcome of).
 */
// ── Single seed-creation path (shared by the bulk seed loop, heal, and the
//    feature-driven `ensureSeededAgentByRole`). One implementation, sourced
//    from `exampleAgents.json`, so no caller hand-rolls agent creation. ──

/** Create one persona's board + sample cards (idempotent only by caller). */
async function seedAgentBoard(
  tenantId: string,
  spec: SeedAgent,
  workflowIds: string[],
  rosterId: string,
): Promise<void> {
  const board = await createBoard({ tenantId, name: `${spec.persona}'s board`, rosterId, columns: exampleColumns(workflowIds[0]) });
  for (const card of spec.cards) {
    await createCard({
      boardId: board.id,
      columnId: card.columnId ?? 'todo',
      title: card.title,
      ...(card.description !== undefined ? { description: card.description } : {}),
      source: card.source,
      ...(card.sourceLabel !== undefined ? { sourceLabel: card.sourceLabel } : {}),
      ...(card.priority !== undefined ? { priority: card.priority } : {}),
      ...(card.createdBy !== undefined ? { createdBy: card.createdBy } : {}),
      ...(card.assignmentReason !== undefined ? { assignmentReason: card.assignmentReason } : {}),
      ...(card.blockerNote !== undefined ? { blockerNote: card.blockerNote } : {}),
    });
  }
}

/** Register one of a persona's standing schedules (skips an out-of-range index). */
async function seedAgentSchedule(
  tenantId: string,
  workflowIds: string[],
  rosterId: string,
  agentId: string,
  sched: SeedSchedule,
): Promise<void> {
  const workflowId = workflowIds[sched.workflowIndex];
  if (!workflowId) return;
  await registerJob({ jobId: `${rosterId}:${sched.slug}`, tenantId, cronExpr: sched.cronExpr, workflowId, rosterId, agentId, metadata: { label: sched.label } });
}

/** Resolve a spec's authored profile into a full {@link AgentProfileInput},
 *  single-sourcing `roleKey` + `department` from the enclosing SeedAgent so the
 *  two never drift. Returns undefined for a profile-less persona. */
function profileInputFor(spec: SeedAgent): AgentProfileInput | undefined {
  if (!spec.profile) return undefined;
  return {
    ...spec.profile,
    roleKey: spec.roleKey,
    department: spec.profile.department ?? spec.department,
  };
}

/** Persist the seeded profile for a member (keyed by `rosterId`), if one is
 *  authored. Idempotent create-or-replace via the durable `agent-profile`
 *  store — re-seeding the same persona overwrites identically (no duplicate
 *  row; the key is the rosterId). No-op when the spec has no profile. */
async function seedAgentProfile(tenantId: string, spec: SeedAgent, rosterId: string): Promise<boolean> {
  const input = profileInputFor(spec);
  if (!input) return false;
  await upsertAgentProfile(tenantId, rosterId, input);
  return true;
}

/** The persona's standing-workflow portfolio: the explicit `tmpl.*` ids authored
 *  on the spec (work twins, ADR 0032), or the legacy `exampleWorkflowsForRole`
 *  filter when none are authored. One resolver, shared by the create + heal
 *  paths, so a schedule's `workflowIndex` indexes the same array everywhere. */
function workflowIdsForSpec(spec: SeedAgent): string[] {
  return spec.workflows ?? exampleWorkflowsForRole(spec.roleKey).map((w) => w.workflowId);
}

/** The ONE roster-member creation path: chat-agent record + roster entry
 *  (carrying `roleKey` for exact theming + system-role lookup) + board + cards
 *  + schedules + the rich agent profile, all sourced from a `exampleAgents.json`
 *  spec. */
async function createSeededRosterMember(tenantId: string, storage: Storage, spec: SeedAgent): Promise<RosterEntry> {
  const workflowIds = workflowIdsForSpec(spec);
  const chatAgentId = `user.${tenantId}.${personaSlug(spec.persona)}`;
  await ensureUserAgentRegistered(storage, {
    agentId: chatAgentId,
    tenantId,
    persona: spec.persona,
    label: spec.role,
    description: spec.description,
    modelClass: spec.modelClass ?? 'chat',
    systemPrompt: spec.systemPrompt,
    toolAllowlist: [],
    memoryShape: { scratchpad: true, conversation: true, longTerm: false },
    createdAt: new Date().toISOString(),
  });
  const entry = await createRosterEntry({
    tenantId,
    persona: spec.persona,
    agentRef: { agentId: chatAgentId, version: '1.0.0' },
    workflows: workflowIds,
    label: spec.role,
    description: spec.description,
    autonomyLevel: spec.autonomyLevel,
    roleKey: spec.roleKey,
  });
  await seedAgentBoard(tenantId, spec, workflowIds, entry.rosterId);
  for (const sched of spec.schedules) {
    await seedAgentSchedule(tenantId, workflowIds, entry.rosterId, entry.agentRef.agentId, sched);
  }
  // Persist the rich work-twin profile keyed by the new member's rosterId
  // (ADR 0031 §1c). Last in the create path so a profile-less spec still seeds
  // a complete member; the profile is purely additive.
  await seedAgentProfile(tenantId, spec, entry.rosterId);
  return entry;
}

/**
 * Ensure the single seeded agent for `roleKey` exists, creating it through the
 * one seed path if absent — idempotent. The assistant's Chief of Staff uses
 * this instead of hand-rolling a roster entry, so its creation is owned by the
 * seeder and sourced from `exampleAgents.json` (the "use the seeding method" rule).
 * Identity is the persisted `roleKey`, robust to a user-renamed persona/label.
 * Returns null when no spec declares that role (a misconfiguration).
 */
const ensuringByRole = new Map<string, Promise<RosterEntry | null>>();
export async function ensureSeededAgentByRole(
  tenantId: string,
  storage: Storage,
  roleKey: ExampleRoleKey,
): Promise<RosterEntry | null> {
  const existing = (await listRoster(tenantId)).find((e) => e.roleKey === roleKey);
  if (existing) return existing;
  const spec = SEED_AGENTS.find((s) => s.roleKey === roleKey);
  if (!spec) return null;
  const key = `${tenantId}:${roleKey}`;
  const inflight = ensuringByRole.get(key);
  if (inflight) return inflight;
  const create = (async () => {
    // Re-check under the in-process lock (a concurrent caller may have won) —
    // the roster store has no unique index.
    const again = (await listRoster(tenantId)).find((e) => e.roleKey === roleKey);
    if (again) return again;
    const entry = await createSeededRosterMember(tenantId, storage, spec);
    log.info('seeded agent ensured on demand', { tenantId, roleKey, rosterId: entry.rosterId });
    return entry;
  })();
  ensuringByRole.set(key, create);
  try {
    return await create;
  } finally {
    ensuringByRole.delete(key);
  }
}

/** Read-only lookup of the seeded agent for a role (no creation). */
export async function findSeededAgentByRole(tenantId: string, roleKey: ExampleRoleKey): Promise<RosterEntry | null> {
  return (await listRoster(tenantId)).find((e) => e.roleKey === roleKey) ?? null;
}

export async function seedExampleAgents(
  tenantId: string,
  storage: Storage,
  opts: SeedOptions = {},
): Promise<SeedResult> {
  if (!exampleDataSeedEnabled()) {
    log.info('demo_seed_skipped', { tenantId, reason: 'OPENWOP_DEMO_SEED_ENABLED=false' });
    return { seeded: false, agents: 0 };
  }

  const existing = await listRoster(tenantId);
  const byPersona = new Map<string, RosterEntry>(existing.map((e) => [e.persona.toLowerCase(), e]));

  // First-seed claim — the gate that decides whether a MISSING persona is
  // (re)created. The roster store has no unique index, so a plain check-then-act
  // raced: two concurrent first seeds for one tenant both saw "Sally absent" and
  // each inserted a distinct random `rosterId` → duplicate Sallys. We instead
  // claim the first seed with an atomic, cross-instance compare-and-swap on a
  // per-tenant marker: only the claimant populates a FRESH tenant, so a losing
  // concurrent seed creates nothing. Once the marker exists, the silent
  // auto-seed-on-page-load no longer recreates a persona the user deleted (the
  // live "deleted demo agents reappear on reload" bug). A tenant that already
  // has demo agents but no marker (seeded before this change) just gets the
  // marker stamped — it is treated as already-initialized, never retro-created.
  const examplePersonaSet = new Set(SEED_AGENTS.map((s) => s.persona.toLowerCase()));
  const demoPresentCount = existing.filter((e) => examplePersonaSet.has(e.persona.toLowerCase())).length;
  const claim = await storage.kvCompareAndSwap(seedMarkerKey(tenantId), null, new Date().toISOString());
  const firstSeed = claim.swapped && demoPresentCount === 0;
  // Create a missing persona only on a genuine first seed or an explicit heal
  // ("Load demo data"). The silent path on a known tenant respects deletions.
  const allowCreate = firstSeed || opts.heal === true;

  // Heal mode: one boards read up front so per-agent "is the board missing?"
  // is a map lookup, not N scans.
  const boardByRoster = new Map<string, KanbanBoard>();
  if (opts.heal) {
    for (const b of await listBoards(tenantId)) {
      if (b.rosterId) boardByRoster.set(b.rosterId, b);
    }
  }

  const members: OrgMember[] = [];
  const departments: OrgDepartment[] = [];
  const seenDepartments = new Set<string>();
  let created = 0;
  let healedBoards = 0;
  let healedSchedules = 0;
  let healedProfiles = 0;
  let prunedLegacy = 0;

  for (const spec of SEED_AGENTS) {
    const workflowIds = workflowIdsForSpec(spec);

    const existingEntry = byPersona.get(spec.persona.toLowerCase());
    // Silent path on an already-initialized tenant: a missing demo persona was
    // deliberately deleted — do not resurrect it (nor re-register its chat
    // agent). Only a first seed or an explicit `heal` repopulates a missing one.
    if (!existingEntry && !allowCreate) continue;

    // Register the persona as a tenant-owned, chat-callable inventory agent
    // (RFC 0072) via the same isolation-correct path the create wizard uses, so
    // a user can `@`-mention it in chat (the mention list is fed by
    // `GET /v1/agents`; the chat-responder resolves `inputs.agentId` →
    // systemPrompt, gated by `ownerTenant === tenantId`). The persona's
    // `systemPrompt` is authored in `exampleAgents.json` and was previously unused
    // on any chat-reachable path. Done for EVERY spec (not just newly-created
    // roster entries) so an explicit "Load demo agents" re-seed heals tenants
    // seeded before this feature. Idempotent: insert-if-absent + last-write-wins
    // registry register.
    const chatAgentId = `user.${tenantId}.${personaSlug(spec.persona)}`;
    const userAgentRecord: UserAgentRecord = {
      agentId: chatAgentId,
      tenantId,
      persona: spec.persona,
      label: spec.role,
      description: spec.description,
      modelClass: spec.modelClass ?? 'chat',
      systemPrompt: spec.systemPrompt,
      toolAllowlist: [],
      memoryShape: { scratchpad: true, conversation: true, longTerm: false },
      createdAt: new Date().toISOString(),
    };
    await ensureUserAgentRegistered(storage, userAgentRecord);

    // Board + schedule creation hoisted to module scope (`seedAgentBoard` /
    // `seedAgentSchedule`) so the fresh-create path, heal mode, AND the
    // single-agent `ensureSeededAgentByRole` ensure path all share ONE creation
    // implementation — no parallel orchestration.
    const createBoardWithCards = (rosterId: string): Promise<void> =>
      seedAgentBoard(tenantId, spec, workflowIds, rosterId);

    let entry = existingEntry;
    if (!entry) {
      // The roster entry + board + cards + schedules for one persona, created
      // through the single seed path (`createSeededRosterMember`). The AgentRef
      // points at the persona's chat-callable inventory agent (above), linking
      // the two projections of one persona. Runs still dispatch by workflowId.
      // Reached only when `allowCreate` (first seed or heal) — the silent path
      // `continue`s above for a deleted persona.
      entry = await createSeededRosterMember(tenantId, storage, spec);
      created += 1;
    } else if (opts.heal) {
      // HEAL: restore what is structurally MISSING; never touch what exists.
      // A present-but-emptied board stays untouched (clearing cards is normal
      // usage); a present schedule keeps any user-tweaked cron.
      if (!boardByRoster.has(entry.rosterId)) {
        await createBoardWithCards(entry.rosterId);
        healedBoards += 1;
      }
      for (const sched of spec.schedules) {
        if (await getJob(`${entry.rosterId}:${sched.slug}`)) continue;
        await seedAgentSchedule(tenantId, workflowIds, entry.rosterId, entry.agentRef.agentId, sched);
        healedSchedules += 1;
      }
      // Backfill a MISSING profile only — never clobber one a user (or a prior
      // seed) already wrote. Heals tenants seeded before this feature, and any
      // persona whose profile write failed partway.
      if (spec.profile && !(await getAgentProfile(tenantId, entry.rosterId))) {
        await seedAgentProfile(tenantId, spec, entry.rosterId);
        healedProfiles += 1;
      }
    }

    // Org-chart membership is rebuilt from every demo persona that now has a
    // roster entry (existing + just-created), so a self-healed partial seed
    // still produces a complete chart.
    if (!seenDepartments.has(spec.department.departmentId)) {
      seenDepartments.add(spec.department.departmentId);
      departments.push({
        departmentId: spec.department.departmentId,
        name: spec.department.name,
        parentDepartmentId: null,
        roles: [{ roleId: spec.department.roleId, name: spec.department.roleName }],
      });
    }
    members.push({
      rosterId: entry.rosterId,
      departmentId: spec.department.departmentId,
      roleId: spec.department.roleId,
      reportsTo: null,
    });
  }

  // Reconcile the canonical set (ADR 0032): on an explicit heal / "Load demo
  // data", prune any demo-owned legacy persona (Sally/Marcus/Priya/Devon/Nora)
  // the tenant was seeded with before the ten-twin reconciliation. Gated to
  // `heal` — the silent path must respect user curation and never reconcile
  // behind the user's back. Idempotent + never resurrects user-deleted personas.
  if (opts.heal) {
    prunedLegacy = await pruneRetiredDemoPersonas(tenantId, storage);
  }

  // Only (re)write the org-chart when we created something — avoids clobbering
  // a user's hand-built chart on a no-op re-seed. Heal mode additionally
  // rebuilds it when NO chart exists at all (nothing to clobber).
  let healedChart = false;
  if (opts.heal && created === 0) {
    healedChart = (await getChart(tenantId)) === null;
  }
  if (created > 0 || healedChart) {
    const orgResult = await putChart({ tenantId, departments, members });
    if ('error' in orgResult) {
      // Non-fatal: the roster + boards seeded fine; only the org-chart failed.
      log.warn('demo_seed_orgchart_failed', { tenantId, error: orgResult.error.code });
    }
  }

  if (healedBoards > 0 || healedSchedules > 0 || healedProfiles > 0 || prunedLegacy > 0 || healedChart) {
    log.info('demo_seed_healed', { tenantId, healedBoards, healedSchedules, healedProfiles, prunedLegacy, healedChart });
  }

  // ADR 0038 §B — a demo webhook trigger subscription that auto-ingests an external
  // event into an agent's bound collection via `tmpl.agent-knowledge.auto-ingest`.
  // Idempotent (deterministic id). Auto-ingested content is fenced as UNTRUSTED at
  // retrieval (§C). Fail-closed until an operator binds a collection to the agent
  // named in the event body (seed-nothing, Q1) — the delivery then dead-letters with
  // an actionable reason. `verificationMode:'none'` is demo-only; a real gateway
  // registers its own subscription WITH a signing secret.
  if (allowCreate) {
    await registerSubscription({
      subscriptionId: `demo:agent-knowledge:auto-ingest:${tenantId}`,
      tenantId,
      source: 'webhook',
      // Matches AUTO_INGEST_WORKFLOW_ID in features/agent-knowledge/feature.ts —
      // a string literal here (host MUST NOT import a feature; ADR 0001 boundary).
      // The feature registers this workflow at boot; resolved at fire time.
      workflowId: 'feature.agent-knowledge.auto-ingest',
      verificationMode: 'none',
      label: 'Example data: auto-ingest webhook → agent knowledge (ADR 0038 §B)',
    });
  }

  // Workforce entity is cheap (one row) — seed it on any path, idempotently.
  // The HEAVY run history is gated to the explicit "Load demo data" action
  // (`heal`), so a cookieless anon visitor never triggers a 300-run write storm
  // (architect CTI-1 / fan-out finding). Wall-clock is read here at the host
  // boundary — the generator stays pure.
  const workforcesSeeded = opts.skipWorkforces ? 0 : await seedWorkforceEntities();
  let workforceRuns = 0;
  if (opts.heal && !opts.skipWorkforces) {
    const wf = await seedWorkforceHistory(storage, tenantId, { nowMs: Date.now() });
    workforceRuns = wf.runs;
  }

  log.info('demo_seed_complete', {
    tenantId, created, total: SEED_AGENTS.length, workforcesSeeded, workforceRuns,
  });
  return {
    seeded: created > 0, agents: SEED_AGENTS.length,
    ...(workforcesSeeded > 0 ? { workforces: workforcesSeeded } : {}),
    ...(workforceRuns > 0 ? { workforceRuns } : {}),
    ...(opts.heal ? { healed: { boards: healedBoards, schedules: healedSchedules, profiles: healedProfiles, prunedLegacy, orgChart: healedChart } } : {}),
  };
}

/** The display names of the built-in demo personas (the seeder registry uses
 *  this to count + clear only the demo roster, never a user's own agents). */
export function examplePersonaNames(): string[] {
  return SEED_AGENTS.map((a) => a.persona);
}

/** How many of the built-in demo personas currently exist in the tenant's
 *  roster. Used by the `/demo-data` dashboard's live "N present" count. */
export async function countExampleAgents(tenantId: string): Promise<number> {
  const demo = new Set(SEED_AGENTS.map((a) => a.persona.toLowerCase()));
  return (await listRoster(tenantId)).filter((e) => demo.has(e.persona.toLowerCase())).length;
}

/**
 * Remove the built-in demo personas (and ONLY those) for a tenant via the shared
 * `deleteRosterMemberCascade`: each demo roster entry plus its board (+ cards),
 * schedule jobs, approvals, org-chart membership, sidebar pins, and chat-callable
 * inventory agent. NEVER touches an agent the user created themselves (matched
 * strictly by the canonical demo persona names — current set plus the ADR-0032
 * retired legacy personas, so "Clear demo data" wipes a pre-reconciliation
 * tenant clean too). Powers the dashboard's "Clear demo data" action.
 * Intentionally leaves the first-seed marker in place — a deliberate clear must
 * NOT be auto-repopulated by the silent seed on the next page load; the user
 * restores explicitly via "Load demo data" (`heal`).
 */
export async function clearExampleAgents(tenantId: string, storage: Storage): Promise<{ cleared: number }> {
  const demo = new Set([
    ...SEED_AGENTS.map((a) => a.persona.toLowerCase()),
    ...RETIRED_DEMO_PERSONAS.map((r) => r.persona.toLowerCase()),
  ]);
  const roster = await listRoster(tenantId);
  let cleared = 0;
  for (const entry of roster) {
    if (!demo.has(entry.persona.toLowerCase())) continue;
    await deleteRosterMemberCascade(tenantId, storage, entry.rosterId);
    cleared += 1;
  }
  return { cleared };
}
