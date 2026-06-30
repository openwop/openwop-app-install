/**
 * RoleCatalogPanel — read-only reference of built-in roles + their scopes,
 * extracted from OrgsPage (GAP-ANALYSIS E11). Purely presentational.
 */

import { useTranslation } from 'react-i18next';
import type { AccessRole } from '../client/accessClient.js';
import { ShieldIcon } from '../ui/icons/index.js';
import { NEUTRAL_CHIP, muted } from './orgUi.js';

export function RoleCatalogPanel({ roles }: { roles: AccessRole[] }): JSX.Element {
  const { t } = useTranslation('orgs');
  return (
    <>
      <h3 className="u-fs-14 u-mt-5 u-flex u-items-center u-gap-2">
        <ShieldIcon size={15} /> {t('roleCatalogHeading')}
      </h3>
      <p style={muted}>{t('roleCatalogIntro')}</p>
      {roles.map((r) => (
        <div key={r.id} className="surface-card u-mb-2">
          <div className="u-flex u-items-center u-gap-2">
            <span className={NEUTRAL_CHIP}>{r.id}</span>
            <span style={muted}>{r.description}</span>
          </div>
          <div className="u-flex u-wrap u-gap-1-5 u-mt-1-5">
            {r.scopes.map((s) => (
              <span key={s} className={`${NEUTRAL_CHIP} u-fs-11`}>{s}</span>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
