/**
 * Export lineage (ADR 0348 6c — EX-04, the ADR 0343 `outputLineage` deferral
 * RESOLVED with an as-built correction): lineage lives in a durable SIDE
 * collection, NOT the canvas document — appending to the document would bump
 * its version and 409 any editor session open at export time (a conflict cost
 * the facet sketch missed). The document keeps ONE owner per concern: content
 * in `host.canvas`, output provenance here.
 */
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { onCanvasDeleted } from '../../../host/canvasLifecycle.js';
import { APP_BUILDER_CANVAS_TYPE } from '../componentCatalog.js';

export interface ExportLineageEntry {
  canvasVersion: number;
  target: string;
  fileCount: number;
  sizeBytes: number;
  /** sha256 of the generated ZIP — regenerate-and-compare provenance. */
  hash: string;
  /** The Media capability token (expires; the hash is the durable identity). */
  assetToken: string;
  exportedAt: string;
  warningCount: number;
}

const MAX_ENTRIES = 100;
interface LineageRow { id: string; tenantId: string; entries: ExportLineageEntry[] }
const rows = new DurableCollection<LineageRow>(
  'app-builder:export-lineage',
  (r) => r.id,
  undefined,
  (r) => r.tenantId,
);

const key = (tenantId: string, canvasId: string): string => `${tenantId}:${canvasId}`;

export async function appendExportLineage(tenantId: string, canvasId: string, entry: ExportLineageEntry): Promise<void> {
  const k = key(tenantId, canvasId);
  // CAS-retry, not get→put (grade pass AB-DATA-4): two concurrent exports of
  // the same canvas must BOTH keep their provenance row. 5 attempts dwarfs any
  // real overlap; a persistent loser surfaces via the route's best-effort log.
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await rows.get(k);
    const next: LineageRow = { id: k, tenantId, entries: [...(cur?.entries ?? []).slice(-(MAX_ENTRIES - 1)), entry] };
    if (await rows.compareAndSwap(cur ?? null, next)) return;
  }
  throw new Error('export-lineage append lost the CAS race 5 times');
}

export async function listExportLineage(tenantId: string, canvasId: string): Promise<ExportLineageEntry[]> {
  return (await rows.get(key(tenantId, canvasId)))?.entries ?? [];
}

/** ADR 0835 D1 — the lineage key for an export with no stored canvas (the
 *  surface's inline `export({ app })`, e.g. a render → export → deploy chain).
 *  One capped row per tenant; erased with the tenant like every row here. */
export const INLINE_LINEAGE_CANVAS = '_inline';

/** ADR 0835 D1 — did THIS tenant produce an export with this hash? A deploy's
 *  `exportHash` is its provenance; a hash the tenant never exported (another
 *  tenant's, or invented) must not be recorded as one. Tenant-prefix scan:
 *  one row per exported canvas. */
export async function isTenantExportHash(tenantId: string, hash: string): Promise<boolean> {
  for (const row of await rows.listForTenant(tenantId)) {
    if (row.tenantId === tenantId && row.entries.some((e) => e.hash === hash)) return true;
  }
  return false;
}

export async function deleteExportLineage(tenantId: string, canvasId: string): Promise<void> {
  await rows.delete(key(tenantId, canvasId));
}

/** Grade pass 2026-07-11 (AB-DATA-1): lineage rows are keyed to their canvas —
 *  without this hook a canvas delete strands them forever (tenant deletion was
 *  already covered via `tenantOf`, canvas deletion was not). Rides the ADR 0334
 *  `onCanvasDeleted` seam like comments/collab; keyed registration is
 *  boot-idempotent. Called from the feature's `registerRoutes`. */
export function registerExportLineageCleanup(): void {
  onCanvasDeleted('app-builder-export-lineage', async ({ tenantId, canvasId, canvasTypeId }) => {
    if (canvasTypeId !== APP_BUILDER_CANVAS_TYPE) return;
    await deleteExportLineage(tenantId, canvasId);
  });
}
