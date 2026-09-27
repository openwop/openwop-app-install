/**
 * "Your session ended" — the surface that replaces a MISDIAGNOSIS (ADR 0517 fix D).
 *
 * When a signed-in session lapses, the browser falls back to a fresh anonymous
 * tenant, which cannot see the workspace's stored BYOK secrets. The chat used to
 * read that empty result as "this user has no API key" and open the first-run
 * wizard — so the user, who had done nothing wrong and whose key was sitting
 * safely on the server, pasted it again. Because the wizard minted a timestamped
 * ref, that created a duplicate secret rather than reconnecting the existing one.
 * Seven such duplicates accumulated in one real workspace before anyone noticed.
 *
 * So the honest state gets its own card. It names the actual cause, offers the
 * actual fix (sign back in), and says plainly that the key is still there — the
 * reassurance the wizard's "Add your API key" heading actively contradicted.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../ui/StateCard.js';
import { Button } from '../ui/Button.js';
import { LockIcon } from '../ui/icons/index.js';
import { useAuth } from '../auth/useAuth.js';

export function SessionExpiredCard({ onUseWizard }: {
  /** Escape hatch: the user genuinely wants to set up a key without signing in. */
  onUseWizard: () => void;
}): JSX.Element {
  const { t } = useTranslation('byok');
  const { signIn, isConfigured } = useAuth();
  const [busy, setBusy] = useState(false);

  async function doSignIn(): Promise<void> {
    setBusy(true);
    try {
      await signIn.google();
    } finally {
      setBusy(false);
    }
  }

  return (
    <StateCard
      icon={<LockIcon size={20} />}
      title={t('sessionExpiredTitle')}
      body={t('sessionExpiredBody')}
      // A failed READ that swapped the surface out from under the user — exactly
      // the class StateCard's `announce` exists for. Without it a screen-reader
      // user is told nothing and infers "nothing to report".
      announce
      action={(
        <div className="button-row">
          {isConfigured && (
            <Button variant="primary" onClick={() => { void doSignIn(); }} disabled={busy}>
              {busy ? t('sessionExpiredSigningIn') : t('sessionExpiredSignIn')}
            </Button>
          )}
          <Button variant="secondary" onClick={onUseWizard} disabled={busy}>
            {t('sessionExpiredUseKey')}
          </Button>
        </div>
      )}
    />
  );
}
