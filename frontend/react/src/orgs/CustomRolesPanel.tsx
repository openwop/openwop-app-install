/**
 * CustomRolesPanel — the org-defined custom-role builder section of the Orgs
 * admin page, extracted from OrgsPage (GAP-ANALYSIS E11). Presentational;
 * state + handlers stay lifted.
 */

import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { CustomRole } from '../client/accessClient.js';
import { PencilIcon, TrashIcon } from '../ui/icons/index.js';
import { NEUTRAL_CHIP } from './orgUi.js';

export interface CustomRolesPanelProps {
  customRoles: CustomRole[];
  roleName: string;
  setRoleName: (v: string) => void;
  roleScopes: Set<string>;
  setRoleScopes: Dispatch<SetStateAction<Set<string>>>;
  assignableScopes: string[];
  onCreateRole: (e: FormEvent) => void;
  onDeleteRole: (r: CustomRole) => void;
  can: (scope: string) => boolean;
  toggleStr: (set: Set<string>, id: string) => Set<string>;
}

export function CustomRolesPanel({
  customRoles, roleName, setRoleName, roleScopes, setRoleScopes, assignableScopes,
  onCreateRole, onDeleteRole, can, toggleStr,
}: CustomRolesPanelProps): JSX.Element {
  const { t } = useTranslation('orgs');
  return (
    <>
      <h3 className="u-fs-14 u-mt-5 u-flex u-items-center u-gap-2">
        <PencilIcon size={15} /> {t('customRolesHeading')} <span className="customroles-muted">{t('customRolesHeadingSuffix')}</span>
      </h3>
      <p className="customroles-muted">
        {t('customRolesIntro')}
      </p>
      <form onSubmit={onCreateRole} className="action-bar u-wrap u-mb-2">
        <input value={roleName} onChange={(e) => setRoleName(e.target.value)} placeholder={t('newRolePlaceholder')} aria-label={t('newRoleAriaLabel')} />
        <button
          type="submit"
          className="primary"
          disabled={!roleName.trim() || roleScopes.size === 0 || !can('host:roles:manage')}
          title={can('host:roles:manage') ? undefined : t('createRoleRequiresScope')}
        >
          {t('createRole')}
        </button>
      </form>
      <div className="u-flex u-wrap u-gap-1-5 u-mb-3">
        {assignableScopes.map((s) => (
          <label
            key={s}
            className={`${NEUTRAL_CHIP} customroles-scope-toggle`}
            style={{ opacity: roleScopes.has(s) ? 1 : 0.65 }}
          >
            <input type="checkbox" checked={roleScopes.has(s)} onChange={() => setRoleScopes((x) => toggleStr(x, s))} className="u-mr-1" />
            {s}
          </label>
        ))}
      </div>
      {customRoles.length === 0 ? (
        <p className="customroles-muted">{t('noCustomRolesYet')}</p>
      ) : (
        customRoles.map((r) => (
          <div key={r.roleId} className="surface-card u-mb-2">
            <div className="u-flex u-justify-between u-items-baseline u-gap-2">
              <strong>{r.name}</strong>
              <button type="button" className="secondary" disabled={!can('host:roles:manage')} onClick={() => void onDeleteRole(r)} aria-label={t('deleteRoleAriaLabel', { name: r.name })}>
                <TrashIcon size={13} />
              </button>
            </div>
            <div className="u-flex u-wrap u-gap-1-5 u-mt-1-5">
              {r.scopes.length === 0 ? (
                <span className="chip chip--muted">{t('noScopes')}</span>
              ) : (
                r.scopes.map((s) => (
                  <span key={s} className={`${NEUTRAL_CHIP} u-fs-11`}>{s}</span>
                ))
              )}
            </div>
          </div>
        ))
      )}
    </>
  );
}
