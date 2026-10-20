/**
 * ADR 0889 D2 — the tenant's agent eval suites (RFC 0081 §A + RFC 0244).
 *
 * One DurableCollection, keyed `tenant:suiteId@version`. A version is IMMUTABLE
 * once any eval run has referenced it (`lockedAt`), so a regression baseline
 * always compares like with like; an edit after that must mint a new version.
 *
 * Validation is CLOSED-WORLD and typed: an unknown key, an out-of-range value or
 * a shape the RFC forbids is a `400 validation_error` naming the field — never
 * a silent drop (the validator-allowlist trap this repo has hit six times).
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from '../hostExtPersistence.js';
import { sanitizeFreeTextDeep } from '../../byok/textRedaction.js';
import { registerSubjectEraser } from '../subjectErasure.js';
import { ERASED, subjectKeyForms } from '../subjectErasureRedaction.js';
import { OpenwopError } from '../../types.js';
import type { TrajectoryExpectation } from './trajectory.js';
import type { PassRule } from './trialStats.js';
import type { GoldenStrategy } from './outputGrade.js';

/* ── the RFC shape ──────────────────────────────────────────────────────── */

export type EvalMode = 'golden' | 'rubric' | 'adversarial' | 'regression' | 'live-shadow';

export interface ToolResponseFixture {
  tool: string;
  response?: unknown;
  args?: unknown;
  argsMatch?: 'ignore' | 'exact' | 'subset';
  /** RFC 0245 §A — the recorded call FAILED and `response` is its error payload.
   *  Served as a tool error (never a success), not a miss, never retried live. */
  isError?: boolean;
}

export interface EvalTaskDef {
  taskId: string;
  input: unknown;
  expected: {
    kind: 'golden' | 'rubric' | 'trajectory';
    match?: { strategy: GoldenStrategy; value: unknown };
    rubric?: Array<{ criterion: string; weight: number }>;
    trajectory?: TrajectoryExpectation;
  };
  fixtures?: {
    toolResponses?: ToolResponseFixture[];
    memorySeed?: Array<Record<string, unknown>>;
    onMiss?: 'fail' | 'live';
  };
}

export interface AgentEvalSuite {
  suiteId: string;
  version: string;
  targetAgentId?: string;
  modes: EvalMode[];
  allowedModels?: string[];
  thresholds?: { passScore?: number; maxCostUsd?: number; maxP95LatencyMs?: number };
  trials?: { count?: number; k?: number; passRule?: PassRule };
  tasks: EvalTaskDef[];
}

export interface StoredEvalSuite {
  key: string;
  tenantId: string;
  suite: AgentEvalSuite;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  /** Set the first time an eval run references this version; edits then 409. */
  lockedAt?: string;
  /** EVD-10 — a subject-erasure request redacted task content here (an exact-args
   *  fixture may now miss). Cleared when the content is replaced. */
  erasedAt?: string;
  erasedTasks?: number;
  /** Mid-delete marker: the row is gone to every reader (`deleteEvalSuite`). */
  deletingAt?: string;
}

/* ── host limits (also advertised, ADR 0889 D7) ─────────────────────────── */

export const MAX_TASKS_PER_SUITE = 100;
export const MAX_TRIALS = 10;
export const MAX_SUITE_BYTES = 512 * 1024;
export const MAX_COST_USD_PER_SUITE = 5;
/** AEV-3 — each criterion is one judge call; these bound a trial's judge spend. */
export const MAX_RUBRIC_CRITERIA = 20;
export const MAX_CRITERION_CHARS = 1000;
/** The modes this host implements and gates on (ADR 0889 D7 — never more). */
export const IMPLEMENTED_MODES: readonly EvalMode[] = ['golden', 'rubric', 'regression'];

/* ── store ──────────────────────────────────────────────────────────────── */

const suites = new DurableCollection<StoredEvalSuite>('agent:eval-suite', (r) => r.key, undefined, (r) => r.tenantId);

export const suiteRef = (s: { suiteId: string; version: string }): string => `${s.suiteId}@${s.version}`;

/**
 * The synthetic `workflowId` of an eval run of `ref` (ADR 0889 D1). It MUST match
 * the v2 workflowId grammar `^[A-Za-z0-9._~:-]{1,128}$` (`ids.schema.json`) — the
 * first cut used `eval:<ref>` verbatim, and `@` (and a fixture URI's `/`) made every
 * run list containing an eval run fail `run-list-response` (caught by the major-2
 * conformance lane, `v2-run-list`). Deterministic, so history lists by it.
 */
export function evalWorkflowId(ref: string): string {
  const body = ref.replace(/[^A-Za-z0-9._~:-]/g, '~');
  const id = `eval:${body}`;
  if (id.length <= 128) return id;
  return `eval:${body.slice(0, 100)}~${createHash('sha256').update(ref).digest('hex').slice(0, 16)}`;
}
const suiteKey = (tenantId: string, ref: string): string => `${tenantId}:${ref}`;

/* ── validation ─────────────────────────────────────────────────────────── */

const SUITE_ID_RE = /^[a-z0-9.-]+\.evals\.[a-z0-9-]+$/;
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const MODES = new Set<EvalMode>(['golden', 'rubric', 'adversarial', 'regression', 'live-shadow']);
const MODEL_CLASSES = new Set(['reasoning', 'writing', 'coding', 'research', 'classification', 'general']);
const MATCH_MODES = new Set(['exact', 'in-order', 'any-order', 'subset']);
const ARGS_MATCH = new Set(['ignore', 'exact', 'subset']);
const STRATEGIES = new Set(['exact', 'contains', 'json-match']);
const PASS_RULES = new Set(['all', 'any', 'mean']);
const TASK_KINDS = new Set(['golden', 'rubric', 'trajectory']);
const ON_MISS = new Set(['fail', 'live']);

/**
 * Grade remediation (BE-2) — every refusal names a machine-readable `rule` (plus
 * its `params`), so a client localizes it instead of rendering this English.
 */
export type SuiteRule = 'required' | 'type' | 'range' | 'pattern' | 'enum' | 'unknown_property' | 'duplicate' | 'too_large' | 'too_many';
function bad(field: string, message: string, rule: SuiteRule, params?: Record<string, unknown>): never {
  throw new OpenwopError('validation_error', `${field}: ${message}`, 400, { field, rule, ...(params ? { params } : {}) });
}
/** An absent value is `required`; a present one of the wrong JSON type is `type`. */
function shape(v: unknown): SuiteRule {
  return v === undefined ? 'required' : 'type';
}
/** A closed vocabulary: `enum` with its values, or `required` when absent. */
function oneOf(v: unknown, values: ReadonlySet<string>): [SuiteRule, Record<string, unknown>] {
  return [v === undefined ? 'required' : 'enum', { values: [...values] }];
}
function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function closed(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`${where}.${k}`, 'unknown property', 'unknown_property');
}
function str(v: unknown, field: string, re?: RegExp): string {
  if (typeof v !== 'string' || v.length === 0) bad(field, 'must be a non-empty string', v === undefined ? 'required' : 'type');
  if (re && !re.test(v)) bad(field, `must match ${re.source}`, 'pattern', { pattern: re.source });
  return v;
}
function num(v: unknown, field: string, min: number, max: number, int = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
    bad(field, `must be ${int ? 'an integer' : 'a number'} in [${min}, ${max}]`, v === undefined ? 'required' : typeof v === 'number' ? 'range' : 'type', { min, max, integer: int });
  }
  return v;
}

function validateTrajectory(v: unknown, where: string): TrajectoryExpectation {
  if (!isObj(v)) bad(where, 'must be an object', shape(v));
  closed(v, ['match', 'calls', 'forbidden', 'includeDelegates'], where);
  if (!MATCH_MODES.has(v.match as string)) bad(`${where}.match`, 'must be exact | in-order | any-order | subset', ...oneOf(v.match, MATCH_MODES));
  if (!Array.isArray(v.calls)) bad(`${where}.calls`, 'must be an array', shape(v.calls));
  const calls = v.calls.map((c, i) => {
    const w = `${where}.calls[${i}]`;
    if (!isObj(c)) bad(w, 'must be an object', shape(c));
    closed(c, ['tool', 'args', 'argsMatch'], w);
    str(c.tool, `${w}.tool`);
    if (c.argsMatch !== undefined && !ARGS_MATCH.has(c.argsMatch as string)) bad(`${w}.argsMatch`, 'must be ignore | exact | subset', ...oneOf(c.argsMatch, ARGS_MATCH));
    return {
      tool: c.tool as string,
      ...('args' in c ? { args: c.args } : {}),
      ...(c.argsMatch !== undefined ? { argsMatch: c.argsMatch as 'ignore' | 'exact' | 'subset' } : {}),
    };
  });
  if (v.forbidden !== undefined) {
    if (!Array.isArray(v.forbidden)) bad(`${where}.forbidden`, 'must be an array', shape(v.forbidden));
    v.forbidden.forEach((t, i) => str(t, `${where}.forbidden[${i}]`));
  }
  if (v.includeDelegates !== undefined && typeof v.includeDelegates !== 'boolean') bad(`${where}.includeDelegates`, 'must be a boolean', shape(v.includeDelegates));
  return { match: v.match as TrajectoryExpectation['match'], calls, ...(v.forbidden ? { forbidden: v.forbidden as string[] } : {}), ...(v.includeDelegates !== undefined ? { includeDelegates: v.includeDelegates as boolean } : {}) };
}

function validateTask(t: unknown, i: number): EvalTaskDef {
  const w = `tasks[${i}]`;
  if (!isObj(t)) bad(w, 'must be an object', shape(t));
  closed(t, ['taskId', 'input', 'expected', 'fixtures'], w);
  str(t.taskId, `${w}.taskId`, TASK_ID_RE);
  if (!('input' in t)) bad(`${w}.input`, 'is required', 'required');
  const e = t.expected;
  if (!isObj(e)) bad(`${w}.expected`, 'must be an object', shape(e));
  closed(e, ['kind', 'match', 'rubric', 'trajectory'], `${w}.expected`);
  const kind = e.kind;
  if (kind !== 'golden' && kind !== 'rubric' && kind !== 'trajectory') bad(`${w}.expected.kind`, 'must be golden | rubric | trajectory', ...oneOf(kind, TASK_KINDS));
  if (kind === 'golden') {
    if (!isObj(e.match)) bad(`${w}.expected.match`, 'is required for kind golden', shape(e.match));
    closed(e.match, ['strategy', 'value'], `${w}.expected.match`);
    if (!STRATEGIES.has(e.match.strategy as string)) bad(`${w}.expected.match.strategy`, 'must be exact | contains | json-match', ...oneOf(e.match.strategy, STRATEGIES));
    if (!('value' in e.match)) bad(`${w}.expected.match.value`, 'is required', 'required');
  }
  // A rubric is validated (and capped) wherever it appears, not only on kind rubric.
  if (kind === 'rubric' || e.rubric !== undefined) {
    if (!Array.isArray(e.rubric) || e.rubric.length === 0) bad(`${w}.expected.rubric`, 'is required (non-empty) for kind rubric', shape(e.rubric));
    if (e.rubric.length > MAX_RUBRIC_CRITERIA) bad(`${w}.expected.rubric`, `has more than ${MAX_RUBRIC_CRITERIA} criteria`, 'too_many', { max: MAX_RUBRIC_CRITERIA });
    e.rubric.forEach((r, j) => {
      const rw = `${w}.expected.rubric[${j}]`;
      if (!isObj(r)) bad(rw, 'must be an object', shape(r));
      closed(r, ['criterion', 'weight'], rw);
      str(r.criterion, `${rw}.criterion`);
      // AEV-3 — one judge call per criterion, so the rubric size IS the spend.
      if ((r.criterion as string).length > MAX_CRITERION_CHARS) bad(`${rw}.criterion`, `exceeds ${MAX_CRITERION_CHARS} characters`, 'too_large', { max: MAX_CRITERION_CHARS });
      num(r.weight, `${rw}.weight`, 0, 1);
    });
  }
  if (kind === 'trajectory') {
    // RFC 0244 §A — a trajectory-only task carries no output criterion.
    if (e.match !== undefined || e.rubric !== undefined) bad(`${w}.expected`, 'kind trajectory must not carry match or rubric', 'unknown_property');
    if (e.trajectory === undefined) bad(`${w}.expected.trajectory`, 'is required for kind trajectory', 'required');
  }
  const trajectory = e.trajectory !== undefined ? validateTrajectory(e.trajectory, `${w}.expected.trajectory`) : undefined;
  let fixtures: EvalTaskDef['fixtures'];
  if (t.fixtures !== undefined) {
    const f = t.fixtures;
    if (!isObj(f)) bad(`${w}.fixtures`, 'must be an object', shape(f));
    closed(f, ['toolResponses', 'memorySeed', 'onMiss'], `${w}.fixtures`);
    if (f.onMiss !== undefined && f.onMiss !== 'fail' && f.onMiss !== 'live') bad(`${w}.fixtures.onMiss`, 'must be fail | live', ...oneOf(f.onMiss, ON_MISS));
    if (f.toolResponses !== undefined) {
      if (!Array.isArray(f.toolResponses)) bad(`${w}.fixtures.toolResponses`, 'must be an array', shape(f.toolResponses));
      f.toolResponses.forEach((r, j) => {
        const rw = `${w}.fixtures.toolResponses[${j}]`;
        if (!isObj(r)) bad(rw, 'must be an object', shape(r));
        closed(r, ['tool', 'response', 'args', 'argsMatch', 'isError'], rw);
        str(r.tool, `${rw}.tool`);
        if (r.isError !== undefined && typeof r.isError !== 'boolean') bad(`${rw}.isError`, 'must be a boolean (RFC 0245 §A)', shape(r.isError));
        if (r.argsMatch !== undefined && !ARGS_MATCH.has(r.argsMatch as string)) bad(`${rw}.argsMatch`, 'must be ignore | exact | subset', ...oneOf(r.argsMatch, ARGS_MATCH));
      });
    }
    if (f.memorySeed !== undefined && (!Array.isArray(f.memorySeed) || !f.memorySeed.every(isObj))) bad(`${w}.fixtures.memorySeed`, 'must be an array of objects', shape(f.memorySeed));
    fixtures = f as EvalTaskDef['fixtures'];
  }
  return {
    taskId: t.taskId as string,
    input: t.input,
    expected: {
      kind,
      ...(e.match !== undefined ? { match: e.match as EvalTaskDef['expected']['match'] } : {}),
      ...(e.rubric !== undefined ? { rubric: e.rubric as EvalTaskDef['expected']['rubric'] } : {}),
      ...(trajectory ? { trajectory } : {}),
    },
    ...(fixtures ? { fixtures } : {}),
  };
}

/** Closed-world validation of an `AgentEvalSuite` body (RFC 0081 §A + RFC 0244). */
export function validateEvalSuite(body: unknown): AgentEvalSuite {
  if (!isObj(body)) bad('suite', 'must be an object', shape(body));
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_SUITE_BYTES) bad('suite', `exceeds ${MAX_SUITE_BYTES} bytes`, 'too_large', { max: MAX_SUITE_BYTES });
  closed(body, ['suiteId', 'version', 'targetAgentId', 'modes', 'allowedModels', 'thresholds', 'trials', 'tasks'], 'suite');
  const suiteId = str(body.suiteId, 'suiteId', SUITE_ID_RE);
  const version = str(body.version, 'version', SEMVER_RE);
  if (body.targetAgentId !== undefined) str(body.targetAgentId, 'targetAgentId');
  if (!Array.isArray(body.modes) || body.modes.length === 0) bad('modes', 'must be a non-empty array', shape(body.modes));
  if (new Set(body.modes).size !== body.modes.length) bad('modes', 'must be unique', 'duplicate');
  body.modes.forEach((m, i) => { if (!MODES.has(m as EvalMode)) bad(`modes[${i}]`, 'unknown eval mode', ...oneOf(m, MODES)); });
  if (body.allowedModels !== undefined) {
    if (!Array.isArray(body.allowedModels)) bad('allowedModels', 'must be an array', shape(body.allowedModels));
    body.allowedModels.forEach((m, i) => { if (!MODEL_CLASSES.has(m as string)) bad(`allowedModels[${i}]`, 'unknown model class', ...oneOf(m, MODEL_CLASSES)); });
  }
  if (body.thresholds !== undefined) {
    const th = body.thresholds;
    if (!isObj(th)) bad('thresholds', 'must be an object', shape(th));
    closed(th, ['passScore', 'maxCostUsd', 'maxP95LatencyMs'], 'thresholds');
    if (th.passScore !== undefined) num(th.passScore, 'thresholds.passScore', 0, 1);
    if (th.maxCostUsd !== undefined) num(th.maxCostUsd, 'thresholds.maxCostUsd', 0, Number.MAX_SAFE_INTEGER);
    if (th.maxP95LatencyMs !== undefined) num(th.maxP95LatencyMs, 'thresholds.maxP95LatencyMs', 0, Number.MAX_SAFE_INTEGER, true);
  }
  if (body.trials !== undefined) {
    const tr = body.trials;
    if (!isObj(tr)) bad('trials', 'must be an object', shape(tr));
    closed(tr, ['count', 'k', 'passRule'], 'trials');
    const count = tr.count === undefined ? 1 : num(tr.count, 'trials.count', 1, Number.MAX_SAFE_INTEGER, true);
    if (tr.k !== undefined) num(tr.k, 'trials.k', 1, count, true);
    if (tr.passRule !== undefined && !PASS_RULES.has(tr.passRule as string)) bad('trials.passRule', 'must be all | any | mean', ...oneOf(tr.passRule, PASS_RULES));
  }
  if (!Array.isArray(body.tasks) || body.tasks.length === 0) bad('tasks', 'must be a non-empty array', shape(body.tasks));
  const tasks = body.tasks.map(validateTask);
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.taskId)) bad('tasks', `duplicate taskId ${t.taskId}`, 'duplicate', { value: t.taskId });
    ids.add(t.taskId);
  }
  return {
    suiteId, version, modes: body.modes as EvalMode[], tasks,
    ...(body.targetAgentId !== undefined ? { targetAgentId: body.targetAgentId as string } : {}),
    ...(body.allowedModels !== undefined ? { allowedModels: body.allowedModels as string[] } : {}),
    ...(body.thresholds !== undefined ? { thresholds: body.thresholds as AgentEvalSuite['thresholds'] } : {}),
    ...(body.trials !== undefined ? { trials: body.trials as AgentEvalSuite['trials'] } : {}),
  };
}

/** Which RFC 0244 features a suite uses — the run-create advert check (§G). */
export function suiteFeatures(s: AgentEvalSuite): { trajectory: boolean; trials: number; fixtureMatching: boolean; fixtureErrors: boolean } {
  return {
    trajectory: s.tasks.some((t) => t.expected.trajectory !== undefined || t.expected.kind === 'trajectory'),
    trials: s.trials?.count ?? 1,
    fixtureMatching: s.tasks.some((t) => t.fixtures?.onMiss !== undefined || (t.fixtures?.toolResponses ?? []).some((r) => r.args !== undefined)),
    // RFC 0245 §C — any `isError: true` entry needs `agents.evalSuite.fixtureErrors`.
    fixtureErrors: s.tasks.some((t) => (t.fixtures?.toolResponses ?? []).some((r) => r.isError === true)),
  };
}

/* ── CRUD ───────────────────────────────────────────────────────────────── */
//
// Grade remediation EVD-1/EVD-4/EVAL-2 — every write is a compare-and-swap against
// the row it read (`DurableCollection.compareAndSwap`, atomic across instances).
// The previous get-then-put let a lock erase a concurrent PUT (or a PUT erase the
// lock), so a "locked" version could still change under a run that referenced it.

const MAX_CAS_ATTEMPTS = 8;

function suiteConflict(ref: string, reason: 'suite_exists' | 'suite_locked' | 'suite_conflict' | 'suite_changed', message: string): OpenwopError {
  return new OpenwopError('conflict', message, 409, { reason, suiteRef: ref });
}

/** Canonical content digest (sorted keys). A run stamps it; resume refuses other content. */
export function suiteDigest(suite: AgentEvalSuite): string {
  const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
    : v;
  return createHash('sha256').update(JSON.stringify(canon(suite))).digest('hex');
}

/** The stored row, or null when absent or mid-delete (a `deletingAt` row is gone to readers). */
async function readRow(key: string): Promise<StoredEvalSuite | null> {
  const row = await suites.get(key);
  return row && !row.deletingAt ? row : null;
}

/**
 * Create or replace a version. `create: true` is insert-only: an existing ref is
 * `409 suite_exists`, so a "new suite" form can never overwrite one (EVUX-1).
 */
export async function putEvalSuite(tenantId: string, suite: AgentEvalSuite, createdBy?: string, opts: { create?: boolean } = {}): Promise<StoredEvalSuite> {
  const ref = suiteRef(suite);
  const key = suiteKey(tenantId, ref);
  // Free-text secrets are scrubbed before persistence (the ADR 0477 store precedent).
  const clean = sanitizeFreeTextDeep(suite) as AgentEvalSuite;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const raw = await suites.get(key);
    const existing = raw && !raw.deletingAt ? raw : null;
    if (existing && opts.create) throw suiteConflict(ref, 'suite_exists', `Suite ${ref} already exists; pick another id or version.`);
    if (existing?.lockedAt) throw suiteConflict(ref, 'suite_locked', `Suite ${ref} has been run and is immutable; publish a new version.`);
    const now = new Date().toISOString();
    const row: StoredEvalSuite = {
      key, tenantId, suite: clean,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
      ...(existing?.createdBy ?? createdBy ? { createdBy: existing?.createdBy ?? createdBy } : {}),
    };
    if (await suites.compareAndSwap(raw, row)) return row;
  }
  throw suiteConflict(ref, 'suite_conflict', `Suite ${ref} is being changed concurrently; reload and try again.`);
}

/**
 * Read-modify-write one unlocked version (promote's task append). `mutate` gets
 * the current row and returns the next suite; a lost race re-reads and re-applies,
 * so two concurrent appends both land (EVD-4).
 */
export async function updateEvalSuite(
  tenantId: string,
  ref: string,
  mutate: (row: StoredEvalSuite) => AgentEvalSuite,
): Promise<StoredEvalSuite | null> {
  const key = suiteKey(tenantId, ref);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const row = await readRow(key);
    if (!row || row.tenantId !== tenantId) return null;
    if (row.lockedAt) throw suiteConflict(ref, 'suite_locked', `Suite ${ref} has been run and is immutable; publish a new version.`);
    const next = sanitizeFreeTextDeep(mutate(row)) as AgentEvalSuite;
    if (suiteRef(next) !== ref) throw new OpenwopError('validation_error', 'An update cannot change the suite ref.', 400, { field: 'suiteId', rule: 'enum', params: { values: [ref] } });
    const { erasedAt: _e, erasedTasks: _n, ...keep } = row;
    void _e; void _n;
    const updated: StoredEvalSuite = { ...keep, suite: next, updatedAt: new Date().toISOString() };
    if (await suites.compareAndSwap(row, updated)) return updated;
  }
  throw suiteConflict(ref, 'suite_conflict', `Suite ${ref} is being changed concurrently; reload and try again.`);
}

export async function getEvalSuite(tenantId: string, ref: string): Promise<StoredEvalSuite | null> {
  const row = await readRow(suiteKey(tenantId, ref));
  return row && row.tenantId === tenantId ? row : null;
}

export async function listEvalSuites(tenantId: string): Promise<StoredEvalSuite[]> {
  return (await suites.listByPrefix(`${tenantId}:`)).filter((r) => r.tenantId === tenantId && !r.deletingAt);
}

/**
 * Delete an unlocked version. The row is first CAS-marked `deletingAt` (invisible
 * to every reader and to `lockEvalSuite` from then on), then removed: a plain
 * get-then-delete could remove a row a concurrent run had just locked.
 */
export async function deleteEvalSuite(tenantId: string, ref: string): Promise<boolean> {
  const key = suiteKey(tenantId, ref);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const row = await readRow(key);
    if (!row || row.tenantId !== tenantId) return false;
    // Review M2 — a locked version has runs graded against it. Deleting it would let
    // a PUT re-create the SAME ref with different content, so resumes, baselines and
    // history would mix two suites under one name. Publish a new version instead.
    if (row.lockedAt) throw suiteConflict(ref, 'suite_locked', `Suite ${ref} has been run and is immutable; publish a new version instead of deleting it.`);
    if (await suites.compareAndSwap(row, { ...row, deletingAt: new Date().toISOString() })) {
      await suites.delete(key);
      return true;
    }
  }
  throw suiteConflict(ref, 'suite_conflict', `Suite ${ref} is being changed concurrently; reload and try again.`);
}

/**
 * Lock a version on first use, iff its content is still `expectedDigest` — the
 * content the caller resolved and will run. The digest check and the lock are ONE
 * swap, so no PUT can land between "resolved" and "locked" (EVD-1). A content
 * mismatch is `409 suite_changed` (re-resolve and retry); an already-locked
 * version of the same content is fine. `lockedByUs` says whether THIS call set
 * the lock, so a refused run insert can release exactly its own lock (EVD-9).
 */
export async function lockEvalSuite(tenantId: string, ref: string, expectedDigest: string): Promise<{ lockedByUs: boolean; row: StoredEvalSuite }> {
  const key = suiteKey(tenantId, ref);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const row = await readRow(key);
    if (!row || row.tenantId !== tenantId) throw new OpenwopError('not_found', `Eval suite ${ref} was not found.`, 404, { evalSuiteRef: ref });
    if (suiteDigest(row.suite) !== expectedDigest) throw suiteConflict(ref, 'suite_changed', `Suite ${ref} changed while the run was being created; try again.`);
    if (row.lockedAt) return { lockedByUs: false, row };
    const locked: StoredEvalSuite = { ...row, lockedAt: new Date().toISOString() };
    if (await suites.compareAndSwap(row, locked)) return { lockedByUs: true, row: locked };
  }
  throw suiteConflict(ref, 'suite_conflict', `Suite ${ref} is being changed concurrently; try again.`);
}

/**
 * EVD-9 — undo `lockEvalSuite` when the run that took the lock was never
 * inserted (run limit, quota). Swaps only from the exact row the lock wrote, so
 * any later change (another run's erasure, …) leaves it alone. Best-effort.
 *
 * Residual (accepted): a concurrent create that found the version ALREADY locked
 * by us and inserted its run in the same instant would see the lock released.
 * Both creates would have to straddle one refused insert; the run still grades
 * its in-memory suite and resume still checks the digest.
 */
export async function unlockEvalSuite(locked: StoredEvalSuite): Promise<void> {
  const { lockedAt: _l, ...rest } = locked;
  void _l;
  await suites.compareAndSwap(locked, rest).catch(() => false);
}

/* ── erasure (ADR 0464) ─────────────────────────────────────────────────── */

/** Replace every occurrence of a subject form inside string values (keys untouched). */
function redactForms(value: unknown, forms: readonly string[]): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    let out = value;
    for (const f of forms) if (out.includes(f)) out = out.split(f).join(ERASED);
    return { value: out, changed: out !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => { const r = redactForms(v, forms); changed ||= r.changed; return r.value; });
    return { value: changed ? next : value, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = redactForms(v, forms); changed ||= r.changed; next[k] = r.value;
    }
    return { value: changed ? next : value, changed };
  }
  return { value, changed: false };
}

/**
 * ADR 0464 + review H4 — a suite's `createdBy`, AND the subject inside task content.
 * A task promoted from a captured run (`promoteRun.ts`) carries that run's tool
 * inputs and results; once copied here they left the capture store's TTL and its
 * eraser, so a person's identifiers survived their erasure request. Task `input`,
 * `expected` and `fixtures` are redacted in place. Erasure overrides `lockedAt`:
 * immutability protects graders from edits, not a person from a DSAR.
 */
export async function eraseSubjectEvalSuites(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  // Very short forms would shred unrelated text; ids and emails are never this short.
  const contentForms = [...forms].filter((f) => f.length >= 4);
  for (const listed of await suites.listByPrefix(`${tenantId}:`)) {
    if (listed.tenantId !== tenantId) continue;
    // CAS per row (EVD-1): a plain put here could strip a lock taken concurrently.
    for (let attempt = 0, r: StoredEvalSuite | null = listed; r && attempt < MAX_CAS_ATTEMPTS; attempt++) {
      let next: StoredEvalSuite = r;
      if (r.createdBy !== undefined && forms.has(r.createdBy)) next = { ...next, createdBy: ERASED };
      const redacted = r.suite.tasks.map((t) => redactForms(t, contentForms));
      const changedTasks = redacted.filter((x) => x.changed).length;
      if (changedTasks > 0) {
        // EVD-10 — say WHY a promoted exact-args fixture may now miss.
        next = { ...next, suite: { ...next.suite, tasks: redacted.map((x) => x.value as EvalTaskDef) }, erasedAt: new Date().toISOString(), erasedTasks: (r.erasedTasks ?? 0) + changedTasks };
      }
      if (next === r) break;
      if (await suites.compareAndSwap(r, { ...next, updatedAt: new Date().toISOString() })) break;
      r = await suites.get(r.key);
      if (r && r.tenantId !== tenantId) break;
    }
  }
}

export function registerEvalSuiteErasure(): void {
  registerSubjectEraser(eraseSubjectEvalSuites);
}
