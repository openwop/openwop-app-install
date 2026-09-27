import { Button } from '../ui/Button.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig, ProviderModel } from './lib/providers.js';
import { ShieldIcon } from '../ui/icons/index.js';
import { storeKey } from './lib/byokClient.js';
import { Field } from '../ui/Field.js';

// ── Step 3: key entry ──────────────────────────────────────────────────

export function KeyEntry({
  provider,
  model,
  onBack,
  onStored,
  targetRef,
  existingRef,
}: {
  provider: ProviderConfig;
  model: ProviderModel;
  onBack: () => void;
  onStored: (credentialRef: string) => void | Promise<void>;
  /**
   * The ref a submitted key is stored UNDER (ADR 0517 fix B). Deterministic —
   * `byok:<provider>`, or the provider's existing ref when one is already stored,
   * so replacing a key OVERWRITES the row the chat is bound to. The old
   * `byok:<provider>:${Date.now()}` minted a fresh secret on every submit, which
   * is how one workspace accumulated seven Google keys.
   */
  targetRef: string;
  /**
   * A key this workspace ALREADY has for this provider (ADR 0517 fix A). When
   * present the user is offered it instead of being asked to paste a key they
   * already gave us — the single most common reason the wizard appeared at all.
   */
  existingRef?: string | null;
}): JSX.Element {
  const { t } = useTranslation('byok');
  const [key, setKey] = useState('');
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);

  async function adopt(): Promise<void> {
    if (!existingRef) return;
    setAdopting(true);
    setError(null);
    try {
      await onStored(existingRef);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdopting(false);
    }
  }

  // Soft validation: warn (not block) if the key doesn't match the
  // provider's expected prefix.
  const prefixWarning = provider.apiKeyPrefix && key.length > 0 && !key.startsWith(provider.apiKeyPrefix)
    ? t('prefixWarning', { prefix: provider.apiKeyPrefix })
    : null;

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!key.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      // Deterministic (ADR 0517 fix B): storing again REPLACES this workspace's key
      // for the provider instead of accumulating a new secret row per attempt.
      await storeKey(targetRef, key);
      // Clear the input field immediately — never leave plaintext in React state.
      setKey('');
      await onStored(targetRef);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h2 className="u-m-0 u-fs-14">{t('addYourKeyTitle', { provider: provider.label })}</h2>
      <p className="muted u-mt-1 u-fs-12">
        {t('usingModel')} <strong>{model.label}</strong>.{' '}
        <a href={provider.apiKeyConsoleUrl} target="_blank" rel="noopener noreferrer">{t('getAKey')}</a>
      </p>

      {/* ADR 0517 fix A — this workspace already HAS a key for this provider. Offer
        * it as the primary action. Before this, the wizard silently ignored stored
        * keys and asked again, and every "ask again" minted a duplicate secret. */}
      {existingRef && (
        <div className="surface-card u-mt-2 u-p-2">
          <p className="u-m-0 u-fs-12">
            <strong>{t('savedKeyFound', { provider: provider.label })}</strong>
          </p>
          <p className="muted u-mt-1 u-fs-12">{t('savedKeyExplain')}</p>
          <div className="button-row">
            <Button variant="primary" onClick={() => { void adopt(); }} disabled={adopting || submitting}>
              {adopting ? t('savedKeyUsing') : t('savedKeyUse')}
            </Button>
          </div>
          <p className="muted u-mt-2 u-fs-12">{t('savedKeyReplaceHint')}</p>
        </div>
      )}

      <div className="alert info u-flex u-items-start u-gap-2">
        <span className="byok-entry-icon" aria-hidden="true"><ShieldIcon size={16} /></span>
        <span className="u-fs-12">
          {provider.apiKeyHelpText} {t('payProviderDirectly', { provider: provider.label })}
        </span>
      </div>

      <Field
        label={t('apiKeyLabel')}
        containerStyle={{ marginTop: 12 }}
        {...(prefixWarning ? { help: prefixWarning } : {})}
      >
        {(w) => (
          <div className="u-flex u-gap-1">
            <input
              {...w}
              type={show ? 'text' : 'password'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={provider.apiKeyPlaceholder}
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              variant="secondary" className="keyentry-show-btn"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? t('hideKey') : t('showKey')}
            >
              {show ? t('hide') : t('show')}
            </Button>
          </div>
        )}
      </Field>

      {error && <div role="alert" className="alert error u-fs-12">{error}</div>}

      <div className="button-row">
        <Button
          variant={existingRef ? 'secondary' : 'primary'}
          type="submit"
          disabled={submitting || adopting || !key.trim()}
        >
          {submitting ? t('storing') : (existingRef ? t('replaceKey') : t('storeKey'))}
        </Button>
        <Button variant="secondary" onClick={onBack} disabled={submitting || adopting}>{t('back')}</Button>
      </div>
    </form>
  );
}
