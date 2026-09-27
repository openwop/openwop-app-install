/**
 * Continue working tile (ADR 0377 Wave 3) — resume your most-recently-updated
 * canvases/documents (MyndHyve's default #1 widget), over the EXISTING
 * documents client (`listCanvasSources`). Org-scoped; owns no data (ADR 0082).
 * Rows deep-link into each canvas's own editor (the same toggle-gated
 * resolution as DocumentsPage's `openPathFor`) — a resume tile that lands on
 * a list page isn't resuming anything. A row whose editor feature is off
 * falls back to `/documents`, where the row is still visible/deletable.
 */
import { useTranslation } from 'react-i18next';
import { listCanvasSources, type CanvasSourceRow } from '../../documents/documentsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatRelativeTime } from '../../../i18n/format.js';
import { useFeatureAccess } from '../../../featureToggles/FeatureAccessContext.js';
import { useCreatableTypeAccess } from '../../../canvas/useCreatableTypeAccess.js';
import { CREATABLE_CANVAS_TYPES } from '../../../canvas/creatableTypes.js';
import { useDashboardOrg } from '../useDashboardOrg.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileList } from '../TileList.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function ContinueWorkingTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { orgId } = useDashboardOrg();
  const canvasAccess = useCreatableTypeAccess();
  const packsAccess = useFeatureAccess('canvas-packs');
  const { status, data } = useOrgResource<{ canvases: CanvasSourceRow[] }>((oid) => listCanvasSources(oid));

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['70%', '40%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;

  const openPathFor = (c: CanvasSourceRow): string => {
    const q = orgId ? `?org=${encodeURIComponent(orgId)}` : '';
    const def = CREATABLE_CANVAS_TYPES.find((d) => d.canvasTypeId === c.canvasTypeId);
    if (def) return canvasAccess[def.toggleId]?.enabled ? `${def.editorPath}/${c.canvasId}${q}` : '/documents';
    return packsAccess.enabled ? `/canvas/${c.canvasTypeId}/${c.canvasId}${q}` : '/documents';
  };
  const rows = [...(data?.canvases ?? [])]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, compact ? 4 : 8)
    .map((c) => ({ key: c.canvasId, label: c.name || t('untitledDocument'), to: openPathFor(c), meta: formatRelativeTime(c.updatedAt) }));
  if (status === 'no-org' || rows.length === 0) return <p className="dash-tile__state muted">{t('continueEmpty')}</p>;
  return <TileList rows={rows} />;
}
