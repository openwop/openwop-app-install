/**
 * ADR 0120 Phase 2, rebuilt by ADR 0982 D5/D6 — the consent-gated extraction op.
 *
 * FAIL-CLOSED: nothing is extracted or written without an explicit grant. Given a grant, it asks
 * the injected extractor for facts and writes the ones that are new: not already in the person's
 * memory (typed or learned), not facts the person told it to forget, and only while the lane's
 * own budget allows. Every path returns a typed outcome; none returns success-with-empty.
 *
 * Deps are injected so the gate, the dedupe and the budget are unit-testable without the store
 * or the provider. The binding (`extractionBinding.ts`) supplies the real ones and decides WHERE
 * the op may run at all (D1).
 *
 * @see docs/adr/0982-memory-extraction-closed-world-personal-lane.md
 */
import { normalizeFactText, NOTE_CAP } from '../../host/subjectMemory.js';
import type { ExtractorResult } from './memoryExtractor.js';

/** Learned notes one person may hold (ADR 0982 D6). */
export const AUTO_EXTRACT_CAP = 50;
/** Slots under `NOTE_CAP` the lane always leaves for the person's own notes (ADR 0982 D6). */
export const HUMAN_HEADROOM = 10;

export interface ExtractionDeps {
  isGranted: () => Promise<boolean>;
  extract: () => Promise<ExtractorResult>;
  /** The scope's current notes (any source), for dedupe and the budget. */
  existing: () => Promise<ReadonlyArray<{ content: string; source: string }>>;
  /** True for a fact the person deleted after it was learned. */
  forgotten: () => Promise<(text: string) => boolean>;
  /** Persist one fact. The binding stamps `source:'auto-extract'` (⇒ untrusted) and the
   *  idempotency key. Returns `'duplicate'` when a concurrent writer already holds it. */
  write: (fact: string) => Promise<'written' | 'duplicate'>;
  /** The close deadline (ADR 0982 D4): checked before every write. */
  signal?: AbortSignal;
}

export type SkipReason = 'no-consent' | 'empty' | 'not-personal' | 'client-bound' | 'not-a-chat' | 'no-person';

export type ExtractionOutcome =
  | { status: 'skipped'; reason: SkipReason }
  | { status: 'no-facts' }
  | { status: 'rejected'; rejected: number }
  | { status: 'written'; written: number; duplicates: number; rejected: number; suppressed: number; failedWrites: number; budgetFull: boolean }
  | { status: 'nothing-new'; duplicates: number; suppressed: number; budgetFull: boolean }
  | { status: 'failed'; reason: 'provider-error' | 'invalid-output' | 'no-provider' | 'write-error' | 'lane-error' }
  | { status: 'abandoned' };

export async function runMemoryExtraction(hasUserText: boolean, deps: ExtractionDeps): Promise<ExtractionOutcome> {
  // FAIL-CLOSED consent gate — no grant ⇒ no extraction, no write.
  if (!(await deps.isGranted())) return { status: 'skipped', reason: 'no-consent' };
  if (!hasUserText) return { status: 'skipped', reason: 'empty' };

  const result = await deps.extract();
  if (result.status !== 'ok') return result;
  // MAE2CD-2 — consent is re-read after the model call (up to the close budget). A person who
  // opted out meanwhile, or whose DSAR deleted the grant, gets nothing written.
  if (!(await deps.isGranted())) return { status: 'skipped', reason: 'no-consent' };
  if (result.facts.length === 0) return result.rejected > 0 ? { status: 'rejected', rejected: result.rejected } : { status: 'no-facts' };

  const existing = await deps.existing();
  const seen = new Set(existing.map((n) => normalizeFactText(n.content)));
  let total = existing.length;
  let learned = existing.filter((n) => n.source === 'auto-extract').length;
  const isForgotten = await deps.forgotten();
  let written = 0; let duplicates = 0; let suppressed = 0; let failedWrites = 0; let budgetFull = false;
  for (const { fact } of result.facts) {
    const norm = normalizeFactText(fact);
    if (seen.has(norm)) { duplicates += 1; continue; }
    if (isForgotten(fact)) { suppressed += 1; continue; }
    // Counted inside the loop, so one batch cannot overshoot; concurrent closes can, by at most a
    // batch, which the headroom absorbs (ADR 0982 A10).
    if (learned >= AUTO_EXTRACT_CAP || total >= NOTE_CAP - HUMAN_HEADROOM) { budgetFull = true; break; }
    if (deps.signal?.aborted) return { status: 'abandoned' };
    let r: 'written' | 'duplicate';
    try {
      r = await deps.write(fact);
    } catch {
      // One fact's failure never aborts the others, and it is counted, not hidden.
      failedWrites += 1;
      continue;
    }
    seen.add(norm);
    if (r === 'duplicate') { duplicates += 1; continue; }
    written += 1; total += 1; learned += 1;
  }
  if (written === 0 && failedWrites > 0) return { status: 'failed', reason: 'write-error' };
  // Every fact was already known, forgotten or over budget: typed, and not dressed as a write.
  if (written === 0) return { status: 'nothing-new', duplicates, suppressed, budgetFull };
  return { status: 'written', written, duplicates, rejected: result.rejected, suppressed, failedWrites, budgetFull };
}
