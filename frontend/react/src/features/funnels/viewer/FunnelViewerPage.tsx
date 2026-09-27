/**
 * ADR 0339 — the visitor-facing funnel viewer at `/fn/:orgId/:slug` (bare
 * PublicShell). Composes, never re-implements: the funnel public JSON API
 * (entry + routed `/next`), the public page read + `RenderSections('public')`
 * for the bound CMS page (experiments/localization apply verbatim), and the
 * ADR 0331 form section via the forms embed seam — a submission carries
 * `formContext` + the visitor key and auto-advances; every step also offers a
 * Continue CTA so non-capture steps have a path.
 *
 * ROUND 2 (UX_UPGRADE-funnels VP-R2-0/2/3/6) — the interaction core:
 * - `advance()` is the ONE loader for a successful advance: it renders from
 *   the `/next` payload and stamps `?step` WITHOUT re-triggering the URL
 *   effect (FN-R2-2 — the old double-load flashed a skeleton over the already-
 *   rendered step, unmounted the live region mid-announcement, DOUBLE-COUNTED
 *   `step_viewed` server-side, and added a second failure lane).
 * - A page-read failure NEVER destroys a session in progress (FN-R2-1 — the
 *   round-1 FN-G4 fix, applied one layer further down): with a step on screen,
 *   any failed load renders the retryable notice, not `unavailable`.
 * - Entry reads are DISCRIMINATED (FN-R2-4): 404 keeps the uniform
 *   "unavailable" posture; 5xx/network get a designed load-failed state with a
 *   working Retry. A dead `?step` deep link falls back to the entry instead of
 *   dead-ending (FN-R2-5).
 * - Completion is announced and carries the operator-authored `completionCta`
 *   when one exists (FN-R2-6/FN-G5). Completion is deliberately NOT a URL
 *   state: refreshing the last step re-serves it, and the server's same-`from`
 *   completion guard (VP-R2-1) absorbs a re-advance without double counting.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { config, fetchOpts } from '../../../client/config.js';
import { Notice } from '../../../ui/Notice.js';
import { StateCard } from '../../../ui/StateCard.js';
import { Skeleton } from '../../../ui/Skeleton.js';
import { ArrowLeftIcon, CheckIcon, SearchIcon } from '../../../ui/icons/index.js';
import { RenderSections } from '../../cms/SectionRenderer.js';
import type { Section } from '../../cms/cmsClient.js';
import { fetchPublicPageResult } from '../../site/siteClient.js';
import { getVisitorKey } from '../../site/visitorBeacon.js';
import { FormEmbedProvider } from '../../forms/render/embedContext.js';

interface ViewStep {
  ix: number;
  stepId: string;
  kind: string;
  name?: string;
  pageSlug: string;
  formContext?: { funnelId: string; stepId: string };
}
interface ViewPayload {
  funnel: { slug: string; name: string };
  stepCount: number;
  step?: ViewStep;
  complete?: boolean;
  /** VP-R2-3 (FN-G5) — the operator-authored "what now" for a finished funnel. */
  completionCta?: { label: string; url: string };
}

const PUB = (orgId: string) => `${config.baseUrl}/host/openwop-app/public/${encodeURIComponent(orgId)}/funnels`;

type ViewState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  /** The READ failed (5xx/network) — a different fact from "gone" (FN-R2-4). */
  | { kind: 'loadFailed' }
  | { kind: 'complete'; funnelName: string; cta?: { label: string; url: string } | undefined }
  | { kind: 'step'; payload: ViewPayload; step: ViewStep; sections: Section[] };

type CallResult = { status: 'ok'; payload: ViewPayload } | { status: 'notFound' } | { status: 'error' };

/** An authored CTA URL is either an internal path or http(s) — never rendered otherwise. */
const safeCtaUrl = (url: string): boolean => /^\/(?![/\\])/.test(url) || /^https?:\/\//i.test(url);

export function FunnelViewerPage({ orgId, slug }: { orgId: string; slug: string }): JSX.Element {
  const { t } = useTranslation('funnels');
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [advancing, setAdvancing] = useState(false);
  // FN-G4 — an advance that fails must NOT wipe the funnel. Losing a
  // part-completed funnel to one flaky request is the worst thing this screen
  // can do, so ANY failed load with a step on screen keeps it and offers retry.
  const [advanceFailed, setAdvanceFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const vk = getVisitorKey();
  // FRMX-1 — the step lives in the URL (`?step=ix`): browser Back walks the
  // funnel (each advance pushes), refresh re-serves the CURRENT step, and a
  // step is deep-linkable. `?step` is a VIEW pointer only — completion events
  // still come solely from the server's /next accounting.
  const [searchParams, setSearchParams] = useSearchParams();
  const stepParam = searchParams.get('step');
  const stepRef = useRef<HTMLDivElement | null>(null);
  // VP-R2-0 — when advance() stamps ?step after rendering from its own
  // payload, the URL effect must NOT reload (the double-load defect). The ref
  // names the param value the effect should swallow exactly once.
  const skipParamLoad = useRef<string | null>(null);
  // A Back click during an in-flight advance wins: the advance's late
  // resolution must not yank the visitor forward (FN-R2-8).
  const navGen = useRef(0);
  // FN-R2-5 — one entry-fallback attempt per dead deep link.
  const entryFallbackTried = useRef(false);
  // Whether a step is currently rendered — read by the URL effect to decide
  // between "blank to skeleton" (first load) and "keep the session on screen"
  // (Back navigation), without adding `state` to its deps.
  const hasStepRef = useRef(false);
  hasStepRef.current = state.kind === 'step';

  const call = useCallback(async (suffix: string): Promise<CallResult> => {
    try {
      const r = await fetch(`${PUB(orgId)}/${encodeURIComponent(slug)}${suffix}`, fetchOpts({}));
      if (r.status === 404 || r.status === 410) return { status: 'notFound' };
      if (!r.ok) return { status: 'error' };
      return { status: 'ok', payload: (await r.json()) as ViewPayload };
    } catch {
      return { status: 'error' };
    }
  }, [orgId, slug]);

  /** Render a payload. `hasSession` = a step is on screen and must survive any
   *  failure (FN-R2-1). Returns true when something rendered. */
  const show = useCallback(async (result: CallResult, hasSession: boolean, isStale: () => boolean): Promise<boolean> => {
    // R2R F1 — EVERY state commit re-checks staleness: the page read below is
    // the slow half of a load, and a Back clicked during it must win (the
    // navGen guard used to cover only the first await).
    if (result.status !== 'ok') {
      if (isStale()) return false;
      if (hasSession) { setAdvanceFailed(true); return false; }
      setState(result.status === 'notFound' ? { kind: 'unavailable' } : { kind: 'loadFailed' });
      return false;
    }
    const payload = result.payload;
    if (payload.complete || !payload.step) {
      if (isStale()) return false;
      const cta = payload.completionCta && payload.completionCta.label && safeCtaUrl(payload.completionCta.url)
        ? payload.completionCta : undefined;
      setState({ kind: 'complete', funnelName: payload.funnel.name, cta });
      return true;
    }
    const page = await fetchPublicPageResult(orgId, payload.step.pageSlug, vk);
    if (isStale()) return false;
    if (page.status !== 'ok') {
      // FN-R2-1 — the round-1 lesson applied one layer down: a page-read blip
      // must not cost the visitor their part-completed funnel.
      if (hasSession) { setAdvanceFailed(true); return false; }
      setState(page.status === 'notFound' ? { kind: 'unavailable' } : { kind: 'loadFailed' });
      return false;
    }
    setState({ kind: 'step', payload, step: payload.step, sections: page.page.sections });
    return true;
  }, [orgId, vk]);

  useEffect(() => {
    // VP-R2-0 — a param advance() already rendered: swallow exactly once.
    // R2R F2 — the ref clears on EVERY run (a stale stamp must never swallow a
    // later legitimate Back/forward to the same value).
    const skip = skipParamLoad.current;
    skipParamLoad.current = null;
    if (skip !== null && skip === stepParam) return;
    const gen = ++navGen.current;
    const hadStep = hasStepRef.current;
    // With a step on screen (in-page Back / browser Back), keep it visible
    // while the earlier step loads — blanking to a skeleton would unmount the
    // live region and flash (the FN-R2-2 family).
    if (!hadStep) setState({ kind: 'loading' });
    setAdvanceFailed(false);
    const ix = stepParam !== null ? Number.parseInt(stepParam, 10) : NaN;
    const path = Number.isInteger(ix) && ix >= 0 ? `/steps/${ix}` : '';
    void call(`${path}${vk ? `?vk=${encodeURIComponent(vk)}` : ''}`).then(async (r) => {
      if (gen !== navGen.current) return; // a newer navigation superseded this load
      // FN-R2-5 — a dead ?step deep link falls back to the ENTRY once instead
      // of dead-ending a funnel whose start is alive.
      if (r.status === 'notFound' && path && !entryFallbackTried.current) {
        entryFallbackTried.current = true;
        // R2R F5 — drop only `step`; a shared link's utm_* params survive.
        setSearchParams((prev) => { const nxt = new URLSearchParams(prev); nxt.delete('step'); return nxt; }, { replace: true });
        return;
      }
      const rendered = await show(r, hadStep, () => gen !== navGen.current);
      if (rendered && hadStep) { window.scrollTo({ top: 0 }); stepRef.current?.focus(); }
    });
    // Back/forward + deep-link both land here via stepParam.
  }, [call, show, vk, stepParam, loadAttempt, setSearchParams]);

  /**
   * ADR 0584 §Correction (FORM-FUNNEL-1) — `submissionId` rides the advance.
   *
   * The server needs it to honour "a quarantined submission fires no
   * funnel-completion event": the completion is emitted by THIS request, and
   * without the id the route cannot tell a held submission's advance from a
   * real one. The visitor still advances either way — this suppresses an
   * analytics event, not a step — so nothing here leaks whether a submission
   * was held (the anti-oracle property ADR 0584 Decision 1 turns on).
   */
  const advance = useCallback(async (fromStepId: string, submissionId?: string): Promise<void> => {
    setAdvancing(true);
    setAdvanceFailed(false);
    const gen = ++navGen.current;
    try {
      const q = new URLSearchParams({ from: fromStepId, ...(vk ? { vk } : {}), ...(submissionId ? { submission: submissionId } : {}) });
      const r = await call(`/next?${q.toString()}`);
      if (gen !== navGen.current) return; // Back was clicked mid-flight — it wins
      // FN-G4 — distinguish "this advance failed" from "this funnel is gone".
      const rendered = await show(r, true, () => gen !== navGen.current);
      if (!rendered || gen !== navGen.current) return;
      // VP-R2-0 — stamp the URL WITHOUT reloading (advance already rendered);
      // FRMX-1 — push, so browser Back returns to the previous step; FRMX-2 —
      // land focus at the top of the new content. The live region stays
      // MOUNTED through all of this, so the stage change actually announces.
      if (r.status === 'ok' && r.payload.step) {
        const ix = String(r.payload.step.ix);
        // R2R F2 — a self-routed step resolves to the CURRENT ix: stamping the
        // same value never re-fires the effect, so never arm the skip for it.
        if (ix !== stepParam) {
          skipParamLoad.current = ix;
          // R2R F5 — merge, never replace: utm_* params on a shared link survive.
          setSearchParams((prev) => { const nxt = new URLSearchParams(prev); nxt.set('step', ix); return nxt; });
        }
      }
      window.scrollTo({ top: 0 });
      stepRef.current?.focus();
    } finally {
      setAdvancing(false);
    }
  }, [call, show, vk, stepParam, setSearchParams]);

  /** FN-G2 — an in-page Back. The step already lives in the URL, so this is a
   *  view-pointer move: it re-serves an EARLIER step and never completes one,
   *  so nothing the visitor already did is undone. REPLACES rather than pushes
   *  (FN-R2-8): pushing made browser-Back move you FORWARD after an in-page
   *  Back, and grew history one entry per hop. */
  const goBack = useCallback((toIx: number): void => {
    navGen.current += 1; // an in-flight advance must not yank us forward
    setAdvanceFailed(false);
    setSearchParams((prev) => { const nxt = new URLSearchParams(prev); nxt.set('step', String(toIx)); return nxt; }, { replace: true });
  }, [setSearchParams]);

  // FN-R2-9 — the tab is titled per step (funnel name — stage), undone on exit.
  useEffect(() => {
    if (typeof document === 'undefined' || state.kind !== 'step') return;
    const prev = document.title;
    const name = state.step.name ? ` — ${state.step.name}` : '';
    document.title = `${state.payload.funnel.name}${name}`;
    return () => { document.title = prev; };
  }, [state]);

  if (state.kind === 'loading') return <div className="u-p-4" role="status" aria-label={t('common:loading')}><Skeleton /></div>;
  if (state.kind === 'unavailable') {
    return <StateCard announce icon={<SearchIcon />} title={t('viewerUnavailableTitle')} body={t('viewerUnavailableBody')} />;
  }
  if (state.kind === 'loadFailed') {
    // FN-R2-4 — the read failed; the funnel may well exist. Never claim
    // "unpublished or out of date" for a network blip; offer a real retry.
    return (
      <StateCard
        announce icon={<SearchIcon />} title={t('viewerLoadFailedTitle')} body={t('viewerLoadFailedBody')}
        action={<button type="button" className="fp-btn fp-btn--ghost" onClick={() => setLoadAttempt((n) => n + 1)}>{t('common:retry')}</button>}
      />
    );
  }
  if (state.kind === 'complete') {
    // FN-R2-6 — announced (a SR visitor who finishes hears it), and never a
    // dead end when the operator authored a next step (exactly ONE CTA — the
    // single-CTA thank-you convention).
    return (
      <StateCard
        announce icon={<CheckIcon />} title={t('viewerCompleteTitle', { name: state.funnelName })} body={t('viewerCompleteBody')}
        action={state.cta ? (
          /^\//.test(state.cta.url)
            ? <a className="fp-btn fp-btn--primary" href={state.cta.url}>{state.cta.label}</a>
            : <a className="fp-btn fp-btn--primary" href={state.cta.url} rel="noopener noreferrer">{state.cta.label}</a>
        ) : undefined}
      />
    );
  }

  const { payload, step, sections } = state;
  const done = step.ix; // steps completed BEFORE this one
  const pct = payload.stepCount > 0 ? Math.round((done / payload.stepCount) * 100) : 0;
  // FN-G1/FN-G3 — a LABELLED stage, not a bare percentage: research is explicit
  // that labelled stages manage time-commitment expectations better, and the
  // step's own `name` was already in the payload and never shown.
  const position = t('viewerStepOf', { n: step.ix + 1, total: payload.stepCount });
  const stageLabel = step.name ? `${position} · ${step.name}` : position;
  return (
    <div className="u-w-full" ref={stepRef} tabIndex={-1}>
      {/* The progress header leads, so a visitor knows the shape of the
          commitment before reading the step. */}
      <div className="fp-shell funnel-progress">
        <div
          className="funnel-progress__track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={payload.stepCount}
          aria-valuenow={step.ix + 1}
          aria-valuetext={stageLabel}
          aria-label={t('viewerProgressLabel')}
        >
          <div className="funnel-progress__fill" style={{ inlineSize: `${pct}%` }} />
        </div>
        {/* ONE region: the visible stage label IS the status region, so a step
            change is announced without duplicating the text into a second
            sr-only node a screen reader would then read twice. (VP-R2-0 keeps
            this node MOUNTED across advances — a remounted live region
            announces nothing.) */}
        <p className="funnel-progress__label" role="status">
          <span className="funnel-progress__position">{position}</span>
          {step.name ? <span className="funnel-progress__name">{step.name}</span> : null}
        </p>
      </div>

      <FormEmbedProvider value={{
        ...(step.formContext ? { context: { ...step.formContext, ...(vk ? { visitor: vk } : {}) } } : {}),
        // FORM-FUNNEL-1 — hand the id straight through: the server decides
        // whether this submission earns a completion event.
        onSubmitted: (submissionId) => { void advance(step.stepId, submissionId); },
        // FORM-UX-4 (ADR 0584) — a step whose form is deleted, unpublished or
        // toggled off used to render NOTHING under an intact heading, and since
        // this funnel advances ONLY via `onSubmitted`, that step was a dead end
        // with no exit — the gate-with-no-exit shape. The visitor is now told
        // what happened AND given the way forward, because a step nobody can
        // complete must not be a step nobody can leave.
        renderUnavailable: () => (
          <div className="u-grid u-gap-2 u-justify-start">
            <Notice variant="info">{t('viewerFormUnavailable')}</Notice>
            <button type="button" className="fp-btn fp-btn--primary u-w-auto" onClick={() => { void advance(step.stepId); }}>
              {t('viewerFormUnavailableContinue')}
            </button>
          </div>
        ),
      }}>
        <RenderSections sections={sections} mode="public" />
      </FormEmbedProvider>

      {/* FN-G4 — a failed advance keeps the step on screen and says so. */}
      {advanceFailed ? (
        <div className="fp-shell u-p-4">
          <Notice variant="error">{t('viewerAdvanceFailed')}</Notice>
        </div>
      ) : null}

      {/* Back stays ENABLED during an advance — the navGen guard makes a
          mid-flight Back win; disabling it would trap the visitor behind a
          hanging page read (R2R F1's test caught exactly this). */}
      <div className="fp-shell funnel-nav u-p-4">
        {step.ix > 0 ? (
          <button type="button" className="fp-btn fp-btn--ghost" onClick={() => goBack(step.ix - 1)}>
            <ArrowLeftIcon size={16} /> {t('viewerBack')}
          </button>
        ) : <span />}
        {/* FN-R2-7 — the primary control stays MOUNTED while advancing (the
            old Notice swap dropped keyboard focus mid-activation and shifted
            the layout). */}
        <button
          type="button" className="fp-btn fp-btn--primary" disabled={advancing} aria-busy={advancing}
          onClick={() => { void advance(step.stepId); }}
        >
          {advancing ? t('viewerAdvancing') : advanceFailed ? t('viewerRetry') : t('viewerContinue')}
        </button>
      </div>
    </div>
  );
}
