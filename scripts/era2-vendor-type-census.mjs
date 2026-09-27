#!/usr/bin/env node
/**
 * ADR 0674 follow-up — the era-2 vendor-type census.
 *
 * `openwop-1` asked for "the per-tenant count of era-2 rows carrying the 11"
 * to make the RFC 0176 case for or against relaxing `persistence.md` §The
 * reader rule. This produces it, and it exists as a SCRIPT rather than a
 * one-off query because the number is evidence in someone else's argument and
 * has to be reproducible by them.
 *
 * WHY THE CODE CANNOT ANSWER THIS. I tried. A scan of `appendEvent({ type: '…' })`
 * call sites returns ten literals, all codemap-named, which reads as "this host
 * has written no vendor-shaped type, ever." That conclusion is WRONG, and the
 * reason is the shape `myndhyve-1` hit on their own host: `executor/eventLog.ts`
 * passes `type: input.type` — a VARIABLE — so the main writer is invisible to a
 * literal census. A scan is as wide as the question that generated it, and
 * "which literals are written" is not "what is in the log".
 *
 * So this reads the log.
 *
 * Read-only, one connection, one aggregate. `events` has no tenant column, so
 * the tenant comes from `runs` — which is also why this is a JOIN rather than
 * the single-table scan it looks like it should be.
 */
// `pg` lives in the backend workspace, not at the repo root, and ESM ignores
// NODE_PATH — so resolve it from there explicitly rather than requiring this
// script to be run from inside that directory.
import { createRequire } from 'node:module';
const backendRequire = createRequire(new URL('../backend/typescript/package.json', import.meta.url));
const pg = backendRequire('pg');

const DSN = process.env.OPENWOP_STORAGE_DSN ?? process.env.DATABASE_URL;
if (!DSN || !/^postgres/.test(DSN)) {
  console.error('era2-vendor-type-census: set OPENWOP_STORAGE_DSN to a postgres DSN.');
  console.error('  This is a READ-ONLY aggregate; it opens ONE connection and runs ONE query.');
  process.exit(2);
}

/** `events.md` §Types — the vendor branch. A type the codemap names is a
 *  protocol type and never reaches this rule. */
const VENDOR = /^(?!openwop\.)[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)?$/;

const client = new pg.Client({ connectionString: DSN, application_name: 'era2-vendor-type-census' });
await client.connect();
try {
  // One pass. `type` is indexed only via (run_id, sequence), so this is a scan —
  // acceptable for a one-off on a small instance, and the reason it is not a
  // route.
  const { rows } = await client.query(`
    SELECT r.tenant_id AS tenant, e.type AS type, COUNT(*)::bigint AS rows
    FROM events e
    JOIN runs r ON r.run_id = e.run_id
    GROUP BY r.tenant_id, e.type
    ORDER BY rows DESC
  `);

  const codemap = JSON.parse(
    await (await import('node:fs/promises')).readFile(
      new URL('../schemas/v2/event-codemap.json', import.meta.url), 'utf8'));
  const named = new Set();
  (function collect(o) {
    if (Array.isArray(o)) { o.forEach(collect); return; }
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string') { named.add(k); named.add(v); } else collect(v);
    }
  })(codemap);

  const unnamed = rows.filter((r) => !named.has(r.type));
  const invalid = unnamed.filter((r) => !VENDOR.test(r.type));

  console.log(`era-2 vendor-type census — ${rows.length} (tenant, type) pairs\n`);
  console.log(`  distinct types in the log : ${new Set(rows.map((r) => r.type)).size}`);
  console.log(`  codemap-NAMED pairs       : ${rows.length - unnamed.length}`);
  console.log(`  vendor-branch pairs       : ${unnamed.length}`);
  console.log(`  INVALID under the grammar : ${invalid.length}`);
  console.log('');
  if (unnamed.length === 0) {
    // The answer that would settle the RFC question in the cheap direction.
    console.log('  No era-2 row carries a vendor-branch type. Tightening the reader');
    console.log('  refuses nothing already written, so the durable-log objection does');
    console.log('  not apply to this host.');
  } else {
    console.log('  tenant                                type                                rows   verdict');
    for (const r of unnamed) {
      console.log(`  ${String(r.tenant).padEnd(36)} ${String(r.type).padEnd(34)} ${String(r.rows).padStart(6)}   ${VENDOR.test(r.type) ? 'vendor-shaped' : 'INVALID'}`);
    }
  }
} finally {
  await client.end();
}
