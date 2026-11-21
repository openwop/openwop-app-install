/**
 * ADR 1153 D6 — the visitor's analytics choice as a section of a privacy page (ADR 0860 D6).
 *
 * The banner (`VisitorConsentBanner`) asks on first visit and reopens from the
 * footer. A visitor reading the policy could not see or change the choice there,
 * so this section states the current setting and changes it in place, with no
 * panel. It follows the banner's rules exactly:
 *
 *   - the same equal-weight `Button`s calling `recordChoice` (CNIL 2020; EDPB
 *     05/2020 §§ 86–90): while nothing is chosen under a regime that asks, Accept
 *     and Reject side by side; once chosen, the other setting;
 *   - on a site that offers session recording (ADR 0951 D1), its own UNTICKED box
 *     while asking and its own turn-on/turn-off button after;
 *   - a saved choice is announced through the shell's one live region; a failed
 *     save shows the banner's error Notice and keeps focus on the section;
 *   - rendered only where the consent lane answers or a choice is stored, as the
 *     footer control is.
 *
 * Exported so a distribution's own policy page can render it (an adopter page; a
 * CMS `privacyChoices` section is deferred, ADR 1153 Alternatives). Its `id` is `PRIVACY_CHOICES_ANCHOR`, which
 * the `VITE_BRAND_CONSENT_FOOTER=link` footer link targets.
 */
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { announce } from '../../ui/announce.js';
import { PRIVACY_CHOICES_ANCHOR } from '../../brand/consentOptions.js';
import { recordChoice, replayOfferedFor } from './visitorConsent.js';
import { useVisitorConsent } from './useVisitorConsent.js';

export function VisitorConsentChoices({ orgId, headingLevel = 2 }: { orgId: string; headingLevel?: 2 | 3 }): JSX.Element | null {
  const { t } = useTranslation('site');
  const { regime, choice } = useVisitorConsent(orgId);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [replayTicked, setReplayTicked] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const replayBoxId = useId();
  const replayHintId = useId();
  const replayOffered = replayOfferedFor(orgId);

  // The lane is unavailable AND nothing was ever chosen: nothing to state.
  if (!orgId || ((regime === undefined || regime === null) && !choice)) return null;

  const asking = !choice && (regime === 'opt-in' || (replayOffered && regime === 'opt-out'));
  const current = choice ? choice.analytics : regime === 'opt-out';
  const currentReplay = choice?.replay === true;

  const choose = async (analytics: boolean, replay: boolean | undefined, saved: string): Promise<void> => {
    if (busy) return; // `aria-disabled`, not `disabled`: a disabled button drops focus
    setBusy(true);
    setFailed(false);
    try {
      await recordChoice(orgId, analytics, replay !== undefined ? { replay } : {});
      announce(saved);
    } catch {
      setFailed(true);
      // The pressed button may be replaced by the next state's: keep focus in the section.
      requestAnimationFrame(() => headingRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  const choiceButton = (analytics: boolean): JSX.Element => (
    <Button
      key={String(analytics)}
      variant="secondary"
      aria-disabled={busy || undefined}
      onClick={() => void choose(analytics, asking && replayOffered ? analytics && replayTicked : undefined, t(analytics ? 'consentSavedOn' : 'consentSavedOff'))}
    >
      {t(analytics ? 'consentAccept' : 'consentReject')}
    </Button>
  );
  const replayButton = (
    <Button
      key="replay"
      variant="secondary"
      aria-disabled={busy || undefined}
      onClick={() => void choose(current, !currentReplay, t(currentReplay ? 'consentReplaySavedOff' : 'consentReplaySavedOn'))}
    >
      {t(currentReplay ? 'consentReplayTurnOff' : 'consentReplayTurnOn')}
    </Button>
  );

  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <section id={PRIVACY_CHOICES_ANCHOR} className="visitor-consent-choices" aria-labelledby={headingId}>
      <Heading id={headingId} ref={headingRef} tabIndex={-1} className="visitor-consent-choices__title">{t('consentChoicesTitle')}</Heading>
      <p className="visitor-consent-choices__state">{t(asking ? 'consentStateUnset' : current ? 'consentStateOn' : 'consentStateOff')}</p>
      {replayOffered && !asking ? (
        <p className="visitor-consent-choices__state">{t(currentReplay ? 'consentReplayStateOn' : 'consentReplayStateOff')}</p>
      ) : null}
      {replayOffered && asking ? (
        <div className="visitor-consent__replay">
          <input id={replayBoxId} type="checkbox" checked={replayTicked} onChange={(e) => setReplayTicked(e.target.checked)} aria-describedby={replayHintId} />
          <span>
            <label htmlFor={replayBoxId} className="visitor-consent__replay-label">{t('consentReplayLabel')}</label>{' '}
            <span id={replayHintId}>{t('consentReplayHint')}</span>
          </span>
        </div>
      ) : null}
      {failed ? <Notice variant="error" announce={t('consentFailed')}>{t('consentFailed')}</Notice> : null}
      <div className="visitor-consent__actions">
        {asking ? [choiceButton(true), choiceButton(false)] : [choiceButton(!current), ...(replayOffered ? [replayButton] : [])]}
      </div>
    </section>
  );
}
