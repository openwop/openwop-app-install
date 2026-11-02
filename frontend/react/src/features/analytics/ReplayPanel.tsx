/**
 * ADR 0951 P2.4 — the session-recording viewer (lazy-loaded), for owners and
 * admins of the exact organization.
 *
 * INERT by construction: a recording is numbers only (boxes, fixed placeholders,
 * pointer and scroll positions in the closed P2.1 format), and this view draws
 * them as SVG rectangles from those numbers. Nothing from a recording becomes
 * markup, a link, a style, a script or a request. Every chunk fetch goes through
 * the audited server path, so each view is on the workspace's audit chain.
 *
 * Progressive (ADR 0951 P2 review #4): the player shows the recording once its
 * first chunk is in and fetches the rest one at a time behind it, instead of
 * holding the viewer until every chunk (up to 2048) has loaded.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { InlineState } from '../../ui/InlineState.js';
import { useFormat } from '../../i18n/useFormat.js';
import {
  getReplayChunk, listReplaySessions, ReplayRequestError, type ReplayEvent, type ReplayNode, type ReplaySessionRef,
} from './analyticsClient.js';

type Frame = Extract<ReplayEvent, { type: 'frame' }>;

/** The state of the recording at `t`: the latest frame, scroll and pointer at or before it. */
export function replayStateAt(events: readonly ReplayEvent[], t: number): {
  frame: Frame | null; scroll: { x: number; y: number }; pointer: { x: number; y: number; down: boolean } | null;
} {
  let frame: Frame | null = null;
  let scroll = { x: 0, y: 0 };
  let pointer: { x: number; y: number; down: boolean } | null = null;
  let pressed = false;
  for (const e of events) {
    if (e.at > t) break;
    if (e.type === 'frame') frame = e;
    else if (e.type === 'scroll') scroll = { x: e.x, y: e.y };
    else {
      pressed = e.action === 'down' || (e.action === 'move' && pressed);
      pointer = { x: e.x, y: e.y, down: pressed };
    }
  }
  return { frame, scroll, pointer };
}

function ReplayPlayer({ orgId, session, onClose }: { orgId: string; session: ReplaySessionRef; onClose: () => void }): JSX.Element {
  const { t } = useTranslation('analytics');
  const ids = useId();
  const [events, setEvents] = useState<ReplayEvent[] | 'error' | 'denied' | null>(null);
  const [complete, setComplete] = useState(false);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    setEvents(null);
    setComplete(false);
    void (async () => {
      const all: ReplayEvent[] = [];
      let shown = false;
      try {
        // Chunk indices need not be dense (a lost upload leaves a gap), so a
        // missing chunk is skipped; any other failure stops the player.
        for (let i = 0; i < session.chunkCount && live; i++) {
          let chunk: ReplayEvent[] = [];
          try { chunk = await getReplayChunk(orgId, session.sessionId, i); }
          catch (err) { if (!(err instanceof ReplayRequestError && err.status === 404)) throw err; }
          if (!live || chunk.length === 0) continue;
          all.push(...chunk);
          all.sort((a, b) => a.at - b.at);
          setEvents([...all]);
          if (!shown) { shown = true; setAt(all[0]!.at); }
        }
        if (live) { if (!shown) setEvents([]); setComplete(true); }
      } catch (err) {
        if (live) setEvents(err instanceof ReplayRequestError && err.status === 403 ? 'denied' : 'error');
      }
    })();
    return () => { live = false; };
  }, [orgId, session.sessionId, session.chunkCount]);

  const start = Array.isArray(events) && events.length > 0 ? events[0]!.at : 0;
  const end = Array.isArray(events) && events.length > 0 ? events[events.length - 1]!.at : 0;
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const tick = (now: number): void => {
      setAt((cur) => {
        const next = Math.min(end, cur + (now - last));
        if (next >= end) setPlaying(false);
        return next;
      });
      last = now;
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current !== null) cancelAnimationFrame(raf.current); };
  }, [playing, end]);

  const state = useMemo(() => (Array.isArray(events) ? replayStateAt(events, at) : null), [events, at]);
  if (events === null) return <InlineState kind="loading" message={t('replayLoadingOne')} />;
  if (events === 'denied') return <InlineState kind="failed" message={t('replayNoAccess')} />;
  if (events === 'error' || !state?.frame) return <InlineState kind="failed" message={t('replayLoadFailed')} />;
  const { frame, scroll, pointer } = state;
  const seconds = (ms: number): string => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  return (
    <div className="u-flex u-flex-col u-gap-2">
      <figure className="u-m-0">
        <svg
          className="replay-stage"
          role="img"
          aria-label={t('replayFigure')}
          viewBox={`${scroll.x} ${scroll.y} ${frame.viewport.width} ${frame.viewport.height}`}
          preserveAspectRatio="xMidYMin meet"
        >
          {frame.nodes.slice(1).map((n: ReplayNode) => (
            <rect key={n.id} className={n.kind === 'masked' ? 'replay-mask' : 'replay-box'} x={n.x} y={n.y} width={n.width} height={n.height} />
          ))}
          {pointer ? <circle className={pointer.down ? 'replay-pointer replay-pointer--down' : 'replay-pointer'} cx={scroll.x + pointer.x} cy={scroll.y + pointer.y} r={8} /> : null}
        </svg>
      </figure>
      <div className="u-flex u-gap-2 u-items-center u-flex-wrap">
        <Button variant="quiet" onClick={() => { if (at >= end) setAt(start); setPlaying((p) => !p); }}>{playing ? t('replayPause') : t('replayPlay')}</Button>
        <label htmlFor={`${ids}-pos`} className="u-label-sm">{t('replayPosition')}</label>
        <input id={`${ids}-pos`} type="range" min={start} max={end} step={10} value={Math.round(at)}
          aria-valuetext={`${seconds(at)} / ${seconds(end)}`}
          onChange={(e) => { setPlaying(false); setAt(Number(e.target.value)); }} />
        <span className="u-fs-12 muted">{seconds(at)} / {seconds(end)}</span>
        <Button variant="quiet" onClick={onClose}>{t('replayClose')}</Button>
        {complete ? null : <span className="u-fs-12 muted" role="status">{t('replayLoadingMore')}</span>}
      </div>
    </div>
  );
}

export function ReplayPanel({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('analytics');
  const { dateTime } = useFormat();
  const [sessions, setSessions] = useState<ReplaySessionRef[] | 'error' | 'denied' | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [open, setOpen] = useState<ReplaySessionRef | null>(null);
  const liveOrg = useRef(orgId);
  const newestFirst = (list: ReplaySessionRef[]): ReplaySessionRef[] => [...list].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  useEffect(() => {
    let live = true;
    liveOrg.current = orgId;
    setSessions(null);
    setNextCursor(undefined);
    setMoreFailed(false);
    setOpen(null);
    listReplaySessions(orgId)
      .then((page) => { if (live) { setSessions(newestFirst(page.sessions)); setNextCursor(page.nextCursor); } })
      .catch((err: unknown) => { if (live) setSessions(err instanceof ReplayRequestError && err.status === 403 ? 'denied' : 'error'); });
    return () => { live = false; };
  }, [orgId]);

  // The server returns 50 at a time; older pages load on request.
  const loadMore = (): void => {
    if (!nextCursor || loadingMore) return;
    const forOrg = orgId;
    setLoadingMore(true);
    setMoreFailed(false);
    listReplaySessions(orgId, nextCursor)
      .then((page) => {
        if (liveOrg.current !== forOrg) return;
        setSessions((cur) => {
          if (!Array.isArray(cur)) return cur;
          const seen = new Set(cur.map((s) => s.sessionId));
          return newestFirst([...cur, ...page.sessions.filter((s) => !seen.has(s.sessionId))]);
        });
        setNextCursor(page.nextCursor);
      })
      .catch(() => { if (liveOrg.current === forOrg) setMoreFailed(true); })
      .finally(() => { if (liveOrg.current === forOrg) setLoadingMore(false); });
  };

  if (sessions === null) return <InlineState kind="loading" message={t('replayLoading')} />;
  if (sessions === 'denied') return <InlineState kind="empty" message={t('replayNoAccess')} />;
  if (sessions === 'error') return <InlineState kind="failed" message={t('replayLoadFailed')} />;
  if (open) return <ReplayPlayer orgId={orgId} session={open} onClose={() => setOpen(null)} />;
  if (sessions.length === 0 && !nextCursor) return <InlineState kind="empty" message={t('replayEmpty')} />;
  return (
    <div className="u-flex u-flex-col u-gap-2">
      <table className="data-table">
        <thead><tr><th scope="col">{t('replayStarted')}</th><th scope="col">{t('replayDuration')}</th><th scope="col"><span className="sr-only">{t('replayWatch')}</span></th></tr></thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.sessionId}>
              <td>{dateTime(s.startedAt)}</td>
              <td>{t('replaySeconds', { count: Math.max(1, Math.round((Date.parse(s.updatedAt) - Date.parse(s.startedAt)) / 1000)) })}</td>
              <td><Button variant="quiet" onClick={() => setOpen(s)}>{t('replayWatch')}</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {moreFailed ? <InlineState kind="failed" message={t('replayLoadFailed')} /> : null}
      {nextCursor ? (
        <div><Button variant="quiet" onClick={loadMore} disabled={loadingMore}>{t('replayLoadMore')}</Button></div>
      ) : null}
    </div>
  );
}
