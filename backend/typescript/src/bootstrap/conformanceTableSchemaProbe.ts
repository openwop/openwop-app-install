/**
 * `core.conformance.table-schema-probe` — the node behind the
 * `conformance-table-schema-probe` fixture (RFC 0228 G4; openwop
 * `conformance/fixtures.md` §"The tableStorage schema probe fixture").
 *
 * storage.md §tableStorage: rows MUST conform to the table's declared schema,
 * and an insert or update whose column types diverge MUST be refused.
 * `tableStorage` has no protocol path, so the suite can only witness that rule
 * through a node that calls the host's OWN `ctx.storage.table` for the run's
 * tenant. This is that node, and it does nothing else:
 *
 *   - every action first calls `createTable(table, { k: string, n: number })`;
 *   - `control` inserts `{ k: 'control', n: 1 }` and outputs `{ inserted, rowId }`;
 *   - `insert-mistyped` inserts `{ k: 'mistyped', n: 'not-a-number' }`;
 *   - `update-mistyped` inserts `{ k: 'to-update', n: 2 }`, then updates `n` to
 *     a string.
 *
 * It does no type checking of its own: if the host accepts a mistyped write,
 * the node completes and reports it (`inserted` / `updated`), so the scenario
 * reads executed-fail rather than a probe that refused on the host's behalf. A
 * rejection fails the node with the rejection's code and details, unchanged;
 * the v2 boundary re-spells `table_schema_violation` as `validation_error`
 * with `details.service: tableStorage` (middleware/protocolVersion.ts).
 *
 * Like `core.conformance.storage-probe` (ADR 0858) it touches only the run
 * tenant's own storage, so it has its own switch rather than the
 * conformance-nodes one, and its fixture is advertised exactly when it resolves
 * AND `tableStorage` is advertised (host/index.ts).
 */
import type { NodeModule, NodeContext, NodeOutcome } from '../executor/types.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';

export const CONFORMANCE_TABLE_SCHEMA_PROBE_TYPE_ID = 'core.conformance.table-schema-probe';
export const CONFORMANCE_TABLE_SCHEMA_PROBE_FIXTURE = 'conformance-table-schema-probe';

/** The schema every action declares (the fixture contract's, verbatim). */
export const PROBE_TABLE_SCHEMA = { k: 'string', n: 'number' } as const;
export const PROBE_ACTIONS = ['control', 'insert-mistyped', 'update-mistyped'] as const;
export type ProbeAction = (typeof PROBE_ACTIONS)[number];

type Surface = Record<string, ((args: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

async function run(t: Surface, action: ProbeAction, table: string): Promise<Record<string, unknown>> {
  await t['createTable']!({ table, columns: PROBE_TABLE_SCHEMA });
  if (action === 'control') {
    const r = await t['insert']!({ table, row: { k: 'control', n: 1 } });
    return { inserted: true, rowId: r['id'] };
  }
  if (action === 'insert-mistyped') {
    const r = await t['insert']!({ table, row: { k: 'mistyped', n: 'not-a-number' } });
    return { inserted: true, rowId: r['id'] };
  }
  const r = await t['insert']!({ table, row: { k: 'to-update', n: 2 } });
  const rowId = r['id'];
  await t['update']!({ table, id: rowId, patch: { n: 'not-a-number' } });
  return { updated: true, rowId };
}

export const tableSchemaProbeNode: NodeModule = {
  typeId: CONFORMANCE_TABLE_SCHEMA_PROBE_TYPE_ID,
  version: '1.0.0',
  sideEffecting: true,
  async execute(ctx: NodeContext): Promise<NodeOutcome> {
    // The fixture declares these as run variables; the run's inputs seed them.
    const action = str(ctx.variables?.get('action')) ?? 'control';
    const table = str(ctx.variables?.get('table'));
    if (!(PROBE_ACTIONS as readonly string[]).includes(action)) {
      return { status: 'failure', error: { code: 'validation_error', message: `table-schema-probe action must be one of ${PROBE_ACTIONS.join(', ')}` } };
    }
    if (!table) return { status: 'failure', error: { code: 'validation_error', message: 'table-schema-probe requires a table' } };
    const t = (ctx.storage as unknown as Record<string, Surface | undefined> | undefined)?.['table'];
    if (!t?.['createTable'] || !t['insert'] || !t['update']) {
      return { status: 'failure', error: { code: 'host_capability_missing', message: 'tableStorage (createTable, insert, update) is not available to this node' } };
    }
    try {
      return { status: 'success', outputs: { result: await run(t, action as ProbeAction, table) } };
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown; details?: unknown };
      return {
        status: 'failure',
        error: {
          code: typeof e.code === 'string' ? e.code : 'internal_error',
          message: typeof e.message === 'string' ? e.message : String(err),
          ...(e.details && typeof e.details === 'object' ? { details: e.details as Record<string, unknown> } : {}),
        },
      };
    }
  },
};

/**
 * `OPENWOP_CONFORMANCE_TABLE_SCHEMA_PROBE=false` turns the probe off (and with
 * it the fixture); anything else leaves it on. Read once, at registration.
 */
export function tableSchemaProbeEnabled(): boolean {
  return process.env.OPENWOP_CONFORMANCE_TABLE_SCHEMA_PROBE !== 'false';
}

let registered = false;

export function registerConformanceTableSchemaProbeNode(): void {
  if (registered) return;
  if (!tableSchemaProbeEnabled()) return;
  getNodeRegistry().register(tableSchemaProbeNode);
  registered = true;
}
