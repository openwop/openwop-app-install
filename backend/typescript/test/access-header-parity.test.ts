/**
 * The "act as" header has exactly ONE spelling, and the SPA sends that one.
 *
 * THE DEFECT THIS PINS (`ACTAS-1`, 2026-08-08). The header was redeclared as a
 * literal in five route files and they DISAGREED:
 *
 *   routes/accessControl.ts          'x-openwop-act-as'          ← what the SPA sends
 *   features/cdp/routes.ts           'x-openwop-act-as-member'   ← nothing sends this
 *   features/orgs/routes.ts          'x-openwop-act-as-member'
 *   features/environments/routes.ts  'x-openwop-act-as-member'
 *   features/entities/routes.ts      'x-openwop-act-as-member'
 *
 * (Corrected w107: this table showed all five as the same spelling, which is not
 * a disagreement. The four route files said `-member`; `git log -S` on
 * bb701e003, the ACTAS-1 fix.)
 *
 * MEASURED SEVERITY, because the first write-up of this overstated it. No client
 * calls those four route families with ANY act-as header — `accessClient.ts` is
 * the only sender and it does not call them — so this was a **trap, not a live
 * leak**. What made it a trap is the fail direction: `resolveEffectiveAccess`
 * with no member context returns the tenant-owner principal with OWNER_SCOPES
 * rather than zero, so a caller who guessed the name the rest of the app uses
 * would be silently un-narrowed instead of refused.
 *
 * Five copies of one authorization-relevant string is the generator. The shared
 * constant is the cure; this keeps it the only spelling.
 *
 * Tracker TST-BG1-19. Red when (probe-witnessed, wave 58): the SPA sends a
 * different spelling; a backend file writes the header as its own literal (or the
 * stale `-member` spelling); `ACT_AS_HEADER` is renamed. Since the shared
 * comment stripper (#5422, re-probed w107) both scans have a positive control:
 * the walk reaches the owner file, and the scan run on it FINDS its declaration,
 * so a stripper that ate code (or a walk that found nothing) reds instead of
 * reading clean.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ACT_AS_HEADER } from '../src/host/accessControlService.js';
import { stripComments } from './helpers/stripComments.js';

const SRC = resolve(__dirname, '../src');
const OWNER = 'host/accessControlService.ts';

/** Every backend source file, excluding the one that DEFINES the constant. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (e.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('act-as header parity', () => {
  it('the constant is the name the SPA actually sends', () => {
    // The SPA copy is a literal in `client/accessClient.ts`; if these two ever
    // disagree the lens silently stops narrowing, which is the whole defect.
    expect(ACT_AS_HEADER).toBe('x-openwop-act-as');
  });

  it('the SPA sends exactly this header', () => {
    const spa = readFileSync(
      resolve(__dirname, '../../../frontend/react/src/client/accessClient.ts'),
      'utf8',
    );
    // Fixture guard: if the send site is ever renamed or removed, this test
    // must fail rather than silently stop checking anything.
    expect(spa, 'accessClient no longer sends an act-as header at all').toContain('act-as');
    expect(spa).toContain(`'${ACT_AS_HEADER}'`);
  });

  it('NO backend file redeclares the header as its own literal', () => {
    // The generator. A new route file that writes its own
    // `const ACT_AS_HEADER = '…'` is exactly how the five drifted apart.
    const LITERAL = /['"`]x-openwop-act-as[a-z-]*['"`]/i;
    const files = sourceFiles(SRC);
    // Positive control: the scan, run on the one file allowed to hold the
    // literal, finds it. A stripper that removed code, or a regex that no longer
    // matches the real spelling, would otherwise report every file clean.
    expect(files, 'the walk no longer reaches the owner file').toContain(join(SRC, OWNER));
    expect(LITERAL.test(stripComments(readFileSync(join(SRC, OWNER), 'utf8')))).toBe(true);
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith(OWNER)) continue;
      // STRIP COMMENTS FIRST. The first run of this gate flagged
      // `routes/accessControl.ts` and `middleware/cors.ts` for PROSE mentions in
      // docblocks — a ratchet that counts comments cries wolf, which is the
      // recorded failure mode that gets gates ignored.
      const text = stripComments(readFileSync(f, 'utf8'));
      if (LITERAL.test(text)) {
        offenders.push(f.slice(SRC.length + 1));
      }
    }
    expect(
      offenders,
      `these files hardcode the act-as header instead of importing ACT_AS_HEADER: ${offenders.join(', ')} — `
      + 'five copies is how the spellings drifted apart and left four readers listening for a name nobody sends',
    ).toEqual([]);
  });

  it('the stale `-member` spelling is gone from the backend entirely', () => {
    const stale = sourceFiles(SRC)
      .filter((f) => stripComments(readFileSync(f, 'utf8')).includes('act-as-member'));
    expect(stale.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
