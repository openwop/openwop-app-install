/**
 * The "act as" header has exactly ONE spelling, and the SPA sends that one.
 *
 * THE DEFECT THIS PINS (`ACTAS-1`, 2026-08-08). The header was redeclared as a
 * literal in five route files and they DISAGREED:
 *
 *   routes/accessControl.ts          'x-openwop-act-as'          ← what the SPA sends
 *   features/cdp/routes.ts           'x-openwop-act-as'   ← nothing sends this
 *   features/orgs/routes.ts          'x-openwop-act-as'
 *   features/environments/routes.ts  'x-openwop-act-as'
 *   features/entities/routes.ts      'x-openwop-act-as'
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
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ACT_AS_HEADER } from '../src/host/accessControlService.js';

/**
 * Strip comments WITHOUT being fooled by string literals.
 *
 * §Correction (grade-code 2026-08-09). The first version used
 * `text.replace(/\/\*[\s\S]*?\*\//g, '')`. MEASURED: given
 * `const glob = '/*'; const HDR = 'x-openwop-act-as'; /* real *\/`, that regex
 * matches from the `/*` INSIDE THE STRING to the first real `*\/` and eats the
 * header declaration with it — the scan then reports the file clean.
 *
 * A FALSE NEGATIVE is the one direction this gate must never have: it hides a
 * real hardcoded header while looking green. (Not reachable in `src` today — no
 * file currently has `/*` inside a string — but "not reachable today" is how
 * every one of these starts.)
 *
 * So: a single pass that knows whether it is inside a string, a template
 * literal, a line comment or a block comment. Longer than a regex and correct,
 * which is the right trade for a gate whose failure is silent.
 */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code';
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      out += c; i += 1; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i += 1; continue; }
    if (state === 'block') { if (c === '*' && next === '/') { state = 'code'; i += 2; } else i += 1; continue; }
    // inside a string: copy verbatim, honour escapes, end on the matching quote
    if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) state = 'code';
    out += c; i += 1;
  }
  return out;
}

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
    const offenders: string[] = [];
    for (const f of sourceFiles(SRC)) {
      if (f.endsWith(OWNER)) continue;
      // STRIP COMMENTS FIRST. The first run of this gate flagged
      // `routes/accessControl.ts` and `middleware/cors.ts` for PROSE mentions in
      // docblocks — a ratchet that counts comments cries wolf, which is the
      // recorded failure mode that gets gates ignored.
      const text = stripComments(readFileSync(f, 'utf8'));
      if (/['"`]x-openwop-act-as[a-z-]*['"`]/i.test(text)) {
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
