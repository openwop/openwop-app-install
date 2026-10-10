/**
 * ADR 0820 §7 — the client for the portability lapsed-data door
 * (`GET /host/openwop-app/export/features[/:featureId]`, admin/owner only,
 * `host:billing:manage`). "Your data stays, paid features pause": a workspace
 * whose plan stopped including a feature can still take its data out.
 *
 * Lazy-only: imported by `YourDataPanel` / `ExportDataButton`, never by entry.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { ApiError } from '../../client/errorEnvelope.js';
import { downloadBlob } from '../../canvas/exportUtils.js';

const root = `${config.baseUrl}/host/openwop-app/export/features`;

export interface ExportableFeature { featureId: string; label: string; access: 'entitled' | 'plan-lapsed' }
interface ExportPage {
  featureId: string; readOnly: true; access: string; exportedAt: string;
  sections: Record<string, unknown[]>;
  page?: { offset: number; limit: number; totals: Record<string, number>; nextOffset: number | null };
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => undefined) as { message?: unknown } | undefined;
    const msg = typeof body?.message === 'string' ? body.message : undefined;
    throw new ApiError(msg ?? `${what} returned ${res.status}`, res.status, msg);
  }
  return (await res.json()) as T;
}

/** The features THIS workspace can export right now (entitled or plan-lapsed). */
export async function listExportableFeatures(): Promise<ExportableFeature[]> {
  const body = await readJson<{ exportable?: ExportableFeature[] }>(await fetch(root, fetchOpts({ headers: authedHeaders() })), 'export list');
  return Array.isArray(body.exportable) ? body.exportable : [];
}

/** Every page of one feature's export, merged into ONE JSON document. The server
 *  pages each section (bounded responses); this walks `nextOffset` to the end. */
export async function fetchFeatureExport(featureId: string): Promise<ExportPage> {
  const url = `${root}/${encodeURIComponent(featureId)}`;
  let merged: ExportPage | null = null;
  let offset: number | null = 0;
  for (let guard = 0; offset !== null && guard < 1000; guard += 1) {
    const page: ExportPage = await readJson<ExportPage>(await fetch(`${url}?offset=${offset}`, fetchOpts({ headers: authedHeaders() })), 'export');
    if (!merged) merged = { ...page, sections: { ...page.sections } };
    else for (const [k, rows] of Object.entries(page.sections)) merged.sections[k] = [...(merged.sections[k] ?? []), ...rows];
    offset = page.page?.nextOffset ?? null;
  }
  if (!merged) throw new Error('export returned no page');
  const { page: _page, ...doc } = merged;
  void _page;
  return doc;
}

/** Fetch and save `<featureId>-export-<date>.json` through the shared download helper. */
export async function downloadFeatureExport(featureId: string): Promise<void> {
  const doc = await fetchFeatureExport(featureId);
  downloadBlob(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), `${featureId}-export-${doc.exportedAt.slice(0, 10)}.json`);
}
