/**
 * The PUBLIC shared-deck viewer (ADR 0328 Phase 7) — a one-frame pager built
 * on `SlideFrame`, so speaker notes are STRUCTURALLY absent (the S7 audience
 * posture; the deck-listing renderer would leak them). Skipped slides are
 * passed over, same as present mode. Each frame the visitor actually reaches
 * is reported once per mount to the share-link's per-frame analytics.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { config } from '../../client/config.js';
import { SlideFrame } from '../../chat/artifacts/SlidesPreview.js';
import { firstVisible, gotoVisible, stepVisible } from '../../canvas/presentNav.js';
import { ChevronLeftIcon, ChevronRightIcon, MonitorIcon, PauseIcon, PlayIcon } from '../../ui/icons/index.js';
import { StateCard } from '../../ui/StateCard.js';
import { coerceDeck } from './definition.js';

/** SL-R2-5 — autoplay cadence (the 5–8s leader norm; long enough to read a
 *  title-bullets frame, short enough for a kiosk loop). */
const AUTOPLAY_MS = 7000;

export function SharedDeckViewer({ token, deck: rawDeck }: { token: string; deck: Record<string, unknown> }): JSX.Element {
  const { t } = useTranslation('canvas');
  const deck = useMemo(() => coerceDeck(rawDeck), [rawDeck]);
  const frames = useMemo(() => deck.slides.map((s) => ({ skip: s.skip === true })), [deck]);
  const [current, setCurrent] = useState(() => firstVisible(frames));
  const reported = useRef<Set<number>>(new Set());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  // R3 SL-R2-5 — audience-initiated autoplay. NEVER starts on its own (motion
  // is opt-in, which is also the honest prefers-reduced-motion posture: the
  // visitor pressed Play). Loops at the end (the kiosk convention).
  const [playing, setPlaying] = useState(false);

  // UX_UPGRADE-slides SL-G1/SL-G2 — the AUDIENCE projection. A skipped slide is
  // unreachable here, so counting it (or drawing a dot for it) tells the
  // audience about material they can neither see nor open. That is the same
  // backstage leak the S7 posture already forbids for speaker notes.
  const visible = useMemo(
    () => deck.slides.map((s, i) => ({ slide: s, i })).filter(({ slide }) => slide.skip !== true),
    [deck],
  );
  const position = Math.max(0, visible.findIndex(({ i }) => i === current));

  // R2 SL-SP-2/SL-SP-5 — the AUDIENCE-EMPTY cases. A missing/corrupt payload
  // must not FABRICATE "Slide 1" (coerceDeck's editor default), and an
  // all-skipped deck must not render a slide the author explicitly retracted
  // (the old fallback showed deck.slides[0] under a "1 / 0" counter). Neither
  // case may report analytics for a frame no audience was meant to see.
  // Empty means: no RAW entry that is a real, non-skipped object (review F3 —
  // coerceSlide never DROPS an entry, so a deck of nulls would otherwise
  // fabricate a blank visible slide), and nothing visible after coercion.
  const audienceEmpty = !Array.isArray(rawDeck?.slides)
    || !(rawDeck.slides as unknown[]).some((s) => !!s && typeof s === 'object' && (s as Record<string, unknown>).skip !== true)
    || visible.length === 0;

  // Per-frame analytics: report each frame ONCE per mount (best-effort).
  useEffect(() => {
    if (audienceEmpty) return;
    if (reported.current.has(current)) return;
    reported.current.add(current);
    void fetch(`${config.baseUrl}/host/openwop-app/shared/${encodeURIComponent(token)}/frame-view`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ frame: current }),
    }).catch(() => { /* analytics never block the viewer */ });
  }, [current, token, audienceEmpty]);

  const step = useCallback((dir: 1 | -1) => {
    // Manual paging takes control back — autoplay stops rather than fighting
    // the visitor for the current frame.
    setPlaying(false);
    setCurrent((cur) => stepVisible(frames, cur, dir, false));
  }, [frames]);

  const jumpTo = useCallback((i: number) => {
    setPlaying(false);
    setCurrent(gotoVisible(frames, i));
  }, [frames]);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setCurrent((cur) => {
        const next = stepVisible(frames, cur, 1, false);
        return next === cur ? firstVisible(frames) : next; // last frame → loop
      });
    }, AUTOPLAY_MS);
    return () => window.clearInterval(id);
  }, [playing, frames]);

  // Keep the fullscreen label honest when the visitor leaves via Esc.
  useEffect(() => {
    const onChange = (): void => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (rootRef.current) void rootRef.current.requestFullscreen?.();
  }, []);

  // R2 SL-SP-4 — swipe paging on touch (leaders all page on swipe; 28px
  // buttons were the only touch affordance). Horizontal-dominant only, so
  // vertical scrolling stays untouched.
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const t0 = e.touches[0];
    touchStart.current = t0 ? { x: t0.clientX, y: t0.clientY } : null;
  }, []);
  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    const t0 = e.changedTouches[0];
    if (!start || !t0) return;
    const dx = t0.clientX - start.x;
    const dy = t0.clientY - start.y;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
    step(dx < 0 ? 1 : -1);
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // R2 SR-9 — a WINDOW-level handler steals keys from other controls.
      // Text inputs get everything back; for buttons/links only SPACE conflicts
      // (it must activate the control) — arrows/Home/End must keep paging even
      // when focus rests on the deck's own prev/next/dot buttons (review F2:
      // the blanket exclusion killed keyboard paging after any nav click).
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (el && /^(BUTTON|A)$/.test(el.tagName) && e.key === ' ') return;
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); step(-1); }
      else if (e.key === 'Home') { e.preventDefault(); setPlaying(false); setCurrent(firstVisible(frames)); }
      else if (e.key === 'End') { e.preventDefault(); setPlaying(false); setCurrent(gotoVisible(frames, frames.length - 1)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, frames]);

  // R2 SL-SP-2/SL-SP-5 — the designed audience-empty state (after all hooks).
  if (audienceEmpty) {
    return (
      <StateCard
        icon={<MonitorIcon size={20} />}
        title={t('sharedDeckEmptyTitle')}
        body={t('sharedDeckEmptyBody')}
      />
    );
  }

  const slide = deck.slides[current];
  return (
    // R2 SL-SP-3 — fullscreen wraps the WHOLE viewer (nav + strip included):
    // fullscreening only the stage stranded pointer-only viewers with no way
    // to page and, on touch, no way out at all.
    <div
      className="cv-shared-deck"
      ref={rootRef}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* R2 SL-SP-3/SL-SP-4 — click/tap on the stage advances (the universal
          presentation convention); keyboard users page with the window-level
          arrow handler and the labelled nav buttons — those are the accessible
          paths, so this pointer shortcut needs no keyboard listener of its own. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events */}
      <div className="cv-shared-deck__stage" onClick={() => step(1)}>
        {slide ? <SlideFrame slide={slide} theme={deck.theme ?? 'default'} /> : null}
      </div>
      <div className="cv-shared-deck__nav">
        <Button variant="secondary" size="sm" onClick={() => step(-1)} disabled={current === firstVisible(frames)} aria-label={t('prevFrame')}>
          <ChevronLeftIcon size={14} aria-hidden />
        </Button>
        {/* Counted over the VISIBLE deck: the old counter used the raw index and
            the full slide count, so a deck with hidden slides told the audience
            "1 of 10" when only 7 were reachable — and the number then jumped. */}
        <span className="cv-present__counter" aria-live="polite">{t('frameCounter', { n: position + 1, total: visible.length })}</span>
        <Button variant="secondary" size="sm" onClick={() => step(1)} disabled={stepVisible(frames, current, 1, false) === current} aria-label={t('nextFrame')}>
          <ChevronRightIcon size={14} aria-hidden />
        </Button>
        {/* R3 SL-R2-5 — absent (not disabled) on a single-frame deck: there is
            nothing to advance to, so offering Play would be a dead control. */}
        {visible.length > 1 ? (
          <Button variant="secondary" size="sm" onClick={() => setPlaying((p) => !p)} aria-label={t(playing ? 'autoplayPause' : 'autoplayPlay')} aria-pressed={playing}>
            {playing ? <PauseIcon size={14} aria-hidden /> : <PlayIcon size={14} aria-hidden />}
          </Button>
        ) : null}
        {/* Absent, not disabled, where the browser has no Fullscreen API — the
            same posture as the copy-link button on the public form. */}
        {typeof document !== 'undefined' && document.fullscreenEnabled ? (
          <Button variant="secondary" size="sm" onClick={toggleFullscreen} aria-label={t(fullscreen ? 'exitFullscreen' : 'fullscreen')}>
            <MonitorIcon size={14} aria-hidden />
          </Button>
        ) : null}
      </div>
      <nav className="cv-shared-deck__strip" aria-label={t('jumpGrid')}>
        {visible.map(({ slide: s, i }, ix) => (
          <button
            key={s.id}
            type="button"
            className={`cv-shared-deck__dot${i === current ? ' cv-shared-deck__dot--current' : ''}`}
            aria-current={i === current ? 'true' : undefined}
            aria-label={s.name || t('frameN', { n: ix + 1 })}
            onClick={() => jumpTo(i)}
          />
        ))}
      </nav>
    </div>
  );
}
