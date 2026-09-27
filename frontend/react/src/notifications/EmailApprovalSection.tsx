/**
 * ADR 0478 §2 — the recipient's email opt-in section (lazy-loaded by the
 * notification preferences panel — entry-chunk budget discipline).
 */

import { Button } from '../ui/Button.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/useAuth.js';
import { getEmailApprovalPref, putEmailApprovalPref } from './approvalDeliveryClient.js';

/** ADR 0478 §2 — the recipient's email opt-in for addressed approval mail. */
export function EmailApprovalSection(): JSX.Element {
  const { t } = useTranslation('notifications');
  const { user } = useAuth();
  const [email, setEmail] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'saved' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setState('loading');
    getEmailApprovalPref()
      // ux-review B2 (minimal v1) — default to the SIGNED-IN account's email:
      // decision links are capability-bearing, so the free-typed address is
      // prefilled with the one identity we know, and the copy states the
      // responsibility. The confirm-loop verification is a recorded follow-on.
      .then((p) => { if (live) { setEmail(p.email ?? user?.email ?? ''); setEnabled(p.enabled); setState('idle'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- user?.email is a prefill-once default, not a re-fetch trigger
  }, [reload]);

  async function save(nextEnabled: boolean): Promise<void> {
    setState('saving');
    setError(null);
    try {
      const p = await putEmailApprovalPref({ email, enabled: nextEnabled });
      setEmail(p.email ?? email);
      setEnabled(p.enabled);
      setState('saved');
    } catch (err) {
      setError(err instanceof Error && !/_\d+$/.test(err.message) ? err.message : t('emailApprovalSaveFailed'));
      setState('idle');
    }
  }

  return (
    <section className="u-mb-3">
      <h4 className="u-fs-12 u-m-0 u-mb-2">{t('emailApprovalHeading')}</h4>
      <p className="muted u-fs-11 u-m-0">{t('emailApprovalBody')}</p>
      {state === 'loading' ? <p className="muted u-fs-11">{t('emailApprovalLoading')}</p>
        : state === 'error' ? (
          // Grade-ux #3 — a failed load must NOT render the live form over
          // `email:''`/`enabled:false`: Save from that state would overwrite
          // the stored address (the SlaPolicySection H2 fix, applied here).
          <div className="u-mt-2">
            <p className="alert error u-fs-11 u-m-0" role="alert">{t('emailApprovalLoadFailed')}</p>
            <Button variant="secondary" size="sm" className="u-mt-2" onClick={() => setReload((n) => n + 1)}>
              {t('emailApprovalLoadRetry')}
            </Button>
          </div>
        ) : (
        <div className="u-flex u-items-center u-gap-2 u-wrap u-mt-2">
          <input
            type="email"
            className="ui-input"
            value={email}
            onChange={(e) => { setEmail(e.target.value); if (state === 'saved') setState('idle'); }}
            placeholder={t('emailApprovalPlaceholder')}
            aria-label={t('emailApprovalHeading')}
          />
          <label className="u-flex u-items-center u-gap-1 u-fs-12">
            <input
              type="checkbox"
              checked={enabled}
              disabled={state === 'saving'}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t('emailApprovalEnable')}
          </label>
          <Button variant="secondary" size="sm" onClick={() => { void save(enabled); }} disabled={state === 'saving'}>
            {t('emailApprovalSave')}
          </Button>
          {state === 'saved' ? <span className="muted u-fs-11" role="status">{t('emailApprovalSaved')}</span> : null}
        </div>
      )}
      <p className="muted u-fs-11 u-m-0">{t('emailApprovalOwnership')}</p>
      {error ? <p className="alert error u-fs-11 u-m-0" role="alert">{error}</p> : null}
    </section>
  );
}
