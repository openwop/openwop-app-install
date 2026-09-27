#!/usr/bin/env node
/**
 * Steward data-probes must be able to MATCH something.
 *
 * `docs/steward/DATA-ASSESSMENT*.md` records SQL probes against `host_ext_kv`,
 * each with an expectation — usually "expect 0". A `[x]` on one of those is an
 * assertion that a condition was measured. Ten of forty-two could not have been:
 * they name columns the table does not have, or a keyspace nothing writes.
 *
 * THE FAILURE MODE IS SILENT BY CONSTRUCTION. A wrong predicate returns zero
 * rows, and zero rows is exactly what most of these declare healthy. **A broken
 * probe reads as a passing probe** — including `PROBE-CP1`, which claims to
 * measure PII exposure on globally-shared definition rows.
 *
 * Fixing the prose was already tried and failed: a correction block written
 * 2026-08-03 named two offending lines, diagnosed the cause and gave the correct
 * predicate — and neither source line was ever edited. The author of that
 * correction then wrote a fresh non-executable probe in the same file. Knowing
 * the keyspace is not the failing skill; never executing the query is.
 *
 * WHAT THIS CHECKS (and what it does not):
 *   1. Columns — every identifier used must exist on `host_ext_kv` (`k`, `v`,
 *      `updated_at`). Kills the `key`/`value` class.
 *   2. Keyspace — a `hostext:<ns>:` literal must match a real
 *      `new DurableCollection('<ns>')`; a flat prefix must match a real
 *      `KEY_PREFIX`/`kvSet` literal. Derived from SOURCE, never a hand list.
 *
 * NOT checked here, stated so nobody over-trusts it — and stated ACCURATELY,
 * because an earlier version of this sentence claimed only that a probe with a
 * CORRECT prefix could still be wrong, while the matcher was in fact also
 * accepting INCORRECT ones (any proper prefix of a real name). A probe with
 * correct columns and a correct prefix can still be wrong — a value-field condition
 * written as a key predicate, or a `split_part` index off by one, are valid SQL
 * over a real keyspace. Catching those needs execution against a seeded fixture,
 * which is deliberately deferred until this layer's yield is measured. Nor does
 * it catch Postgres-only type errors (`jsonb` operators on a TEXT column), which
 * a sqlite fixture would mask anyway — that is the documented
 * sqlite-masks-Postgres-type-errors class.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STEWARD = join(ROOT, 'docs', 'steward');
const BACKEND_SRC = join(ROOT, 'backend', 'typescript', 'src');

/** Real columns of `host_ext_kv` (storage/{postgres,sqlite}/schema.ts). */
const COLUMNS = new Set(['k', 'v', 'updated_at']);
// `id` is deliberately NOT here: it appears inside `orgId`, `<id>`, `formId`
// and prose constantly, so it produced false positives on correct probes — and
// a gate that cries wolf gets ignored, which is the failure this whole ADR is
// about. The names below are specific enough to mean what they say.
const COLUMN_LOOKALIKES = new Set(['key', 'value', 'created_at', 'tenant_id']);

/** Every `hostext:` namespace the code actually registers. */
function realDurableCollections() {
  const found = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) {
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(/new DurableCollection[<(][^'"`]*['"`]([^'"`]+)['"`]/g)) {
          found.add(m[1]);
        }
      }
    }
  };
  walk(BACKEND_SRC);
  return found;
}

/** Flat (non-`hostext:`) key prefixes the code writes directly. */
function realFlatPrefixes() {
  const found = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) {
        for (const m of readFileSync(p, 'utf8').matchAll(/KEY_PREFIX\s*=\s*['"`]([^'"`]+)['"`]/g)) {
          found.add(m[1].replace(/:$/, ''));
        }
      }
    }
  };
  walk(BACKEND_SRC);
  return found;
}

function probeLines() {
  const out = [];
  for (const f of readdirSync(STEWARD)) {
    if (!f.startsWith('DATA-ASSESSMENT') || !f.endsWith('.md')) continue;
    const path = join(STEWARD, f);
    // §Correction (code review): this filtered on `/host_ext_kv/` PER LINE, so
    // of 68 lines carrying a `hostext:` keyspace claim only 28 were seen — 40
    // were structurally invisible while the gate printed a count that implied
    // full coverage. A fenced SQL block whose FROM and WHERE sit on different
    // lines escaped entirely. Widen to any line making a claim this gate can
    // check, and match case-insensitively.
    readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
      // Must look like SQL, not prose that happens to contain "key" — and must
      // not be a BLOCKQUOTE, because a correction note legitimately QUOTES a
      // wrong predicate in order to explain it. Widening the filter without
      // these two exclusions made the gate flag its own documentation, which is
      // how a gate earns being ignored.
      if (/^\s*>/.test(line)) return;
      // A checklist bullet carrying a bare `k LIKE '…'` IS a probe even with no
      // SELECT/FROM, so accept that shape too — but require an actual predicate
      // rather than prose that merely contains the word "key".
      // Any shape that constrains the key, not just `k LIKE`. `k =`, `k ~`,
      // `starts_with(k, …)` and a bare WHERE line inside a fenced block were all
      // invisible — which meant the column check the docblock claims to "kill"
      // never even saw them.
      const hasPredicate = /\bk\s*(?:like|=|~|~\*)\s*'/i.test(line)
        || /\bstarts_with\s*\(\s*k\b/i.test(line)
        || /\bfrom\s+host_ext_kv\b/i.test(line)
        || /\bwhere\b/i.test(line);
      const looksSql = /\bselect\b/i.test(line) || hasPredicate;
      if (!looksSql) return;
      out.push({ file: f, path, lineNo: i + 1, line });
    });
  }
  return out;
}

const collections = realDurableCollections();
const flatPrefixes = realFlatPrefixes();
const lines = probeLines();

const problems = [];

for (const { file, lineNo, line } of lines) {
  // 1 — column names.
  for (const bad of COLUMN_LOOKALIKES) {
    const re = new RegExp(`(?:^|[\\s(,])${bad}\\s*(?:LIKE|=|->|->>|\\)|,)`, 'i');
    if (re.test(line) && !COLUMNS.has(bad)) {
      problems.push({
        file, lineNo,
        why: `uses column \`${bad}\` — host_ext_kv has only (${[...COLUMNS].join(', ')})`,
      });
      break;
    }
  }
  // 2 — keyspace.
  // A collection NAME MAY CONTAIN COLONS — `new DurableCollection('workflow:ownership')`
  // is keyed `hostext:workflow:ownership:<tenant>:<id>`. So match the LONGEST
  // registered name that prefixes the remainder, not the first colon-delimited
  // segment; the naive version reported `workflow` and produced false positives
  // on correct probes, which is how a gate becomes untrusted.
  for (const m of line.matchAll(/'hostext:([^']*)/g)) {
    const rest = m[1];
    // `hostext:%…` is a deliberate leading wildcard ("any collection matching"),
    // not a keyspace claim — flagging it would be a false positive, and a gate
    // that cries wolf gets ignored.
    if (rest.startsWith('%')) continue;
    // Match in BOTH directions. `hostext:<ns>:…` is the exact form, but
    // `hostext:campaign-brief:%` is a legitimate FAMILY wildcard spanning
    // `campaign-brief:brief`, `campaign-brief:hook`, … — flagging it would be a
    // false positive on a correct probe, and a gate that cries wolf gets
    // ignored, which is how the unrunnable one survived.
    // §Correction (grade-code, BLOCKER): this used `ns.startsWith(literal)`,
    // which accepts ANY proper prefix — so truncating `workflow:ownership` to
    // `workflow:ownershi` stayed GREEN. A family wildcard must match on a
    // SEGMENT boundary, not on an arbitrary character count.
    const literal = rest.split('%')[0] ?? '';
    const hasTrailingWildcard = rest.includes('%');
    // §Correction (2026-08-05, FALSE POSITIVE ON A PEER'S CORRECT PROBE). The
    // segment-boundary rule above rejected `hostext:dashboard%`, which is a
    // deliberate wildcard over the `dashboardlayout` + `dashboardnote` FAMILY —
    // the probe's own text says so, and it is a `GROUP BY` discovery query. My
    // gate cried wolf on a correct probe, which is the failure mode I wrote the
    // gate's own docblock warning about.
    //
    // The safe rule, and why it does not re-open the truncation hole the
    // grade-code BLOCKER closed: with a TRAILING `%`, a truncated literal can
    // only ever match MORE rows, never fewer. `hostext:workflow:ownershi%`
    // still matches every `workflow:ownership` row. The defect this gate exists
    // to catch is a probe that silently matches TOO LITTLE and reads its zero as
    // health — a prefix that over-matches cannot do that, because you see the
    // extra rows. A literal that is a prefix of no real collection at all
    // (`dashboardx%`) is still rejected.
    const prefixOfSome = literal.length > 0
      && [...collections].some((ns) => ns.startsWith(literal));
    const familyOk = literal.length > 0
      && (literal.endsWith(':')
        ? [...collections].some((ns) => ns === literal.slice(0, -1) || ns.startsWith(literal))
        : collections.has(literal) || (hasTrailingWildcard && prefixOfSome));
    const hit = [...collections].some((ns) =>
      rest === ns || rest.startsWith(`${ns}:`) || rest.startsWith(`${ns}%`)) || familyOk;
    if (!hit) {
      const shown = rest.split(/[:%']/)[0];
      problems.push({
        file, lineNo,
        why: `\`hostext:${shown}…\` matches no registered DurableCollection — the query matches nothing`,
      });
    }
  }
  for (const m of line.matchAll(/k\s+like\s+'([a-z][a-zA-Z0-9._-]*):/gi)) {
    const pfx = m[1];
    if (pfx === 'hostext') continue;
    if (!flatPrefixes.has(pfx)) {
      problems.push({ file, lineNo, why: `flat prefix \`${pfx}:\` matches no KEY_PREFIX in source` });
    }
  }
}

// ── Rule 3: a self-declared BLOCKED row is not tickable work ─────────────────
// A `- [ ]` is a claim that someone can do this. `[BLOCKED — needs read access to
// the production database]` / `— operator action (a key this session cannot
// supply)` says the opposite: nobody with only a checkout can ever tick it. Carried
// as an open checkbox it reads as NEGLECTED work, and a list where the permanently
// un-tickable sits beside the actionable trains readers to skim past both — the
// same false-staleness signal that let five broken probes sit open while a green
// gate reported 99 clean lines.
//
// These belong in a RUNBOOK / OPERATOR ACTION section as plain bullets: still
// recorded, still findable when prod access exists, but not pretending to be work
// in flight. This rule does NOT fire on a row blocked by something a contributor
// CAN resolve (a dependency PR, a review) — only on the self-declared `[BLOCKED`
// marker, which is reserved for the un-suppliable.
// Scans EVERY steward doc, not just DATA-ASSESSMENT*: tracker hygiene is not
// specific to data probes, and blocked checkboxes were found in CODEBASE-* too.
const blockedBoxes = [];
for (const file of readdirSync(STEWARD).filter((f) => f.endsWith('.md'))) {
  const src = readFileSync(join(STEWARD, file), 'utf8').split('\n');
  src.forEach((line, i) => {
    if (/^\s*- \[ \]/.test(line) && line.includes('[BLOCKED')) {
      blockedBoxes.push({ file, lineNo: i + 1, why: 'a `[BLOCKED — …]` row is an OPEN CHECKBOX. Nobody with a checkout can tick it; move it to a RUNBOOK / OPERATOR ACTION bullet (`- 🔒 …`) so open ≠ neglected.' });
    }
  });
}
problems.push(...blockedBoxes);

// Anti-vacuity: a gate that parsed nothing must not report success. This is the
// failure mode where a sibling tripwire read 1407 files and examined zero nodes.
if (lines.length === 0 || collections.size === 0) {
  console.error(
    `✗ check-steward-probes: parsed ${lines.length} probe line(s) and ${collections.size} `
    + 'DurableCollection registration(s) — nothing was actually checked. Refusing to report success.',
  );
  process.exit(1);
}

if (problems.length === 0) {
  console.log(
    `✓ check-steward-probes: ${lines.length} probe line(s) reference real columns and real keyspaces `
    + `(${collections.size} collections, ${flatPrefixes.size} flat prefixes); no BLOCKED row is an open checkbox.`,
  );
  process.exit(0);
}

console.error(`✗ check-steward-probes: ${problems.length} probe(s) cannot match what they claim to measure.`);
for (const p of problems) console.error(`  docs/steward/${p.file}:${p.lineNo}\n    ${p.why}`);
console.error(
  '\n  A probe that cannot match returns 0 rows — which is what most of these declare\n'
  + '  "healthy". Fix the predicate, and re-run the probe before re-checking its box.',
);
process.exit(1);
