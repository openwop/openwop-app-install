/**
 * Board of Advisors demo seed (ADR 0040). Creates the simulated-persona advisor
 * agents from `seed-data/advisorAgents.json` and groups them into the demo boards
 * — composing the SAME owners the feature uses, no parallel persona/RAG store:
 *
 *   - each advisor is its OWN user-agent (`ensureUserAgentRegistered`) carrying
 *     that persona's authored instructions (`systemPrompt`) + description, so the
 *     convene layer resolves each advisor's distinct prompt (NOT a shared pack);
 *   - a roster member (`createRosterEntry`) references that user-agent;
 *   - the `knowledge` capability is activated on the member's `agentProfile`
 *     (`upsertAgentProfile`) so its PRESEEDED memory recalls at dispatch (ADR 0038);
 *   - the persona's principles are written into its RFC-0004 memory namespace
 *     (`agentMemoryAdapter`, keyed by rosterId) — recalled in council chats;
 *   - the boards are created via the feature service (`createBoard`).
 *
 * Gated on the `advisory-board` toggle being ENABLED for the tenant (so the demo
 * roster stays clean until an operator turns the feature on), and idempotent:
 * advisors are matched by their deterministic user-agent id, memory by a seed tag,
 * boards by handle. The profile + memory are (re)written only for a newly-created
 * advisor or on the explicit `heal` path, so a user's later curation survives.
 *
 * @see docs/adr/0040-board-of-advisors.md
 */

import advisorSeed from './seed-data/advisorAgents.json';
import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';
import { resolveOne } from './featureToggles/service.js';
import { ensureUserAgentRegistered } from '../routes/userAgents.js';
import { createRosterEntry, listRoster } from './rosterService.js';
import { upsertAgentProfile } from './agentProfileService.js';
import { createAgentMemoryPort, agentMemoryScope, countAgentMemoryByTag } from './agentMemoryAdapter.js';
import { createBoard, listBoards, clearSeededAdvisoryBoards, clearFabricatedLivingAcks } from '../features/advisory-board/service.js';
import { deleteRosterMemberCascade } from './rosterCascade.js';
import { listOrgs } from './accessControlService.js';

const log = createLogger('advisory-board-seed');

/** Marks a memory entry as seed-authored, so a re-seed doesn't duplicate it. */
const SEED_TAG = 'advisor:seeded';

interface AdvisorSpec {
  slug: string;
  persona: string;
  modeledOn: string;
  role: string;
  description: string;
  systemPrompt: string;
  memory: string[];
}
interface BoardSpec {
  handle: string;
  name: string;
  personaKind: string;
  visibility: string;
  advisors: string[];
}
interface AdvisorSeedFile {
  _note?: string;
  advisors: AdvisorSpec[];
  boards: BoardSpec[];
}

const SEED = advisorSeed as AdvisorSeedFile;

/** The deterministic user-agent id for an advisor — stable across re-seeds so
 *  `ensureUserAgentRegistered` + the roster match are idempotent. ADR 0379 P2:
 *  persona-scoped (no tenant in the id — the tenant lives on the ROW), so a
 *  fold collides instead of duplicating. `tenantId` kept in the signature for
 *  call-site clarity only. */
function advisorAgentId(_tenantId: string, slug: string): string {
  return `user.advisor-${slug}`;
}

export interface AdvisorySeedResult {
  /** Advisor roster members created this call (0 when all already existed). */
  advisorsCreated: number;
  /** Advisory boards created this call (0 when all handles already existed). */
  boardsCreated: number;
  /** True when the `advisory-board` toggle was off ⇒ nothing seeded. */
  skippedToggleOff?: boolean;
}

/**
 * Seed the advisor agents + demo boards for `tenantId`. Best-effort and
 * idempotent; safe to call on every demo seed. Returns what it created.
 */
export async function seedAdvisoryBoards(
  tenantId: string,
  storage: Storage,
  opts: { heal?: boolean } = {},
): Promise<AdvisorySeedResult> {
  // Only seed when the feature is enabled for this tenant — keeps the default
  // demo roster clean; the advisors appear once an operator turns it on + reseeds.
  const toggle = await resolveOne('advisory-board', { tenantId });
  if (!toggle?.enabled) {
    log.debug('advisory_seed_skipped_toggle_off', { tenantId });
    return { advisorsCreated: 0, boardsCreated: 0, skippedToggleOff: true };
  }

  const existingRoster = await listRoster(tenantId);
  const slugToRoster = new Map<string, string>();
  let advisorsCreated = 0;

  for (const spec of SEED.advisors) {
    const agentId = advisorAgentId(tenantId, spec.slug);
    await ensureUserAgentRegistered(storage, {
      agentId,
      tenantId,
      persona: spec.persona,
      label: spec.role,
      description: spec.description,
      modelClass: 'reasoning',
      systemPrompt: spec.systemPrompt,
      toolAllowlist: [],
      memoryShape: { scratchpad: true, conversation: true, longTerm: true },
      createdAt: new Date().toISOString(),
    });

    // Grade-pass fix: ALSO match the grandfathered pre-ADR-0379 id form
    // (`user.<tenant>.advisor-<slug>`) — matching only the new form made a
    // reseed on an old tenant mint a duplicate advisor (roster + user-agent)
    // beside the legacy one: the exact bug class ADR 0379 exists to kill.
    const legacyAgentId = `user.${tenantId}.advisor-${spec.slug}`;
    const found = existingRoster.find((e) => e.agentRef.agentId === agentId || e.agentRef.agentId === legacyAgentId);
    const entry = found ?? (await createRosterEntry({
      tenantId,
      persona: spec.persona,
      agentRef: { agentId, version: '1.0.0' },
      label: spec.role,
      description: spec.description,
      autonomyLevel: 'review',
      roleKey: 'advisor',
    }));
    const isNew = !found;
    if (isNew) advisorsCreated += 1;
    slugToRoster.set(spec.slug, entry.rosterId);

    // Activate `knowledge` + memory recall on a newly-created advisor (or on heal),
    // so its preseeded principles surface at dispatch (ADR 0038). Skip for an
    // existing advisor on a non-heal run to respect later user curation.
    if (isNew || opts.heal) {
      await upsertAgentProfile(tenantId, entry.rosterId, {
        roleKey: 'advisor',
        capabilities: ['knowledge'],
        knowledge: { memoryWritable: true, retrieval: { sources: ['memory', 'kb'], topK: 5 } },
        autonomy: { specLevel: 'recommend' },
      });
    }

    // Preseed the persona's principles into its RFC-0004 memory namespace once
    // (idempotent via the seed tag — a re-seed never duplicates).
    const scope = agentMemoryScope(entry.rosterId);
    if ((await countAgentMemoryByTag(tenantId, scope, SEED_TAG)) === 0) {
      const memory = createAgentMemoryPort(tenantId);
      for (const principle of spec.memory) {
        await memory.write(scope, { content: principle, tags: [SEED_TAG, entry.rosterId] });
      }
    }
  }

  // Create the boards — idempotent by handle. orgId is the tenant's first org
  // (the board's orgId is RBAC scope metadata; reads gate on tenant + visibility).
  const existingHandles = new Set((await listBoards(tenantId, undefined)).map((b) => b.handle));
  const orgId = (await listOrgs(tenantId))[0]?.orgId ?? 'default';
  let boardsCreated = 0;
  for (const board of SEED.boards) {
    if (existingHandles.has(board.handle)) continue;
    const advisorIds = board.advisors
      .map((slug) => slugToRoster.get(slug))
      .filter((id): id is string => typeof id === 'string');
    if (advisorIds.length === 0) continue;
    // ADVB-4 / ADR 0588 D5 — the seed does NOT acknowledge on a human's behalf.
    // It used to ship `livingPersonaAck: true` on the ONE `living` board
    // (`titans`) over its FOUR advisors — pastiche names (Elon Trask, Geoff
    // Bezor, Steve Jobes, Sam Oltman) modeled on named real individuals — and
    // adoption then transferred that fabricated record to the first user who
    // renamed the board. (CORRECTED 2026-08-20: this said "eight named real
    // individuals". `seed-data/advisorAgents.json` ships eight ADVISORS across
    // TWO boards; the other four are `timeless`, `personaKind:'historical'`,
    // with no ack. Overstating the blast radius of a defect is the same failure
    // as understating it — it stops the number being checkable.) A `living` seeded board is now created UNACKNOWLEDGED
    // and is unconvenable until its owner acknowledges — which is the governance
    // gate demonstrating itself rather than being bypassed by the one cohort in
    // the product that triggers it.
    await createBoard(tenantId, orgId, 'demo:advisory-seed', {
      name: board.name,
      handle: board.handle,
      advisors: advisorIds,
      visibility: board.visibility,
      personaKind: board.personaKind,
    }, { allowUnacknowledgedLiving: true });
    boardsCreated += 1;
  }

  // ADVB-4 / ADR 0588 D5 — the seeder is idempotent by HANDLE, so a tenant
  // seeded before this change keeps the fabricated acknowledgement forever
  // unless it is actively removed. Narrow + idempotent; see the service.
  const acksCleared = await clearFabricatedLivingAcks(tenantId);
  if (acksCleared > 0) log.info('advisory_seed_ack_unfabricated', { tenantId, acksCleared });

  if (advisorsCreated > 0 || boardsCreated > 0) {
    log.info('advisory_seed_done', { tenantId, advisorsCreated, boardsCreated });
  }
  return { advisorsCreated, boardsCreated };
}

/** The seeded advisor user-agent ids for this tenant (the deterministic ids the
 *  seed creates) — so count/clear scope to seed-created advisors only, never a
 *  user-authored `roleKey:'advisor'` agent. */
function seededAdvisorAgentIds(tenantId: string): Set<string> {
  return new Set(SEED.advisors.map((a) => advisorAgentId(tenantId, a.slug)));
}

/** Count the demo advisors present (roster members backed by a seeded advisor
 *  user-agent). Drives the `advisors` row's "N present" chip. */
export async function countAdvisors(tenantId: string): Promise<number> {
  const ids = seededAdvisorAgentIds(tenantId);
  return (await listRoster(tenantId)).filter((e) => ids.has(e.agentRef.agentId)).length;
}

/** Clear ONLY the demo-seeded advisors + their boards (cascade-deletes each
 *  seeded advisor roster member — board/cards/schedules/profile — and removes the
 *  seeded advisory boards). Scoped to seed-created entities; never touches a
 *  user-authored advisor or board. Returns the totals removed. */
export async function clearAdvisoryBoards(
  tenantId: string,
  storage: Storage,
): Promise<{ advisorsCleared: number; boardsCleared: number }> {
  const boardsCleared = await clearSeededAdvisoryBoards(tenantId);
  const ids = seededAdvisorAgentIds(tenantId);
  let advisorsCleared = 0;
  for (const entry of await listRoster(tenantId)) {
    if (ids.has(entry.agentRef.agentId)) {
      await deleteRosterMemberCascade(tenantId, storage, entry.rosterId);
      advisorsCleared += 1;
    }
  }
  return { advisorsCleared, boardsCleared };
}
