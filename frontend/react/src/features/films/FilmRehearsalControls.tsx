import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { filmTimingHash, validateFilmPerformance, type FilmPerformance } from '../../../../../contracts/filmPerformance.js';
import type { FilmSpec } from '../../../../../contracts/films.js';
import { authedHeaders, fetchOpts } from '../../client/config.js';
import { Button } from '../../ui/Button.js';
import type { FilmTransport } from './useFilmTransport.js';
interface Summary { id: string; name: string; createdAt: string; durationMs: number }
interface SavedTake extends Summary { performance: FilmPerformance }
function takeUrl(endpoint: string, id?: string, after?: string): string {
  const u = new URL(endpoint, window.location.origin);
  if (id) u.pathname += '/' + encodeURIComponent(id);
  if (after) u.searchParams.set('after', after);
  return u.href;
}
async function request<T>(address: string, body?: unknown): Promise<T> {
  const response = await fetch(address, fetchOpts({ method: body ? 'POST' : 'GET', headers: authedHeaders({ 'content-type': 'application/json' }), ...(body ? { body: JSON.stringify(body) } : {}) }));
  if (!response.ok) throw new Error('Rehearsal request failed');
  return response.json() as Promise<T>;
}
const time = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
export function FilmRehearsalControls({ film, endpoint, transport: tr }: { film: FilmSpec; endpoint: string; transport: FilmTransport }): JSX.Element {
  const { t } = useTranslation('films');
  const [canSave, setCanSave] = useState(false);
  const [open, setOpen] = useState(false), [hash, setHash] = useState('');
  const [takes, setTakes] = useState<Summary[]>([]), [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(false), [saved, setSaved] = useState(false);
  const [name, setName] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true; setLoading(true); setError(false);
    void Promise.all([filmTimingHash(film), request<{ takes: Summary[]; next: string | null; canSave: boolean }>(takeUrl(endpoint))]).then(([h, data]) => {
      if (live) { setHash(h); setTakes(data.takes); setNext(data.next); setCanSave(data.canSave === true); }
    }).catch(() => { if (live) setError(true); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [open, endpoint, film, attempt]);
  const loadMore = async () => {
    if (!next || loading) return;
    setLoading(true); setError(false);
    try { const data = await request<{ takes: Summary[]; next: string | null; canSave: boolean }>(takeUrl(endpoint, undefined, next)); setTakes(old => [...old, ...data.takes]); setNext(data.next); setCanSave(data.canSave === true); }
    catch { setError(true); } finally { setLoading(false); }
  };
  const select = async (id: string) => {
    setLoading(true); setError(false); setSaved(false);
    try {
      const take = await request<SavedTake>(takeUrl(endpoint, id));
      if (take.id !== id || validateFilmPerformance(film, take.performance, hash).length) throw new Error('Invalid take');
      tr.review(take.performance);
    } catch { setError(true); } finally { setLoading(false); }
  };
  const save = async () => {
    const draft = tr.draft;
    if (!draft || saving || !canSave || !name.trim()) return;
    setSaving(true); setError(false); setSaved(false);
    try {
      const take = await request<SavedTake>(takeUrl(endpoint), { requestId: draft.requestId, name: name.trim(), performance: draft.performance });
      if (validateFilmPerformance(film, take.performance, hash).length) throw new Error('Invalid saved take');
      tr.saved(); tr.review(take.performance); setSaved(true); setAttempt(n => n + 1);
    } catch { setError(true); } finally { setSaving(false); }
  };
  return <section aria-label={t('rehearsal')}>
    <Button aria-expanded={open} disabled={tr.capturing || !!tr.draft || saving} onClick={() => setOpen(v => !v)}>{t('rehearsal')}</Button>
    {open && <div className="film-rehearsal__panel">
      <p>{t('rehearsalHelp')}</p>
      {loading && <p role="status">{t('takesLoading')}</p>}
      {error && <div><p role="alert">{t('takeError')}</p><Button disabled={loading || saving} onClick={() => setAttempt(n => n + 1)}>{t('retry')}</Button></div>}
      {!loading && !error && !canSave && <p>{t('takeReadOnly')}</p>}
      {saved && <p role="status">{t('takeSaved')}</p>}
      <div className="film-toolbar">
        {!tr.capturing ? <Button disabled={!hash || loading || saving || !!tr.draft || tr.playing} onClick={() => { setSaved(false); setName(t('takeDefault', { n: takes.length + 1 })); tr.startCapture(hash); }}>{t('startRehearsal')}</Button>
          : <><span role="status">{t('timingCapture')}</span><Button onClick={() => tr.stopCapture()}>{t('stopRehearsal')}</Button></>}
      </div>
      {tr.draft && <div>
        <p role="status">{t(tr.draft.interrupted ? 'takeInterrupted' : 'takeUnsaved', { duration: time(tr.draft.performance.durationMs) })}</p>
        <label>{t('takeName')}<input value={name} maxLength={80} disabled={saving} onChange={e => setName(e.target.value)} /></label>
        <div className="film-toolbar">
          <Button disabled={saving || tr.playing} onClick={() => tr.review(tr.draft!.performance)}>{t('reviewTake')}</Button>
          <Button disabled={saving || !canSave || tr.playing || !name.trim()} onClick={() => void save()}>{t(saving ? 'takeSaving' : 'saveTake')}</Button>
          <Button disabled={saving || tr.playing} onClick={tr.discardDraft}>{t('discardTake')}</Button>
        </div>
      </div>}
      {takes.length > 0 ? <label>{t('savedTakes')}<select value="" disabled={loading || saving || tr.capturing || !!tr.draft || tr.playing} onChange={e => { if (e.target.value) void select(e.target.value); }}>
        <option value="">{t('chooseTake')}</option>{takes.map(take => <option key={take.id} value={take.id}>{take.name} · {time(take.durationMs)}</option>)}
      </select></label> : !loading && !error && <p>{t('noTakes')}</p>}
      {next && <Button disabled={loading || saving} onClick={() => void loadMore()}>{t('moreTakes')}</Button>}
      {tr.replayTake && <div className="film-toolbar">
        <span>{t('silentReplay')}</span><Button disabled={saving || loading} onClick={tr.togglePlay}>{t(tr.playing ? 'pauseTake' : 'playTake')}</Button>
        <label>{t('seekTake')}<input type="range" min={0} max={tr.replayTake.durationMs} step={1} value={Math.round(tr.playheadMs)} disabled={saving || loading} onChange={e => tr.seek(Number(e.target.value))} aria-valuetext={`${time(tr.playheadMs)} / ${time(tr.replayTake.durationMs)}`} onKeyDown={e => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); tr.seek(tr.playheadMs + (e.key === 'ArrowRight' ? 1000 : -1000)); }
        }} /></label>
        <span role="timer" aria-live="off" aria-label={t('replayPosition')}>{time(tr.playheadMs)} / {time(tr.replayTake.durationMs)}</span>
        <Button disabled={tr.playing || saving || loading} onClick={tr.returnLive}>{t('returnLive')}</Button>
      </div>}
    </div>}
  </section>;
}
