import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { audienceFilm, evaluateFilm, filmSteps, validateFilm, type FilmSpec } from '../../../../../contracts/films.js';
import { Button } from '../../ui/Button.js';
import { ModalPortal } from '../../ui/ModalPortal.js';
import { FilmStage } from './FilmStage.js';
import { firstFilmPosition, moveFilm, validPosition, type FilmPosition } from './playback.js';

interface Snapshot { type: 'snapshot'; source: string; film: FilmSpec; position: FilmPosition; assetUrls: Record<string, string> }
const channelName = (id: string) => `owp-film:${id}`;
function validSession(value: string | null): value is string { return !!value && /^[a-zA-Z0-9_-]{1,100}$/.test(value); }
function targetIsInput(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input,textarea,select,[contenteditable="true"],[role="menu"],[role="dialog"]');
}

/** Reusable manual presenter, pinned by source (e.g. canvas/version or project/revision).
 * No media capture, speech synthesis, auto narration or provider connection is used.
 */
interface PresenterProps { film: FilmSpec; source: string; assetUrls?: Record<string, string> }
export function FilmPresenter(props: PresenterProps): JSX.Element {
  const { t } = useTranslation('films');
  if (validateFilm(props.film).length) return <p role="alert">{t('invalid')}</p>;
  return <ManualFilmPresenter key={props.source} {...props} />;
}
function ManualFilmPresenter({ film, source, assetUrls = {} }: PresenterProps): JSX.Element {
  const { t } = useTranslation('films');
  const [position, setPosition] = useState(firstFilmPosition);
  const [elapsed, setElapsed] = useState(0);
  const [audience, setAudience] = useState<'closed' | 'waiting' | 'connected' | 'blocked' | 'unsupported'>('closed');
  const [fullscreenError, setFullscreenError] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const root = useRef<HTMLDivElement>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const audienceWindow = useRef<Window | null>(null);
  const latest = useRef<Snapshot>({ type: 'snapshot', source, film: audienceFilm(film), position, assetUrls });
  const safeFilm = useMemo(() => audienceFilm(film), [film]);
  const steps = useMemo(() => filmSteps(film), [film]);
  const current = evaluateFilm(film, position.step, position.progress).scene;
  latest.current = { type: 'snapshot', source, film: safeFilm, position, assetUrls };
  const move = useCallback((direction: 'next' | 'back') => setPosition(p => moveFilm(film, p, direction, reducedMotion)), [film, reducedMotion]);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const update = () => setReducedMotion(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => { if (reducedMotion) setPosition(p => ({ ...p, progress: 1 })); }, [reducedMotion]);
  // The only running clock is the active transition. Completion holds indefinitely.
  useEffect(() => {
    if (position.progress >= 1) return;
    const duration = steps[position.step]!.durationMs;
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = duration ? Math.min(1, (now - started) / duration) : 1;
      setPosition(p => p.step === position.step && p.progress < 1 ? { ...p, progress } : p);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // Progress is deliberately excluded: one animation clock per selected cue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position.step, position.progress < 1]);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [source]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || targetIsInput(event.target)) return;
      // Space activates a focused button/link natively; arrows remain film
      // controls after a mouse click has focused one of the presenter buttons.
      if (event.key === ' ' && event.target instanceof Element && event.target.closest('button,a')) return;
      if (['ArrowRight', 'ArrowDown', ' ', 'PageDown'].includes(event.key)) { event.preventDefault(); move('next'); }
      else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) { event.preventDefault(); move('back'); }
      else if (event.key.toLowerCase() === 'b') setPosition(p => ({ ...p, blank: !p.blank }));
      else if (event.key === 'Home') { event.preventDefault(); setPosition(firstFilmPosition()); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move]);
  useEffect(() => { channel.current?.postMessage(latest.current); }, [position, safeFilm, source, assetUrls]);
  useEffect(() => () => { channel.current?.close(); }, []);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (audienceWindow.current?.closed) { setAudience('closed'); channel.current?.close(); channel.current = null; audienceWindow.current = null; }
      else channel.current?.postMessage(latest.current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  const openAudience = () => {
    if (typeof BroadcastChannel === 'undefined') { setAudience('unsupported'); return; }
    channel.current?.close();
    const id = crypto.randomUUID();
    const next = new BroadcastChannel(channelName(id));
    channel.current = next;
    next.onmessage = event => { if (event.data?.type === 'hello' && event.data.source === source) { setAudience('connected'); next.postMessage(latest.current); } };
    const url = new URL('/films/audience', window.location.origin);
    url.hash = new URLSearchParams({ channel: id, source }).toString();
    // No opener access: the audience is a notes-free, receive-only surface.
    audienceWindow.current = window.open(url, `film-${id}`, 'popup,width=1280,height=800');
    if (audienceWindow.current) { audienceWindow.current.opener = null; setAudience('waiting'); }
    else { next.close(); channel.current = null; setAudience('blocked'); }
  };
  return <div className="film-presenter" ref={root}>
    <header className="film-toolbar"><h1>{film.title}</h1><span>{t('live')}</span><span role="timer" aria-live="off" aria-label={t('elapsed')}>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
      <Button onClick={openAudience}>{t('openAudience')}</Button>
      <Button onClick={() => { setFullscreenError(false); if (!root.current?.requestFullscreen) setFullscreenError(true); else void root.current.requestFullscreen().catch(() => setFullscreenError(true)); }}>{t('fullscreen')}</Button>
    </header>
    <p className="muted">{t('instructions')}</p>
    <p role="status">{t(`audience_${audience}`)} {fullscreenError ? t('fullscreenError') : ''}</p>
    <main className="film-presenter__main">
      <section aria-label={t('current')}><FilmStage film={safeFilm} position={position} assetUrls={assetUrls} />
        <div className="film-toolbar">
          <Button disabled={position.step === 0} onClick={() => move('back')}>{t('back')}</Button>
          <Button variant="primary" disabled={position.step === steps.length - 1 && position.progress === 1} onClick={() => move('next')}>{position.progress < 1 ? t('complete') : t('next')}</Button>
          <Button aria-pressed={position.blank} onClick={() => setPosition(p => ({ ...p, blank: !p.blank }))}>{position.blank ? t('show') : t('blank')}</Button>
          <Button onClick={() => setPosition(firstFilmPosition())}>{t('restart')}</Button>
          <span role="status">{t('position', { current: position.step + 1, total: steps.length })} · {position.progress < 1 ? t('animating') : t('holding')}</span>
        </div>
      </section>
      <aside><h2>{t('notes')}</h2><p className="film-notes">{current.notes || t('noNotes')}</p>
        <h2>{t('upNext')}</h2>{position.step + 1 < steps.length ? <><p>{steps[position.step + 1]!.label}</p><FilmStage film={safeFilm} position={{ ...position, blank: false, step: position.step + 1, progress: 1 }} assetUrls={assetUrls} /></> : <p>{t('end')}</p>}
      </aside>
    </main>
    <nav className="film-timeline" aria-label={t('timeline')}>{steps.map((step, i) => <Button key={`${step.sceneId}:${step.cueId ?? 'start'}`} size="sm" aria-current={i === position.step ? 'step' : undefined}
      onClick={() => setPosition(p => ({ ...p, step: i, progress: 1 }))}>{i + 1}. {step.label}</Button>)}</nav>
  </div>;
}

/** Audience never loads the private canvas/project. Only sanitized presenter
 * snapshots arrive over a per-opening, same-origin channel. No notes/controls. */
export function FilmAudience(): JSX.Element {
  const { t } = useTranslation('films');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The authenticated app shell stays mounted for its authority lifecycle,
    // but it must not appear or receive focus on the shared audience screen.
    const shell = document.getElementById('root');
    const wasInert = shell?.inert ?? false;
    if (shell) shell.inert = true;
    root.current?.querySelector('button')?.focus();
    return () => { if (shell) shell.inert = wasInert; };
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const id = params.get('channel'), source = params.get('source');
    if (!validSession(id) || !source || source.length > 300 || typeof BroadcastChannel === 'undefined') { setDisconnected(true); return; }
    const channel = new BroadcastChannel(channelName(id));
    let last = Date.now();
    channel.onmessage = event => {
      const data = event.data as Snapshot;
      if (data?.type !== 'snapshot' || data.source !== source || validateFilm(data.film).length || !validPosition(data.film, data.position)) return;
      // Only bounded asset entries for known image elements, never arbitrary fields.
      const urls: Record<string, string> = {};
      for (const scene of data.film.scenes) for (const e of scene.elements) if (e.kind === 'image' && e.assetId) {
        const raw = data.assetUrls?.[e.assetId];
        if (typeof raw === 'string' && raw.length < 4096) { try { const url = new URL(raw, window.location.origin); if (['https:', 'http:'].includes(url.protocol)) urls[e.assetId] = url.href; } catch { /* malformed media omitted */ } }
      }
      last = Date.now(); setDisconnected(false);
      setSnapshot({ type: 'snapshot', source, film: audienceFilm(data.film), position: { step: data.position.step, progress: data.position.progress, blank: data.position.blank }, assetUrls: urls });
    };
    channel.postMessage({ type: 'hello', source });
    const timer = window.setInterval(() => { setDisconnected(Date.now() - last > 4000); channel.postMessage({ type: 'hello', source }); }, 1000);
    return () => { window.clearInterval(timer); channel.close(); };
  }, []);
  return <ModalPortal><div className="film-audience" ref={root}>
    {snapshot && !disconnected ? <FilmStage film={snapshot.film} position={snapshot.position} assetUrls={snapshot.assetUrls} /> : <p role="status">{t(disconnected ? 'disconnected' : 'waiting')}</p>}
    <Button className="film-audience__fullscreen" onClick={() => { if (!root.current?.requestFullscreen) setFullscreenError(true); else void root.current.requestFullscreen().catch(() => setFullscreenError(true)); }}>{t('fullscreen')}</Button>
    {fullscreenError && <p role="status">{t('fullscreenError')}</p>}
  </div></ModalPortal>;
}
