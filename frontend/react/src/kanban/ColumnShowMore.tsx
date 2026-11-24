/**
 * ADR 1155 D7 — the footer of a paged column: how much of the column is showing, and
 * a button for the next page. Renders nothing once the column is complete.
 */
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';

export function ColumnShowMore({ shown, total, hasMore, loading, onMore }: {
  shown: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
}): JSX.Element | null {
  const { t } = useTranslation('kanban');
  if (!hasMore) return null;
  return (
    <Button variant="quiet" size="sm" loading={loading} onClick={onMore}>
      {loading ? t('loadingMoreCards') : t('showMoreCards', { shown, total })}
    </Button>
  );
}
