/**
 * People & access (ADR 0438 A4) — the admin's read-only lens over WHO is in the
 * tenant and HOW the org programs compose, as AGGREGATES the platform-admin tier
 * may lawfully see: member counts by role and per-org link/library counts — never
 * a per-person row, never cohort membership, and (the B16 law) never a cohort
 * OUTCOME aggregate. Anything person- or consent-scoped is LINKED at its own
 * authority (`/access` at host:members:manage; each org's report at org-manager
 * authority, k-anon + consent re-verified per read). §3.3: this tier renders
 * server-authoritative facts and never mints roles — there is no write here.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { getAdminPeople, type AdminPeopleView } from '../../client/kicktodoOrgClient.js';

export function PeopleAccessPage(): JSX.Element {
  const { t } = useTranslation('kicktodo-admin');
  const [view, setView] = useState<AdminPeopleView | null | undefined>(undefined);

  const reload = useCallback(async () => {
    setView(undefined); // re-engage the loading state so Retry gives feedback
    try { setView(await getAdminPeople()); }
    catch { setView(null); }
  }, []);
  useEffect(() => { void reload(); }, [reload]); // KTUX-18 — retryable load

  return (
    <div className="page">
      <div className="action-bar">
        <Link className="btn-ghost btn-sm" to="/admin/kicktodo">{t('backToConsole')}</Link>
      </div>
      <header className="page-header">
        <h1 className="page-header__title">{t('peopleTitle')}</h1>
        <p className="page-header__lede">{t('peopleLede')}</p>
      </header>

      {view === undefined && <StateCard loading title={t('peopleTitle')} />}
      {view === null && (
        <>
          <Notice variant="error">{t('peopleError')}</Notice>
          <div className="action-bar">
            <Button variant="quiet" size="sm" onClick={() => void reload()}>{t('retry')}</Button>
          </div>
        </>
      )}

      {view && (
        <>
          <section className="surface-card" aria-label={t('peopleMembersHeading')}>
            <h2 className="kt-eyebrow">{t('peopleMembersHeading')}</h2>
            <p className="u-fs-13">{t('peopleMembersTotal', { count: view.members.total })}</p>
            {(view.members.byRole.length > 0 || view.members.rolelessCount > 0) && (
              <div className="action-bar">
                {/* DESIGN.md rule 13 — chips carry LOCALIZED labels: built-in role
                    ids map to catalog keys; a custom role id falls back verbatim
                    (it is operator-authored text, not an enum). */}
                {view.members.byRole.map(({ role, count }) => (
                  <span key={role} className="chip chip--muted">
                    {t('peopleRoleCount', { role: t(`peopleRole_${role}`, { defaultValue: role }), count })}
                  </span>
                ))}
                {view.members.rolelessCount > 0 && (
                  <span className="chip chip--muted">{t('peopleRoleNone', { count: view.members.rolelessCount })}</span>
                )}
              </div>
            )}
            <p className="muted u-fs-13">{t('peopleMembersNote')}</p>
            <div className="action-bar">
              <Link className="btn-ghost btn-sm" to="/access">{t('openAccess')}</Link>
            </div>
          </section>

          <section className="surface-card" aria-label={t('peopleOrgsHeading')}>
            <h2 className="kt-eyebrow">{t('peopleOrgsHeading')}</h2>
            {view.orgs.length === 0 ? (
              <p className="muted u-fs-13">{t('peopleOrgsEmpty')}</p>
            ) : (
              <ul role="list" className="list-plain">
                {view.orgs.map((org) => (
                  <li key={org.orgId} className="list-row">
                    <div>
                      <strong>{org.name}</strong>
                      <div className="action-bar">
                        <span className="chip chip--muted">{t('peopleOrgMembers', { count: org.memberCount })}</span>
                        <span className="chip chip--muted">{t('peopleOrgCohorts', { count: org.cohortLinkCount })}</span>
                        {org.libraryCurated && <span className="chip chip--success">{t('peopleOrgCurated')}</span>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="action-bar">
              <Link className="btn-ghost btn-sm" to="/kicktodo/org-programs">{t('openOrgPrograms')}</Link>
            </div>
          </section>

          {/* B16 — outcome aggregates are consent-gated per org link; this lens
              declares that posture instead of pretending the read exists here. */}
          <section className="surface-card" aria-label={t('peopleConsentHeading')}>
            <h2 className="kt-eyebrow">{t('peopleConsentHeading')}</h2>
            <p className="muted u-fs-13">{t('peopleB16Note')}</p>
          </section>
        </>
      )}
    </div>
  );
}
