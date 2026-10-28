/**
 * ADR 0959 D5 — the content-adapter seam for campaign playbooks: the ADR 0387
 * `registerConfigDomain` inversion, for per-client content instead of tenant config.
 *
 * A playbook version can carry content items (`{slot, kind, payload}`): a CMS page, an email
 * template, a brand preset. The feature that OWNS each kind registers its adapter here, and
 * campaign-playbooks drives them — so campaign-playbooks never writes another feature's store,
 * and no owner imports campaign-playbooks. Every write lands in the CLIENT org (ADR 0921 D1).
 *
 * The contract:
 *  - `parse(payload)` validates and normalizes (typed 400 on a bad payload);
 *  - `read(ctx, resourceId)` returns the resource normalized to the payload's shape, plus
 *    whether the owner allows this seam to update it now (`locked`), or null when it is gone;
 *  - `diff(current, desired)` is PURE: the payload fields that differ;
 *  - `create(ctx, desired)` writes a new resource and returns its id — idempotent on
 *    `ctx.key` where the owner allows a caller-chosen id;
 *  - `update(ctx, resourceId, desired)` writes through the owner's own service.
 */

export interface PlaybookContentCtx {
  tenantId: string;
  /** The client org every write lands in. */
  orgId: string;
  /** Who acts (an agency admin). */
  by: string;
  /** Deterministic per (tenant, org, playbook, slot) — usable as a resource id. */
  key: string;
}

export interface PlaybookContentSnapshot {
  /** The resource, normalized to the payload's shape. */
  value: Record<string, unknown>;
  /** Owner concurrency token from the exact resource read. */
  revision: string | number;
  /** The owner refuses an update through this seam now (e.g. a live CMS page, ADR 0836). */
  locked?: string;
}

export interface PlaybookContentAdapter {
  kind: string;
  /** A short, human label of the kind ("CMS page"). */
  label: string;
  parse(payload: unknown): Record<string, unknown>;
  read(ctx: Omit<PlaybookContentCtx, 'by' | 'key'>, resourceId: string): Promise<PlaybookContentSnapshot | null>;
  diff(current: Record<string, unknown> | null, desired: Record<string, unknown>): string[];
  create(ctx: PlaybookContentCtx, desired: Record<string, unknown>): Promise<{ resourceId: string; snapshot: PlaybookContentSnapshot }>;
  update(ctx: PlaybookContentCtx, resourceId: string, desired: Record<string, unknown>, expected: PlaybookContentSnapshot): Promise<PlaybookContentSnapshot>;
}

const adapters = new Map<string, PlaybookContentAdapter>();

/** Called once at boot by the feature that owns `kind`. A second registration replaces. */
export function registerPlaybookContentAdapter(adapter: PlaybookContentAdapter): void {
  adapters.set(adapter.kind, adapter);
}

export function getPlaybookContentAdapter(kind: string): PlaybookContentAdapter | undefined {
  return adapters.get(kind);
}

export function listPlaybookContentKinds(): string[] {
  return [...adapters.keys()].sort();
}

/** The shallow field diff most adapters use: top-level keys of `desired` whose JSON differs. */
export function shallowFieldDiff(current: Record<string, unknown> | null, desired: Record<string, unknown>): string[] {
  if (!current) return Object.keys(desired).sort();
  return Object.keys(desired).filter((k) => JSON.stringify(current[k] ?? null) !== JSON.stringify(desired[k] ?? null)).sort();
}
