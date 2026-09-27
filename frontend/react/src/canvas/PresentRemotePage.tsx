/**
 * The phone-remote controller (ADR 0328 Phase 4 / research C3) — the public
 * page a scanned QR opens, rendered in the bare PublicShell like `/shared/:token`.
 * The capability token in the URL is the only credential: it grants the deck
 * OUTLINE (frame names + the presenter's notes) and the nav channel for one
 * canvas. Big touch targets; the presenter's position arrives over SSE.
 */
import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StateCard, Notice } from '../ui/index.js';
import { config } from '../client/config.js';
import { ChevronLeftIcon, ChevronRightIcon } from '../ui/icons/index.js';

interface OutlineFrame { name: string; notes?: string; skip?: boolean }
interface Outline { title: string; frames: OutlineFrame[] }

export function PresentRemotePage({ token }: { token: string }): JSX.Element {
  const { t } = useTranslation('canvas');
  const [outline, setOutline] = useState<Outline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  const [connected, setConnected] = useState(false);
  const [expired, setExpired] = useState(false);

  const base = `/host/openwop-app/present/${encodeURIComponent(token)}`;

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`${config.baseUrl}${base}/outline`);
        if (!res.ok) throw new Error(t('remoteExpired'));
        const data = (await res.json()) as Outline;
        if (live) setOutline(data);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : t('remoteExpired'));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [base, t]);

  // Presenter position over the public SSE feed.
  useEffect(() => {
    if (!outline) return;
    const es = new EventSource(`${config.sseBaseUrl}${base}/events`);
    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      // A CLOSED stream will NOT auto-reconnect (non-2xx — the token
      // expired/revoked); saying "Reconnecting…" forever would lie.
      if (es.readyState === EventSource.CLOSED) setExpired(true);
    };
    es.addEventListener('nav', (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data as string) as { kind?: string; current?: number };
        if (ev.kind === 'position' && typeof ev.current === 'number') setCurrent(ev.current);
      } catch { /* ignore malformed frames */ }
    });
    return () => es.close();
  }, [outline, base]);

  const send = useCallback((body: { action: string; index?: number }) => {
    void fetch(`${config.baseUrl}${base}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => { /* the position feed shows whether it landed */ });
  }, [base]);

  if (loading) return <div className="cv-remote"><StateCard loading title={t('loading')} /></div>;
  if (error || !outline || expired) return <div className="cv-remote"><Notice variant="error">{error ?? t('remoteExpired')}</Notice></div>;

  const frame = outline.frames[current];

  return (
    <div className="cv-remote">
      <header className="cv-remote__head">
        <h1 className="cv-remote__title">{outline.title}</h1>
        <span className={`chip${connected ? '' : ' chip--warning'}`}>{connected ? t('remoteConnected') : t('remoteReconnecting')}</span>
      </header>
      <div className="cv-remote__now">
        <p className="cv-remote__counter">{t('frameCounter', { n: current + 1, total: outline.frames.length })}</p>
        <h2 className="cv-remote__frame-name">{frame?.name ?? ''}</h2>
        <p className="cv-remote__notes">{frame?.notes || t('noNotes')}</p>
      </div>
      <div className="cv-remote__pad">
        <button type="button" className="cv-remote__btn" onClick={() => send({ action: 'prev' })} aria-label={t('prevFrame')}>
          <ChevronLeftIcon size={28} aria-hidden />
        </button>
        <button type="button" className="cv-remote__btn cv-remote__btn--primary" onClick={() => send({ action: 'next' })} aria-label={t('nextFrame')}>
          <ChevronRightIcon size={28} aria-hidden />
        </button>
      </div>
      <Button variant="secondary" size="sm" className="cv-remote__blank" onClick={() => send({ action: 'blank' })}>{t('blankBlack')}</Button>
      <nav className="cv-remote__list" aria-label={t('jumpGrid')}>
        {outline.frames.map((f, i) => (
          <button
            key={i}
            type="button"
            className={`cv-remote__row${i === current ? ' cv-remote__row--current' : ''}${f.skip ? ' cv-remote__row--skipped' : ''}`}
            aria-current={i === current ? 'true' : undefined}
            onClick={() => send({ action: 'goto', index: i })}
          >
            <span className="cv-remote__row-num">{i + 1}</span>
            <span className="cv-remote__row-name">{f.name}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
