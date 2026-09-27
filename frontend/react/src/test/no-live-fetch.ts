/**
 * ADR 0661 — a live `fetch` from a jsdom unit test is a silent defect.
 *
 * The component under test quietly enters a failure branch the test never asked
 * for, and whether it gets there before or after the assertion is a race:
 * load-sensitive in the normal vitest lane, deterministic in the
 * `OPENWOP_CI_CLOCKSHIFT=1` lane. One instance (`emailRound2.test.tsx`, an
 * unmocked `getProviderStatus`) cost about a day across two sessions and was
 * attributed in turn to worker starvation, cross-session contention, missing
 * `cleanup()`, `isolate: false`, and test-file ordering — none of which it was.
 * Isolation and serial runs all came back GREEN, because a quiet machine loses
 * the race in the test's favour.
 *
 * So: throw, name the URL and the file, and say what usually causes it. 87 files
 * already do this and are allowlisted (`test-live-fetch-allowlist.txt`,
 * shrink-only) — the guard's job is that the 88th cannot land unnoticed.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect } from 'vitest';

const FE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const allowed = new Set<string>(
  readFileSync(join(FE_ROOT, 'test-live-fetch-allowlist.txt'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    // `path  # reason` — an entry may state why it does not fetch every run.
    .map((l) => (l.includes('#') ? l.slice(0, l.indexOf('#')).trim() : l)),
);

/** The path as the allowlist spells it: relative to frontend/react, POSIX. */
function currentTestFile(): string {
  const p = expect.getState().testPath;
  if (!p) return '';
  return relative(FE_ROOT, p).split('\\').join('/');
}

const realFetch = globalThis.fetch;

// Throwing is not sufficient on its own. The call sites this guard exists to
// catch are inside components that already handle a failed read — `try { await
// fetch() } catch { setFailed(true) }` is the SHAPE of every one of the 87 — so a
// synchronous throw would be swallowed by the very code path the defect creates,
// and the guard would report nothing. That is the exact species of unfireable
// check this repo keeps finding, and building a fresh one here would be absurd.
// So each violation is also RECORDED, and the record is asserted after the test
// body, where no component's catch can reach it.
let violation: string | null = null;

// INSTALLED ONCE, AT MODULE SCOPE — not re-armed per test.
//
// The first version re-armed in `beforeEach`, reasoning that a test which
// replaces `fetch` should get the guard back afterwards. That is backwards, and
// the full suite said so immediately: setup-file `beforeEach` hooks run AFTER a
// test file's module body, so re-arming DESTROYED every module-scope
// `vi.stubGlobal('fetch', …)` and sent its calls to the real network. It
// reported `meshHonesty.test.tsx` as a live-fetch violation when that file's
// whole point is that it stubs fetch — a guard manufacturing the defect it
// exists to detect, in six tests.
//
// Setup files are evaluated BEFORE the test file's module body, so installing
// here means a file's own stub cleanly wins, and a file with no stub gets the
// guard. That is also exactly what the instrumentation that produced the
// 87-file measurement did, which is the property worth preserving: the guard and
// the census must be able to see the same population.
globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    const file = currentTestFile();
    if (allowed.has(file)) {
      // ADR 0661 phase 2 — WITNESS the allowlisted call. The allowlist could not
      // detect an entry whose file has STOPPED fetching, so a stale line kept the
      // guard disarmed for a path nothing uses and overstated the remaining work.
      // I created one in the same PR that documented the gap, which is the
      // argument for closing it rather than tracking it.
      //
      // Append-only, one line per call, O_APPEND so parallel workers interleave
      // safely — the aggregation happens after the run, in
      // scripts/check-live-fetch-stale.mjs. Off unless asked: the audit path is
      // set by ci.sh around the suite it already runs, so this costs no extra run.
      const audit = process.env['OPENWOP_LIVE_FETCH_AUDIT'];
      if (audit) { try { appendFileSync(audit, `${file}\n`); } catch { /* never fail a test to record */ } }
      return (realFetch as typeof fetch)(...args);
    }
    const url = typeof args[0] === 'string' ? args[0] : String((args[0] as Request)?.url ?? args[0]);
    const message =
      `ADR 0661: live fetch from a unit test — ${url}\n` +
        `  in: ${file || '(unknown test file)'}\n` +
        `  A real network call means something the test meant to mock is NOT mocked, so the\n` +
        `  component is entering a failure branch nobody asked for. That is a RACE: it may pass\n` +
        `  on a quiet machine and fail under load, or only in the +365d date-bomb lane.\n` +
        `  TWO causes, both seen in this repo:\n` +
        `   1. a \`vi.mock('…Client.js', async (importOriginal) => ({ ...(await importOriginal()),\n` +
        `      … }))\` factory that overrides most exports and MISSES ONE — the real function then\n` +
        `      runs. Check what the component calls that your factory does not name.\n` +
        `   2. a SHARED cross-feature module the test never mentions (e.g. client/accessClient.ts,\n` +
        `      orgs/orgMembers.ts), reached through some component the page under test renders.\n` +
        `      The URL above is the fastest way to find its owner: grep for that path.\n` +
        `  If the call is genuinely intended, add this file to frontend/react/test-live-fetch-allowlist.txt.`;
    violation = violation ?? message;
    throw new Error(message);
}) as typeof fetch;

afterEach(() => {
  if (violation !== null) {
    const message = violation;
    violation = null;
    throw new Error(message);
  }
});
