#!/usr/bin/env node
/**
 * ADR 0524 Phase C — restore node `inputs` to heads that lost them.
 *
 * ── WHY THIS IS NOT AN APP_MIGRATIONS ENTRY (the central decision) ─────────
 * The obvious shape is `APP_MIGRATIONS` version 16: versioned, single-shot,
 * runs itself on deploy. It was rejected, and the reason is a gate I set myself
 * one phase earlier.
 *
 * Phase B's ruling was that Phase C is **gated on B's numbers**, and B has not
 * been run against production — nobody knows how many heads this would rewrite.
 * An `APP_MIGRATIONS` entry is an automatic, unreviewable, host-wide rewrite of
 * tenant-owned durable state with an unmeasured blast radius. Shipping one
 * anyway would be exactly the mistake ADR 0504 records me NOT making once
 * before: there I built a correct gate, measured that it would block 114 of 169
 * chains, and did not ship it. Building the repair correctly and letting the
 * operator measure first is the same discipline.
 *
 * So: **dry-run by default**, `--apply` to write. Promoting this to a migration
 * later is a few lines once the numbers exist.
 *
 * ── WHY THE REPAIR IS SAFE TODAY, AND WHY THAT IS TIME-LIMITED ─────────────
 * Restoring inputs onto a head where the user DELIBERATELY cleared them would
 * be data loss in the other direction. That cannot happen today: the Inspector's
 * preset-inputs section is read-only, so a deliberate clear is not expressible —
 * the same reasoning ADR 0524 §4 used for the guard's discriminator.
 *
 * **It stops being true the day editable preset inputs (Phase E) ship.** This
 * tool must therefore run BEFORE Phase E. It refuses to guess: it only ever
 * restores onto a head carrying ZERO input-bearing nodes, sourced from a real
 * prior revision of that same workflow.
 *
 * ── REPLAY / FORK ──────────────────────────────────────────────────────────
 * Safe, for two independent reasons. Node ids are untouched (this is a surgical
 * field restore, never a re-expansion), so a run resolving HEAD still matches
 * its checkpoints by nodeId. And a run that stamped
 * `run.metadata.definitionRevision` keeps resolving its own revision row, which
 * is content-addressed and additive.
 *
 * ── IDEMPOTENCY ────────────────────────────────────────────────────────────
 * By construction, not by a marker: after a repair the head carries inputs, so
 * the `now === 0` precondition fails and a second run is a no-op. Deterministic
 * on the same input, with no random id and no clock.
 *
 * Usage:
 *   node scripts/repair-stripped-workflow-inputs.mjs --dsn postgres://...
 *   node scripts/repair-stripped-workflow-inputs.mjs --dsn ... --apply
 */

import { nodesCarryingInputs } from './measure-stripped-workflow-inputs.mjs';
import { isEntryModule } from './lib/entry-module.mjs';

/**
 * Pick the revision to restore from: the most recent one that actually carried
 * inputs. `seq` is the durable order (`workflowRevisions.ts` — `createdAt` ties
 * at millisecond resolution, so it is NOT the sort key).
 */
export function pickRepairSource(revisions) {
  const candidates = revisions.filter((r) => nodesCarryingInputs(r.definition) > 0);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, r) => ((r.seq ?? 0) > (best.seq ?? 0) ? r : best));
}

/**
 * Plan the repair for ONE head. Returns null when there is nothing to do, so
 * the caller never writes a row it did not have to.
 *
 * Restoration is keyed on the SURVIVING node id, matching
 * `preserveDroppedFields`: a node the head no longer has stays gone, and a node
 * the head added inherits nothing. A retyped node id is deliberately NOT
 * repaired — inheriting inputs onto a different `typeId` is how you get values
 * that typecheck against the wrong schema.
 */
export function planRepair(head, revisions) {
  if (nodesCarryingInputs(head.definition) > 0) return null;

  // ADR 0524 Phase E — DID THE AUTHOR MEAN THE ZERO?
  //
  // Once preset inputs are editable, "no inputs" stops being purely a symptom of
  // an old bundle and becomes an authoring choice. The durable rows cannot tell
  // the two zeroes apart on their own; the revision's `declaredFields` stamp
  // can. A head whose LATEST revision was written by a client that declared it
  // models `inputs` is deliberately empty — repairing it would resurrect values
  // a user removed on purpose, which is the same silent-overwrite harm as the
  // strip, only pointing the other way.
  //
  // Latest by `seq`, the durable order — `createdAt` ties at ms resolution.
  const latest = revisions.reduce(
    (best, r) => (best === null || (r.seq ?? 0) > (best.seq ?? 0) ? r : best),
    null,
  );
  if (latest?.declaredFields?.includes('inputs')) return null;

  const source = pickRepairSource(revisions);
  if (!source) return null;

  // The node identity field is `nodeId` (`executor/types.ts:403`), the same one
  // `preserveDroppedFields` keys its restoration on. NOT `id`.
  //
  // §Correction — this shipped keyed on `n.id`, which does not exist on a
  // WorkflowDefinition node, and the failure was NOT a harmless no-op:
  // `new Map(nodes.map(n => [undefined, n]))` collapses to ONE entry, so
  // `get(undefined)` returned the LAST source node for EVERY node, and the
  // repair wrote one node's inputs onto all of them. On a mail node that means
  // another node's recipient. It passed 20 tests because the FIXTURES used `id`
  // too — the tests encoded my wrong belief about the shape rather than the
  // shape, which is the "my tests pin INTENT, not behaviour" failure.
  const idOf = (n) => n?.nodeId;
  const sourceNodes = new Map(
    (source.definition.nodes ?? []).filter((n) => idOf(n) !== undefined).map((n) => [idOf(n), n]),
  );
  // Structural guard so this class cannot recur silently. If a definition has
  // nodes but none of them yielded an identity, the field name is wrong — refuse
  // rather than "restore" against a map of nothing.
  if ((source.definition.nodes ?? []).length > 0 && sourceNodes.size === 0) {
    throw new Error(
      'repair-stripped-workflow-inputs: no source node exposed a `nodeId`. The node identity '
      + 'field has changed or the rows are malformed; refusing to plan a repair keyed on nothing.',
    );
  }
  let restoredNodes = 0;
  const nodes = (head.definition.nodes ?? []).map((n) => {
    const key = idOf(n);
    const from = key === undefined ? undefined : sourceNodes.get(key);
    if (!from || !from.inputs || Object.keys(from.inputs).length === 0) return n;
    // Only repair when the node is still the SAME TYPE. A node whose typeId
    // changed is a different contract; restoring the old inputs onto it would
    // produce values shaped for a schema that no longer applies.
    if (from.typeId !== n.typeId) return n;
    restoredNodes += 1;
    return { ...n, inputs: from.inputs };
  });
  if (restoredNodes === 0) return null;

  const definition = { ...head.definition, nodes };
  const fields = ['inputs'];

  // Coherence, mirroring the guard: restored inputs may reference variables by
  // name (RFC 0124 `{type:'variable',variableName}`). Restoring the values but
  // not the declarations yields a definition whose refs resolve to nothing.
  if (
    Array.isArray(source.definition.variables)
    && source.definition.variables.length > 0
    && !(Array.isArray(head.definition.variables) && head.definition.variables.length > 0)
  ) {
    definition.variables = source.definition.variables;
    fields.push('variables');
  }
  if (head.definition.configurableSchema === undefined && source.definition.configurableSchema !== undefined) {
    definition.configurableSchema = source.definition.configurableSchema;
    fields.push('configurableSchema');
  }

  return {
    workflowId: head.workflowId,
    fromRevision: source.revisionHash ?? null,
    restoredNodes,
    fields,
    definition,
  };
}

/** Plan the whole population. Pure — no IO, no clock, no randomness. */
export function planAll(heads, revisions) {
  const byWorkflow = new Map();
  for (const r of revisions) {
    const list = byWorkflow.get(r.workflowId) ?? [];
    list.push(r);
    byWorkflow.set(r.workflowId, list);
  }
  const plans = [];
  for (const h of heads) {
    const plan = planRepair(h, byWorkflow.get(h.workflowId) ?? []);
    if (plan) plans.push(plan);
  }
  return plans;
}

/** Wrap on word boundaries so an identifier never splits across lines. */
function wrapLines(text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) { out.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

export function formatPlan(plans, heads, applied) {
  if (heads === 0) {
    // Same anti-vacuity rule as the measurement tool: zero rows is not a clean
    // database, and "0 to repair" out of 0 heads is the reassuring number that
    // means nothing.
    return 'REFUSING TO ACT: the head query matched ZERO rows. That is not evidence '
      + 'that nothing needs repair — check the DSN and the `wfreg:%` prefix first.';
  }
  const lines = [];
  lines.push(`${applied ? 'REPAIRED' : 'WOULD REPAIR'} ${plans.length} of ${heads} head(s).`);
  if (plans.length === 0) {
    lines.push('');
    lines.push('No head carries zero inputs while an earlier revision of it carried some.');
    return lines.join('\n');
  }
  lines.push('');
  for (const p of plans.slice(0, 50)) {
    lines.push(`  ${p.workflowId}`);
    lines.push(`    ${p.restoredNodes} node(s), fields: ${p.fields.join(', ')}, from revision ${p.fromRevision ?? '(unknown)'}`);
  }
  if (plans.length > 50) lines.push(`  … and ${plans.length - 50} more (not truncated in --json).`);

  // `wf.seed.*` rows are GLOBAL — one definition every tenant runs. DATA-D /
  // PROBE-CP1 record that such a row can hold a recipient address frozen into a
  // node input, so restoring inputs onto one restores whatever was there.
  //
  // Disclosed rather than skipped, deliberately. The values being restored were
  // already globally visible before the strip removed them, so this returns the
  // row to its prior state rather than creating a new exposure — and refusing
  // would leave those workflows broken for every tenant. But an operator should
  // know they are touching shared rows before they type --apply.
  const globals = plans.filter((p) => p.workflowId.startsWith('wf.seed.'));
  if (globals.length > 0) {
    lines.push('');
    lines.push(
      ...wrapLines(
        globals.length === 1
          ? 'WARNING: one of these is a GLOBAL `wf.seed.*` definition shared by every tenant, '
            + 'not a tenant-owned copy. Restoring its inputs restores whatever was frozen into '
            + 'it — see DATA-D / PROBE-CP1 on recipient addresses in shared definition rows. '
            + 'Run PROBE-CP1 before --apply if that matters here.'
          : `WARNING: ${globals.length} of these are GLOBAL \`wf.seed.*\` definitions shared by `
            + 'every tenant, not tenant-owned copies. Restoring their inputs restores whatever '
            + 'was frozen into them — see DATA-D / PROBE-CP1 on recipient addresses in shared '
            + 'definition rows. Run PROBE-CP1 before --apply if that matters here.',
        78,
      ),
    );
  }

  if (!applied) {
    lines.push('');
    lines.push('DRY RUN — nothing was written. Re-run with --apply to persist.');
  }
  return lines.join('\n');
}

/* ───────────────────────── IO shell (not unit-tested) ───────────────────── */

const Q_HEADS = "SELECT k, v FROM host_ext_kv WHERE k LIKE 'wfreg:%'";
const Q_REVISIONS = "SELECT k, v FROM host_ext_kv WHERE k LIKE 'hostext:workflow:revision:%'";
// Parameterised. The workflowId comes from a database row, not a human, but a
// value read from data is exactly the value people forget to parameterise.
//
// The trailing `AND v = $4` is a COMPARE-AND-SWAP against the exact bytes this
// run planned from. `rowCount === 0` then means "someone changed it underneath
// us", and the safe response is to skip rather than clobber.
const Q_WRITE = 'UPDATE host_ext_kv SET v = $2, updated_at = $3 WHERE k = $1 AND v = $4';

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const apply = argv.includes('--apply');
  const asJson = argv.includes('--json');
  const fixture = arg('--fixture');
  const dsn = arg('--dsn') ?? process.env.DATABASE_URL;

  if (!fixture && !dsn) {
    console.error(
      'repair-stripped-workflow-inputs — restore node `inputs` to heads that lost them.\n'
      + '\n'
      + '  --dsn <postgres-url>   connection (or set $DATABASE_URL)\n'
      + '  --fixture <file.json>  read rows from a file (never writes)\n'
      + '  --apply                PERSIST the repair (default is a dry run)\n'
      + '  --json                 machine-readable plan on stdout\n'
      + '\n'
      + 'Run scripts/measure-stripped-workflow-inputs.mjs FIRST — this tool is\n'
      + 'deliberately not an APP_MIGRATIONS entry, because the population must be\n'
      + 'measured before a host-wide rewrite of tenant data is worth running.\n'
      + '\n'
      + 'Exit codes: 0 ok · 2 bad invocation · 3 REFUSED (matched no heads).',
    );
    process.exit(2);
  }

  let heads = [];
  let revisions = [];
  let client = null;

  if (fixture) {
    const { readFileSync } = await import('node:fs');
    const f = JSON.parse(readFileSync(fixture, 'utf8'));
    heads = f.heads ?? [];
    revisions = f.revisions ?? [];
    if (apply) {
      console.error('--apply is ignored with --fixture: there is nothing to write to.');
    }
  } else {
    const { loadPg } = await import('./measure-stripped-workflow-inputs.mjs');
    const pg = await loadPg();
    client = new pg.Client({ connectionString: dsn });
    await client.connect();
    const [h, r] = await Promise.all([client.query(Q_HEADS), client.query(Q_REVISIONS)]);
    heads = h.rows.map((row) => {
      try {
        const def = JSON.parse(row.v);
        return { key: row.k, raw: row.v, workflowId: def.workflowId ?? row.k.slice('wfreg:'.length), definition: def };
      } catch { return null; }
    }).filter(Boolean);
    revisions = r.rows.map((row) => {
      try {
        const rec = JSON.parse(row.v);
        return { workflowId: rec.workflowId, seq: rec.seq, revisionHash: rec.revisionHash, declaredFields: rec.declaredFields, definition: rec.definition };
      } catch { return null; }
    }).filter(Boolean);
  }

  try {
    const plans = planAll(heads, revisions);

    if (heads.length === 0) {
      console.log(formatPlan(plans, 0, false));
      process.exit(3);
    }

    let written = 0;
    let skippedStale = 0;
    if (apply && client) {
      const now = new Date().toISOString();
      const byId = new Map(heads.map((h) => [h.workflowId, h]));
      for (const p of plans) {
        const head = byId.get(p.workflowId);
        const key = head?.key ?? `wfreg:${p.workflowId}`;
        // COMPARE-AND-SWAP on the exact bytes we planned against. Without it, a
        // tenant autosaving between our SELECT and our UPDATE loses their edit
        // to a definition we reconstructed from an OLDER revision — we would
        // overwrite fresh authored work with a repair. `wfreg:` has no CAS in
        // the app either, but the app's writers are racing each other over
        // seconds; this tool reads the whole table and then writes it back over
        // minutes, so the window is orders of magnitude wider.
        const res = await client.query(Q_WRITE, [key, JSON.stringify(p.definition), now, head?.raw ?? null]);
        if (res.rowCount === 0) skippedStale += 1;
        else written += 1;
      }
      if (skippedStale > 0) {
        console.error(
          `⚠ ${skippedStale} head(s) changed underneath this run and were SKIPPED, not overwritten. `
          + 'Re-run to pick them up.',
        );
      }
      // The registry is a write-through cache in front of storage
      // (`workflowsRegistry.ts`), and `getRegisteredWorkflowAsync` reads durable
      // storage only on a cache MISS. A direct SQL write is invisible to any
      // instance that already has the workflow cached, so the repair can look
      // like it did nothing until instances cycle.
      console.error(
        '⚠ Written directly to storage. Running instances hold a process-local registry '
        + 'cache and will keep serving the OLD definition until they restart or evict it.',
      );
    }

    console.log(asJson
      // `plans` carries the full repaired DEFINITION, which can contain
      // recipient email addresses frozen into node inputs (DATA-ASSESSMENT
      // PROBE-CP1). Printing it would put PII on stdout and into whatever
      // captures it. Only the audit fields are emitted.
      ? JSON.stringify({
        heads: heads.length,
        repaired: plans.length,
        applied: apply && !!client,
        written,
        skippedStale,
        plans: plans.map((p) => ({
          workflowId: p.workflowId,
          fromRevision: p.fromRevision,
          restoredNodes: p.restoredNodes,
          fields: p.fields,
        })),
      }, null, 2)
      : formatPlan(plans, heads.length, apply && !!client));
  } finally {
    if (client) await client.end();
  }
}

// A REPAIR script that silently does nothing is the worst instance of this
// class: it exits 0 and you believe the data was repaired. The hand-rolled
// `file://` comparison this replaces was false through a symlink (#3070).
if (isEntryModule(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
