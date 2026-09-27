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
 * So the split is: prose steers the HUMAN's editing of the policy and gives the
 * agent context to talk about; the POLICY ranks, deterministically.
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
  /**
   * Free prose. Read by a human and available to the agent as CONTEXT; never a
   * ranking input, and never parsed into behaviour. Bounded because it is
   * user-authored text that will be composed into a model context.
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

const steering = new DurableCollection<AgentSteering>(
  'job-search:steering',
  (s) => s.tenantId,
  undefined,
  (s) => s.tenantId,
);

export async function getSteering(tenantId: string): Promise<AgentSteering> {
  const row = await steering.get(tenantId);
  if (row) return row;
  // A tenant that has never steered gets the DEFAULTS rather than null, so every
  // caller reads a complete policy and none has to invent one locally.
  return {
    tenantId,
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
  const current = await getSteering(tenantId);
  const p = (input.policy ?? {}) as Record<string, unknown>;
  const next: AgentSteering = {
    tenantId,
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
 * The ADR 0464 ratchet scans HOST-owned stores and did not flag this one, which
 * lives in a feature. That is a gap in coverage, not a licence: `goals` is a
 * person's career aspirations and `updatedBy` names them.
 *
 * REDACTED rather than deleted, and the distinction matters. Steering is
 * TENANT-scoped — one row governs the whole workspace — so deleting it because
 * one member was erased would silently reset the campaign policy for everyone
 * else. What must go is the person: the author attribution, and the prose they
 * wrote about their own search.
 */
const ERASED = '[erased]';

export async function eraseSubjectSteering(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  const row = await steering.get(tenantId);
  if (!row || !forms.has(row.updatedBy)) return;
  await steering.put({
    ...row,
    // The prose is theirs and describes their own job search; the POLICY is the
    // workspace's operating configuration and survives.
    goals: '',
    updatedBy: ERASED,
    updatedAt: new Date().toISOString(),
  });
}

registerSubjectEraser(eraseSubjectSteering);
