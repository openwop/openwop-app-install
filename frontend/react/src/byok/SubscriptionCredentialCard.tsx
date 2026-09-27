/**
 * RFC 0121 AT-OWN-RISK subscription-credential entry (ADR 0180).
 *
 * A DELIBERATELY gated surface: it renders ONLY when the host actually advertises
 * the `subscription` auth mode for at least one provider (read from
 * `aiProviders.authModes` in the capabilities document). On the public demo the
 * host is DARK, so this card is hidden entirely.
 *
 * Reusing a personal, non-metered consumer subscription (e.g. ChatGPT Plus;
 * Anthropic and Google now prohibit it — ADR 0756) as a provider credential may VIOLATE the provider's terms of
 * service and risk ACCOUNT SUSPENSION. This card therefore surfaces a mandatory,
 * explicit risk disclosure + a REQUIRED acknowledgement checkbox, and sends
 * `acknowledgedRisk:true` to the bind seam ONLY after the user checks it. The
 * credential binds at USER scope (§B.8); the value stays on the host.
 */

import { Button } from '../ui/Button.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCapabilities } from '../client/runsClient.js';
import { bindSubscriptionCredential } from './lib/byokClient.js';
import { subscriptionProvidersFrom } from './lib/subscriptionProviders.js';
import { Notice, StateCard } from '../ui/index.js';
import { SelectField, TextField, CheckboxField } from '../ui/Field.js';
import { ShieldIcon } from '../ui/icons/index.js';
import { CopilotConnectCard } from './CopilotConnectCard.js';

/** ADR 0757 — RFC 0121 CLEARED providers: connected through their own sign-in
 *  flow (no paste, no ToS-risk consent). Everything else advertised here is the
 *  ADR 0180 at-own-risk path. */
const CLEARED_PROVIDERS: ReadonlySet<string> = new Set(['github.copilot']);

export function SubscriptionCredentialCard(): JSX.Element | null {
  const { t } = useTranslation('byok');
  const [providers, setProviders] = useState<string[] | null>(null);
  const [cleared, setCleared] = useState<string[]>([]);
  const [provider, setProvider] = useState('');
  const [value, setValue] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedRef, setSavedRef] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const caps = await getCapabilities();
        const all = subscriptionProvidersFrom(caps);
        const list = all.filter((p) => !CLEARED_PROVIDERS.has(p));
        if (!live) return;
        setCleared(all.filter((p) => CLEARED_PROVIDERS.has(p)));
        setProviders(list);
        if (list[0]) setProvider(list[0]);
      } catch {
        if (live) setProviders([]);
      }
    })();
    return () => { live = false; };
  }, []);

  const copilot = cleared.includes('github.copilot') ? <CopilotConnectCard /> : null;
  // The at-own-risk form is hidden entirely when the host advertises no
  // at-own-risk subscription provider (dark); a cleared provider renders alone.
  if (providers === null || providers.length === 0) return copilot;

  const canSubmit = acknowledged && value.trim().length > 0 && provider.length > 0 && !busy;

  async function onSubmit(): Promise<void> {
    setError(null);
    setSavedRef(null);
    if (!acknowledged || !value.trim()) return;
    setBusy(true);
    try {
      const res = await bindSubscriptionCredential({ provider, value: value.trim(), acknowledgedRisk: true });
      setSavedRef(res.credentialRef);
      setValue('');
      setAcknowledged(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    {copilot}
    <div className="surface-card">
      <div className="keys-provider-head action-bar u-justify-between">
        <div className="keys-provider-name u-iflex u-gap-2">
          <span className="chip chip--warning">
            <span className="u-iflex u-gap-1"><ShieldIcon size={13} aria-hidden /> {t('sub.title')}</span>
          </span>
        </div>
      </div>
      <p className="muted">{t('sub.intro')}</p>

      <Notice variant="warning">{t('sub.riskDisclosure')}</Notice>

      {savedRef && <Notice variant="success" announce={t('sub.saved')}>{t('sub.saved')}</Notice>}
      {error && <Notice variant="error">{error}</Notice>}

      <div className="form-row">
        <SelectField
          label={t('sub.providerLabel')}
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        >
          {providers.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </SelectField>
        <TextField
          label={t('sub.valueLabel')}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('sub.valuePlaceholder')}
          autoComplete="off"
          help={t('sub.valueHelp')}
        />
        <CheckboxField
          label={t('sub.acknowledge')}
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          required
        />
        <div className="u-flex u-gap-2 u-justify-end">
          <Button variant="primary" onClick={() => { void onSubmit(); }} disabled={!canSubmit}>
            {busy ? t('common:saving') : t('sub.save')}
          </Button>
        </div>
      </div>

      {savedRef ? <StateCard icon={<ShieldIcon size={24} />} title={t('sub.boundTitle')} body={savedRef} /> : null}
    </div>
    </>
  );
}
