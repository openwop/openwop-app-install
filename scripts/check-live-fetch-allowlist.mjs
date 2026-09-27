#!/usr/bin/env node
/**
 * ADR 0661 — the live-fetch allowlist is SHRINK-ONLY and must not rot.
 *
 * What this can check: every entry names a file that exists, entries are unique
 * and sorted, and the count has not grown past the recorded ceiling.
 *
 * What it CANNOT check, stated here rather than left for a reader to assume: a
 * listed file that has STOPPED making live calls. That needs per-file runtime
 * attribution aggregated across vitest workers, and it is ADR 0661 phase 2 —
 * deliberately deferred until the list is short enough for the mechanism to pay
 * for itself. Until then a stale entry is permitted and is a known lie about the
 * tree; it is the same species #3644 closed for the v2 conformance ratchet.
 *
 * The ceiling is the ratchet. It only ever moves DOWN, and it moves by editing
 * this file in the same PR that removes the entries — which is the review moment
 * the whole design is for.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FE = join(ROOT, 'frontend', 'react');
const LIST = join(FE, 'test-live-fetch-allowlist.txt');

/** Only ever edit this DOWNWARD, EXCEPT when the guard discovers a file the census
 * could not see — the 87 came from one run and some calls are racy, so 87 was a
 * lower bound. 88 was the first such discovery (failedReadDecisions.test.tsx);
 * 85 after ADR 0661 phase 3 retired brandRound2, strategyR3, strategyR4. */
const CEILING = 58;

const fail = (msg) => {
  console.error(`✗ check-live-fetch-allowlist: ${msg}`);
  process.exit(1);
};

if (!existsSync(LIST)) fail(`${LIST} is missing — the guard reads it at test time and would let every live fetch through.`);

const raw = readFileSync(LIST, 'utf8').split('\n');
// `path  # reason` — the inline reason is stripped here; check-live-fetch-stale.mjs
// is what reads it.
const entries = raw.map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#'))
  .map((l) => l.split('#')[0].trim());

// A floor as well as a ceiling. An empty or truncated list makes the guard
// STRICTER, so it cannot fail the suite — but it also means this check is
// inspecting nothing, and "0 entries, all valid" must never read as success.
if (entries.length === 0) {
  console.log('✓ check-live-fetch-allowlist: empty — every unit test is free of live fetches. Delete the guard\'s allowlist branch and this check.');
  process.exit(0);
}

const missing = entries.filter((e) => !existsSync(join(FE, e)));
if (missing.length > 0) {
  fail(
    `${missing.length} entr(y/ies) name a file that does not exist:\n` +
      missing.map((m) => `  ${m}`).join('\n') +
      `\n  A renamed or deleted test leaves the guard permanently disarmed for a path nothing\n` +
      `  occupies, and the count then overstates the remaining work. Remove the line.`,
  );
}

const dupes = entries.filter((e, i) => entries.indexOf(e) !== i);
if (dupes.length > 0) fail(`duplicate entr(y/ies): ${[...new Set(dupes)].join(', ')}`);

const sorted = [...entries].sort();
const firstUnsorted = entries.findIndex((e, i) => e !== sorted[i]);
if (firstUnsorted !== -1) {
  fail(`entries are not sorted (first out of order: "${entries[firstUnsorted]}") — an unsorted list hides duplicates and makes the diff unreadable.`);
}

if (entries.length > CEILING) {
  fail(
    `${entries.length} entries, ceiling ${CEILING} — the list GREW.\n` +
      `  Each new entry is a unit test making a real network call, which is a race that passes\n` +
      `  on a quiet machine and fails under load. Mock what the component calls instead. If the\n` +
      `  call is genuinely intended, lower nothing and say so in review — then raise the ceiling\n` +
      `  deliberately, in this file, with a reason.`,
  );
}

const slack = CEILING - entries.length;
console.log(
  `✓ check-live-fetch-allowlist: ${entries.length} file(s) allowed to fetch live, all present, sorted, unique ` +
    `(ceiling ${CEILING}${slack > 0 ? ` — ${slack} retired; LOWER THE CEILING in this file` : ''}). ` +
    `Cannot detect a listed file that has stopped fetching — ADR 0661 phase 2.`,
);
