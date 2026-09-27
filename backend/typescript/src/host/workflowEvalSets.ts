/**
 * ADR 0477 §1 — workflow eval sets + results: owner-authored regression
 * suites for a workflow. A SET is one bounded row holding its cases (atomic
 * edits); a RESULT is one row per invocation (keep-20 per set), recording the
 * revision it evaluated — evals are revision-scoped facts.
 *
 * Assertions are a CLOSED WORLD: an unknown kind is a 400 at write time,
 * never stored, never "skipped" at evaluation time.
 */

import { DurableCollection } from './hostExtPersistence.js';
import { stripSecretsFromPersisted } from '../byok/ephemeralRunSecrets.js';
import { sanitizeFreeTextDeep } from '../byok/textRedaction.js';
import { onWorkflowDeleted } from './workflowsRegistry.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { ERASED, subjectKeyForms } from './subjectErasureRedaction.js';
import { OpenwopError } from '../types.js';

/* ── shapes ─────────────────────────────────────────────────────────────── */

export type EvalAssertion =
  | { kind: 'status'; value: 'completed' | 'failed' }
  | { kind: 'output-contains'; value: string }
  | { kind: 'output-path-equals'; path: string; value: unknown }
  | { kind: 'node-completed'; nodeId: string }
  | { kind: 'node-not-run'; nodeId: string }
  | { kind: 'llm-judge'; criteria: string; threshold?: number };

export interface EvalCase {
  caseId: string;
  name?: string;
  inputs?: Record<string, unknown>;
  /** Mocked nodes — the ADR 0475 pin `output` shape. */
  pins?: Array<{ nodeId: string; output: Record<string, unknown> }>;
  assertions: EvalAssertion[];
}

export interface WorkflowEvalSet {
  /** `${tenantId}:${encodeURIComponent(workflowId)}:${evalSetId}` */
  key: string;
  tenantId: string;
  workflowId: string;
  evalSetId: string;
  name: string;
  /** ADR 0477 §4 — opt this set into the evals-green promote gate. */
  requiredForPromote: boolean;
  /** ADR 0480 — online scoring of PRODUCTION runs at terminal. The online
   *  lane carries its OWN assertions: INVARIANTS that hold for any input
   *  (case assertions pair with fixture inputs and would misfire on live
   *  traffic). `sampleRate` is 0..1 (default 1); `judge` opts llm-judge
   *  assertions into the online lane (spend-capped per tenant-day — see
   *  workflowEvalOnline). */
  online?: { enabled: boolean; sampleRate?: number; judge?: boolean; assertions: EvalAssertion[] };
  cases: EvalCase[];
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export type EvalCaseStatus = 'running' | 'passed' | 'failed' | 'timed_out';

export interface EvalCaseResult {
  caseId: string;
  runId: string;
  status: EvalCaseStatus;
  assertions: Array<{ kind: string; pass: boolean; detail?: string }>;
}

export interface WorkflowEvalResult {
  /** `${tenantId}:${encodeURIComponent(workflowId)}:${evalSetId}:${resultId}` */
  key: string;
  tenantId: string;
  workflowId: string;
  evalSetId: string;
  resultId: string;
  /** The head content hash the invocation evaluated (ADR 0474 revisionHashOf). */
  revisionHash: string;
  /** `incomplete` (grade-data M6) — the dispatching instance died mid-
   *  invocation (timers + onRunTerminal are in-process): read-time repair
   *  flips a long-stale `running` row so the FE chip and the promote gate
   *  never read a permanent lie. */
  status: 'running' | 'complete' | 'incomplete';
  cases: EvalCaseResult[];
  startedAt: string;
  finishedAt?: string;
  startedBy?: string;
}

/* ── caps ───────────────────────────────────────────────────────────────── */

export const EVAL_SETS_PER_WORKFLOW_MAX = 10;
export const EVAL_CASES_PER_SET_MAX = 20;
export const EVAL_SET_MAX_BYTES = 256 * 1024;
export const EVAL_RESULTS_KEEP = 20;

/* ── stores ─────────────────────────────────────────────────────────────── */

const sets = new DurableCollection<WorkflowEvalSet>(
  'workflow:eval-set',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);
const results = new DurableCollection<WorkflowEvalResult>(
  'workflow:eval-result',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

const setKey = (tenantId: string, workflowId: string, evalSetId: string): string =>
  `${tenantId}:${encodeURIComponent(workflowId)}:${evalSetId}`;
const setPrefix = (tenantId: string, workflowId: string): string =>
  `${tenantId}:${encodeURIComponent(workflowId)}:`;
const resultKey = (tenantId: string, workflowId: string, evalSetId: string, resultId: string): string =>
  `${tenantId}:${encodeURIComponent(workflowId)}:${evalSetId}:${resultId}`;

/* ── validation (closed world) ──────────────────────────────────────────── */

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function validateAssertion(a: unknown, i: number, ci: number): EvalAssertion {
  // ci === -1 labels ONLINE invariant assertions (code-review L3 — a 400
  // citing "cases[-1]" pointed users at a nonexistent case).
  const where = ci < 0 ? `online.assertions[${i}]` : `cases[${ci}].assertions[${i}]`;
  if (!a || typeof a !== 'object' || Array.isArray(a)) {
    throw new OpenwopError('validation_error', `${where} must be an object.`, 400, {});
  }
  const rec = a as Record<string, unknown>;
  const fail = (msg: string): never => {
    throw new OpenwopError('validation_error', `${where}: ${msg}`, 400, {});
  };
  switch (rec.kind) {
    case 'status':
      if (rec.value !== 'completed' && rec.value !== 'failed') fail("status.value must be 'completed' or 'failed'");
      return { kind: 'status', value: rec.value as 'completed' | 'failed' };
    case 'output-contains':
      if (typeof rec.value !== 'string' || rec.value.length === 0) fail('output-contains.value must be a non-empty string');
      return { kind: 'output-contains', value: rec.value as string };
    case 'output-path-equals':
      if (typeof rec.path !== 'string' || rec.path.length === 0) fail('output-path-equals.path must be a non-empty string');
      return { kind: 'output-path-equals', path: rec.path as string, value: rec.value };
    case 'node-completed':
    case 'node-not-run':
      if (typeof rec.nodeId !== 'string' || rec.nodeId.length === 0) fail(`${String(rec.kind)}.nodeId must be a non-empty string`);
      return { kind: rec.kind, nodeId: rec.nodeId as string };
    case 'llm-judge': {
      if (typeof rec.criteria !== 'string' || rec.criteria.trim().length === 0) fail('llm-judge.criteria must be a non-empty string');
      if (rec.threshold !== undefined && (typeof rec.threshold !== 'number' || rec.threshold < 0 || rec.threshold > 1)) {
        fail('llm-judge.threshold must be 0..1');
      }
      return {
        kind: 'llm-judge',
        criteria: (rec.criteria as string).trim(),
        ...(typeof rec.threshold === 'number' ? { threshold: rec.threshold } : {}),
      };
    }
    default:
      return fail(`unknown assertion kind '${String(rec.kind)}' (closed world — see ADR 0477 §1)`);
  }
}

/** Validate + sanitize a client-supplied set body into a persistable row. */
export function validateEvalSetBody(body: unknown, ctx: { tenantId: string; workflowId: string; evalSetId: string; createdBy?: string; existing?: WorkflowEvalSet }): WorkflowEvalSet {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new OpenwopError('validation_error', 'The eval set must be an object.', 400, {});
  }
  const rec = body as Record<string, unknown>;
  const name = typeof rec.name === 'string' && rec.name.trim().length > 0 ? rec.name.trim().slice(0, 120) : null;
  if (!name) throw new OpenwopError('validation_error', 'name is required.', 400, {});
  const casesRaw = rec.cases;
  if (!Array.isArray(casesRaw) || casesRaw.length === 0) {
    throw new OpenwopError('validation_error', 'cases must be a non-empty array.', 400, {});
  }
  if (casesRaw.length > EVAL_CASES_PER_SET_MAX) {
    throw new OpenwopError('validation_error', `A set holds at most ${EVAL_CASES_PER_SET_MAX} cases.`, 400, {});
  }
  const seenCaseIds = new Set<string>();
  const cases: EvalCase[] = casesRaw.map((c, ci) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new OpenwopError('validation_error', `cases[${ci}] must be an object.`, 400, {});
    }
    const cr = c as Record<string, unknown>;
    const caseId = typeof cr.caseId === 'string' && ID_RE.test(cr.caseId) ? cr.caseId : null;
    if (!caseId) throw new OpenwopError('validation_error', `cases[${ci}].caseId must match ${String(ID_RE)}.`, 400, {});
    if (seenCaseIds.has(caseId)) throw new OpenwopError('validation_error', `duplicate caseId '${caseId}'.`, 400, {});
    seenCaseIds.add(caseId);
    const assertionsRaw = cr.assertions;
    if (!Array.isArray(assertionsRaw) || assertionsRaw.length === 0) {
      throw new OpenwopError('validation_error', `cases[${ci}] needs at least one assertion.`, 400, {});
    }
    const inputs = cr.inputs && typeof cr.inputs === 'object' && !Array.isArray(cr.inputs)
      ? (sanitizeFreeTextDeep(stripSecretsFromPersisted(cr.inputs)) as Record<string, unknown>)
      : undefined;
    let pins: EvalCase['pins'];
    if (cr.pins !== undefined) {
      if (!Array.isArray(cr.pins)) throw new OpenwopError('validation_error', `cases[${ci}].pins must be an array.`, 400, {});
      pins = (cr.pins as unknown[]).map((p, pi) => {
        const pr = (p ?? {}) as Record<string, unknown>;
        if (typeof pr.nodeId !== 'string' || !pr.output || typeof pr.output !== 'object' || Array.isArray(pr.output)) {
          throw new OpenwopError('validation_error', `cases[${ci}].pins[${pi}] must be {nodeId, output:object}.`, 400, {});
        }
        return {
          nodeId: pr.nodeId,
          output: sanitizeFreeTextDeep(stripSecretsFromPersisted(pr.output)) as Record<string, unknown>,
        };
      });
    }
    return {
      caseId,
      ...(typeof cr.name === 'string' && cr.name.trim() ? { name: cr.name.trim().slice(0, 120) } : {}),
      ...(inputs ? { inputs } : {}),
      ...(pins ? { pins } : {}),
      assertions: assertionsRaw.map((a, ai) => validateAssertion(a, ai, ci)),
    };
  });
  if (rec.requiredForPromote !== undefined && typeof rec.requiredForPromote !== 'boolean') {
    // Review LOW — a string "true" silently de-gating promote is the closed-
    // world validator failing its own bar.
    throw new OpenwopError('validation_error', 'requiredForPromote must be a boolean.', 400, {});
  }
  // ADR 0480 — the online block is validated explicitly (closed world:
  // unknown fields never persist silently).
  let online: WorkflowEvalSet['online'];
  if (rec.online !== undefined) {
    if (!rec.online || typeof rec.online !== 'object' || Array.isArray(rec.online)) {
      throw new OpenwopError('validation_error', 'online must be an object { enabled, sampleRate?, judge? }.', 400, {});
    }
    const o = rec.online as Record<string, unknown>;
    if (typeof o.enabled !== 'boolean') {
      throw new OpenwopError('validation_error', 'online.enabled must be a boolean.', 400, {});
    }
    if (o.sampleRate !== undefined && (typeof o.sampleRate !== 'number' || !Number.isFinite(o.sampleRate) || o.sampleRate <= 0 || o.sampleRate > 1)) {
      throw new OpenwopError('validation_error', 'online.sampleRate must be a number in (0, 1].', 400, {});
    }
    if (o.judge !== undefined && typeof o.judge !== 'boolean') {
      throw new OpenwopError('validation_error', 'online.judge must be a boolean.', 400, {});
    }
    // Online assertions are INVARIANTS scored against live traffic — required
    // when enabled (an enabled lane with nothing to assert is a no-op lie),
    // closed-world validated like case assertions, bounded.
    const oa = o.assertions;
    if (!Array.isArray(oa) || oa.length === 0) {
      throw new OpenwopError('validation_error', 'online.assertions must be a non-empty array of assertions (input-independent invariants).', 400, {});
    }
    if (oa.length > 10) {
      throw new OpenwopError('validation_error', 'online.assertions holds at most 10 assertions.', 400, {});
    }
    const onlineAssertions = oa.map((a, ai) => validateAssertion(a, ai, -1));
    // Code-review H2 — an llm-judge invariant without judge opt-in would be
    // permanently excluded from scoring (H1's skip semantics): reject the
    // misconfiguration at write time instead of shipping a silent lie.
    if (onlineAssertions.some((a) => a.kind === 'llm-judge') && o.judge !== true) {
      throw new OpenwopError('validation_error', 'online.assertions includes llm-judge — set online.judge: true to opt this set into judge spend (capped per day).', 400, {});
    }
    online = {
      enabled: o.enabled,
      ...(o.sampleRate !== undefined ? { sampleRate: o.sampleRate as number } : {}),
      ...(o.judge !== undefined ? { judge: o.judge as boolean } : {}),
      assertions: onlineAssertions,
    };
  }
  const row: WorkflowEvalSet = {
    key: setKey(ctx.tenantId, ctx.workflowId, ctx.evalSetId),
    tenantId: ctx.tenantId,
    workflowId: ctx.workflowId,
    evalSetId: ctx.evalSetId,
    name,
    requiredForPromote: rec.requiredForPromote === true,
    ...(online ? { online } : {}),
    cases,
    createdAt: ctx.existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(ctx.existing?.createdBy ? { createdBy: ctx.existing.createdBy } : ctx.createdBy ? { createdBy: ctx.createdBy } : {}),
  };
  const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
  if (size > EVAL_SET_MAX_BYTES) {
    throw new OpenwopError('validation_error', `Eval set too large (${size} bytes; max ${EVAL_SET_MAX_BYTES}).`, 400, {});
  }
  return row;
}

/* ── set CRUD ───────────────────────────────────────────────────────────── */

export async function putEvalSet(row: WorkflowEvalSet): Promise<void> {
  const existing = await sets.listByPrefix(setPrefix(row.tenantId, row.workflowId));
  if (!existing.some((s) => s.evalSetId === row.evalSetId) && existing.length >= EVAL_SETS_PER_WORKFLOW_MAX) {
    throw new OpenwopError('validation_error', `At most ${EVAL_SETS_PER_WORKFLOW_MAX} eval sets per workflow.`, 400, {});
  }
  await sets.put(row);
}

export async function getEvalSet(tenantId: string, workflowId: string, evalSetId: string): Promise<WorkflowEvalSet | null> {
  return sets.get(setKey(tenantId, workflowId, evalSetId));
}

export async function listEvalSets(tenantId: string, workflowId: string): Promise<WorkflowEvalSet[]> {
  return (await sets.listByPrefix(setPrefix(tenantId, workflowId)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function deleteEvalSet(tenantId: string, workflowId: string, evalSetId: string): Promise<boolean> {
  for (const r of await results.listByPrefix(`${setKey(tenantId, workflowId, evalSetId)}:`)) {
    await results.delete(r.key);
  }
  return sets.delete(setKey(tenantId, workflowId, evalSetId));
}

/* ── results ────────────────────────────────────────────────────────────── */

export function newEvalResultRow(input: {
  tenantId: string; workflowId: string; evalSetId: string; resultId: string;
  revisionHash: string; caseIds: string[]; startedBy?: string;
}): WorkflowEvalResult {
  return {
    key: resultKey(input.tenantId, input.workflowId, input.evalSetId, input.resultId),
    tenantId: input.tenantId,
    workflowId: input.workflowId,
    evalSetId: input.evalSetId,
    resultId: input.resultId,
    revisionHash: input.revisionHash,
    status: 'running',
    cases: input.caseIds.map((caseId) => ({ caseId, runId: '', status: 'running', assertions: [] })),
    startedAt: new Date().toISOString(),
    ...(input.startedBy ? { startedBy: input.startedBy } : {}),
  };
}

export async function putEvalResult(row: WorkflowEvalResult): Promise<void> {
  await results.put(row);
}

export async function getEvalResult(tenantId: string, workflowId: string, evalSetId: string, resultId: string): Promise<WorkflowEvalResult | null> {
  return results.get(resultKey(tenantId, workflowId, evalSetId, resultId));
}

export async function listEvalResults(tenantId: string, workflowId: string, evalSetId?: string): Promise<WorkflowEvalResult[]> {
  const prefix = evalSetId
    ? `${setKey(tenantId, workflowId, evalSetId)}:`
    : setPrefix(tenantId, workflowId);
  const rows = (await results.listByPrefix(prefix))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (let i = 0; i < rows.length; i++) rows[i] = await repairIfStale(rows[i]!);
  return rows;
}

/** Grade-data M6 — an instance restart mid-invocation strands the row at
 *  `running` forever (every settle path is in-process). Far past any legit
 *  invocation budget (20 cases × 2-stride × the case timeout ≪ 30 min), a
 *  read repairs the row to an HONEST `incomplete` — never silently 'complete'
 *  (unsettled cases were not evaluated) and never a permanent 'running'. */
const EVAL_RESULT_STALE_MS = 30 * 60_000;
async function repairIfStale(row: WorkflowEvalResult): Promise<WorkflowEvalResult> {
  if (row.status !== 'running') return row;
  const age = Date.now() - Date.parse(row.startedAt);
  if (!Number.isFinite(age) || age < EVAL_RESULT_STALE_MS) return row;
  const repaired: WorkflowEvalResult = { ...row, status: 'incomplete', finishedAt: new Date().toISOString() };
  try { await results.put(repaired); } catch { /* best-effort — the caller still sees the honest status */ }
  return repaired;
}

/** Review HIGH-1 — settles for ONE result row are SERIALIZED through a
 *  per-key promise chain: each case settle rewrites the whole `cases[]`
 *  array, and two concurrent read-modify-write `put`s (stride-2 dispatch,
 *  near-simultaneous timeouts) lost an update under real storage latency —
 *  stranding the row at `running` forever (and the promote gate with it).
 *  All settles for an invocation happen in the dispatching process, so an
 *  in-process chain is sufficient; the entry is dropped once the row
 *  completes (bounded map). */
const settleQueues = new Map<string, Promise<void>>();

/** Update ONE case's verdict inside a result row; flips the row to `complete`
 *  when every case has settled. A case already settled is never replaced
 *  (first-writer-wins — the timeout-vs-terminal race). */
export async function settleEvalCase(
  keyParts: { tenantId: string; workflowId: string; evalSetId: string; resultId: string },
  caseResult: EvalCaseResult,
): Promise<void> {
  const key = resultKey(keyParts.tenantId, keyParts.workflowId, keyParts.evalSetId, keyParts.resultId);
  const prev = settleQueues.get(key) ?? Promise.resolve();
  const next = prev.then(async () => {
    const row = await getEvalResult(keyParts.tenantId, keyParts.workflowId, keyParts.evalSetId, keyParts.resultId);
    if (!row) return;
    const patched: WorkflowEvalResult = {
      ...row,
      cases: row.cases.map((c) => (c.caseId === caseResult.caseId && c.status === 'running' ? caseResult : c)),
    };
    if (patched.cases.every((c) => c.status !== 'running')) {
      patched.status = 'complete';
      patched.finishedAt = new Date().toISOString();
    }
    await results.put(patched);
    if (patched.status === 'complete') settleQueues.delete(key);
  });
  // The chain must survive a failed settle (the next caller still queues).
  settleQueues.set(key, next.catch(() => {}));
  return next;
}

/** Test seam: has a case already settled? (The runner skips post-timeout
 *  evaluation — incl. live judge dispatches — for an already-settled case.) */
export async function isEvalCaseSettled(
  keyParts: { tenantId: string; workflowId: string; evalSetId: string; resultId: string },
  caseId: string,
): Promise<boolean> {
  const row = await getEvalResult(keyParts.tenantId, keyParts.workflowId, keyParts.evalSetId, keyParts.resultId);
  const c = row?.cases.find((x) => x.caseId === caseId);
  return c !== undefined && c.status !== 'running';
}

export async function pruneEvalResults(tenantId: string, workflowId: string, evalSetId: string): Promise<void> {
  const rows = await listEvalResults(tenantId, workflowId, evalSetId);
  for (const r of rows.slice(EVAL_RESULTS_KEEP)) await results.delete(r.key);
}

/* ── lifecycle ──────────────────────────────────────────────────────────── */

onWorkflowDeleted(async (workflowId, tenantIds) => {
  // Grade-data M7 — prefix-scan the owning tenants' slices when known (see
  // workflowDebugPins for the rationale); full scan only on tenant-less paths.
  const slices = async <T extends { workflowId: string; key: string }>(
    col: { list(): Promise<readonly T[]>; listByPrefix(p: string): Promise<readonly T[]> },
  ): Promise<readonly T[]> =>
    tenantIds && tenantIds.length > 0
      ? (await Promise.all(tenantIds.map((t) => col.listByPrefix(`${t}:`)))).flat()
      : col.list();
  for (const r of await slices(sets)) {
    if (r.workflowId === workflowId) await sets.delete(r.key);
  }
  for (const r of await slices(results)) {
    if (r.workflowId === workflowId) await results.delete(r.key);
  }
});

/** Deep subject-form scrub (grade-data H3): fixture `pins`/`inputs` are run
 *  outputs users PASTE into the editor, and result `assertions[].detail`
 *  embeds run-output excerpts — both can quote the erased subject even when
 *  `createdBy` is someone else. Every string containing a subject-key form
 *  has the form replaced with the sentinel. Over-erasure (a form appearing in
 *  unrelated prose) is the safe direction for a DSAR. */
function scrubDeep(v: unknown, forms: ReadonlySet<string>): { value: unknown; changed: boolean } {
  if (typeof v === 'string') {
    let out = v;
    let changed = false;
    for (const f of forms) {
      if (f && out.includes(f)) { out = out.split(f).join(ERASED); changed = true; }
    }
    return { value: out, changed };
  }
  if (Array.isArray(v)) {
    let changed = false;
    const arr = v.map((x) => { const r = scrubDeep(x, forms); changed = changed || r.changed; return r.value; });
    return { value: arr, changed };
  }
  if (v && typeof v === 'object') {
    let changed = false;
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) { const r = scrubDeep(val, forms); changed = changed || r.changed; o[k] = r.value; }
    return { value: o, changed };
  }
  return { value: v, changed: false };
}

/** ADR 0464 — attribution redacted in place (the revision-store precedent)
 *  PLUS a deep content scrub of fixture/verdict payloads (grade-data H3: suite
 *  STRUCTURE is tenant work-product, but fixture payloads and assertion
 *  details are run-output content that can quote the subject). */
export async function eraseSubjectEvalRows(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const r of await sets.listByPrefix(`${tenantId}:`)) {
    const scrubbed = scrubDeep(r.cases, forms);
    const attribution = r.createdBy !== undefined && forms.has(r.createdBy);
    if (scrubbed.changed || attribution) {
      await sets.put({
        ...r,
        cases: scrubbed.value as WorkflowEvalSet['cases'],
        ...(attribution ? { createdBy: ERASED } : {}),
      });
    }
  }
  for (const r of await results.listByPrefix(`${tenantId}:`)) {
    const scrubbed = scrubDeep(r.cases, forms);
    const attribution = r.startedBy !== undefined && forms.has(r.startedBy);
    if (scrubbed.changed || attribution) {
      await results.put({
        ...r,
        cases: scrubbed.value as WorkflowEvalResult['cases'],
        ...(attribution ? { startedBy: ERASED } : {}),
      });
    }
  }
}

export function registerEvalSetErasure(): void {
  registerSubjectEraser(eraseSubjectEvalRows);
}
