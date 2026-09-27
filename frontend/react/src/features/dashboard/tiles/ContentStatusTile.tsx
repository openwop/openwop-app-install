/**
 * Content status tile (ADR 0377 Wave 2) — CMS pages by status (draft /
 * in-review / published / archived) as distribution bars. Org-scoped; owns no
 * data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { listPages, type Page, type PageStatus } from '../../cms/cmsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileBars } from '../TileBars.js';
import type { DashboardTileProps } from '../tileTypes.js';

const STATUSES: readonly PageStatus[] = ['draft', 'in_review', 'published', 'archived'];

export default function ContentStatusTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<Page[]>((orgId) => listPages(orgId));

  if (status === 'loading') return <SkeletonRows rows={3} columns={['30%', '55%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const pages = data ?? [];
  if (status === 'no-org' || pages.length === 0) return <p className="dash-tile__state muted">{t('contentEmpty')}</p>;

  const bars = STATUSES
    .map((s) => ({ key: s, label: t(`pageStatus_${s}`), value: pages.filter((p) => p.status === s).length }))
    .filter((b) => b.value > 0);

  return <TileBars bars={bars} />;
}
