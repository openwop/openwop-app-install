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
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const FEATURE = join(REPO, 'backend/typescript/src/features/assistant');

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
    // A gate with no exit is a defect: an operator told "no" needs to know what
    // to set instead. This was FIRST written as a hard 400 — and a hard 400 is
    // itself a dead end here, because the route's own GET hands back the
    // persisted row verbatim, so GET → edit → PUT on any tenant that ever set
    // one of these blocked EVERY other governance change until the field was
    // hand-stripped. So: drop the value, report it, name the exit.
    const src = readFileSync(join(REPO, 'backend/typescript/src/routes/governance.ts'), 'utf8');
    expect(src).toContain("const DEAD_RETENTION_FIELDS = ['assistantGraphDays', 'sourceDerivedDays'] as const");
    expect(src).toMatch(/is not enforced by any sweep and is ignored/);
    expect(src, 'the warning must name the windows that ARE enforced').toMatch(/confidentialPiiDays.*internalDays/s);
    // A 400 must NOT come back — that is the regression this replaces.
    expect(src, 'a dead-window value must not 400 the whole policy edit').not.toMatch(/no longer accepted/);
    // …and the write path must no longer copy them through.
    const writeBlock = /const retention =[\s\S]*?: undefined;/.exec(src);
    expect(writeBlock, 'the retention assembly must be findable').toBeTruthy();
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
    const has = (file: string, event: string) => readFileSync(join(FEATURE, file), 'utf8').includes(event);
    expect(has('surface.ts', 'assistant_briefing_notification_failed'), 'the briefing IS the loop\'s product').toBe(true);
    expect(has('actionApproval.ts', 'assistant_approval_notification_failed'), 'this is how the principal learns').toBe(true);
    expect(has('routes.ts', 'assistant_action_audit_append_failed'), 'the compliance trail').toBe(true);
    expect(has('actionExecution.ts', 'action_execution_policy_skip_audit_failed')).toBe(true);
  });
});
