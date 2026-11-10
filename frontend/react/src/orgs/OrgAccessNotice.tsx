/**
 * ADR 1034 (grade-ux H1) — the ONE notice a page shows when it could not read what the
 * caller may change. `useOrgScopes` hides manager controls until the answer is in; when the
 * read FAILS, a manager would otherwise lose every control with no word why, and could not
 * tell an outage from a demotion. Shared so the three sales-ops pages do not hand-roll it.
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../ui/Notice.js';
import { Button } from '../ui/Button.js';
import type { OrgScopes } from './useOrgScopes.js';

export function OrgAccessNotice({ access }: { access: Pick<OrgScopes, 'failed' | 'retry'> }): JSX.Element | null {
  const { t } = useTranslation('orgs');
  if (!access.failed) return null;
  return (
    <Notice variant="warning" announce={t('accessReadFailed')}>
      {t('accessReadFailed')} <Button variant="link" onClick={access.retry}>{t('accessReadRetry')}</Button>
    </Notice>
  );
}
