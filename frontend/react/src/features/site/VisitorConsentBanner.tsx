/**
 * ADR 0860 D6 — the public visitor's analytics choice.
 *
 * Mounted by the two surfaces that use a visitor key (`FrontPage`, which docs also
 * render, and `FunnelViewerPage`, in every state). It renders two things:
 *
 *   - the CHOICE REGION: shown automatically only under an `opt-in` regime with no
 *     recorded choice, and on demand from the footer. Non-modal (`role="region"`,
 *     labelled): it never traps focus or blocks reading the page, and it does not
 *     steal focus on load. When asking, Accept and Reject are the SAME `Button`
 *     variant and size, side by side — equal prominence, no pre-ticked box, no
 *     second layer to refuse (CNIL 2020; EDPB Guidelines 05/2020 §§ 86–90; EDPB
 *     cookie-banner taskforce report 2023, practices 3 and 5). When changing, it
 *     states the current setting and offers the other one.
 *   - the FOOTER CONTROL ("Privacy choices"), portalled into PublicShell's
 *     footer (in a container this chunk creates) whenever the lane answers OR a choice is stored, so
 *     withdrawing is always one click away (GDPR Art. 7(3): as easy as giving) —
 *     even when the posture read fails.
 *
 * Focus: a choice returns focus to where it was before the region took it, else to
 * the footer control without scrolling (never to `<body>`), and is announced
 * through the shell's one live region. Opening from the footer moves focus to the
 * region's heading (never onto a choice); Esc closes it and returns to the button.
 * A failed save keeps the region open with its error. While the region is pinned,
 * the page gets matching bottom padding (so the end of the page, footer included,
 * can scroll clear of it) and `scroll-padding-bottom` (so a focused control is never
 * hidden behind it — WCAG 2.2 SC 2.4.11), both tracked with a ResizeObserver.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { announce } from '../../ui/announce.js';
import { recordChoice, useVisitorConsent } from './visitorConsent.js';
import { PRIVACY_HREF } from '../../brand/privacyHref.js';


export function VisitorConsentBanner({ orgId }: { orgId: string }): JSX.Element | null {
  const { t } = useTranslation('site');
  const { regime, choice } = useVisitorConsent(orgId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const regionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const footerBtnRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const headingId = useId();

  // The footer control's container is created HERE, inside PublicShell's existing
  // footer, so the entry chunk (PublicShell) carries no slot of its own — the
  // banner and everything it needs stay in this lazy chunk. No footer (an embed,
  // a test) ⇒ the control renders inline below the page instead.
  useLayoutEffect(() => {
    const footer = document.querySelector('.public-shell .app-footer');
    if (!footer) return;
    const el = document.createElement('div');
    el.className = 'visitor-consent__slot';
    footer.appendChild(el);
    setSlot(el);
    return () => { el.remove(); };
  }, []);

  const asking = regime === 'opt-in' && !choice;
  const shown = asking || open;

  // Keep the end of the page and any focused control clear of the pinned region.
  useLayoutEffect(() => {
    const el = regionRef.current;
    if (!shown || !el) return;
    const root = document.documentElement;
    const body = document.body;
    const prev = { scroll: root.style.scrollPaddingBottom, pad: body.style.paddingBottom };
    const apply = (): void => {
      root.style.scrollPaddingBottom = `${el.offsetHeight}px`;
      body.style.paddingBottom = `${el.offsetHeight}px`;
    };
    apply();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.scrollPaddingBottom = prev.scroll;
      body.style.paddingBottom = prev.pad;
    };
  }, [shown]);

  // Remember where focus came from the first time it enters the region, so a
  // choice can return it there. A document-level `focusin` listener, not a handler
  // on the (non-interactive) region element.
  useEffect(() => {
    if (!shown) return;
    const onFocusIn = (e: FocusEvent): void => {
      const region = regionRef.current;
      const from = e.relatedTarget;
      if (!region || !(e.target instanceof Node) || !region.contains(e.target)) return;
      if (from instanceof HTMLElement && !region.contains(from) && !returnFocusRef.current) returnFocusRef.current = from;
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, [shown]);

  // Opening on demand: focus moves to the heading; Esc closes and returns to the button.
  useEffect(() => {
    if (!open) return;
    headingRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setOpen(false);
      footerBtnRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // The lane is unavailable AND nothing was ever chosen: there is nothing to show.
  if (!orgId || ((regime === undefined || regime === null) && !choice)) return null;

  const choose = async (analytics: boolean): Promise<void> => {
    if (busy) return; // `aria-disabled`, not `disabled`: a disabled button drops focus
    setBusy(true);
    setFailed(false);
    try {
      await recordChoice(orgId, analytics);
      setOpen(false);
      announce(t(analytics ? 'consentSavedOn' : 'consentSavedOff'));
      const back = returnFocusRef.current;
      returnFocusRef.current = null;
      // After the region unmounts: back to where the visitor was, else the footer
      // control — without jumping the page to the bottom.
      requestAnimationFrame(() => {
        if (back && back.isConnected) back.focus({ preventScroll: true });
        else footerBtnRef.current?.focus({ preventScroll: true });
      });
    } catch {
      // Keep the region (and the focused button) on screen with the error. A
      // refusal is already kept on this device; the error says it did not reach us.
      setOpen(true);
      setFailed(true);
      requestAnimationFrame(() => headingRef.current?.focus()); // the pressed button may have been replaced
    } finally {
      setBusy(false);
    }
  };

  const current = choice ? choice.analytics : regime === 'opt-out';
  const changing = !asking;
  const choiceButton = (analytics: boolean): JSX.Element => (
    <Button key={String(analytics)} variant="secondary" aria-disabled={busy || undefined} onClick={() => void choose(analytics)}>
      {t(analytics ? 'consentAccept' : 'consentReject')}
    </Button>
  );
  const region = shown ? (
    <section
      ref={regionRef}
      className="visitor-consent"
      role="region"
      aria-labelledby={headingId}
    >
      <div className="visitor-consent__inner">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="visitor-consent__title">{t('consentTitle')}</h2>
        <p className="visitor-consent__body">
          {t(changing ? 'consentBodyChange' : 'consentBody')}{' '}
          <a href={PRIVACY_HREF}>{t('consentPrivacyLink')}</a>
        </p>
        {changing ? <p className="visitor-consent__state">{t(current ? 'consentStateOn' : 'consentStateOff')}</p> : null}
        {failed ? <Notice variant="error" announce={t('consentFailed')}>{t('consentFailed')}</Notice> : null}
        <div className="visitor-consent__actions">
          {changing ? choiceButton(!current) : [choiceButton(true), choiceButton(false)]}
          {changing ? (
            <Button variant="quiet" className="visitor-consent__close" onClick={() => { setOpen(false); setFailed(false); footerBtnRef.current?.focus(); }}>{t('consentClose')}</Button>
          ) : null}
        </div>
      </div>
    </section>
  ) : null;

  const footerControl = (
    <Button
      ref={footerBtnRef}
      variant="link"
      className="visitor-consent__footer-btn"
      aria-expanded={shown}
      onClick={() => {
        if (open) { setOpen(false); return; }
        returnFocusRef.current = footerBtnRef.current;
        setOpen(true);
      }}
    >
      {t('consentFooterLink')}
    </Button>
  );

  return (
    <>
      {region}
      {slot ? createPortal(footerControl, slot) : <div className="visitor-consent__inline-footer">{footerControl}</div>}
    </>
  );
}
