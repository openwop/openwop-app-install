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
