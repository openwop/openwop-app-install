/**
 * Manual-test run store (ADR 0183) — durable, PER-USER progress for the `/test` manual-test
 * runner. A "run" is one tester's pass/fail/blocked/skip results + notes for a single suite.
 *
 * Authorization is STRUCTURAL (the ADR 0071 `uiStateStore` precedent): a row is keyed by the
 * authenticated caller's `${tenantId}:${subjectRef}:${suiteKey}`, so a caller can only ever
 * read/write their OWN runs — there is no cross-subject or cross-tenant read. Backed by the
 * host-ext `DurableCollection` with a tenant index for bounded per-tenant scans. NON-NORMATIVE
 * (`/v1/host/openwop-app/*`) — no OpenWOP wire.
 *
 * @see docs/adr/0183-manual-test-runner-feature-parity.md
 * @see backend/typescript/src/host/uiStateStore.ts (the per-user pattern)
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';

export const TEST_STATUSES = ['untested', 'pass', 'fail', 'blocked', 'skip'] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export interface CaseResult { status: TestStatus; note: string; ts: string }
export interface ManualTestRun {
  runId: string;            // `${tenantId}:${subjectRef}:${suiteKey}`
  tenantId: string;
  subjectRef: string;       // `user:<id>`
  suiteKey: string;
  results: Record<string, CaseResult>;  // keyed by case id
  updatedAt: string;
}

// Bounds — this is authoring/QA state, never product data. Keep it small + abuse-resistant.
const MAX_SUITE_KEY_LEN = 80;
const MAX_CASE_ID_LEN = 80;
const MAX_CASES = 500;      // far above the largest suite
const MAX_NOTE_LEN = 4000;

const runs = new DurableCollection<ManualTestRun>('manual-tests:run', (r) => r.runId, undefined, (r) => r.tenantId);

const nowIso = (): string => new Date().toISOString();
const runId = (tenantId: string, subjectRef: string, suiteKey: string): string => `${tenantId}:${subjectRef}:${suiteKey}`;
const cleanKey = (raw: unknown, max: number): string => (typeof raw === 'string' ? raw.trim().slice(0, max) : '');

/**
 * All of the caller's runs (their own rows only — filtered by subjectRef within the tenant).
 * PERF (accepted, ADR 0183 review): `listForTenantIndexed` is a BOUNDED per-tenant scan (≈ 1
 * row per user×suite) that we then filter to the caller. On a many-tester shared tenant it
 * grows with users×suites, but it's only hit on the `/test` list-page load (admin, infrequent),
 * so the tenant index is the right primitive here — no per-subject index warranted yet.
 */
export async function listRuns(tenantId: string, subjectRef: string): Promise<ManualTestRun[]> {
  return (await runs.listForTenantIndexed(tenantId)).filter((r) => r.subjectRef === subjectRef);
}

/** One suite's run for the caller, or null. */
export async function getRun(tenantId: string, subjectRef: string, suiteKey: string): Promise<ManualTestRun | null> {
  const key = cleanKey(suiteKey, MAX_SUITE_KEY_LEN);
  if (!key) return null;
  const r = await runs.get(runId(tenantId, subjectRef, key));
  // Defence-in-depth: the id already scopes to the caller, but never return another subject's row.
  return r && r.tenantId === tenantId && r.subjectRef === subjectRef ? r : null;
}

/** Normalize + persist the caller's results for a suite (full replace of that suite's map). */
export async function saveRun(tenantId: string, subjectRef: string, suiteKey: string, rawResults: unknown): Promise<ManualTestRun> {
  const key = cleanKey(suiteKey, MAX_SUITE_KEY_LEN);
  if (!key) throw new OpenwopError('validation_error', 'A non-empty `suiteKey` is required.', 400, { field: 'suiteKey' });
  const src = (rawResults && typeof rawResults === 'object') ? rawResults as Record<string, unknown> : {};
  const results: Record<string, CaseResult> = {};
  for (const [rawId, rawVal] of Object.entries(src).slice(0, MAX_CASES)) {
    const caseId = cleanKey(rawId, MAX_CASE_ID_LEN);
    if (!caseId) continue;
    const v = (rawVal && typeof rawVal === 'object') ? rawVal as Record<string, unknown> : {};
    const status: TestStatus = (TEST_STATUSES as readonly string[]).includes(v.status as string) ? v.status as TestStatus : 'untested';
    // Drop untested rows — an untested case is the absence of a result (keeps the row lean).
    if (status === 'untested' && !(typeof v.note === 'string' && v.note.trim())) continue;
    results[caseId] = {
      status,
      note: typeof v.note === 'string' ? v.note.slice(0, MAX_NOTE_LEN) : '',
      ts: typeof v.ts === 'string' ? v.ts.slice(0, 40) : nowIso(),
    };
  }
  const run: ManualTestRun = { runId: runId(tenantId, subjectRef, key), tenantId, subjectRef, suiteKey: key, results, updatedAt: nowIso() };
  await runs.put(run);
  return run;
}

