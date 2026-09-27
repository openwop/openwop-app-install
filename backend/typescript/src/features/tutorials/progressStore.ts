/**
 * Tutorial progress store (ADR 0488 D4) — the ONE owner of the
 * `tutorial-progress` collection.
 *
 * WHY A SERVER STORE AT ALL: progress lived in `localStorage`
 * (`openwop-app.tutorials.<id>`), which cannot survive a device change, cannot
 * feed the Tutor agent (P6), and cannot answer "did this workspace actually
 * learn this?" honestly. The row is the durable answer.
 *
 * KEY DISCIPLINE, inherited verbatim from `walkthroughs/progressStore.ts`:
 * keys are `tenantId:userId:tutorialId`, the `userId` is the caller's durable
 * subject stamped SERVER-side (never client-supplied), and keys are
 * **CONSTRUCTED ONLY, NEVER PARSED** — a subject contains ':' (`user:<hash>`),
 * so any future parser must split on FIELDS, not on the key.
 *
 * DELIBERATE DIVERGENCE from the walkthrough store: there is **no tenant-level
 * row**. That store carries a legacy `tenantId:walkthroughId` key whose original
 * form caused a real cross-member resume-hijack (ADR 0378 P3) — ANY member's
 * in-flight row hijacked every other member's launch. A new store has no legacy
 * to honour, so an anonymous caller simply gets **no server row** and the client
 * keeps its `localStorage` behaviour. Shared-by-default is how that bug happened;
 * this store cannot reproduce it.
 *
 * PRIVACY (ADR 0464 / DATA-T2): these rows ARE subject-bearing. The coverage
 * ratchet `test/subject-erasure-coverage.test.ts` enumerates only `src/host/**`,
 * so a feature-owned collection is **NOT build-caught** — this module therefore
 * self-polices: it registers its own eraser below and `tutorials-progress.test.ts`
 * asserts the registration exists and actually deletes.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';

export interface TutorialProgressRecord {
  key: string;
  tenantId: string;
  /** The caller's durable subject — server-stamped. Always present: an
   *  anonymous caller gets no row at all (see the module docblock). */
  userId: string;
  tutorialId: string;
  /** Step ids the learner has completed, e.g. ["1.1","2.1"]. Bounded below. */
  completedStepIds: string[];
  updatedAt: string;
}

/** A tutorial cannot plausibly exceed this many steps (ADR 0488 D5 caps a PHASE
 *  at 5; the largest shipped tutorial has 20 steps across 10 phases). The cap
 *  stops a malicious or buggy client turning one row into unbounded storage. */
const MAX_STEPS = 200;
/** Step ids are badge ids like "3.1" — bounded so a row cannot carry payloads. */
const MAX_STEP_ID_LEN = 40;

const progress = new DurableCollection<TutorialProgressRecord>(
  'tutorial-progress',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

/** Deterministic key ⇒ the upsert is idempotent and a retry cannot duplicate. */
const keyOf = (tenantId: string, userId: string, tutorialId: string): string =>
  `${tenantId}:${userId}:${tutorialId}`;

/** Normalize client-supplied step ids: de-duplicated, bounded in both count and
 *  length, non-empty strings only. The client is not trusted to bound itself. */
export function normalizeStepIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (!s || s.length > MAX_STEP_ID_LEN || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_STEPS) break;
  }
  return out;
}

/**
 * The prefix every row for one subject-in-one-tenant shares. CONSTRUCTED, never
 * parsed (see the key discipline above). Prefix matching is exact here because
 * the trailing ':' cannot be crossed: subject `user:abc` yields `…:user:abc:`,
 * which is not a prefix of `…:user:abcd:<tut>`.
 */
const prefixOf = (tenantId: string, userId: string): string => `${tenantId}:${userId}:`;

/**
 * This caller's own rows. Never another member's — there is no shared row.
 *
 * §Correction (grade-code `TUT-12`): this used a bare `list()`, which is a FULL
 * CROSS-TENANT scan of every tenant's rows, on a path `TutorialHint` triggers on
 * every app load. That is the same shape as the resolved `host_ext_kv`
 * prefix-scan incident. The key is already tenant+subject prefixed, so the
 * bounded scan is a drop-in and reads strictly fewer rows.
 */
export async function listTutorialProgress(tenantId: string, userId: string): Promise<TutorialProgressRecord[]> {
  // The prefix pins tenant AND subject, so the residual filter is a belt-and-braces
  // check on the FIELDS rather than trust in the key shape.
  return (await progress.listByPrefix(prefixOf(tenantId, userId)))
    .filter((r) => r.tenantId === tenantId && r.userId === userId);
}

/**
 * Upsert one tutorial's completed steps for one user.
 *
 * §Correction (grade-data `TUT-7`) — LOST UPDATE ACROSS DEVICES. This was a
 * blind whole-row replace of a client-supplied list, so two devices both
 * hydrated at `{1.1}` — A completes 2.1, B completes 3.1 — ended with one
 * step silently gone. The module's "deterministic key ⇒ idempotent" note
 * addressed duplicate ROWS, not lost UPDATES, and the suite only covered the
 * former.
 *
 * A plain union-merge is NOT the fix: the checkbox is bidirectional, so
 * unioning would make un-checking a step impossible. The rule instead is:
 *
 *  - `mode: 'replace'` (the default, and what a normal toggle sends) writes
 *    exactly the supplied list under a COMPARE-AND-SWAP on the row the client
 *    last saw. No contention ⇒ un-checking works exactly as before.
 *  - When the CAS fails, another writer moved the row since the client read it.
 *    Rather than clobber them, the two sets are UNIONED — completion is
 *    monotonic in every real conflict (two devices ticking different steps), so
 *    a union loses nothing. The caller is told (`merged: true`) and gets the
 *    authoritative list back so its optimistic state can re-sync instead of
 *    drifting.
 *  - `mode: 'clear'` is the explicit reset path. It must NOT union — that is the
 *    one operation whose whole purpose is removal — so it writes the empty list
 *    unconditionally.
 *
 * Returns what is now stored, so the route never has to guess.
 */
export async function putTutorialProgress(input: {
  tenantId: string; userId: string; tutorialId: string; completedStepIds: string[];
  mode?: 'replace' | 'clear';
}): Promise<{ completedStepIds: string[]; merged: boolean }> {
  const key = keyOf(input.tenantId, input.userId, input.tutorialId);
  const wanted = normalizeStepIds(input.completedStepIds);
  const base = {
    key,
    tenantId: input.tenantId,
    userId: input.userId,
    tutorialId: input.tutorialId,
  };

  if (input.mode === 'clear') {
    await progress.put({ ...base, completedStepIds: [], updatedAt: new Date().toISOString() });
    return { completedStepIds: [], merged: false };
  }

  // Bounded CAS retry. `desired` accumulates FORWARD across attempts: the first
  // attempt writes exactly what the caller asked (so un-checking works), and
  // every subsequent attempt folds in whatever the winning writer had. An
  // earlier draft recomputed the union but then re-attempted with the ORIGINAL
  // list, so under 5-way contention four completions were still lost — caught by
  // the interleaved test rather than by reasoning, which is why that test issues
  // its writes together instead of in sequence.
  let expected = await progress.get(key);
  let desired = wanted;
  let merged = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const next = { ...base, completedStepIds: desired, updatedAt: new Date().toISOString() };
    if (await progress.compareAndSwap(expected, next)) {
      return { completedStepIds: desired, merged };
    }
    // Lost the race. Re-read the winner and fold their steps in — completion is
    // monotonic in every real conflict, so a union drops nothing.
    expected = await progress.get(key);
    desired = normalizeStepIds([...(expected?.completedStepIds ?? []), ...desired]);
    merged = true;
  }
  // Sustained contention: write the accumulated union so a completion is never
  // DROPPED, and report the merge. Returning the caller's own list here would be
  // the failed-write-reported-as-success shape.
  await progress.put({ ...base, completedStepIds: desired, updatedAt: new Date().toISOString() });
  return { completedStepIds: desired, merged: true };
}

/**
 * ADR 0464 — erase every row this subject owns in this tenant.
 *
 * DELETE rather than anonymize: a progress row is behavioural data with no
 * retention duty and no value once the subject is gone, so keeping an
 * anonymized husk would be retention without a reason.
 *
 * Filters on the `userId` FIELD, never by parsing the key — see the key
 * discipline in the module docblock.
 */
export async function eraseTutorialProgressForSubject(tenantId: string, subjectKey: string): Promise<void> {
  const rows = (await progress.listByPrefix(prefixOf(tenantId, subjectKey)))
    .filter((r) => r.tenantId === tenantId && r.userId === subjectKey);
  for (const row of rows) await progress.delete(row.key);
}

registerSubjectEraser(eraseTutorialProgressForSubject);

/** Test-only. */
export async function __clearTutorialProgressForTests(): Promise<void> {
  for (const r of await progress.list()) await progress.delete(r.key);
}
