/**
 * ADR 0820 §7 — "downgrade never deletes data; a read-only export goes through
 * `portability`". The host seam a feature registers its READ-ONLY data exporter
 * into, so the core `portability` feature can hand a workspace its data back
 * after the plan stopped including that feature.
 *
 * Why a seam and not an import: `portability` is a LEAF core feature and must
 * not import every paid feature's services; a feature that owns data registers
 * `(tenantId) => sections` from its own `registerRoutes`, the same direction as
 * `registerRetentionPurger` / `registerSubjectEraser`.
 *
 * The contract an exporter MUST keep (it is the whole safety argument of the
 * lapsed-export door, which deliberately serves a plan-refused feature):
 *   - READ ONLY. It lists rows; it never writes, emits a mutation event, starts a
 *     run or calls a model. The door is reachable while every write lane of the
 *     feature still refuses, so an exporter that wrote would be a paywall bypass.
 *   - TENANT-SCOPED to the `tenantId` it is given, nothing else.
 *   - Workspace-wide: the door is admin-class (`host:billing:manage`), so the
 *     exporter returns the workspace's rows, not one member's view.
 */

import { listOrgs } from './accessControlService.js';

/** One export: named sections of plain rows (`{ contacts: [...], deals: [...] }`). */
export type FeatureDataSections = Record<string, readonly unknown[]>;
export type FeatureDataExporter = (tenantId: string) => Promise<FeatureDataSections>;

const exporters = new Map<string, FeatureDataExporter>();

/** Register `featureId`'s read-only exporter. Last registration wins (a re-boot in
 *  one process re-registers the same function). */
export function registerFeatureDataExporter(featureId: string, exporter: FeatureDataExporter): void {
  exporters.set(featureId, exporter);
}

export function featureDataExporter(featureId: string): FeatureDataExporter | null {
  return exporters.get(featureId) ?? null;
}

/**
 * ADR 1110 P3 — the PAGED form, for a feature whose data cannot be read whole in one
 * request (a catalog of up to 500,000 products): the door hands the exporter an opaque
 * `cursor` and a row `limit`, and the exporter returns one page of sections plus the
 * next cursor (absent on the last page). Same contract as above: read only,
 * tenant-scoped, workspace-wide. A feature registers one form or the other; the paged
 * form wins when both exist.
 */
export interface FeatureDataPage { sections: FeatureDataSections; nextCursor?: string }
export type FeatureDataPagedExporter = (tenantId: string, page: { cursor?: string; limit: number }) => Promise<FeatureDataPage>;
const pagedExporters = new Map<string, FeatureDataPagedExporter>();
export function registerFeatureDataPagedExporter(featureId: string, exporter: FeatureDataPagedExporter): void {
  pagedExporters.set(featureId, exporter);
}
export function featureDataPagedExporter(featureId: string): FeatureDataPagedExporter | null {
  return pagedExporters.get(featureId) ?? null;
}

/** Feature ids with a registered exporter of either form, sorted (the door's discovery list). */
export function exportableFeatureIds(): string[] {
  return [...new Set([...exporters.keys(), ...pagedExporters.keys()])].sort();
}

/** Concatenate an org-scoped list over every org of `tenantId` (tenant-scoped:
 *  `listOrgs` reads the tenant index). The helper the per-org exporters share. */
export async function collectPerOrg<T>(tenantId: string, list: (orgId: string) => Promise<readonly T[]>): Promise<T[]> {
  const out: T[] = [];
  for (const org of await listOrgs(tenantId)) out.push(...await list(org.orgId));
  return out;
}

/** ADR 0820 §7 — the door pages every section so a response stays bounded: at
 *  most this many rows per section per request (`?offset=` walks the rest). */
export const EXPORT_PAGE_MAX = 2000;
