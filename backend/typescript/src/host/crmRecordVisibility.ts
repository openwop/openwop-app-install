/**
 * CRM record-visibility resolver (ADR 0272 P4) — a host seam answering "which of
 * these CRM records may THIS caller READ?" Modeled on `subjectAccess.ts`
 * (ADR 0054 D5): a single feature registers a resolver at boot; CRM's read path
 * consults it. The DEFAULT (no resolver registered) is ALLOW-ALL, so with the
 * `territories` feature OFF the CRM surface is byte-for-byte unchanged.
 *
 * THE BOUNDARY (ADR 0006 / 0054): this narrows READ only — it is a row-level
 * read-ACL, NOT an RBAC scope. WRITE stays org-scoped (a `workspace:write`
 * member may still edit any org record). A caller with no subject (a system /
 * internal read) is never filtered. Fail-closed is the resolver's job, not the
 * default here (a missing resolver ⇒ the feature is off ⇒ allow-all is correct).
 *
 * Records are passed opaquely (`record: unknown`) so this host module stays
 * agnostic of CRM shapes — the registering feature (territories) knows the shape
 * and casts. `modelId` carries the run-frozen active model (replay-safe reads
 * inside a run, via `runStartContext`); absent for live HTTP reads.
 *
 * @see docs/adr/0272-sales-territory-management.md §4.4
 */

export type CrmVisibilityTarget = 'company' | 'deal';

export interface CrmVisibilityQuery {
  tenantId: string;
  orgId: string;
  target: CrmVisibilityTarget;
  /** The records under consideration; `record` is the full row (opaque here). */
  records: ReadonlyArray<{ recordId: string; record: unknown }>;
  /** The reading subject (RFC 0048). `undefined` ⇒ system/internal read. */
  callerSubject: string | undefined;
  /** Run-frozen active model id (replay); absent for live reads. */
  modelId?: string;
}

/** Returns the subset of record ids the caller MAY read. */
export type CrmVisibilityResolver = (q: CrmVisibilityQuery) => Promise<ReadonlySet<string>>;

let resolver: CrmVisibilityResolver | null = null;

/** Register the resolver (called once at boot by the owning feature). */
export function setCrmVisibilityResolver(fn: CrmVisibilityResolver): void {
  resolver = fn;
}

/** ADR 0837 D5 — is a resolver registered? Lets a caller that would have to
 *  LOAD linked records before filtering skip that work when territories is off. */
export function isCrmVisibilityActive(): boolean {
  return resolver !== null;
}

/**
 * Filter `rows` to those the caller may read. No resolver (feature off) OR no
 * caller subject (system read) ⇒ ALLOW-ALL (rows returned unchanged) — this is
 * the property that keeps the CRM surface unchanged when territories is off.
 */
export async function filterVisibleCrmRecords<T>(args: {
  tenantId: string;
  orgId: string;
  target: CrmVisibilityTarget;
  callerSubject: string | undefined;
  modelId?: string;
  rows: T[];
  idOf: (row: T) => string;
}): Promise<T[]> {
  if (!resolver || args.callerSubject === undefined) return args.rows;
  const visible = await resolver({
    tenantId: args.tenantId,
    orgId: args.orgId,
    target: args.target,
    callerSubject: args.callerSubject,
    records: args.rows.map((r) => ({ recordId: args.idOf(r), record: r })),
    ...(args.modelId ? { modelId: args.modelId } : {}),
  });
  return args.rows.filter((r) => visible.has(args.idOf(r)));
}

/** ADR 0846 D2 — how CRM turns one of its kernel rows into the DOMAIN row its own
 *  reads hand the resolver (`kernelToDeal` + the `projectDeal` defaulting), so a
 *  kernel reader filters on exactly the record CRM's list would. Registered by CRM
 *  per kernel type; the host knows no CRM shape. `null` ⇒ not a well-formed row. */
export interface CrmKernelProjection {
  target: CrmVisibilityTarget;
  project: (rec: { values: Record<string, unknown>; ext?: Record<string, unknown> }) => { id: string; orgId: string; record: unknown } | null;
}
const kernelProjections = new Map<string, CrmKernelProjection>();

export function registerCrmKernelProjection(typeName: string, projection: CrmKernelProjection): void {
  kernelProjections.set(typeName, projection);
}

/**
 * ADR 0846 D2 — `filterVisibleCrmRecords` for CRM rows read through the content
 * kernel (a BI metric), which see the kernel record, not the domain row. Projects
 * each row through CRM's registered projection, groups by org (the resolver is per
 * org), and keeps the kernel rows whose domain record survives. A type with no
 * registered projection, no resolver, or no viewer (a system read) returns the
 * rows unchanged. For a viewer, a row the projection cannot read is dropped: it
 * cannot be shown to be visible (CRM's own writers always produce a readable row).
 */
export async function filterVisibleCrmKernelRows<R extends { values: Record<string, unknown>; ext?: Record<string, unknown> }>(args: {
  tenantId: string;
  typeName: string;
  callerSubject: string | undefined;
  rows: R[];
}): Promise<R[]> {
  const projection = kernelProjections.get(args.typeName);
  if (!projection || !resolver || args.callerSubject === undefined) return args.rows;
  const byOrg = new Map<string, Array<{ row: R; id: string; record: unknown }>>();
  for (const row of args.rows) {
    const p = projection.project(row);
    if (!p) continue;
    const group = byOrg.get(p.orgId) ?? [];
    group.push({ row, id: p.id, record: p.record });
    byOrg.set(p.orgId, group);
  }
  const keep = new Set<R>();
  for (const [orgId, group] of byOrg) {
    // The resolver receives the DOMAIN record — the shape it was written for.
    const idOf = new Map(group.map((g) => [g.record, g.id]));
    const visible = await filterVisibleCrmRecords({ tenantId: args.tenantId, orgId, target: projection.target, callerSubject: args.callerSubject, rows: group.map((g) => g.record), idOf: (r) => idOf.get(r)! });
    const ids = new Set(visible.map((r) => idOf.get(r)!));
    for (const g of group) if (ids.has(g.id)) keep.add(g.row);
  }
  return args.rows.filter((r) => keep.has(r));
}
