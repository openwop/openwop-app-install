import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { validateFilm, type FilmSpec } from '../../../../../contracts/films.js';
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { listOrgs, asJson } from '../../canvas/canvasClient.js';
import { resolveCanvasOrg } from '../../canvas/resolveCanvasOrg.js';
import { CanvasOrgGate } from '../../canvas/CanvasOrgGate.js';
import { Button } from '../../ui/Button.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { FilmPresenter } from './FilmPresenter.js';
interface LoadedFilm { canvasId: string; version: number; film: FilmSpec; assetUrls: Record<string, string> }
export function FilmPresentPage(): JSX.Element {
  const { t } = useTranslation('films');
  const { canvasId } = useParams();
  const [params, setParams] = useSearchParams();
  const org = params.get('org');
  const { orgs, orgsFailed, retry: retryOrgs } = useOrgSelection(listOrgs, true, org ?? '', { scopeKey: org ?? '' });
  const resolved = orgs === null ? null : resolveCanvasOrg([...orgs], org);
  const orgId = resolved?.kind === 'ok' ? resolved.orgId : '';
  const sourceKey = orgId && canvasId ? `${orgId}:${canvasId}` : '';
  const [loaded, setLoaded] = useState<{ sourceKey: string; data: LoadedFilm } | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true; setLoaded(null); setError(false);
    if (!orgId || !canvasId) return;
    void (async () => {
      try {
        const response = await fetch(`${config.baseUrl}/host/openwop-app/films/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}/presenter`, fetchOpts({ headers: authedHeaders() }));
        const data = await asJson<LoadedFilm>(response, 'film');
        if (validateFilm(data.film).length) throw new Error('Invalid film');
        const urls = Object.fromEntries(Object.entries(data.assetUrls).map(([id, url]) => [id, url.startsWith('http') ? url : `${config.baseUrl}${url}`]));
        if (live) setLoaded({ sourceKey, data: { ...data, assetUrls: urls } });
      } catch { if (live) setError(true); }
    })();
    return () => { live = false; };
  }, [canvasId, orgId, sourceKey, attempt]);
  const current = sourceKey && loaded?.sourceKey === sourceKey ? loaded.data : null;
  return <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs} emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')}>
    {resolved && resolved.kind !== 'ok' ? <CanvasOrgGate resolution={resolved} onPick={id => setParams(previous => { const next = new URLSearchParams(previous); next.set('org', id); return next; })} />
      : error ? <div><p role="alert">{t('loadError')}</p><Button onClick={() => setAttempt(v => v + 1)}>{t('retry')}</Button></div>
      : !current ? <p role="status">{t('loading')}</p>
      : <FilmPresenter key={`${current.canvasId}:${current.version}`} film={current.film} source={`canvas:${current.canvasId}:${current.version}`} assetUrls={current.assetUrls} />}
  </OrgSelectionState>;
}
