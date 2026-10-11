#!/usr/bin/env node
// ADR 0871 — the mechanical re-check for the three deferred storage decisions.
//
//   T1  per-tenant row quota       (ADR 0868 open question 1)
//   T2  table storage on real tables (ADR 0868 open question 2)
//   T3  an HNSW index for pgvector  (ADR 0867 open question 2)
//
// Reads the production log lines the host writes (`surface_rows_gauge`,
// `vector_rows_gauge` hourly; `surface_scan_heavy`, `vector_query_slow` per
// event) and prints CLEAR or TRIGGERED for each, with the numbers behind it.
// Read-only: one `gcloud logging read`.
//
// Exit: 0 all CLEAR · 1 at least one TRIGGERED · 2 UNMEASURED.
// UNMEASURED means no gauge line in the window. The gauge logs every hour once
// deployed, so an empty window says the QUERY or the deploy is wrong — never
// "nothing grew" (an empty read must not pass as a clean one).
//
// Usage:
//   node scripts/measure-storage-growth.mjs [--days 7] [--json]
// Project and service come from OPENWOP_DEPLOY_PROJECT / OPENWOP_DEPLOY_SERVICE,
// else scripts/deploy.env.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryModule } from './lib/entry-module.mjs';

/** The ADR 0871 thresholds. The row/namespace ones match the host's env defaults. */
export const TRIGGERS = {
  t1TenantRows: 100_000,
  t1HeavyPerDayPerFamily: 10,
  t2TableQueryHeavyPerDay: 10,
  t3NamespaceRows: 50_000,
  t3SlowQueriesPerDay: 20,
};

const MSGS = ['surface_rows_gauge', 'vector_rows_gauge', 'surface_scan_heavy', 'vector_query_slow',
  'surface_rows_gauge_failed', 'vector_rows_gauge_failed'];

/** `entries`: [{ msg, ...fields }]. Pure, so the verdicts are unit-tested. */
export function evaluate(entries, days, t = TRIGGERS) {
  const by = (m) => entries.filter((e) => e.msg === m);
  const surfaceGauge = by('surface_rows_gauge').filter((e) => e.family);
  const vectorGauge = by('vector_rows_gauge');
  const heavy = by('surface_scan_heavy');
  const slow = by('vector_query_slow');
  const failed = [...by('surface_rows_gauge_failed'), ...by('vector_rows_gauge_failed')].length;

  if (by('surface_rows_gauge').length === 0) {
    return { status: 'UNMEASURED', reason: 'no surface_rows_gauge line in the window: the gauge is not deployed, or the query is wrong', failed };
  }

  const families = {};
  for (const g of surfaceGauge) {
    const f = (families[g.family] ??= { maxTenantRows: 0, latestTotalRows: 0, earliestTotalRows: null, heavy: 0 });
    f.maxTenantRows = Math.max(f.maxTenantRows, Number(g.maxTenantRows) || 0);
    f.latestTotalRows = Number(g.totalRows) || 0; // entries are oldest-first
    f.earliestTotalRows ??= Number(g.totalRows) || 0;
  }
  const heavyByOp = {};
  for (const h of heavy) {
    const f = (families[h.family] ??= { maxTenantRows: 0, latestTotalRows: 0, earliestTotalRows: null, heavy: 0 });
    f.heavy += 1;
    heavyByOp[h.op] = (heavyByOp[h.op] ?? 0) + 1;
  }
  const perDay = (n) => n / days;

  const t1Hits = Object.entries(families).filter(([, f]) =>
    f.maxTenantRows >= t.t1TenantRows || perDay(f.heavy) >= t.t1HeavyPerDayPerFamily).map(([k]) => k);
  const tableHeavy = heavyByOp['table.query'] ?? 0;
  const latestVector = vectorGauge.at(-1) ?? null;
  const maxNamespaceRows = Math.max(0, ...vectorGauge.map((v) => Number(v.maxNamespaceRows) || 0));
  const t3 = maxNamespaceRows >= t.t3NamespaceRows || perDay(slow.length) >= t.t3SlowQueriesPerDay;

  return {
    status: t1Hits.length || perDay(tableHeavy) >= t.t2TableQueryHeavyPerDay || t3 ? 'TRIGGERED' : 'CLEAR',
    days,
    failed,
    families,
    heavyByOp,
    t1: { triggered: t1Hits.length > 0, families: t1Hits },
    t2: { triggered: perDay(tableHeavy) >= t.t2TableQueryHeavyPerDay, tableQueryHeavyPerDay: perDay(tableHeavy) },
    t3: {
      triggered: t3,
      maxNamespaceRows,
      slowPerDay: perDay(slow.length),
      measured: latestVector !== null,
      pgvector: latestVector?.pgvector ?? null,
      iterativeScanAvailable: latestVector?.pgvector ? versionAtLeast(latestVector.pgvector, 0, 8) : null,
    },
  };
}

export function versionAtLeast(v, major, minor) {
  const [a = 0, b = 0] = String(v).split('.').map(Number);
  return a > major || (a === major && b >= minor);
}

function loadDeployEnv() {
  const p = join(dirname(fileURLToPath(import.meta.url)), 'deploy.env');
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--days');
  const days = i >= 0 && Number(args[i + 1]) > 0 ? Number(args[i + 1]) : 7;
  const env = { ...loadDeployEnv(), ...process.env };
  const project = env.OPENWOP_DEPLOY_PROJECT;
  const service = env.OPENWOP_DEPLOY_SERVICE;
  if (!project || !service) {
    console.error('measure-storage-growth: OPENWOP_DEPLOY_PROJECT / OPENWOP_DEPLOY_SERVICE unset (export them or create scripts/deploy.env)');
    process.exit(2);
  }
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const filter = `resource.type="cloud_run_revision" AND resource.labels.service_name="${service}" AND timestamp>="${since}" AND (${MSGS.map((m) => `jsonPayload.msg="${m}"`).join(' OR ')})`;
  const LIMIT = 50_000;
  const raw = execFileSync('gcloud', ['logging', 'read', filter, '--project', project, '--limit', String(LIMIT),
    '--order', 'asc', '--format', 'json(timestamp,jsonPayload)'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  const rows = JSON.parse(raw || '[]');
  const entries = rows.map((r) => ({ timestamp: r.timestamp, ...(r.jsonPayload ?? {}) }));
  const result = evaluate(entries, days);
  if (rows.length >= LIMIT) result.truncated = `hit the ${LIMIT}-line limit; shorten --days`;

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`storage growth, last ${days} day(s), ${service} (${project}): ${result.status}`);
    if (result.status === 'UNMEASURED') {
      console.log(`  ${result.reason}`);
    } else {
      for (const [f, s] of Object.entries(result.families)) {
        console.log(`  ${f.padEnd(10)} max tenant ${s.maxTenantRows} rows · total ${s.earliestTotalRows ?? '?'} → ${s.latestTotalRows} · heavy scans ${s.heavy}`);
      }
      console.log(`  T1 row quota      ${result.t1.triggered ? `TRIGGERED (${result.t1.families.join(', ')})` : 'clear'}`);
      console.log(`  T2 real tables    ${result.t2.triggered ? 'TRIGGERED' : 'clear'} (table.query heavy ${result.t2.tableQueryHeavyPerDay.toFixed(1)}/day)`);
      const v = result.t3;
      console.log(`  T3 HNSW           ${v.triggered ? 'TRIGGERED' : 'clear'} (largest namespace ${v.maxNamespaceRows}; slow ${v.slowPerDay.toFixed(1)}/day; ${v.measured ? `pgvector ${v.pgvector}, iterative scan ${v.iterativeScanAvailable ? 'available' : 'NOT available'}` : 'no vector gauge (pgvector not selected?)'})`);
      if (result.failed) console.log(`  WARNING: ${result.failed} gauge read(s) failed in the window`);
      if (result.truncated) console.log(`  WARNING: ${result.truncated}`);
    }
  }
  process.exit(result.status === 'CLEAR' ? 0 : result.status === 'TRIGGERED' ? 1 : 2);
}

if (isEntryModule(import.meta.url)) main();
