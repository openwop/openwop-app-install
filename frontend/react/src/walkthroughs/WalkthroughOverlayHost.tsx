/**
 * The one walkthrough-player mount (ADR 0368 Phase 3) — chrome renders this once;
 * surfaces launch walkthroughs through the bus. Renders nothing until a walkthrough is
 * live, and nothing at all when the `guided-tours` toggle is off.
 *
 * Chrome anatomy (drafting-table quiet — DESIGN.md §7):
 *  - a dimmed SCRIM with a rounded cutout tracking the current target (four
 *    rects, no SVG mask): clicks on the scrim PAUSE the walkthrough (the user can
 *    always grab the wheel); the cutout region stays fully interactive for
 *    HITL steps;
 *  - an animated CURSOR dot gliding to the target center (pure CSS
 *    transform transition; `prefers-reduced-motion` disables the glide —
 *    the spotlight jumps instead);
 *  - a bottom CAPTION bar: narration (`role="status"` — announced politely),
 *    the step chip, Pause/Resume · "I did it" (HITL without a completion
 *    subscription) · Stop. Escape pauses.
 */

import { Button } from '../ui/Button.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useFeatureAccess } from '../featureToggles/FeatureAccessContext.js';
import { toast } from '../ui/toast.js';
import { useWalkthroughPlayer } from './useWalkthroughPlayer.js';
import { onWalkthroughLaunchRequest } from './walkthroughBus.js';
import { useWalkthroughRecorder } from './useWalkthroughRecorder.js';
import { stageComposerDraft } from '../chat/composerSeed.js';

const SPOT_PAD = 8;

function useTargetRect(target: HTMLElement | null): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!target) { setRect(null); return; }
    const update = () => setRect(target.getBoundingClientRect());
    update();
    const ro = new ResizeObserver(update);
    ro.observe(target);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [target]);
  return rect;
}

export function WalkthroughOverlayHost(): JSX.Element | null {
  const { t } = useTranslation('walkthroughs');
  const access = useFeatureAccess('walkthroughs');
  const player = useWalkthroughPlayer();
  const nav = useNavigate();
  const [stepCount, setStepCount] = useState(0);
  // ADR 0378 P2a — steps-panel visibility, remembered per user (OQ1 default).
  const [panelOpen, setPanelOpen] = useState(() => {
    try { return localStorage.getItem('openwop.walkthrough.panel') !== 'closed'; } catch { return true; }
  });
  const togglePanel = () => {
    // Grade-pass: the persistence write lives OUTSIDE the setState updater
    // (updaters must stay pure — StrictMode double-invokes them).
    setPanelOpen((v) => !v);
    try { localStorage.setItem('openwop.walkthrough.panel', panelOpen ? 'closed' : 'open'); } catch { /* private mode */ }
  };
  const [recName, setRecName] = useState('');
  // Record refuses to start while a walkthrough is playing (mutual exclusion).
  const canRecord = player.status === 'idle';
  const recorder = useWalkthroughRecorder(canRecord);
  useEffect(() => recorder.onRequest(() => toast.error(t('recordBusy'))), [recorder, t]);

  useEffect(() => onWalkthroughLaunchRequest((walkthroughId) => { void player.launch(walkthroughId); }), [player]);

  // Count each time the step CHANGES (by nodeId). The effect body must read
  // ONLY the primitive its deps declare: depending on `player.step` itself
  // would re-run this on EVERY render (fresh object identity from state) and
  // `setStepCount(n => n + 1)` would loop forever. Hoisting the id is the fix —
  // `WalkthroughStepView.nodeId` is required, so `!== undefined` means "a step is
  // open", exactly as `if (player.step)` did.
  const stepNodeId = player.step?.nodeId;
  useEffect(() => {
    if (stepNodeId !== undefined) setStepCount((n) => n + 1);
  }, [stepNodeId]);

  useEffect(() => {
    if (player.status === 'completed') { toast.success(t('completedToast')); setStepCount(0); }
    if (player.status === 'failed') { toast.error(t('failedToast')); setStepCount(0); }
  }, [player.status, t]);

  // ADR 0489 D2 — a skip resolves its step IMMEDIATELY, so the next step's
  // interrupt overwrites the caption almost at once and the narrated reason can
  // flash past unread. The steps panel keeps the record, but it is collapsible
  // and hidden ≤719px — so on mobile the skip would be effectively invisible.
  // A toast is the durable, announced surface that survives the caption change.
  const skippedCount = player.skipped.length;
  const lastToastedSkip = useRef(0);
  useEffect(() => {
    if (skippedCount > lastToastedSkip.current) {
      const newest = player.skipped[skippedCount - 1];
      if (newest) toast.success(t('skippedToast', { because: newest.because }));
    }
    lastToastedSkip.current = skippedCount;
  }, [skippedCount, player.skipped, t]);

  // Escape pauses (never steals other dialogs' Escape: only while driving).
  useEffect(() => {
    if (player.status !== 'performing' && player.status !== 'waiting-user') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') player.pause(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [player]);

  // ── ADR 0489 P5 — focus management ──────────────────────────────────────
  // Remember what had focus when the walkthrough took over, so Stop/complete can
  // hand it back (WCAG 2.4.3 focus order — a walkthrough that ends by dumping
  // focus on <body> strands every keyboard user).
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasLiveRef = useRef(false);
  useEffect(() => {
    const isLive = player.status !== 'idle' && player.status !== 'completed' && player.status !== 'failed';
    if (isLive && !wasLiveRef.current) {
      const el = document.activeElement;
      returnFocusRef.current = el instanceof HTMLElement && el !== document.body ? el : null;
    }
    if (!isLive && wasLiveRef.current) {
      // isConnected guards the common case: the launcher unmounted during the
      // walkthrough (we navigated away from the page that started it).
      const back = returnFocusRef.current;
      if (back?.isConnected) back.focus();
      returnFocusRef.current = null;
    }
    wasLiveRef.current = isLive;
  }, [player.status]);

  // CORRECTION to ADR 0489 P5's wording ("move focus into the caption on step
  // change"): a blanket focus move would BREAK HITL, where the whole point is
  // that the user reaches the page. Focus follows the step's NATURE instead:
  //  - HITL  ⇒ focus the TARGET. The user must act on it, and a keyboard user
  //            otherwise has no idea where "your turn" points.
  //  - scripted ⇒ do NOT steal focus. The player is driving and the caption is
  //            already announced via role="status"; grabbing focus mid-drive
  //            would fight the user for the caret.
  const hitlTarget = player.status === 'waiting-user' ? player.target : null;
  useEffect(() => {
    if (!hitlTarget?.isConnected) return;
    // Only move focus if it isn't already inside the spotlighted region — a
    // re-render must never yank the caret back from where the user moved it.
    if (hitlTarget.contains(document.activeElement)) return;
    const focusable = hitlTarget.matches('button, a[href], input, select, textarea, [tabindex]')
      ? hitlTarget
      : hitlTarget.querySelector<HTMLElement>('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    focusable?.focus();
  }, [hitlTarget]);

  // WCAG 2.2 §2.4.11 Focus Not Obscured — the caption is fixed to the viewport
  // edge, so anything scrolled to the very bottom can end up behind it. The
  // `captionTop` flip only covers the CURRENT TARGET; a user tabbing elsewhere
  // during an HITL step is not covered. Scroll padding fixes it generally, for
  // any focused element, for the whole time the overlay owns screen space.
  // NB: computed inline, not from the `live` const below — that is declared after
  // this component's early return, and a hook may not read it.
  const captionOnScreen = player.status === 'performing' || player.status === 'waiting-user'
    || player.status === 'starting' || player.status === 'paused';
  useEffect(() => {
    if (!captionOnScreen) return;
    document.documentElement.classList.add('walkthrough-scroll-inset');
    return () => document.documentElement.classList.remove('walkthrough-scroll-inset');
  }, [captionOnScreen]);

  const rect = useTargetRect(player.target);
  const spot = useMemo(() => rect && {
    top: Math.max(0, rect.top - SPOT_PAD),
    left: Math.max(0, rect.left - SPOT_PAD),
    width: rect.width + SPOT_PAD * 2,
    height: rect.height + SPOT_PAD * 2,
  }, [rect]);

  if (!access.enabled || (player.status === 'idle' && recorder.status === 'idle')) return null;

  const live = player.status === 'performing' || player.status === 'waiting-user' || player.status === 'starting' || player.status === 'paused';
  // Grade-pass: manual fallback whenever NO auto-completer attached (not just
  // when the step has no actionId) — a pack whose hitlComplete returned null
  // (companion element missing) must never dead-end the walkthrough.
  const hitlManual = player.status === 'waiting-user' && player.step && (!player.step.actionId || !player.hitlAuto);

  // Grade-pass: flip the caption to the top when the spotlighted target sits in
  // the bottom band (e.g. the chat composer) so the caption never covers the
  // very control an HITL step asks the user to operate.
  const captionTop = Boolean(spot && typeof window !== 'undefined' && spot.top + spot.height > window.innerHeight - 160);
  const panelVisible = live && panelOpen && player.steps.length > 0;

  return createPortal(
    <div className={`walkthrough-overlay${panelVisible ? ' walkthrough-overlay--panel' : ''}`} role="region" aria-label={t('overlayLabel')}>
      {live && spot ? (
        <>
          {/* Four scrim rects around the cutout — the cutout stays interactive. */}
          <button type="button" className="walkthrough-scrim" tabIndex={-1} aria-hidden="true" onClick={player.pause}
            style={{ top: 0, left: 0, right: 0, height: spot.top }} />
          <button type="button" className="walkthrough-scrim" tabIndex={-1} aria-hidden="true" onClick={player.pause}
            style={{ top: spot.top, left: 0, width: spot.left, height: spot.height }} />
          <button type="button" className="walkthrough-scrim" tabIndex={-1} aria-hidden="true" onClick={player.pause}
            style={{ top: spot.top, left: spot.left + spot.width, right: 0, height: spot.height }} />
          <button type="button" className="walkthrough-scrim" tabIndex={-1} aria-hidden="true" onClick={player.pause}
            style={{ top: spot.top + spot.height, left: 0, right: 0, bottom: 0 }} />
          <div className="walkthrough-spotlight" style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }} aria-hidden="true" />
          {player.status === 'waiting-user' ? (
            /* ADR 0378 P2b — the HITL beacon: quiet = watch, pulse = your turn.
               The cursor dot (watch-me grammar) hides while the beacon shows. */
            <div className="walkthrough-beacon" style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }} aria-hidden="true" />
          ) : (
            <div className="walkthrough-cursor" style={{ transform: `translate(${spot.left + spot.width / 2}px, ${spot.top + spot.height / 2}px)` }} aria-hidden="true" />
          )}
        </>
      ) : null}

      {player.status === 'needs-update' ? (
        <div className={`walkthrough-caption${captionTop ? ' walkthrough-caption--top' : ''}`} role="alertdialog" aria-label={t('needsUpdateTitle')}>
          <div className="walkthrough-caption-text">
            <strong>{t('needsUpdateTitle')}</strong> {t('needsUpdateBody')}
          </div>
          <div className="walkthrough-caption-actions action-bar">
            {/* alertdialog focus lands on the one action (a11y: the state
                change must be keyboard-reachable immediately). */}
            <Button variant="secondary" size="sm" autoFocus onClick={() => { void player.stop(); }}>{t('stop')}</Button>
          </div>
        </div>
      ) : live ? (
        <div className={`walkthrough-caption${captionTop ? ' walkthrough-caption--top' : ''}`}>
          <span className="chip chip--muted">{player.status === 'waiting-user' ? t('waitingUser') : player.position ? t('stepOfTotal', { n: player.position.index + 1, m: player.position.total }) : t('stepOf', { n: stepCount })}</span>
          <div className="walkthrough-caption-text" role="status" aria-live="polite">
            {player.position ? <span className="sr-only">{t('stepOfTotal', { n: player.position.index + 1, m: player.position.total })}{' '}</span> : null}
            {player.step?.narration ? t(player.step.narration, { defaultValue: player.step.narration }) : t('narrating')}
          </div>
          <div className="walkthrough-caption-actions action-bar">
            {hitlManual ? (
              <Button variant="accent" size="sm" onClick={() => { void player.confirmHitl(); }}>{t('didIt')}</Button>
            ) : null}
            {player.status === 'paused'
              ? <Button variant="secondary" size="sm" onClick={player.resume}>{t('resume')}</Button>
              : <Button variant="secondary" size="sm" onClick={player.pause}>{t('pause')}</Button>}
            {player.steps.length > 0 ? (
              <Button variant="secondary" size="sm" aria-expanded={panelOpen} aria-controls="walkthrough-steps" onClick={togglePanel}>{t('stepsToggle')}</Button>
            ) : null}
            <Button variant="secondary" size="sm" onClick={() => { void player.stop(); }}>{t('stop')}</Button>
          </div>
        </div>
      ) : null}

      {/* ADR 0378 P2a — the steps panel: a NON-modal companion region (the
          DESIGN.md "drawers ride ui/Modal" carve-out — Modal's focus trap +
          aria-modal would break HITL, where the user must reach the page).
          No scrim of its own; Escape keeps meaning pause. Hidden ≤719px. */}
      {panelVisible ? (
        <aside id="walkthrough-steps" className="walkthrough-steps" role="complementary" aria-label={t('stepsPanelTitle')}>
          <header className="walkthrough-steps-head">
            <strong>{t('stepsPanelTitle')}</strong>
            <span className="chip chip--muted">{t('stepOfTotal', { n: (player.position?.index ?? 0) + 1, m: player.steps.length })}</span>
            <Button variant="secondary" size="sm" aria-expanded={true} aria-controls="walkthrough-steps" onClick={togglePanel}>{t('stepsClose')}</Button>
          </header>
          <ol className="walkthrough-steps-list">
            {player.steps.map((st, i) => {
              const cur = player.position?.index ?? -1;
              // ADR 0489 D2 — `skipped` is a FOURTH state and takes precedence over
              // `done`: a step the learner had already satisfied must read as skipped,
              // never as work they did. The reason rides a labelled chip + the row's
              // accessible name, so the state is NEVER conveyed by colour alone.
              const skip = player.skipped.find((s) => s.nodeId === st.nodeId);
              const state = skip ? 'skipped' : i < cur ? 'done' : i === cur ? 'current' : 'upcoming';
              return (
                <li key={st.nodeId} className={`walkthrough-steps-item walkthrough-steps-item--${state}`} {...(state === 'current' ? { 'aria-current': 'step' as const } : {})}>
                  <span className="walkthrough-steps-marker" aria-hidden="true" />
                  <span className="walkthrough-steps-text">{st.narration ? t(st.narration, { defaultValue: st.narration }) : st.nodeId}</span>
                  {skip ? <span className="chip chip--success">{t('skippedBadge')}</span> : null}
                  {skip ? <span className="sr-only">{t('skippedReason', { because: skip.because })}</span> : null}
                  {st.hitl && !skip ? <span className="chip chip--muted">{t('waitingUser')}</span> : null}
                  {st.checkpoint ? <span className="chip chip--muted">{t('checkpointBadge')}</span> : null}
                </li>
              );
            })}
          </ol>
        </aside>
      ) : null}

      {recorder.status !== 'idle' ? (
        <div className="walkthrough-caption" data-walkthrough-recorder role="region" aria-label={t('recordOverlayLabel')}>
          <span className="chip chip--danger">{t('recording')}</span>
          <span className="chip chip--muted">{t('stepsCaptured', { n: recorder.steps.length })}</span>
          <input
            type="text"
            className="walkthrough-record-name"
            placeholder={t('recordNamePlaceholder')}
            aria-label={t('recordNameLabel')}
            value={recName}
            onChange={(e) => setRecName(e.target.value)}
          />
          <div className="walkthrough-caption-actions action-bar">
            <Button
              variant="accent" size="sm"
              disabled={recorder.status === 'saving' || recorder.steps.length === 0 || !recName.trim()}
              onClick={() => {
                void recorder.save(recName.trim()).then((r) => {
                  setRecName('');
                  if (!r) return;
                  toast.success(r.hasUnregisteredSteps ? t('recordSavedNeedsWork') : t('recordSaved'));
                  nav(`/builder/${r.workflowId}`);
                }).catch(() => toast.error(t('recordSaveFailed')));
              }}
            >
              {t('recordSave')}
            </Button>
            <Button
              variant="secondary" size="sm"
              disabled={recorder.steps.length === 0}
              title={t('recordEnrichTitle')}
              onClick={() => {
                // Hand the recording to the ONE chat (ADR 0058/0334): stage a
                // composer draft + guidance; the agent reasons then calls the
                // walkthroughs.register-draft tool. Never a bespoke AI panel.
                const actions = recorder.steps.map((s, i) => `${i + 1}. ${s.actionId ?? '(unregistered) ' + (s.describe ?? '')} [${s.verb}]`).join('\n');
                stageComposerDraft(t('recordEnrichPrompt', { name: recName.trim() || t('recordEnrichUnnamed'), steps: actions }));
                recorder.cancel();
                nav('/');
              }}
            >
              {t('recordEnrich')}
            </Button>
            {/* ADR 0489 D4 — the ratchet says a screen is uninstrumented; this
                hands the author the exact registration to paste. Only shown when
                there IS something to copy, and it reports honestly when the
                clipboard is unavailable rather than claiming a silent success. */}
            {recorder.unregisteredCount > 0 ? (
              <Button
                variant="secondary" size="sm"
                title={t('recordCopyStubsTitle')}
                onClick={() => {
                  void recorder.copyStubs().then((ok) => {
                    if (ok) toast.success(t('recordStubsCopied', { n: recorder.unregisteredCount }));
                    else toast.error(t('recordStubsCopyFailed'));
                  });
                }}
              >
                {t('recordCopyStubs', { n: recorder.unregisteredCount })}
              </Button>
            ) : null}
            <Button variant="secondary" size="sm" onClick={recorder.cancel}>{t('recordCancel')}</Button>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
