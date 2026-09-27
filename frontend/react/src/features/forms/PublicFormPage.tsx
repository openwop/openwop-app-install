/**
 * ADR 0331 §D3 — the hosted public fill page at `/f/:formId`, rendered in the
 * bare PublicShell (the `/store/:orgId` posture: anonymous or signed-in
 * visitors get the same page). A missing/unpublished/toggled-off form shows a
 * designed unavailable state — uniform, no draft-existence leak.
 */

import { useTranslation } from 'react-i18next';
import { StateCard } from '../../ui/StateCard.js';
import { SearchIcon } from '../../ui/icons/index.js';
import { PublicFormRenderer } from './render/PublicFormRenderer.js';

export function PublicFormPage({ formId }: { formId: string }): JSX.Element {
  const { t } = useTranslation('forms');
  return (
    <div className="u-mx-auto u-w-full u-p-4 u-maxw-560">
      <PublicFormRenderer
        formId={formId}
        titleAs="h1"
        renderUnavailable={() => (
          <StateCard announce icon={<SearchIcon />} title={t('fillUnavailableTitle')} body={t('fillUnavailableBody')} />
        )}
      />
    </div>
  );
}
