/**
 * The DETACHED-LATCH tripwire — the #3056 class, pinned so the next instance is
 * a red test rather than a production outage.
 *
 * THE INCIDENT. `features/publishing/routes.ts` held a module-scope
 * `shellRefreshing: Promise<void> | null` as an in-flight latch and refreshed
 * the SPA shell FIRE-AND-FORGET. Cloud Run runs this service with
 * `cpu-throttling=true`, so once a response is flushed the instance gets ~no CPU
 * and a detached continuation may never resume. The promise never settled, the
 * latch was never cleared, and the guard `(expired && !shellRefreshing)` then
 * disabled EVERY later refresh for the life of that instance. `/` served a
 * pruned bundle for 16+ minutes; Cloud Logging showed ten served requests and
 * ZERO fetch failures, because the fetch had not failed — it had never settled.
 *
 * THE PROPERTY. A module-scope promise latch is safe only if a stuck attempt
 * cannot block the next one FOREVER. There are exactly two ways to earn that,
 * and this file accepts either:
 *
 *   (a) CLEAR-ON-SETTLE — `x = doIt().catch((e) => { x = null; throw e; })` or
 *       `x = doIt().finally(() => { x = null; })`. The `ensuring` family in
 *       `src/host/*` does this. It covers a REJECTED attempt, the common case.
 *
 *       CORRECTION (first cut of this file): I accepted only `.catch` and so
 *       failed `marketingLegalPages`, which uses `.finally`. They are equivalent
 *       for this property — `.finally` runs on rejection too. The real axis is
 *       SETTLES vs NEVER-SETTLES, not which combinator clears the latch, and
 *       encoding the wrong axis made the check merely strict rather than correct.
 *
 *   (b) A TIME BOUND — a `…StartedAt` timestamp (or deadline) the caller checks,
 *       so an attempt that never settles stops blocking after a while. This is
 *       what #3056 had to add, because (a) alone does NOT cover the starvation
 *       case: a promise that never settles never rejects either.
 *
 *       The bound is matched MODULE-WIDE, not as `<latchName>StartedAt`: the
 *       real pair is `shellRefreshing` / `shellRefreshStartedAt`, and a
 *       name-derived regex missed it (the second wrong cut of this file).
 *
 * WHY (a) IS ENOUGH FOR THE `ensuring` FAMILY, and why that is worth writing
 * down rather than assuming: those latches are safe because **every caller
 * awaits them**, so the work runs with in-request CPU and always settles. That
 * is an invariant of the CALLERS, not of the latch — the day one caller becomes
 * fire-and-forget, the module becomes #3056 with no code change to the latch
 * itself. That is precisely the transition this tripwire exists to make loud.
 *
 * Scope note: this asserts a STRUCTURAL property over real source, which is the
 * only thing a static check can honestly claim here. It cannot prove a caller
 * awaits, and it asserts NO behaviour itself — an earlier draft of this comment
 * claimed a behavioural case "below" that does not exist in this file, which is
 * exactly the doc-as-claim error the tripwire's own subject matter is about.
 * The behavioural halves live in `adr0384-shell-url.test.ts`: "a refresh that
 * never settles does NOT disable later refreshes" (starvation) and "a hung
 * origin costs a BOUNDED wait, not a hung request" (the deadline).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { out.push(...walk(p)); continue; }
    if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.endsWith('.test.ts') && !p.includes('__tests__')) out.push(p);
  }
  return out;
}

/** Comments stripped — a docstring that DESCRIBES the hazard must not read as one. */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

interface Latch { rel: string; name: string; clearsOnSettle: boolean; timeBound: boolean }

/**
 * Module-scope `let x: Promise<…> | null` declarations — the latch shape.
 *
 * Deliberately narrow: a latch INSIDE a function is per-call and cannot outlive
 * the instance, and a `const` cannot be re-assigned so it is not a latch at all.
 * Narrow beats clever here — a scan that flags everything gets an allowlist,
 * and an allowlist is where this kind of check goes to die.
 */
function findLatches(): Latch[] {
  const out: Latch[] = [];
  for (const file of walk(SRC)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const rel = relative(SRC, file).split(sep).join('/');
    // Module scope only: the declaration starts at column 0.
    const re = /^let\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;]*Promise<[^;]*>\s*\|\s*null/gm;
    for (const m of src.matchAll(re)) {
      const name = m[1]!;
      out.push({
        rel,
        name,
        // `.catch` and `.finally` are EQUIVALENT here — both run when the promise
        // REJECTS, which is all "clears on settle" claims. (First cut checked only
        // `catch` and wrongly failed `marketingLegalPages`, which uses `finally`.)
        clearsOnSettle: new RegExp(`\\.(catch|finally)\\([^;]{0,120}?\\b${name}\\s*=\\s*null`, 's').test(src),
        // Any deadline/started-at in the MODULE — not a name derived from the
        // latch. (First cut looked for `${'$'}{name}StartedAt` and so missed
        // `shellRefreshStartedAt` beside `shellRefreshing`.)
        timeBound: /StartedAt|Deadline|withDeadline|WEDGE_MS/.test(src),
      });
    }
  }
  return out;
}

const LATCHES = findLatches();

describe('detached promise latches cannot wedge forever (#3056)', () => {
  it('the scan actually finds latches — a broken walk would assert nothing', () => {
    // Without this, a regex or path change turns every assertion below into zero
    // cases and the tripwire passes by describing nothing. Pinned at the real
    // count; it may move in EITHER direction (a latch removed is as valid as one
    // added), so this is a liveness floor, not a no-growth ratchet.
    expect(LATCHES.length).toBeGreaterThanOrEqual(8);
    // …and it must find the two we know about by name, or the shape drifted.
    const names = LATCHES.map((l) => `${l.rel}:${l.name}`);
    expect(names).toContain('features/publishing/routes.ts:shellRefreshing');
    expect(names).toContain('host/systemSite.ts:ensuring');
  });

  it.each(LATCHES.map((l) => [`${l.rel} → ${l.name}`, l] as const))(
    '%s recovers from a FAILED attempt',
    (_label, latch) => {
      expect(
        latch.clearsOnSettle || latch.timeBound,
        `${latch.rel}'s \`${latch.name}\` is a module-scope in-flight latch with NEITHER `
        + 'a clear-on-settle `.catch`/`.finally` NOR a time bound. A failed attempt blocks '
        + 'every later one for the life of the process — this is the #3056 outage shape. '
        + 'Add `.catch((e) => { ' + latch.name + ' = null; throw e; })`, and a '
        + `\`${latch.name}StartedAt\` bound too if the work is ever fire-and-forget `
        + '(a promise that never settles never rejects, so the catch alone will not save you).',
      ).toBe(true);
    },
  );

  it('the FIRE-AND-FORGET latch carries a time bound, not just a catch', () => {
    // The distinction the incident turned on. `publishing`'s refresh is the one
    // latch that is NOT awaited by its caller on the hot path, so clear-on-
    // rejection is insufficient for it by construction.
    const shell = LATCHES.find((l) => l.rel === 'features/publishing/routes.ts' && l.name === 'shellRefreshing');
    expect(shell, 'the shell refresh latch vanished — update this tripwire').toBeDefined();
    expect(
      shell!.timeBound,
      'the SPA-shell refresh is fire-and-forget, so a clear-on-rejection catch cannot cover it: '
      + 'the 2026-08-08 outage was a promise that never SETTLED. It needs a time bound.',
    ).toBe(true);
  });

  it('the predicate is not just answering true — a never-cleared latch FAILS it', () => {
    // Positive control. Without it, a predicate that returned `true` for
    // everything would keep this file green while guarding nothing.
    const clears = (src: string, name: string): boolean =>
      new RegExp(`\\.(catch|finally)\\([^;]{0,120}?\\b${name}\\s*=\\s*null`, 's').test(src)
      || /StartedAt|Deadline|withDeadline|WEDGE_MS/.test(src);

    // Cleared NOWHERE — one failure disables the latch for the process lifetime.
    expect(clears('let pending: Promise<void> | null = null;\n'
      + 'export function go() { if (!pending) pending = work(); return pending; }', 'pending'),
    'a latch cleared nowhere must FAIL').toBe(false);

    // …and both real forms must PASS, or the check is merely strict, not correct.
    expect(clears('let p: Promise<void> | null = null;\n'
      + 'p = work().catch((e) => { p = null; throw e; });', 'p'), '.catch form').toBe(true);
    expect(clears('let p: Promise<void> | null = null;\n'
      + 'p = work().finally(() => { p = null; });', 'p'), '.finally form').toBe(true);
  });
});
