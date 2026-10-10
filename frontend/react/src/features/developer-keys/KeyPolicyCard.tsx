/**
 * ADR 0798 — the workspace's own rules about API keys, for its admins: turn
 * keys off altogether (none can be created, none authenticates), and set a
 * tighter lifetime cap than the deployment's. The server is the authority; this
 * card is offered only to someone the server would let change it, and a refusal
 * is shown, not hidden.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { ShieldIcon } from '../../ui/icons/index.js';
import { announce } from '../../ui/announce.js';
import { writeErrorMessage } from '../../lib/writeAccess.js';
import { setWorkspaceKeyPolicy, type KeyMintPolicy } from './apiKeysClient.js';

export function KeyPolicyCard({ policy, onChanged }: { policy: KeyMintPolicy; onChanged: () => void }): JSX.Element {
  const { t } = useTranslation('developer-keys');
  const allowId = useId();
  const capId = useId();
  const [allow, setAllow] = useState(policy.disabled !== true);
  const [cap, setCap] = useState(String(policy.maxLifetimeDays));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const capDays = Number(cap);
  const capValid = Number.isInteger(capDays) && capDays >= 1 && capDays <= 3660;

  const save = async (): Promise<void> => {
    if (!capValid) return;
    setBusy(true);
    setError(null);
    try {
      await setWorkspaceKeyPolicy({ disabled: !allow, maxLifetimeDays: capDays });
      announce(t('policySaved'));
      onChanged();
    } catch (err) {
      setError(writeErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="surface-card">
      <h2 className="u-flex u-items-center u-gap-2"><ShieldIcon size={18} /> {t('policyTitle')}</h2>
      <p className="muted">{t('policyHelp')}</p>
      <form className="mcp-key-form" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="field">
          <label className="field-check-label u-flex u-items-center u-gap-2 u-fs-13" htmlFor={allowId}>
            <input id={allowId} type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} />
            {t('policyAllow')}
          </label>
          {!allow && <p className="muted u-fs-12">{t('policyOffHelp')}</p>}
        </div>
        <div className="field">
          <label htmlFor={capId}>{t('policyMaxLabel')}</label>
          <input
            id={capId}
            type="number"
            inputMode="numeric"
            min={1}
            max={3660}
            value={cap}
            aria-invalid={!capValid || undefined}
            onChange={(e) => setCap(e.target.value)}
          />
          <p className="muted u-fs-12">{t('policyMaxHelp')}</p>
        </div>
        <div className="action-bar">
          <Button type="submit" variant="secondary" loading={busy} disabled={!capValid}>{t('policySave')}</Button>
        </div>
      </form>
      {error && <Notice variant="error" announce={error}>{error}</Notice>}
    </div>
  );
}
