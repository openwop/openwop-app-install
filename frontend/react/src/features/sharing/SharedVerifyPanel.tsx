/**
 * ADR 1141 D6 — what a recipient-bound share link shows before its code.
 *
 * Only the firm's name and the masked address on record are on screen: nothing from
 * the shared resource, not even its title. The visitor asks for a code (it goes to
 * the address on record, never to one typed here), enters it, and the page re-reads
 * the link with this browser's now-verified session. Sending is an explicit act, not
 * a page-load side effect, so reloading the page never emails anyone.
 */
import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useBrand } from '../../brand/BrandProvider.js';
import { Button } from '../../ui/Button.js';
import { TextField } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { LinkIcon } from '../../ui/icons/index.js';
import { requestShareCode, verifyShareCode, ShareCodeError, type ShareVerifyPrompt } from './sharingClient.js';

const COLUMN_STYLE: React.CSSProperties = { maxWidth: '30rem' };

type Phase = 'ask' | 'sending' | 'sent' | 'verifying';

/**
 * `onWrongCode` lets the page re-read the link quietly after a miss. The code routes
 * answer the fifth wrong code exactly like the others (uniform, by design), so only
 * that re-read can tell the visitor the link has locked. Without it, they kept asking
 * for codes that were never sent.
 */
export function SharedVerifyPanel({ token, prompt, onVerified, onWrongCode }: { token: string; prompt: ShareVerifyPrompt; onVerified: () => void; onWrongCode?: () => void }): JSX.Element {
  const { t } = useTranslation('sharing');
  const brand = useBrand();
  const [phase, setPhase] = useState<Phase>('ask');
  // Once a code has gone out, the code form stays up through a resend (and a failed
  // one), so the visitor never loses the field they were typing into.
  const [hasSent, setHasSent] = useState(false);
  // A resend says so in its own words, so a screen reader announces it (the first
  // notice's text is unchanged, and an unchanged live region is not re-read).
  const [sentAgain, setSentAgain] = useState(false);
  const codeField = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const org = prompt.orgDisplayName || brand.productName;
  const email = prompt.maskedEmail;

  const explain = (err: unknown): string => {
    if (err instanceof ShareCodeError && err.kind === 'wrong') {
      return t('verifyWrong', { defaultValue: "That code didn't work. Check it, or send a new one." });
    }
    if (err instanceof ShareCodeError && err.kind === 'rateLimited') {
      const minutes = Math.max(1, Math.ceil((err.retryAfterS ?? 60) / 60));
      return t('verifyRateLimited', { defaultValue: 'Too many tries. Try again in {{minutes}} min.', minutes });
    }
    return t('verifyUnavailable', { defaultValue: 'Something went wrong on our end. Try again in a moment.' });
  };

  const send = async (): Promise<void> => {
    setProblem(null);
    setPhase('sending');
    try {
      await requestShareCode(token);
      setCode('');
      setSentAgain(hasSent);
      setHasSent(true);
      setPhase('sent');
    } catch (err) {
      setProblem(explain(err));
      setPhase(hasSent ? 'sent' : 'ask');
    }
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setProblem(t('verifyFormat', { defaultValue: 'Enter the 6-digit code from the email.' }));
      return;
    }
    setProblem(null);
    setPhase('verifying');
    try {
      await verifyShareCode(token, code);
      onVerified();
    } catch (err) {
      setProblem(explain(err));
      setPhase('sent');
      if (err instanceof ShareCodeError && err.kind === 'wrong') {
        // Back to the field, selected, so the next try is one keystroke away.
        requestAnimationFrame(() => { codeField.current?.focus(); codeField.current?.select(); });
        onWrongCode?.();
      }
    }
  };

  const sentOrLater = hasSent;
  return (
    <div className="u-p-4 u-mx-auto page-enter" style={COLUMN_STYLE}>
      <header className="u-flex u-flex-col u-gap-2 u-mb-4">
        <span className="chip chip--muted u-fs-11 u-self-start">{org}</span>
        <h1 className="page-header__title">{t('verifyTitle', { defaultValue: 'Confirm it’s you' })}</h1>
        <p className="u-m-0">
          {t('verifyLede', { defaultValue: '{{org}} shared this link with {{email}}. To open it, we’ll email a one-time code to that address.', org, email })}
        </p>
      </header>

      {problem ? <div className="u-mb-3"><Notice variant="error" announce={problem}>{problem}</Notice></div> : null}

      {sentOrLater ? (
        <form className="u-flex u-flex-col u-gap-3" onSubmit={(e) => { void submit(e); }} noValidate>
          {(() => {
            const sent = sentAgain
              ? t('verifySentAgain', { defaultValue: 'We’ve sent a new code to {{email}}. The earlier one no longer works.', email })
              : t('verifySent', { defaultValue: 'We’ve sent a code to {{email}}. It expires in 10 minutes.', email });
            return <Notice variant="info" announce={sent}>{sent}</Notice>;
          })()}
          <TextField
            ref={codeField}
            label={t('verifyCodeLabel', { defaultValue: '6-digit code' })}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            autoFocus
          />
          <div className="u-flex u-gap-2 u-flex-wrap">
            <Button type="submit" disabled={phase === 'verifying' || phase === 'sending'}>
              {phase === 'verifying'
                ? t('verifyChecking', { defaultValue: 'Checking…' })
                : t('verifySubmit', { defaultValue: 'Open the link' })}
            </Button>
            <Button type="button" variant="secondary" onClick={() => { void send(); }} disabled={phase === 'verifying' || phase === 'sending'}>
              {phase === 'sending'
                ? t('verifySending', { defaultValue: 'Sending…' })
                : t('verifyResend', { defaultValue: 'Send a new code' })}
            </Button>
          </div>
        </form>
      ) : (
        <Button onClick={() => { void send(); }} disabled={phase === 'sending'}>
          {phase === 'sending'
            ? t('verifySending', { defaultValue: 'Sending…' })
            : t('verifySend', { defaultValue: 'Email me a code' })}
        </Button>
      )}

      <p className="muted u-fs-11 u-mt-4">
        {t('verifyWhy', { defaultValue: 'This keeps a forwarded link from opening for someone else. Not you? Ask the sender for a link of your own.' })}
      </p>
    </div>
  );
}

/** ADR 1141 — five wrong codes locked the link; only its owner can unlock it. */
export function SharedLockedCard({ prompt }: { prompt: ShareVerifyPrompt }): JSX.Element {
  const { t } = useTranslation('sharing');
  const brand = useBrand();
  const org = prompt.orgDisplayName || brand.productName;
  return (
    <div className="u-p-4 page-enter">
      <StateCard
        icon={<LinkIcon size={28} />}
        announce
        title={t('verifyLockedTitle', { defaultValue: 'This link is locked' })}
        body={t('verifyLockedBody', { defaultValue: 'Too many wrong codes were entered. Ask {{org}} to unlock it or send you a new link.', org })}
      />
    </div>
  );
}
