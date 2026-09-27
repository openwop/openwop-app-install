#!/usr/bin/env node
/**
 * ADR 0524 Phase B — how many workflow heads are still missing the `inputs`
 * their author declared?
 *
 * ADR 0524 shipped a server-side merge that restores dropped `inputs` ON WRITE,
 * and says the guard must be "retired on a measured zero, never a date". The
 * measurement was owed. This is it.
 *
 * ── WHY THE OBVIOUS POPULATION IS THE WRONG ONE ────────────────────────────
 * ADR 0523 measured "114 of 169 chains / 187 nodes". That is the PACK CORPUS —
 * what ships in the repo. The population that matters is TENANT-OWNED
 * REGISTERED HEADS: what tenants actually have persisted. Different set,
 * different size, and nobody had counted it. Counting the packs again and
 * calling it the blast radius would be the same category error as measuring the
 * artifact instead of the thing (recorded twice in this repo already).
 *
 * ── WHY THIS READS REVISIONS, NOT PACKS ────────────────────────────────────
 * "Stripped" is only decidable against what the head SHOULD carry. Two possible
 * ground truths:
 *
 *   (a) re-expand `metadata.expandedFrom` from the source chain pack, and diff.
 *       Correct, but it needs the pack corpus loaded — which means booting the
 *       backend outside vitest, which re-points every `~/.openwop-packs`
 *       symlink at this checkout (CLAUDE.md § "the pack hazard that IS real").
 *       A measurement tool that mutates a shared developer environment is not a
 *       measurement tool.
 *
 *   (b) the workflow's OWN revision history. `workflow:revision` rows carry the
 *       FULL definition as registered (`workflowRevisions.ts:46-48`) plus the
 *       `tenantId`. If an earlier revision of this workflow carried inputs and
 *       the head carries none, the head lost them. No packs, no boot, pure SQL.
 *
 * (b) is used. It is also strictly closer to the guard's own semantics: the
 * guard compares next-vs-previous, and so does this.
 *
 * ── THE BUCKET THIS TOOL EXISTS TO PROTECT ─────────────────────────────────
 * A head with no inputs and no revision that ever had inputs is **UNKNOWABLE**,
 * not clean. It may be a workflow that legitimately declares none. Folding
 * those into "intact" produces a reassuring number that means nothing — the
 * "absence is a claim" failure this whole program is about. So this reports
 * FOUR numbers and refuses to print a headline percentage that hides the third.
 *
 * Usage:
 *   node scripts/measure-stripped-workflow-inputs.mjs --dsn postgres://...
 *   node scripts/measure-stripped-workflow-inputs.mjs --fixture rows.json
 *   ... --json          machine-readable output
 *
 * READ-ONLY. Issues SELECTs only; never writes, and takes no lock.
 */
import { isEntryModule } from './lib/entry-module.mjs';

/**
 * A node "carries inputs" iff `inputs` is truthy with at least one own key.
 *
 * This is `preserveDroppedFields.ts:53` **character for character**:
 *   `(def.nodes ?? []).filter((n) => n.inputs && Object.keys(n.inputs).length > 0)`
 * and it is deliberately not "improved".
 *
 * §Correction (code review). The first version added a
 * `typeof n.inputs === 'object'` test, which reads like a tightening and is
 * strictly more correct in isolation — but it made the two predicates DISAGREE
 * on a truthy non-object: for `inputs: "abc"` the guard counts 1 (because
 * `Object.keys('abc')` is `['0','1','2']`) while the tightened version counted
 * 0. The failure direction is the bad one: a revision the guard would treat as
 * input-carrying scored 0 here, so its head fell out of `stripped` and into
 * `unknowable` — an UNDERCOUNT, which reads as good news.
 *
 * The tool's job is to measure the population the guard ACTS ON, not the
 * population a better guard would act on. If the string behaviour is wrong it
 * is wrong in `preserveDroppedFields`, and changing it there is a behaviour
 * change with its own tests — not something a measurement script gets to decide
 * unilaterally.
 *
 * `def`/`n` are still guarded because this scans raw database rows, where a
 * malformed definition must degrade to 0 rather than kill a 10,000-row scan.
 */
export function nodesCarryingInputs(def) {
  if (!def || !Array.isArray(def.nodes)) return 0;
  return def.nodes.filter((n) => n && n.inputs && Object.keys(n.inputs).length > 0).length;
}

/**
 * Classify every head against its own revision history.
 *
 * @param heads    [{ workflowId, definition }]           — the `wfreg:` rows
 * @param revisions[{ workflowId, tenantId, definition }] — `workflow:revision` rows
 * @param ownership[{ workflowId, tenantId }]             — `workflow:ownership` rows
 */
export function classifyPopulation(heads, revisions, ownership = []) {
  // workflowId -> max inputs-carrying-node count ever seen in its history
  const bestEverByWorkflow = new Map();
  // workflowId -> Set(tenantId) seen on revisions
  const revisionTenants = new Map();
  for (const r of revisions) {
    const n = nodesCarryingInputs(r.definition);
    bestEverByWorkflow.set(r.workflowId, Math.max(bestEverByWorkflow.get(r.workflowId) ?? 0, n));
    if (r.tenantId) {
      const set = revisionTenants.get(r.workflowId) ?? new Set();
      set.add(r.tenantId);
      revisionTenants.set(r.workflowId, set);
    }
  }

  // workflowId -> Set(tenantId) from the ownership index. A workflow can be
  // owned by MORE THAN ONE tenant — `purgeTenantOwnedWorkflowDefs` handles that
  // edge explicitly — so this is a set union, and "affected tenants" is NOT a
  // multiple of "affected workflows".
  const ownerTenants = new Map();
  for (const o of ownership) {
    const set = ownerTenants.get(o.workflowId) ?? new Set();
    set.add(o.tenantId);
    ownerTenants.set(o.workflowId, set);
  }

  const buckets = { stripped: [], intact: [], unknowable: [] };
  const strippedTenants = new Set();
  let unowned = 0;

  for (const h of heads) {
    const now = nodesCarryingInputs(h.definition);
    const everHad = bestEverByWorkflow.get(h.workflowId) ?? 0;
    const tenants = new Set([
      ...(ownerTenants.get(h.workflowId) ?? []),
      ...(revisionTenants.get(h.workflowId) ?? []),
    ]);
    // 'host' is the sentinel for globally-shared seeded definitions
    // (`HOST_REVISION_TENANT`), not a real tenant — never counted as one.
    tenants.delete('host');
    if (tenants.size === 0) unowned += 1;

    const entry = { workflowId: h.workflowId, now, everHad, tenants: [...tenants] };
    if (now > 0) {
      buckets.intact.push(entry);
    } else if (everHad > 0) {
      buckets.stripped.push(entry);
      for (const t of tenants) strippedTenants.add(t);
    } else {
      // No inputs now, and no revision ever had any. NOT provably clean.
      buckets.unknowable.push(entry);
    }
  }

  // DD-0524-1: rollback is exempt from the guard and is one-way — restoring a
  // bug-window revision re-strips the head, and a FIXED bundle then cannot
  // re-arm the guard (`beforeCount === 0`). So a head that is clean today can be
  // re-broken tomorrow by one click. Counting only current heads understates the
  // hazard; these are the poisoned restore targets.
  const poisonedRollbackTargets = revisions.filter(
    (r) => nodesCarryingInputs(r.definition) === 0 && (bestEverByWorkflow.get(r.workflowId) ?? 0) > 0,
  ).length;

  return {
    counts: {
      heads: heads.length,
      stripped: buckets.stripped.length,
      intact: buckets.intact.length,
      unknowable: buckets.unknowable.length,
      strippedTenants: strippedTenants.size,
      unownedHeads: unowned,
      poisonedRollbackTargets,
      revisionsScanned: revisions.length,
    },
    buckets,
  };
}

/** Wrap on WORD boundaries so a long identifier never splits across lines. */
function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

/**
 * Render the report. Deliberately refuses a single headline percentage.
 *
 * §Correction (code review) — THE ANTI-VACUITY GUARD. The first version, run
 * against an empty result set, printed `stripped 0 … Every head was
 * classifiable against its own history.` So a DSN pointing at the wrong
 * database, a prefix that matches nothing, or a fresh empty schema ALL produced
 * a clean bill of health. That is precisely the "a broken check reads as a
 * passing check" family this entire program (ADR 0523/0524/0525) exists to
 * close — reproduced inside the tool built to close it, which is how these
 * survive. Zero heads is now a REFUSAL, not a result.
 */
export function formatReport(result) {
  const c = result.counts;
  const lines = [];
  if (c.heads === 0) {
    return [
      'REFUSING TO REPORT: the head query matched ZERO rows.',
      '',
      'This is not evidence of a clean database. `wfreg:%` matches nothing when the',
      'DSN points at the wrong database, the schema is empty, or the key prefix has',
      'drifted from `workflowsRegistry.ts` (KEY_PREFIX). A zero here would read as',
      '"no workflow was ever stripped", which is the exact failure mode this tool',
      'exists to measure.',
      '',
      'Confirm the connection first:',
      "  SELECT count(*) FROM host_ext_kv;                        -- table reachable at all?",
      "  SELECT count(*) FROM host_ext_kv WHERE k LIKE 'wfreg:%'; -- any heads?",
    ].join('\n');
  }
  lines.push(`Scanned ${c.heads} registered head(s) against ${c.revisionsScanned} revision(s).`);
  lines.push('');
  lines.push(`  stripped   ${String(c.stripped).padStart(6)}  head has no inputs; an earlier revision did`);
  lines.push(`  intact     ${String(c.intact).padStart(6)}  head carries inputs`);
  lines.push(`  unknowable ${String(c.unknowable).padStart(6)}  no inputs now, none ever recorded — NOT provably clean`);
  lines.push('');
  lines.push(`  distinct tenants with >=1 stripped head : ${c.strippedTenants}`);
  lines.push(`  heads owned by no tenant                : ${c.unownedHeads}`);
  lines.push(`    (shared fixtures and seeded definitions — no one tenant to notify)`);
  lines.push(`  stripped revisions still restorable     : ${c.poisonedRollbackTargets}`);
  lines.push(`    (rollback is exempt from the guard, so restoring one of these`);
  lines.push(`     re-breaks a repaired head — tracked as DD-0524-1)`);
  lines.push('');
  if (c.unknowable > 0) {
    // Hard-wrapped rather than emitted as one long string: at 80 columns the
    // single-string version split OPENWOP_WORKFLOW_REVISIONS_KEEP across a line
    // break, which makes the one env var a reader might need to act on
    // un-greppable and un-copyable.
    lines.push(
      ...wrap(
        `NOTE: ${c.unknowable} head(s) are UNKNOWABLE, not clean — they carry no inputs `
        + 'and no surviving revision of them ever did, so they may simply declare none. '
        + 'Revision history is capped (see OPENWOP_WORKFLOW_REVISIONS_KEEP, default 50), '
        + 'so a workflow stripped long enough ago that every surviving revision is also '
        + `stripped lands here too. Report "${c.stripped} stripped" as a FLOOR, never as `
        + 'the whole population.',
        78,
      ),
    );
  } else {
    lines.push('Every head was classifiable against its own history.');
  }
  return lines.join('\n');
}

/* ───────────────────────── IO shell (not unit-tested) ───────────────────── */

const KV = 'host_ext_kv';
// `v` is TEXT, not jsonb (`storage/postgres/schema.ts:502`), so every JSON read
// must cast explicitly. A jsonb operator applied straight to `v` is the
// Postgres-only error class a sqlite fixture would mask — the reason this
// parses JSON in Node instead of in SQL.
const Q_HEADS = `SELECT k, v FROM ${KV} WHERE k LIKE 'wfreg:%'`;
const Q_REVISIONS = `SELECT k, v FROM ${KV} WHERE k LIKE 'hostext:workflow:revision:%'`;
const Q_OWNERSHIP = `SELECT k, v FROM ${KV} WHERE k LIKE 'hostext:workflow:ownership:%'`;

/**
 * Load `pg` from whichever workspace has it.
 *
 * No user input reaches an import specifier here — the two candidates are
 * literals and the third resolves the bare name `'pg'` — so there is no
 * injection surface. `process.cwd()` only chooses a resolution ROOT; it can
 * never name the module.
 *
 * §Correction (code review). The first version caught every failure and always
 * reported "could not load pg — run npm ci". That MISDIAGNOSES the case that
 * actually matters: `pg` installed but throwing on import (a broken native
 * binding, a corrupt install). The operator would reinstall, see the same
 * message, and never learn the real cause. The first error is now kept and
 * surfaced.
 */
export async function loadPg() {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  // Resolve the PACKAGE, not a file inside it — `pg/lib/index.js` is a private
  // path that a major version is free to move.
  const backendRoot = new URL('../backend/typescript/', import.meta.url);
  const attempts = [
    () => import('pg'),
    () => Promise.resolve(createRequire(backendRoot)('pg')),
    () => Promise.resolve(createRequire(pathToFileURL(`${process.cwd()}/`))('pg')),
  ];
  let first;
  for (const attempt of attempts) {
    try {
      const m = await attempt();
      return m.default ?? m;
    } catch (err) {
      first ??= err;
    }
  }
  const code = first && typeof first === 'object' && 'code' in first ? first.code : undefined;
  const detail = first instanceof Error ? first.message : String(first);
  throw new Error(
    code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
      ? 'measure-stripped-workflow-inputs: `pg` is not installed. It belongs to the backend '
        + 'workspace, not the repo root — run `npm ci` in backend/typescript, or use '
        + `--fixture instead of --dsn. (${detail})`
      : 'measure-stripped-workflow-inputs: `pg` was found but failed to load, so this is NOT '
        + `a missing-dependency problem and reinstalling will not fix it: ${detail}`,
  );
}

function parseRows(rows, pick) {
  const out = [];
  for (const row of rows) {
    try {
      out.push(pick(JSON.parse(row.v), row.k));
    } catch {
      // A row that will not parse is reported, never silently skipped — a
      // dropped row is an undercount, which is the direction that reads as good
      // news.
      out.push(null);
    }
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const asJson = argv.includes('--json');
  const fixture = arg('--fixture');
  const dsn = arg('--dsn') ?? process.env.DATABASE_URL;

  let heads;
  let revisions;
  let ownership;
  /** Rows that would not parse. Never silently dropped: a dropped row is an
   *  undercount, and undercount is the direction that reads as good news. */
  let parseFailures = 0;

  if (fixture) {
    const { readFileSync } = await import('node:fs');
    const f = JSON.parse(readFileSync(fixture, 'utf8'));
    heads = f.heads ?? [];
    revisions = f.revisions ?? [];
    ownership = f.ownership ?? [];
  } else if (dsn) {
    // `pg` is a dependency of the backend workspace, not of the repo root, and
    // this script is documented as `node scripts/...` FROM the root — where a
    // bare `import('pg')` dies with an opaque ERR_MODULE_NOT_FOUND. Resolve it
    // against the workspace that actually owns it, and if that fails say what to
    // do rather than leaking a module-resolution stack at someone holding a
    // production DSN.
    const pg = await loadPg();
    const client = new pg.Client({ connectionString: dsn });
    await client.connect();
    try {
      const [h, r, o] = await Promise.all([
        client.query(Q_HEADS),
        client.query(Q_REVISIONS),
        client.query(Q_OWNERSHIP),
      ]);
      const bad = [];
      heads = parseRows(h.rows, (def, k) => ({ workflowId: def.workflowId ?? k.slice('wfreg:'.length), definition: def }))
        .filter((x, i) => (x ? true : (bad.push(h.rows[i].k), false)));
      revisions = parseRows(r.rows, (rec) => ({ workflowId: rec.workflowId, tenantId: rec.tenantId, definition: rec.definition }))
        .filter((x, i) => (x ? true : (bad.push(r.rows[i].k), false)));
      ownership = parseRows(o.rows, (rec) => ({ workflowId: rec.workflowId, tenantId: rec.tenantId }))
        .filter((x, i) => (x ? true : (bad.push(o.rows[i].k), false)));
      parseFailures = bad.length;
      if (bad.length > 0) console.error(`⚠ ${bad.length} row(s) failed to parse and are EXCLUDED — the counts below are a floor.`);
    } finally {
      await client.end();
    }
  } else {
    console.error(
      'measure-stripped-workflow-inputs — how many workflow heads lost their node `inputs`?\n'
      + '\n'
      + '  --dsn <postgres-url>   read-only connection (or set $DATABASE_URL)\n'
      + '  --fixture <file.json>  read rows from a file instead of a database\n'
      + '  --json                 machine-readable counts on stdout\n'
      + '\n'
      + 'Exit codes: 0 reported · 2 bad invocation · 3 REFUSED (the query matched no heads).',
    );
    process.exit(2);
  }

  const result = classifyPopulation(heads, revisions, ownership);

  if (asJson) {
    // `parseFailures` and `refused` ride the JSON itself. A warning printed to
    // stderr is invisible to anything consuming stdout, so a machine reader
    // would otherwise see a smaller-than-real population with no signal at all
    // that rows were dropped.
    console.log(JSON.stringify({ ...result.counts, parseFailures, refused: result.counts.heads === 0 }, null, 2));
  } else {
    console.log(formatReport(result));
  }

  // Non-zero on the refusal so a caller that only checks the exit status cannot
  // read "matched nothing" as "nothing wrong".
  if (result.counts.heads === 0) process.exit(3);
}

// Only run the shell when invoked directly, so the pure half stays importable.
// NOT a hand-rolled `file://` comparison — that form is false through a symlink
// and on paths with spaces, so the script silently measures nothing (#3070).
if (isEntryModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
