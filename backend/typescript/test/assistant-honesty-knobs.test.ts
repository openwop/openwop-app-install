/**
 * COS-2 + WF-COS-8 — two honesty defects in the same feature, both of the shape
 * "the system says nothing, and silence reads as fine".
 *
 * COS-2: `GovernancePolicy.retention.assistantGraphDays` / `sourceDerivedDays`
 * were declared, accepted and PERSISTED by the governance admin route — and read
 * by NOTHING repo-wide. An operator configured an assistant retention window,
 * got a 200, and nothing was ever purged. That is worse than a missing control,
 * because a believed control stops the operator looking for the real answer, and
 * it is exactly why "retention is the backstop" could not be used to wave off the
 * erasure gap (COS-1).
 *
 * WF-COS-8: four swallow sites, three of which lose something a human depends on
 * — the morning briefing's notification (the loop's entire product), the
 * "an action needs your approval" notification, and the governance AUDIT append
 * for an approve/reject of an outbound action.
 *
 * What breaks it (sabotage-witnessed, /grade-tests w11): re-adding a dead field to
 * the `GovernancePolicy` retention type, copying one through the PUT write block,
 * a new `src/` reader of either identifier, a bare `catch {}` in the feature, or
 * renaming any of the four named swallow events. The operator-facing warning text
 * and the GET→edit→PUT 200 are asserted BEHAVIOURALLY in `governance.test.ts`
 * ('COS-2: a LEGACY row …') — the source-text pins that used to sit here were cut
 * because the header comment of `routes/governance.ts` satisfied them on its own.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const FEATURE = join(REPO, 'backend/typescript/src/features/assistant');
/** Comments out — a comment that names an identifier must not satisfy (or fail) a source pin. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

describe('COS-2 — the dead retention knobs are refused, not silently persisted', () => {
  it('neither field survives on the GovernancePolicy type', () => {
    const src = readFileSync(join(REPO, 'backend/typescript/src/host/governanceService.ts'), 'utf8');
    const retentionBlock = /retention\?: \{([\s\S]*?)\};/.exec(src);
    expect(retentionBlock, 'the retention block must be findable, or this test is inert').toBeTruthy();
    expect(retentionBlock![1]).not.toContain('assistantGraphDays');
    expect(retentionBlock![1]).not.toContain('sourceDerivedDays');
    // …and the two that ARE enforced must still be declared, so this is not
    // satisfied by deleting retention altogether.
    expect(retentionBlock![1]).toContain('confidentialPiiDays');
    expect(retentionBlock![1]).toContain('internalDays');
  });

  it('the route STRIPS a body carrying either, warns, and names the exit', () => {
    // The PUT must DROP a dead window, never persist it. The warning + the
    // non-blocking 200 are asserted on the live route in `governance.test.ts`;
    // what that test cannot see is the STORED row — its response passes through
    // `withoutDeadRetention`, which strips the fields on the way out whether or not
    // they were written. So the write block itself is pinned here.
    //
    // CORRECTED (/grade-tests w11): this regex used to be `/const retention =…/`,
    // which matched the FIRST `const retention =` in the file — inside
    // `withoutDeadRetention` — and ran to an unrelated `: undefined;` ~110 lines
    // later. The PUT's write block was never examined, so a write path that copied
    // `assistantGraphDays` through stayed green (MEASURED: probe `hk-write` vacuous).
    // Anchored now on the block's own shape: `const retention =` followed by
    // `body.retention`.
    const src = stripComments(readFileSync(join(REPO, 'backend/typescript/src/routes/governance.ts'), 'utf8'));
    const writeBlock = /const retention =\s*\n\s*body\.retention[\s\S]*?: undefined;/.exec(src);
    expect(writeBlock, 'the PUT retention assembly must be findable').toBeTruthy();
    expect(writeBlock![0], 'positive anchor — this is the block that writes the live windows').toContain('confidentialPiiDays');
    expect(writeBlock![0]).not.toContain('assistantGraphDays');
    expect(writeBlock![0]).not.toContain('sourceDerivedDays');
  });

  it('the claim behind the removal still holds: nothing reads either identifier', () => {
    // The finding was "settable and read by nothing". If a reader ever appears,
    // removing the knob was the wrong call and this reddens rather than the
    // decision quietly becoming wrong. Scoped to `src/` — docs and the steward
    // assessments legitimately discuss them.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
      );
    const hits = walk(join(REPO, 'backend/typescript/src'))
      .filter((f) => /assistantGraphDays|sourceDerivedDays/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(REPO.length + 1));
    // Only the three places that DOCUMENT the removal may mention them: the type
    // (why the fields are gone), the route (the refusal) and the assistant
    // eraser (whose header cites the dead knob as the reason "retention is the
    // backstop" was never available as an argument for COS-1).
    expect(hits.sort()).toEqual([
      'backend/typescript/src/features/assistant/erasure.ts',
      'backend/typescript/src/host/governanceService.ts',
      'backend/typescript/src/routes/governance.ts',
    ]);
  });
});

describe('WF-COS-8 — no swallow in this feature is silent', () => {
  const files = readdirSync(FEATURE).filter((f) => f.endsWith('.ts'));

  it('the file set is non-empty (a broken walker would pass everything)', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it('no bare `catch {}` and no `.catch(() => {})` anywhere in the feature', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(FEATURE, f), 'utf8');
      if (/catch\s*\{\s*(\/\*[\s\S]*?\*\/|\/\/[^\n]*)?\s*\}/.test(src)) offenders.push(`${f} (bare catch)`);
      if (/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(src)) offenders.push(`${f} (.catch(() => {}))`);
    }
    expect(
      offenders,
      'A swallowed failure in this feature is invisible AND user-affecting — the briefing notification, '
      + 'the approval notification and the governance audit append all ride these paths. Log it.',
    ).toEqual([]);
  });

  it('the three user-affecting swallows each log a NAMED event', () => {
    // Named individually rather than counted: "some file logs something" is
    // satisfiable without touching any of the three that matter.
    // Comments stripped and the event matched as a LOG CALL's first argument: a
    // comment that merely mentions the name must not satisfy this.
    const has = (file: string, event: string) =>
      new RegExp(`log\\.(warn|error|info)\\(\\s*'${event}'`).test(stripComments(readFileSync(join(FEATURE, file), 'utf8')));
    expect(has('surface.ts', 'assistant_briefing_notification_failed'), 'the briefing IS the loop\'s product').toBe(true);
    expect(has('actionApproval.ts', 'assistant_approval_notification_failed'), 'this is how the principal learns').toBe(true);
    expect(has('routes.ts', 'assistant_action_audit_append_failed'), 'the compliance trail').toBe(true);
    expect(has('actionExecution.ts', 'action_execution_policy_skip_audit_failed')).toBe(true);
  });
});
