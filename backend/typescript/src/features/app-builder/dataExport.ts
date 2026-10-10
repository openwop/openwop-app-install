/**
 * ADR 0820 §7 — App Builder's READ-ONLY data exporter for the portability lapsed-data
 * door (`host/featureDataExport.ts`; the CRM exporter is the reference). List
 * calls only: no write, no mutation event, no run, no model call. Tenant-scoped
 * to the `tenantId` given; workspace-wide (the door is admin-class).
 * The app definitions are the tenant's `canvas.app-builder` canvases, exported
 * whole (state = the app document). Sync bindings are not exported: their row
 * carries a sealed webhook secret.
 */
import { getCanvasForTenant, listCanvasesForTenant } from '../../host/canvasSurface.js';
import { APP_BUILDER_CANVAS_TYPE } from './componentCatalog.js';
import type { FeatureDataSections } from '../../host/featureDataExport.js';

export async function exportAppBuilderData(tenantId: string): Promise<FeatureDataSections> {
  const apps: unknown[] = [];
  for (const row of await listCanvasesForTenant(tenantId)) {
    if (row.canvasTypeId !== APP_BUILDER_CANVAS_TYPE) continue;
    const doc = await getCanvasForTenant(tenantId, row.canvasId);
    if (doc) apps.push({ ...doc, updatedAt: row.updatedAt });
  }
  return { apps };
}
