/**
 * The free tier refuses signed-out visitors on this host (`sign_in_required`), but
 * the chat still renders — a visitor's own key works. Without this notice they
 * learned that only after typing and sending. The flag comes from
 * `/byok/active-config` via `useBYOKConfig`; `ChatTab` provides it, so embedded
 * chats (which own their own gate) never show it.
 */
import { createContext, useContext, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { SignInButton } from '../auth/SignInButton.js';
import { Button } from '../ui/Button.js';

export const SignInRequiredContext = createContext(false);

export function SignInRequiredNotice({ onUseOwnKey }: { onUseOwnKey: () => void }): JSX.Element | null {
  const { t } = useTranslation();
  const headingId = useId();
  if (!useContext(SignInRequiredContext)) return null;
  return (
    <section className="signin-notice" aria-labelledby={headingId}>
      <p className="signin-notice-text">
        <strong id={headingId}>{t('chat:errSignInTitle')}</strong>{' '}
        {t('chat:signInNoticeBody')}
      </p>
      <div className="signin-notice-actions">
        <SignInButton />
        <Button variant="quiet" size="sm" onClick={onUseOwnKey}>{t('chat:signInNoticeOwnKey')}</Button>
      </div>
    </section>
  );
}
