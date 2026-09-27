import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from './Notice.js';

/**
 * Shared "stale deep link" affordance (grade-ux DL-UX-6). A `?param=<id>` that
 * names no row in the loaded list — a deleted entity, or an old bookmark/shared
 * link — otherwise degrades silently to "nothing selected". These give it one
 * owner so every master-detail surface reads + behaves the same.
 */

/** True when the param is set, the list has loaded, and nothing matched. */
export function isDeepLinkMiss(param: string | null | undefined, listLoaded: boolean, matched: unknown): boolean {
  return Boolean(param) && listLoaded && matched == null;
}

/** A one-line notice whose "clear" action removes the stale param (clearing IS
 *  the dismiss — it drops the miss condition and composes with the URL). */
export function DeepLinkMissNotice({ show, onClear }: { show: boolean; onClear: () => void }): JSX.Element | null {
  const { t } = useTranslation('common');
  if (!show) return null;
  return (
    <Notice variant="info">
      {t('deepLinkMissing')}{' '}
      <button type="button" className="inline-link" onClick={onClear}>{t('deepLinkMissingClear')}</button>
    </Notice>
  );
}
