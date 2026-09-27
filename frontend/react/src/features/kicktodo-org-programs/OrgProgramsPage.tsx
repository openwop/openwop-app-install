/**
 * Org programs (ADR 0428 P4) — the org-admin surface: curate the challenge
 * library (allowlist overlay, stated plainly) and read the k-anonymous
 * outcome report (withheld cells shown as withheld, never as small numbers).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BuildingIcon } from '../../ui/icons/index.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { listOrgs, type Organization } from '../../client/accessClient.js';
import {
  getOrgLibrary,
  setOrgLibraryEntry,
  getOrgReport,
  type OrgLibraryView,
  type OrgReportCell,
} from '../../client/kicktodoOrgClient.js';
import { listChallenges, type ChallengeSummary } from '../../client/kicktodoClient.js';

export function OrgProgramsPage() {
  const { t } = useTranslation('kicktodo-org-programs');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [orgId, setOrgId] = useState('');
  const [library, setLibrary] = useState<OrgLibraryView | null>(null);
  const [report, setReport] = useState<OrgReportCell[]>([]);
  // KT2-G1 — the report read failed; `[]` here is our ignorance, not their data.
  const [reportFailed, setReportFailed] = useState(false);
  const [catalog, setCatalog] = useState<ChallengeSummary[]>([]);
  // Screen-polish: an org switch shows a loading state, never the previous
  // org's data under the new selection.
  const [orgLoading, setOrgLoading] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState('');

  const loadOrg = useCallback(async (id: string) => {
    if (!id) return;
    try {
      setError(false);
      setOrgLoading(true);
      // KT2-G1 — the report is a MANAGEMENT view: `[]` renders "No circle
      // outcomes yet", which tells an org admin their programs produced nothing.
      // Swallowing the read made a failure indistinguishable from that claim.
      const [lib, cells] = await Promise.all([
        getOrgLibrary(id),
        getOrgReport(id).then((c) => ({ ok: true as const, c })).catch(() => ({ ok: false as const, c: [] as OrgReportCell[] })),
      ]);
      setLibrary(lib);
      setReport(cells.c);
      setReportFailed(!cells.ok);
    } catch {
      setError(true);
    } finally {
      setOrgLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [os, cs] = await Promise.all([listOrgs(), listChallenges().catch(() => [])]);
        setOrgs(os);
        setCatalog(cs);
        const first = os[0];
        if (first) {
          setOrgId(first.orgId);
          await loadOrg(first.orgId);
        }
      } catch {
        setError(true);
      } finally {
        setLoaded(true);
      }
    })();
  }, [loadOrg]);

  const inLibrary = (id: string, version: number): boolean =>
    Boolean(library?.library?.entries.some((e) => e.challengeId === id && e.version === version));

  // Per-ROW busy — toggling one challenge must not freeze the whole library.
  const toggleEntry = async (id: string, version: number) => {
    setBusy(`${id}@${version}`);
    try {
      await setOrgLibraryEntry(orgId, id, version, !inLibrary(id, version));
      await loadOrg(orgId);
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page" data-walkthrough="kicktodo-org-programs.page">
      <header className="page-header">
        <h1 className="page-header__title">{t('title')}</h1>
        <p className="page-header__lede">{t('lede')}</p>
      </header>

      {error && (
        <Notice variant="error">
          {t('loadError')}{' '}
          <Button variant="quiet" size="sm" onClick={() => void loadOrg(orgId)}>{t('common:retry')}</Button>
        </Notice>
      )}
      {!loaded && !error && <StateCard loading title={t('title')} />}

      {loaded && orgs.length === 0 && !error && (
        <StateCard icon={<BuildingIcon aria-hidden />} title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      )}

      {loaded && orgs.length > 0 && (
        <>
          <div className="action-bar">
            <label htmlFor="ktop-org">{t('orgLabel')}</label>
            <select
              id="ktop-org"
              value={orgId}
              onChange={(e) => {
                setOrgId(e.target.value);
                void loadOrg(e.target.value);
              }}
            >
              {orgs.map((o) => (
                <option key={o.orgId} value={o.orgId}>{o.name}</option>
              ))}
            </select>
          </div>

          {orgLoading && <StateCard loading title={t('title')} />}

          {!orgLoading && (
          <section className="surface-card" aria-label={t('libraryHeading')}>
            <h2>{t('libraryHeading')}</h2>
            <p className="muted">{library?.catalog.curated ? t('curatedNote') : t('uncuratedNote')}</p>
            {catalog.length > 4 && (
              <div className="filterbar">
                <input type="search" className="ui-input filterbar-search" value={libraryQuery}
                  onChange={(e) => setLibraryQuery(e.target.value)}
                  placeholder={t('librarySearchPlaceholder')} aria-label={t('librarySearchPlaceholder')} />
              </div>
            )}
            <ul role="list" className="list-plain">
              {catalog
                .filter((c) => !libraryQuery.trim() || c.title.toLowerCase().includes(libraryQuery.trim().toLowerCase()))
                .map((c) => (
                <li key={`${c.id}-${c.version}`} className="list-row">
                  <strong>{c.title}</strong>
                  <button
                    type="button"
                    className={inLibrary(c.id, c.version) ? 'chip chip--accent' : 'chip'}
                    aria-pressed={inLibrary(c.id, c.version)}
                    disabled={busy === `${c.id}@${c.version}`}
                    aria-busy={busy === `${c.id}@${c.version}`}
                    onClick={() => void toggleEntry(c.id, c.version)}
                  >
                    {inLibrary(c.id, c.version) ? t('inLibrary') : t('addToLibrary')}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          )}

          {!orgLoading && (
          <section className="surface-card" aria-label={t('reportHeading')}>
            <h2>{t('reportHeading')}</h2>
            <p className="muted">{t('reportPrivacyNote')}</p>
            {report.length === 0 && (reportFailed
              ? <StateCard announce title={t('reportFailedTitle')} body={t('reportFailedBody')}
                  action={<Button variant="secondary" size="sm" onClick={() => void loadOrg(orgId)}>{t('reportRetry')}</Button>} />
              : <StateCard title={t('reportEmptyTitle')} body={t('reportEmpty')} />
            )}
            <ul role="list" className="list-plain">
              {report.map((cell) => (
                <li key={cell.circleId} className="list-row">
                  {/* The challenge by NAME (the id was rendered raw despite the
                      loaded catalog — vocabulary leak); id demoted to tooltip. */}
                  <strong title={cell.challengeId}>
                    {catalog.find((c) => c.id === cell.challengeId)?.title ?? t('reportUnknownChallenge')}
                  </strong>
                  {cell.outcome ? (
                    <span>
                      {t('reportCell', {
                        active: cell.outcome.activeMembers,
                        completed: cell.outcome.completedMembers,
                        rate: Math.round(cell.outcome.completionRate * 100),
                      })}
                    </span>
                  ) : (
                    <span className="chip chip--muted">{t('withheld')}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
          )}
        </>
      )}
    </div>
  );
}
