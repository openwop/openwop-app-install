/**
 * Recent documents tile (ADR 0375 Phase 3) — the org's most-recently-updated
 * documents (ADR 0350), over the EXISTING documents client. Org-scoped via the
 * shared `useOrgResource`; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { listDocuments, type DocumentRecord } from '../../documents/documentsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatRelativeTime } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function RecentDocumentsTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<DocumentRecord[]>((orgId) => listDocuments(orgId));

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['70%', '45%', '50%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  if (status === 'no-org') return <p className="dash-tile__state muted">{t('documentsEmpty')}</p>;

  const docs = [...(data ?? [])]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, compact ? 4 : 8);
  if (docs.length === 0) return <p className="dash-tile__state muted">{t('documentsEmpty')}</p>;

  return (
    <ul className="dash-tile__list u-list-none u-m-0 u-p-0">
      {docs.map((d) => (
        <li key={d.documentId} className="dash-tile__row">
          <Link to="/documents" className="dash-tile__row-main u-truncate" title={d.title}>{d.title || t('untitledDocument')}</Link>
          <span className="dash-tile__row-meta muted">{formatRelativeTime(d.updatedAt)}</span>
        </li>
      ))}
    </ul>
  );
}
