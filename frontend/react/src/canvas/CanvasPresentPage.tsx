/**
 * Canvas framework — PRESENT mode (ADR 0328 Phase 4 / research C2+C3+S7).
 * One chassis page, three roles chosen by URL params:
 *
 *  - default (solo/audience-on-your-screen): the frame full-bleed, keyboard
 *    nav, B/W blanking, kiosk auto-advance/loop via `?kiosk=1&advance=8&loop=1`.
 *  - `?presenter=1`: the presenter window — current + next preview, speaker
 *    notes (read via the `present.notesKey`; the audience render path never
 *    sees them — the S7 leak fix is structural), elapsed timer, jump grid,
 *    "open audience window", and the QR phone remote.
 *  - `?audience=1`: a listen-only window (opened by the presenter) that follows
 *    the presenter over a same-origin BroadcastChannel — zero backend.
 *
 * The backend is involved ONLY when a phone remote joins: the presenter mints
 * a stateless capability (the canvas factory's `present-remote` verb), shows
 * it as a QR, and consumes commands over the public present SSE feed.
 */
import { Button } from '../ui/Button.js';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CanvasOrgGate } from './CanvasOrgGate.js';
import { resolveCanvasOrg, type CanvasOrgResolution } from './resolveCanvasOrg.js';
import { StateCard, Notice, toast } from '../ui/index.js';
import { authedHeaders, config, fetchOpts } from '../client/config.js';
import { createCanvasClient, listOrgs, asJson } from './canvasClient.js';
import { advancePosition, firstPosition, firstVisible, gotoPosition, retreatPosition, stepVisible, type PresentPosition, type PresentableFrame } from './presentNav.js';
import { useMagicMove } from './useMagicMove.js';
import type { FrameBase } from './frameOps.js';
import type { TreeNodeBase } from './treeOps.js';
import type { CanvasTypeDefinition } from './types.js';
import { copyToClipboard } from '../ui/copyToClipboard.js';

type Blank = null | 'blackout' | 'whiteout';
interface SyncMsg { type: 'sync'; current: number; step: number; blank: Blank }
interface HelloMsg { type: 'hello' }

interface RemoteSession { token: string; joinUrl: string; qrDataUrl?: string }

const dict = (o: object): Record<string, unknown> => o as Record<string, unknown>;

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m % 60)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

export function CanvasPresentPage<Doc extends object, F extends FrameBase, N extends TreeNodeBase>({ definition: def }: {
  definition: CanvasTypeDefinition<Doc, F, N>;
}): JSX.Element {
  const { t } = useTranslation('canvas');
  const { canvasId } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const client = useMemo(() => createCanvasClient({ basePath: def.clientBasePath }), [def.clientBasePath]);

  const isPresenter = search.get('presenter') === '1';
  const isAudience = search.get('audience') === '1';
  const kiosk = search.get('kiosk') === '1';
  const advanceSec = Math.max(2, Math.min(600, Number(search.get('advance') ?? 8) || 8));
  const loop = search.get('loop') === '1';
  const startAt = Number(search.get('at') ?? -1);

  const [orgId, setOrgId] = useState<string | null>(null);
  const [orgGate, setOrgGate] = useState<Exclude<CanvasOrgResolution, { kind: 'ok' }> | null>(null);
  const [doc, setDoc] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<PresentPosition>({ frame: 0, step: 0 });
  const current = pos.frame;
  const [blank, setBlank] = useState<Blank>(null);
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [remote, setRemote] = useState<RemoteSession | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  // SLIDES-UX-4 — first-entry keyboard hint; retires on first interaction.
  const [showKeysHint, setShowKeysHint] = useState(() => !isAudience && !kiosk);
  // SLUX-9 — kiosk auto-advance is pausable (HUD chip + the `k` key).
  const [kioskPaused, setKioskPaused] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const framesKey = def.frames?.key ?? 'frames';
  const notesKey = def.present?.notesKey ?? 'notes';
  const skipKey = def.present?.skipKey ?? 'skip';

  const frames = useMemo<PresentableFrame[]>(() => {
    const v = doc ? dict(doc)[framesKey] : null;
    if (!Array.isArray(v)) return [];
    return (v as object[]).map((f) => ({ skip: dict(f)[skipKey] === true }));
  }, [doc, framesKey, skipKey]);

  // ADR 0328 P5 — builds + entry transitions come from the present trait.
  const stepsOf = useCallback((i: number): number => (doc ? def.present?.buildStepsOf?.(doc, i) ?? 0 : 0), [doc, def.present]);

  const rawFrames = useMemo<Record<string, unknown>[]>(() => {
    const v = doc ? dict(doc)[framesKey] : null;
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  }, [doc, framesKey]);

  // ---- load ---------------------------------------------------------------
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const orgs = await listOrgs();
        // Read-only does not make it less org-scoped — same lossy link.
        const resolved = resolveCanvasOrg(orgs, search.get('org'));
        if (resolved.kind !== 'ok') { if (live) setOrgGate(resolved); return; }
        const org = resolved.orgId;
        if (!canvasId) throw new Error(t('loadError'));
        const rec = await client.getCanvas(org, canvasId);
        // Grade pass: present trusts the SAME coercion the editor applies —
        // a malformed doc must not render "1 / 0" over a blank stage.
        const state = def.coerceDoc ? (def.coerceDoc(rec.state) as unknown as Record<string, unknown>) : rec.state;
        if (live) { setOrgId(org); setDoc(state); }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : t('loadError'));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
    // `def` is a module-constant definition object — inert in deps; satisfies
    // exhaustive-deps (pre-existing #1594 lint break, fixed in passing).
  }, [client, canvasId, t, def, search]);

  // Initial frame: ?at=N (from-current), else the first non-skipped.
  useEffect(() => {
    if (!doc) return;
    setPos(startAt >= 0 ? gotoPosition(frames, stepsOf, startAt) : firstPosition(frames));
    // Intentionally only on load — later frame changes are navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // ---- same-origin window sync (BroadcastChannel) --------------------------
  const bcRef = useRef<BroadcastChannel | null>(null);
  const stateRef = useRef({ pos: { frame: 0, step: 0 } as PresentPosition, blank: null as Blank });
  stateRef.current = { pos, blank };

  useEffect(() => {
    if (!canvasId || typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel(`owp-present:${canvasId}`);
    bcRef.current = bc;
    bc.onmessage = (e: MessageEvent) => {
      const msg = e.data as SyncMsg | HelloMsg;
      if (isAudience && msg.type === 'sync') { setPos({ frame: msg.current, step: msg.step }); setBlank(msg.blank); }
      // A new audience window says hello; the driving window answers with state.
      if (!isAudience && msg.type === 'hello') bc.postMessage({ type: 'sync', current: stateRef.current.pos.frame, step: stateRef.current.pos.step, blank: stateRef.current.blank } satisfies SyncMsg);
    };
    if (isAudience) bc.postMessage({ type: 'hello' } satisfies HelloMsg);
    return () => { bcRef.current = null; bc.close(); };
  }, [canvasId, isAudience]);

  const broadcast = useCallback((next: PresentPosition, nextBlank: Blank) => {
    bcRef.current?.postMessage({ type: 'sync', current: next.frame, step: next.step, blank: nextBlank } satisfies SyncMsg);
  }, []);

  // ---- navigation ----------------------------------------------------------
  const go = useCallback((target: PresentPosition) => {
    setBlank(null);
    setPos(target);
    broadcast(target, null);
  }, [broadcast]);

  const step = useCallback((dir: 1 | -1) => {
    const at = stateRef.current.pos;
    go(dir === 1 ? advancePosition(frames, stepsOf, at, kiosk && loop) : retreatPosition(frames, stepsOf, at));
  }, [frames, go, stepsOf, kiosk, loop]);

  const toggleBlank = useCallback((kind: 'blackout' | 'whiteout') => {
    const next = stateRef.current.blank === kind ? null : kind;
    setBlank(next);
    broadcast(stateRef.current.pos, next);
  }, [broadcast]);

  const exit = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else if (canvasId) navigate(`${def.editorPath}/${encodeURIComponent(canvasId)}`);
  }, [navigate, canvasId, def.editorPath]);

  // Keyboard (audience windows are listen-only apart from Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); exit(); return; }
      if (isAudience) return;
      setShowKeysHint(false);
      switch (e.key) {
        case 'ArrowRight': case 'ArrowDown': case ' ': case 'PageDown': e.preventDefault(); step(1); break;
        case 'ArrowLeft': case 'ArrowUp': case 'PageUp': e.preventDefault(); step(-1); break;
        case 'Home': e.preventDefault(); go(firstPosition(frames)); break;
        case 'End': e.preventDefault(); go(gotoPosition(frames, stepsOf, frames.length - 1)); break;
        case 'b': case 'B': e.preventDefault(); toggleBlank('blackout'); break;
        case 'w': case 'W': e.preventDefault(); toggleBlank('whiteout'); break;
        // SLUX-9 — kiosk pause/resume (keyboard parity with the HUD chip).
        case 'k': case 'K': if (kiosk) { e.preventDefault(); setKioskPaused((p) => !p); } break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, go, exit, toggleBlank, frames, stepsOf, isAudience, kiosk]);

  // The keyboard hint also retires on its own after a short beat (it is
  // redundant with the HUD controls, so timed dismissal is safe).
  useEffect(() => {
    if (!showKeysHint) return;
    const id = setTimeout(() => setShowKeysHint(false), 10000);
    return () => clearTimeout(id);
  }, [showKeysHint]);

  // Kiosk auto-advance (SLUX-9: pausable).
  useEffect(() => {
    if (!kiosk || kioskPaused || frames.length === 0) return;
    const id = setInterval(() => step(1), advanceSec * 1000);
    return () => clearInterval(id);
  }, [kiosk, kioskPaused, advanceSec, step, frames.length]);

  // Presenter timer.
  useEffect(() => {
    if (!isPresenter) return;
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [isPresenter, startedAt]);

  // ---- phone remote ---------------------------------------------------------
  const startRemote = useCallback(async () => {
    if (!orgId || !canvasId) return;
    setRemoteBusy(true);
    try {
      const res = await fetch(
        `${config.baseUrl}${def.clientBasePath}/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}/present-remote`,
        fetchOpts({ method: 'POST', headers: { ...authedHeaders(), 'content-type': 'application/json' } }),
      );
      const minted = await asJson<{ token: string; expiresAt: string }>(res, 'mint present remote');
      const joinUrl = `${window.location.origin}/present-remote/${encodeURIComponent(minted.token)}`;
      let qrDataUrl: string | undefined;
      try {
        const qrcode = await import('qrcode');
        qrDataUrl = await qrcode.toDataURL(joinUrl, { margin: 1, width: 220 });
      } catch {
        // QR lib unavailable — the link + copy button still work, but say so
        // instead of degrading silently (SLIDES-UX-8).
        toast.info(t('qrUnavailable'));
      }
      setRemote({ token: minted.token, joinUrl, ...(qrDataUrl ? { qrDataUrl } : {}) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('remoteFailed'));
    } finally {
      setRemoteBusy(false);
    }
  }, [orgId, canvasId, def.clientBasePath, t]);

  // Consume remote commands over the public SSE feed; publish position back.
  useEffect(() => {
    if (!remote) return;
    const es = new EventSource(`${config.sseBaseUrl}/host/openwop-app/present/${encodeURIComponent(remote.token)}/events`);
    es.addEventListener('nav', (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data as string) as { kind?: string; action?: string; index?: number };
        if (ev.kind !== 'command') return;
        if (ev.action === 'next') step(1);
        else if (ev.action === 'prev') step(-1);
        else if (ev.action === 'goto' && typeof ev.index === 'number') go(gotoPosition(frames, stepsOf, ev.index));
        else if (ev.action === 'blank') toggleBlank('blackout');
      } catch { /* malformed frame — ignore */ }
    });
    return () => es.close();
  }, [remote, step, go, toggleBlank, frames, stepsOf]);

  useEffect(() => {
    if (!remote) return;
    const ctl = new AbortController();
    void fetch(`${config.baseUrl}/host/openwop-app/present/${encodeURIComponent(remote.token)}/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current }),
      signal: ctl.signal,
    }).catch(() => { /* position sync is best-effort */ });
    return () => ctl.abort();
  }, [remote, current]);

  // Grade pass (a11y): move focus INTO the presentation surface on entry so
  // a screen reader announces it and Esc/arrows work without a click.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!loading && doc) rootRef.current?.focus();
  }, [loading, doc]);

  // ADR 0328 P5 — the Magic Move player (no-ops unless the incoming frame's
  // transition is 'magic' and motion is allowed).
  useMagicMove(stageRef, current, doc ? def.present?.transitionOf?.(doc, current) : undefined);

  // ---- render ---------------------------------------------------------------
  if (orgGate) return <div className="cv-present u-p-4"><CanvasOrgGate resolution={orgGate} /></div>;
  if (loading) return <div className="cv-present"><StateCard loading title={t('loading')} /></div>;
  if (error || !doc || !def.present) return <div className="cv-present"><Notice variant="error">{error ?? t('loadError')}</Notice></div>;
  if (frames.length === 0) return <div className="cv-present"><StateCard title={t('presentEmpty')} body={t('presentEmptyBody')} /></div>;

  const renderFrame = def.present.renderFrame;
  const total = frames.length;
  // The CURRENT frame renders capped at the live build step; previews (next)
  // render fully built. P5: entry transition class + the Magic Move player.
  const frameView = (idx: number): JSX.Element | null => (idx >= 0 && idx < total ? renderFrame(doc, idx, idx === current ? pos.step : undefined) : null);
  const nextIdx = stepVisible(frames, current, 1, false);
  const notes = String(dict(rawFrames[current] ?? {})[notesKey] ?? '');
  // SLUX-10 — the deck's own title heads the presenter window.
  const deckTitle = doc ? String(dict(doc).title ?? '') : '';
  // SLIDES-UX-3 — announce the frame CONTENT (name), not just the position.
  const currentName = String(dict(rawFrames[current] ?? {}).name ?? '') || t('frameN', { n: current + 1 });
  const frameAnnounce = (
    // Kiosk ticks every advance — a polite live announcer would chatter (merged from main's counter treatment).
    <span className="sr-only" role="status" aria-live={kiosk ? 'off' : 'polite'}>{t('frameAnnounce', { n: current + 1, total, name: currentName })}</span>
  );
  // SLU-1 — the live region announces POSITION; it never carried STRUCTURE, so a
  // screen-reader user could not learn what was coming without arrowing through the
  // whole deck (the editor gives sighted authors an outline tree; Present gave nothing).
  // A visually-hidden outline carries the same information. Skipped frames are omitted —
  // they are not part of the presented deck — so the numbering is the frame's own index.
  const outlineLabel = (i: number): string => {
    const name = String(dict(rawFrames[i] ?? {}).name ?? '');
    return name ? t('presentOutlineItem', { n: i + 1, name }) : t('frameN', { n: i + 1 });
  };
  const deckOutline = (
    <nav className="sr-only" aria-label={t('presentOutline')}>
      <ol>
        {rawFrames.map((_f, i) => (frames[i]?.skip ? null : (
          <li key={i} {...(i === current ? { 'aria-current': 'true' as const } : {})}>
            {i === current ? t('presentOutlineCurrent', { label: outlineLabel(i) }) : outlineLabel(i)}
          </li>
        )))}
      </ol>
    </nav>
  );
  const transition = def.present.transitionOf?.(doc, current);
  const animClass = transition === 'fade' || transition === 'magic' ? ` cv-present__anim--${transition}` : '';

  if (!isPresenter) {
    // Solo / audience: the frame, full-bleed. Blanking overlays everything.
    return (
      <div ref={rootRef} tabIndex={-1} role="region" className={`cv-present${isAudience ? ' cv-present--audience' : ''}`} aria-label={t('presentStage')}>
        <p className="sr-only" role="status">{blank ? t('screenBlanked') : ''}</p>
        <div className="cv-present__stage" ref={stageRef}>
          <div key={current} className={`cv-present__frame-holder${animClass}`}>{frameView(current)}</div>
        </div>
        {blank ? <div className={`cv-present__blank cv-present__blank--${blank}`} aria-hidden="true" /> : null}
        {frameAnnounce}
        {deckOutline}
        {showKeysHint ? <p className="cv-present__keys-hint" role="note">{t('presentKeysHint')}</p> : null}
        <div className="cv-present__hud">
          {kiosk ? (
            <button
              type="button"
              className="chip chip--muted"
              aria-pressed={kioskPaused}
              onClick={() => setKioskPaused((p) => !p)}
            >
              {kioskPaused ? t('kioskPaused') : t('kioskAuto', { s: advanceSec })}
            </button>
          ) : null}
          <span className="cv-present__counter">{t('frameCounter', { n: current + 1, total })}</span>
          <Button variant="quiet" size="sm" className="cv-present__exit" onClick={exit}>{t('exitPresent')}</Button>
        </div>
      </div>
    );
  }

  // Presenter window.
  return (
    <div ref={rootRef} tabIndex={-1} role="region" className="cv-present cv-present--presenter" aria-label={t('presenterView')}>
      <h1 className="sr-only">{deckTitle ? t('presenterTitle', { title: deckTitle }) : t('presenterView')}</h1>
      <p className="sr-only" role="status">{blank ? t('screenBlanked') : ''}</p>
      {frameAnnounce}
      {deckOutline}
      <div className="cv-present__main">
        <div className="cv-present__now">
          <div className="cv-present__stage" ref={stageRef}>
            <div key={current} className={`cv-present__frame-holder${animClass}`}>{frameView(current)}</div>
          </div>
          {blank ? <div className={`cv-present__blank cv-present__blank--${blank}`} aria-hidden="true" /> : null}
        </div>
        <aside className="cv-present__side">
          {deckTitle ? <p className="cv-present__deck-title" aria-hidden="true">{deckTitle}</p> : null}
          <div role="timer" className="cv-present__timer" aria-label={t('elapsed')}>{formatElapsed(elapsed)}</div>
          <h2 className="cv-editor__panel-title">{t('nextFrame')}</h2>
          <div className="cv-present__next">{nextIdx !== current ? frameView(nextIdx) : <p className="cv-present__end">{t('endOfDeck')}</p>}</div>
          <h2 className="cv-editor__panel-title">{t('speakerNotes')}</h2>
          <p className="cv-present__notes">{notes || t('noNotes')}</p>
        </aside>
      </div>
      <div className="cv-present__controls action-bar">
        <Button variant="secondary" size="sm" onClick={() => step(-1)} disabled={current === firstVisible(frames)}>{t('prevFrame')}</Button>
        <span className="cv-present__counter">{t('frameCounter', { n: current + 1, total })}</span>
        <Button variant="secondary" size="sm" onClick={() => step(1)}>{t('nextFrame')}</Button>
        <Button variant="secondary" size="sm" aria-pressed={blank === 'blackout'} onClick={() => toggleBlank('blackout')}>{t('blankBlack')}</Button>
        <Button variant="secondary" size="sm" aria-pressed={blank === 'whiteout'} onClick={() => toggleBlank('whiteout')}>{t('blankWhite')}</Button>
        <Button
          variant="secondary" size="sm"
          onClick={() => window.open(`${window.location.pathname}?audience=1`, '_blank', 'noopener')}
        >
          {t('openAudienceWindow')}
        </Button>
        {remote ? (
          <span className="chip">{t('remoteActive')}</span>
        ) : (
          <Button variant="secondary" size="sm" disabled={remoteBusy} onClick={() => void startRemote()}>{remoteBusy ? t('remoteStarting') : t('phoneRemote')}</Button>
        )}
        <Button variant="quiet" size="sm" onClick={exit}>{t('exitPresent')}</Button>
      </div>
      {remote ? (
        <div className="cv-present__remote surface-card">
          {remote.qrDataUrl ? <img className="cv-present__qr" src={remote.qrDataUrl} alt={t('scanToJoin')} /> : null}
          <div className="cv-present__remote-info">
            <p>{t('scanToJoin')}</p>
            <Button
              variant="secondary" size="sm"
              onClick={() => { void copyToClipboard(remote.joinUrl, t('linkCopied')); }}
            >
              {t('copyJoinLink')}
            </Button>
          </div>
        </div>
      ) : null}
      <nav className="cv-present__grid" aria-label={t('jumpGrid')}>
        {rawFrames.map((f, i) => (
          <Fragment key={i}>
          {def.present?.sectionOf?.(doc, i) ? (
            <h3 className="cv-present__grid-section">{def.present.sectionOf(doc, i)}</h3>
          ) : null}
          <button
            key={i}
            type="button"
            className={`cv-present__grid-item${i === current ? ' cv-present__grid-item--current' : ''}${frames[i]?.skip ? ' cv-present__grid-item--skipped' : ''}`}
            aria-current={i === current ? 'true' : undefined}
            onClick={() => go(gotoPosition(frames, stepsOf, i))}
          >
            <span className="cv-present__grid-num">{i + 1}</span>
            <span className="cv-present__grid-name">{String(dict(f).name ?? '') || t('frameN', { n: i + 1 })}</span>
          </button>
          </Fragment>
        ))}
      </nav>
    </div>
  );
}
