/**
 * ADR 0543 P5 (+ ADR 0545 D5) — how a person steers the career agent.
 *
 * Two things, deliberately in ONE store:
 *
 *  - `goals` — a human-readable steering document ("I want to move into
 *    platform work, I'd rather not go back to agencies");
 *  - `policy` — the structured fields that actually govern behaviour (roles,
 *    locations, remote, match floor, daily cap, tiers).
 *
 * ## The prose NEVER reaches ranking, and that is the point
 *
 * ADR 0543's P5 row originally said the goals text was "the tie-break input the
 * ADR 0534 ranking already consumes". That is false about the code and
 * contradicts OQ-2 in the same ADR: `computePriority` takes
 * `Record<string, number>` and nothing else. Adding a semantic tie-break would
 * mean a selection nobody can reproduce — and the ADR 0534 D3 stamp exists
 * precisely so a past pick can be explained. A stamp that cannot reproduce its
 * own decision explains nothing.
 *
 * So the split is: prose steers the HUMAN's editing of the policy; the POLICY
 * ranks, deterministically. (This header used to add "and gives the agent
 * context to talk about". Nothing composes `goals` into any model context —
 * ADR 1036 D9 — so that half was a promise, not a property.)
 *
 * ## One row per PERSON (ADR 1036 D7)
 *
 * This store was one row per TENANT, so in a workspace with several members any
 * org's writer read a colleague's career goals and overwrote the policy their
 * campaign ran under. A job search is one person's: the row is keyed
 * `<tenantId>:<subjectId>`, the routes read and write the caller's own, and the
 * campaign pass reads the pass subject's. A legacy tenant-keyed row is NEVER
 * served as a shared fallback — its `roles`/`locations`/`goals` are one
 * member's, and serving them as everyone's defaults would be the same leak by
 * another door. Its last author adopts it on their first read; any erasure in
 * the tenant deletes it.
 *
 * ## Why one store and not two
 *
 * ADR 0545 D5 already defines the autopilot policy, and OQ-2 says goals "shape
 * the POLICY". Writing a separate goals store here would create two owners for
 * one concept — the outcome the boundaries audit exists to prevent — and they
 * would drift the first time someone edited one.
 */
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../../host/subjectErasure.js';
import { subjectKeyForms } from '../../../host/subjectErasureRedaction.js';

/** Which submission tiers autopilot may use. `C` is never grantable (ADR 0541). */
export type PolicyTier = 'A' | 'B';

export interface AutopilotPolicy {
  roles: string[];
  locations: string[];
  /** null = no preference. */
  remote: boolean | null;
  /** The eligibility floor: below this, the agent does not prepare an application. */
  minMatchScore: number;
  dailyCap: number;
  ratePerHour: number;
  tiers: PolicyTier[];
}

export interface AgentSteering {
  tenantId: string;
  /** The person this steering belongs to. Absent only on a legacy tenant-keyed
   *  row, which nothing reads (D7) and erasure removes. */
  subjectId?: string;
  /**
   * Free prose, read by a human; never a ranking input, never parsed into
   * behaviour, and not composed into any model context today. Bounded because it
   * is user-authored text.
   */
  goals: string;
  policy: AutopilotPolicy;
  updatedBy: string;
  updatedAt: string;
}

export const MAX_GOALS_CHARS = 4000;

/** Deliberately modest defaults (ADR 0541 D3a): the product does not start a
 *  campaign fast and hope. A user may raise them. */
export const DEFAULT_POLICY: AutopilotPolicy = {
  roles: [],
  locations: [],
  remote: null,
  minMatchScore: 5,
  dailyCap: 10,
  ratePerHour: 4,
  tiers: ['A'],
};

// A legacy row (pre-D7) has no `subjectId` and was keyed by the tenant alone.
const steeringKey = (s: AgentSteering): string => (s.subjectId ? `${s.tenantId}:${s.subjectId}` : s.tenantId);
const steering = new DurableCollection<AgentSteering>(
  'job-search:steering',
  steeringKey,
  undefined,
  (s) => s.tenantId,
);

export async function getSteering(tenantId: string, subjectId: string): Promise<AgentSteering> {
  const row = subjectId ? await steering.get(`${tenantId}:${subjectId}`) : null;
  if (row) return row;
  // A legacy tenant row (pre-D7) is ADOPTED by the one person it names as its
  // last author, never served to anyone else: a tenant that had tightened its
  // policy would otherwise fall back to looser defaults without being told
  // (grade-code row 81). Anyone else still reads defaults (see the header).
  //
  // NOTE: this READ performs a WRITE, once per legacy row — the adoption moves
  // the row to its author's key and deletes the tenant key. Deliberate: a
  // one-time lazy migration needs no migration step, and production held 0
  // steering rows when it shipped. Idempotent (the second read finds the
  // per-person row first); a lost race between two reads by the same person
  // writes the same row twice.
  const legacy = subjectId ? await steering.get(tenantId) : null;
  if (legacy && !legacy.subjectId && legacy.updatedBy === subjectId) {
    const adopted: AgentSteering = { ...legacy, subjectId };
    await steering.put(adopted);
    await steering.delete(tenantId);
    return adopted;
  }
  // A person who has never steered gets the DEFAULTS rather than null, so every
  // caller reads a complete policy and none has to invent one locally.
  return {
    tenantId,
    subjectId,
    goals: '',
    policy: { ...DEFAULT_POLICY },
    updatedBy: '',
    updatedAt: new Date(0).toISOString(),
  };
}

const clampInt = (v: unknown, fallback: number, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
};

const strArr = (v: unknown, cap: number): string[] =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, cap).map((s) => s.trim());

/**
 * Write steering. Closed-world: unknown keys are dropped, every number is
 * clamped, and the prose is bounded.
 *
 * The caps are not paranoia. `dailyCap` and `ratePerHour` are the numbers that
 * decide how fast applications go out, and high velocity is what the evidence
 * ties to auto-rejection — so an unbounded value here would be the product
 * helping a user damage their own search.
 */
export async function putSteering(
  tenantId: string,
  input: { goals?: unknown; policy?: unknown },
  actor: string,
): Promise<AgentSteering> {
  // The actor IS the subject: a person steers only their own search (D7).
  const current = await getSteering(tenantId, actor);
  const p = (input.policy ?? {}) as Record<string, unknown>;
  const next: AgentSteering = {
    tenantId,
    subjectId: actor,
    goals: typeof input.goals === 'string' ? input.goals.slice(0, MAX_GOALS_CHARS) : current.goals,
    policy: {
      roles: input.policy ? strArr(p.roles, 50) : current.policy.roles,
      locations: input.policy ? strArr(p.locations, 50) : current.policy.locations,
      remote: input.policy ? (typeof p.remote === 'boolean' ? p.remote : null) : current.policy.remote,
      minMatchScore: input.policy ? clampInt(p.minMatchScore, DEFAULT_POLICY.minMatchScore, 1, 10) : current.policy.minMatchScore,
      dailyCap: input.policy ? clampInt(p.dailyCap, DEFAULT_POLICY.dailyCap, 1, 200) : current.policy.dailyCap,
      ratePerHour: input.policy ? clampInt(p.ratePerHour, DEFAULT_POLICY.ratePerHour, 1, 60) : current.policy.ratePerHour,
      tiers: input.policy
        ? ((Array.isArray(p.tiers) ? p.tiers : []).filter((t): t is PolicyTier => t === 'A' || t === 'B').slice(0, 2) || []).length > 0
          ? (p.tiers as PolicyTier[]).filter((t) => t === 'A' || t === 'B')
          : ['A']
        : current.policy.tiers,
    },
    updatedBy: actor,
    updatedAt: new Date().toISOString(),
  };
  await steering.put(next);
  return next;
}


/**
 * ADR 0464 — subject erasure.
 *
 * DELETED, not redacted (ADR 1036 D7). The row used to be tenant-scoped, so it
 * was redacted to keep the workspace's policy alive; it is now the person's own
 * row, and nothing in it outlives them. A legacy tenant-keyed row that names the
 * subject is deleted too — nothing reads it any more, and it holds their prose.
 */
export async function eraseSubjectSteering(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const form of forms) await steering.delete(`${tenantId}:${form}`);
  // The legacy tenant row (pre-D7) is deleted on ANY member's erasure: it may
  // hold prose an earlier author wrote under a later author's `updatedBy`
  // (JS81D-2), and only its last author can still adopt it, so nothing else
  // can lose by its going.
  const legacy = await steering.get(tenantId);
  if (legacy && !legacy.subjectId) await steering.delete(tenantId);
}

registerSubjectEraser(eraseSubjectSteering);
