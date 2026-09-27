/**
 * Participant plan-revision command list (ADR 0459 P1).
 *
 * `applyPlanRevision` (enrollmentService) is the blunt re-materialize the coach
 * side rides; the participant's chat-driven replan needs to express INTENT as a
 * bounded, closed-world command list over the ONLY three ADR 0429 flexibility
 * lanes — a schedule-preference change, a publisher-declared substitution, or a
 * missed-window recovery collapse — never new activities and never an
 * evidence-policy change. This service validates that list closed-world (an
 * object that is not exactly one of the three lane shapes is a TYPED failure,
 * never success-with-empty — mirroring `schemas/plan-revision.schema.json` in the
 * agents pack, pinned by the schema-parity test), then executes each command in
 * order through its OWN governed service (each re-checks ownership), and finally
 * runs ONE `applyPlanRevision` so today re-materializes under the new revision.
 *
 * Authorization is checked FIRST via the shared `hasKicktodoEnrollmentAuthority`
 * predicate (the scout found `applyPlanRevision` itself has no owner check), the
 * SAME predicate the enrollment routes + the replan tool use — route and surface
 * cannot drift. A per-lane failure is a typed error carrying the failing command
 * index so the caller can point the participant at the exact command.
 */

import { OpenwopError, type OpenwopErrorCode } from '../../types.js';
import { hasKicktodoEnrollmentAuthority } from '../featureRoute.js';
import {
  setSchedulePreference, substituteOccurrence, applyPlanRevision, getEnrollment,
  setDayOverride, assertDayMoveAllowed, DayMoveDeniedError,
} from './enrollmentService.js';
import { acceptRecovery, todayFor } from './todayService.js';
import { createLogger } from '../../observability/logger.js';
import { emitPlanRevised } from '../../host/planRevisedHook.js';

const log = createLogger('kicktodo.replan');

/** The closed set of daypart values the schedule lane accepts (null clears). */
const DAYPARTS = new Set(['morning', 'afternoon', 'evening']);

/** One revision command — the discriminated union that mirrors, field-for-field,
 *  the `oneOf` in `feature.kicktodo.agents/schemas/plan-revision.schema.json`. */
export type RevisionCommand =
  | { lane: 'schedule'; daypart: 'morning' | 'afternoon' | 'evening' | null }
  | { lane: 'substitute'; cardId: string; alternativeId: string }
  | { lane: 'recovery' }
  /** ADR 0496 D1 — re-date ONE challenge day (1-based) to an explicit local date. */
  | { lane: 'move'; day: number; toDate: string };

export interface RevisionResult {
  applied: boolean;
  results: Array<{ lane: RevisionCommand['lane'] }>;
}

/** A typed refusal that ALSO carries the failing command index (top-level, the
 *  shape `feature.kicktodo.nodes.apply-revision-commands` reads as `failedIndex`). */
export class RevisionCommandError extends OpenwopError {
  constructor(code: OpenwopErrorCode, message: string, httpStatus: number, public readonly failedIndex?: number) {
    super(code, message, httpStatus, failedIndex !== undefined ? { failedIndex } : undefined);
    this.name = 'RevisionCommandError';
  }
}

/** Closed-world validation of ONE command. Returns the typed command or throws a
 *  `validation_error` carrying its index — an unknown lane or an extra/missing
 *  field is a typed failure, never a silently-dropped command. */
function validateCommand(raw: unknown, index: number): RevisionCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RevisionCommandError('validation_error', `Command ${index} must be an object.`, 400, index);
  }
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o);
  switch (o.lane) {
    case 'schedule': {
      // Exactly { lane, daypart }; daypart ∈ {morning,afternoon,evening,null}.
      if (keys.length !== 2 || !('daypart' in o)) {
        throw new RevisionCommandError('validation_error', `Command ${index} (schedule) must carry exactly { lane, daypart }.`, 400, index);
      }
      if (o.daypart !== null && !(typeof o.daypart === 'string' && DAYPARTS.has(o.daypart))) {
        throw new RevisionCommandError('validation_error', `Command ${index} \`daypart\` must be morning|afternoon|evening|null.`, 400, index);
      }
      return { lane: 'schedule', daypart: (o.daypart as 'morning' | 'afternoon' | 'evening' | null) };
    }
    case 'substitute': {
      if (keys.length !== 3 || typeof o.cardId !== 'string' || o.cardId.length === 0 || typeof o.alternativeId !== 'string' || o.alternativeId.length === 0) {
        throw new RevisionCommandError('validation_error', `Command ${index} (substitute) must carry exactly { lane, cardId, alternativeId }.`, 400, index);
      }
      return { lane: 'substitute', cardId: o.cardId, alternativeId: o.alternativeId };
    }
    case 'recovery': {
      if (keys.length !== 1) {
        throw new RevisionCommandError('validation_error', `Command ${index} (recovery) must carry exactly { lane }.`, 400, index);
      }
      return { lane: 'recovery' };
    }
    case 'move': {
      // ADR 0496 D1 — exactly { lane, day, toDate }; day 1-based integer,
      // toDate a local ISO date. Range/window/liveness guards are the shared
      // `assertDayMoveAllowed` (they need the enrollment, not just the shape).
      if (keys.length !== 3 || typeof o.day !== 'number' || !Number.isInteger(o.day) || o.day < 1
        || typeof o.toDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.toDate)) {
        throw new RevisionCommandError('validation_error', `Command ${index} (move) must carry exactly { lane, day (1-based integer), toDate (YYYY-MM-DD) }.`, 400, index);
      }
      return { lane: 'move', day: o.day, toDate: o.toDate };
    }
    default:
      throw new RevisionCommandError('validation_error', `Command ${index} has an unknown lane \`${String(o.lane)}\` (allowed: schedule|substitute|recovery|move).`, 400, index);
  }
}

/**
 * Pure closed-world check of a command LIST (0..5, each a known lane shape) — the
 * TS mirror of `plan-revision.schema.json`'s `commands` array, exported so the
 * schema-parity test can prove they agree. `rationale` (the schema's other
 * required field) is the composer's/gate's concern, not this list validator's.
 */
export function revisionCommandsValid(commands: unknown): boolean {
  if (!Array.isArray(commands) || commands.length > 5) return false;
  try {
    commands.forEach((c, i) => validateCommand(c, i));
    return true;
  } catch {
    return false;
  }
}

/** ADR 0459 grade-fix — the HUMANIZED render of a plan revision for the approval card.
 *  Server-composed English prose (like the coach-proposal card's `proposal` string);
 *  the FE renders `lines` verbatim, so no opaque id ever reaches the participant. */
export interface PlanRevisionDisplay {
  summary: string;
  lines: string[];
}

const DAYPART_PHRASE: Record<string, string> = {
  morning: 'the morning',
  afternoon: 'the afternoon',
  evening: 'the evening',
};

/** Humanize ONE revision command, resolving ids to titles from the caller-provided
 *  maps. An UNRESOLVED id degrades to a neutral phrase — the card NEVER shows a raw id. */
function humanizeRevisionCommand(raw: unknown, cardTitle: Map<string, string>, altTitle: Map<string, string>): string {
  const c = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  switch (c.lane) {
    case 'schedule': {
      const phrase = typeof c.daypart === 'string' ? DAYPART_PHRASE[c.daypart] : undefined;
      return phrase ? `Move your sessions to ${phrase}.` : 'Clear your preferred time of day.';
    }
    case 'substitute': {
      const from = (typeof c.cardId === 'string' && cardTitle.get(c.cardId)) || 'a scheduled activity';
      const to = (typeof c.alternativeId === 'string' && altTitle.get(c.alternativeId)) || 'a publisher-approved alternative';
      return `Swap “${from}” for “${to}”.`;
    }
    case 'recovery':
      return 'Collapse your missed activities into a single recovery day.';
    case 'move': {
      const day = typeof c.day === 'number' ? `day ${c.day}` : 'a plan day';
      const to = typeof c.toDate === 'string' ? c.toDate : 'another date';
      return `Move ${day} to ${to}.`;
    }
    default:
      return 'A plan adjustment.';
  }
}

/**
 * ADR 0501 (console) — describe a command list WITHOUT reading anyone's plan: the
 * same humanizer as the approval card, with EMPTY title maps, so a coach composing
 * a proposal sees what they are asking for ("Move your sessions to the morning.")
 * before sending it — and never the participant's plan shape, which the owner-only
 * preview (`previewProposal`) exists to protect. Validates first: an off-lane command
 * throws the same typed refusal the propose path would.
 */
export function describeRevisionCommands(commands: unknown): string[] {
  const validated = validateRevisionCommands(commands);
  return validated.map((c) => humanizeRevisionCommand(c, new Map(), new Map()));
}

/**
 * ADR 0459 grade-fix — build the humanized `display` for a plan-revision approval card,
 * resolving each command's opaque `cardId`/`alternativeId` to REAL activity + alternative
 * titles from the participant's own Today state (the server has the state; the card must
 * never show an id). Best-effort reads: a lookup miss degrades to a neutral phrase, and a
 * read failure yields id-free neutral lines — this never throws, so enrichment can never
 * fail the run. `commands` is NOT touched here (the apply path reads the raw revision).
 */
export async function buildPlanRevisionDisplay(
  tenantId: string,
  enrollmentId: string,
  revision: { commands?: unknown; rationale?: unknown },
): Promise<PlanRevisionDisplay> {
  const commands: unknown[] = Array.isArray(revision.commands) ? revision.commands : [];
  const cardTitle = new Map<string, string>();
  const altTitle = new Map<string, string>();
  try {
    const enrollment = await getEnrollment(tenantId, enrollmentId);
    if (enrollment) {
      const view = await todayFor(tenantId, enrollment.ownerSubject);
      const actions = view.enrollments.find((e) => e.enrollmentId === enrollmentId)?.actions ?? [];
      for (const a of actions) {
        if (a.card) cardTitle.set(a.card.id, a.card.title);
        for (const alt of a.alternatives) altTitle.set(alt.stableActivityId, alt.title);
      }
    }
  } catch {
    // Best-effort — an unresolved title degrades to a neutral phrase (never an id).
  }
  const lines = commands.map((c) => humanizeRevisionCommand(c, cardTitle, altTitle));
  const summary = lines.length === 0
    ? 'No changes — your ask falls outside the schedule, swap, and recovery lanes.'
    : lines.length === 1 ? '1 change to your plan' : `${lines.length} changes to your plan`;
  return { summary, lines };
}

/**
 * Apply a participant's closed-world revision command list to their OWN
 * enrollment. Owner-checked FIRST; each lane re-checks ownership as defence in
 * depth. Idempotent under retry where the lanes are (substitute + recovery are
 * keyed idempotent; a schedule set is a CAS point-write) — the trailing
 * `applyPlanRevision` re-materializes today under a fresh revision. An EMPTY
 * command list is an honest no-op (the composer said the intent falls outside
 * the lanes): nothing executes and no revision is bumped.
 */
/**
 * The closed world, in ONE place. Validates a whole command list up front (0..5)
 * so a bad command never half-applies a prefix of the list.
 *
 * Exported because `kicktodo-accountability` validates a COACH's proposed commands
 * at authoring time (ADR 0501 step 2) — a coach must learn immediately that their
 * ask falls outside the three ADR 0429 lanes, not at the participant's accept.
 * Sharing this function is what keeps that one closed world: add a lane here and it
 * becomes proposable with no change there, and a lane rejected here can never be
 * persisted on a proposal.
 */
export function validateRevisionCommands(commands: unknown): RevisionCommand[] {
  if (!Array.isArray(commands)) {
    throw new RevisionCommandError('validation_error', '`commands` must be an array.', 400);
  }
  if (commands.length > 5) {
    throw new RevisionCommandError('validation_error', 'A revision carries at most 5 commands.', 400);
  }
  return commands.map((c, i) => validateCommand(c, i));
}

export async function applyRevisionCommands(
  tenantId: string,
  args: { enrollmentId: string; subject: string; commands: unknown[] },
): Promise<RevisionResult> {
  const { enrollmentId, subject, commands } = args;
  // `subject` is CALLER-TRUSTED — the surface op passes the authenticated actor (the
  // sibling-op trust model), and the authority check below is what makes trusting it
  // safe: a mismatched/spoofed subject simply fails `hasKicktodoEnrollmentAuthority`.
  // 1) AUTHORITY FIRST — the shared predicate the routes + tool use. applyPlanRevision
  //    has no owner check of its own, so this is the boundary that guards the whole list.
  if (!(await hasKicktodoEnrollmentAuthority(tenantId, enrollmentId, subject))) {
    throw new RevisionCommandError('forbidden', 'Not your enrollment.', 403);
  }
  // 2) CLOSED-WORLD validate the whole list up front (0..5), so a bad command
  //    never half-applies a prefix of the list before failing.
  const validated = validateRevisionCommands(commands);

  // 3) Execute in order; a lane refusal surfaces the failing command index.
  const results: RevisionResult['results'] = [];
  for (let idx = 0; idx < validated.length; idx++) {
    const c = validated[idx]!;
    try {
      if (c.lane === 'schedule') {
        await setSchedulePreference(tenantId, enrollmentId, subject, c.daypart);
      } else if (c.lane === 'substitute') {
        await substituteOccurrence(tenantId, subject, c.cardId, c.alternativeId);
      } else if (c.lane === 'move') {
        // ADR 0496 D1 — the day-move point-write (guards inside; a refusal
        // surfaces its reason verbatim with this command's index below).
        const moved = await setDayOverride(tenantId, enrollmentId, subject, c.day, c.toDate);
        if (!moved) throw new Error('not-owner');
      } else {
        await acceptRecovery(tenantId, subject, enrollmentId);
      }
      results.push({ lane: c.lane });
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'A revision command could not be applied.';
      throw new RevisionCommandError('validation_error', `Command ${idx} (${c.lane}) failed: ${message}`, 409, idx);
    }
  }

  // 4) ONE re-materialize (only when something changed — an empty list never
  //    bumps the revision pointlessly).
  const applied = validated.length > 0;
  if (applied) await applyPlanRevision(tenantId, enrollmentId);
  log.info('kicktodo_revision_applied', { enrollmentId, commandCount: validated.length });

  // ENG-15(b) — announce the durable revision so projections (today: the calendar
  // write in kicktodo-integrations) can re-derive. Fired AFTER the revision is
  // committed, and the host seam contains every listener error, so a failing
  // projection can never surface as a failed revision. No cross-feature import:
  // kicktodo-core does not know who is listening.
  if (applied) {
    await emitPlanRevised({
      tenantId,
      ownerSubject: subject,
      enrollmentId,
      lanes: validated.map((c) => c.lane),
    });
  }

  return { applied, results };
}

/** ADR 0496 D2 — one previewed change: the humanized line plus, for a move,
 *  the before/after dates the compare view renders. */
export interface PlanChange {
  lane: RevisionCommand['lane'];
  line: string;
  day?: number;
  fromDate?: string;
  toDate?: string;
}

/**
 * ADR 0496 D2 — the PURE dry-run behind the §5.5 compare: same authority
 * predicate, same closed-world validator, and — for the move lane — the SAME
 * `assertDayMoveAllowed` guards the apply path runs (architect M5: one guard
 * path, so preview can never pass what apply refuses). ZERO writes. Refusals
 * are the same typed `RevisionCommandError`s apply would raise, carrying the
 * failing command index.
 */
export async function previewRevisionCommands(
  tenantId: string,
  args: { enrollmentId: string; subject: string; commands: unknown[] },
): Promise<{ changes: PlanChange[] }> {
  const { enrollmentId, subject, commands } = args;
  if (!(await hasKicktodoEnrollmentAuthority(tenantId, enrollmentId, subject))) {
    throw new RevisionCommandError('forbidden', 'Not your enrollment.', 403);
  }
  const validated = validateRevisionCommands(commands);
  const enrollment = await getEnrollment(tenantId, enrollmentId);
  const display = await buildPlanRevisionDisplay(tenantId, enrollmentId, { commands });
  const changes: PlanChange[] = [];
  for (let idx = 0; idx < validated.length; idx++) {
    const c = validated[idx]!;
    const line = display.lines[idx] ?? '';
    if (c.lane === 'move') {
      if (!enrollment) throw new RevisionCommandError('validation_error', `Command ${idx} (move) failed: not-found`, 409, idx);
      try {
        const { fromDate } = await assertDayMoveAllowed(tenantId, enrollment, c.day, c.toDate);
        changes.push({ lane: 'move', line, day: c.day, fromDate, toDate: c.toDate });
      } catch (err) {
        const reason = err instanceof DayMoveDeniedError ? err.reason : (err instanceof Error ? err.message : 'refused');
        throw new RevisionCommandError('validation_error', `Command ${idx} (move) failed: ${reason}`, 409, idx);
      }
    } else {
      changes.push({ lane: c.lane, line });
    }
  }
  return { changes };
}
