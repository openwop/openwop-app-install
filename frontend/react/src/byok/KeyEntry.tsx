import { useState } from 'react';
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
}: {
  provider: ProviderConfig;
  model: ProviderModel;
  onBack: () => void;
  onStored: (credentialRef: string) => void | Promise<void>;
}): JSX.Element {
  const [key, setKey] = useState('');
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Soft validation: warn (not block) if the key doesn't match the
  // provider's expected prefix.
  const prefixWarning = provider.apiKeyPrefix && key.length > 0 && !key.startsWith(provider.apiKeyPrefix)
    ? `Anthropic keys usually start with "${provider.apiKeyPrefix}". Continuing anyway.`
    : null;

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!key.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const credentialRef = `byok:${provider.id}:${Date.now()}`;
      await storeKey(credentialRef, key);
      // Clear the input field immediately — never leave plaintext in React state.
      setKey('');
      await onStored(credentialRef);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h2 className="u-m-0 u-fs-14">Add your {provider.label} API key</h2>
      <p className="muted u-mt-1 u-fs-12">
        Using <strong>{model.label}</strong>.{' '}
        <a href={provider.apiKeyConsoleUrl} target="_blank" rel="noopener noreferrer">Get a key →</a>
      </p>

      <div className="alert info u-flex u-items-start u-gap-2">
        <ShieldIcon size={16} style={{ flexShrink: 0, marginTop: 1, color: 'var(--color-accent)' }} />
        <span className="u-fs-12">
          {provider.apiKeyHelpText} You pay {provider.label} directly for usage.
        </span>
      </div>

      <Field
        label="API key"
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
            <button
              type="button"
              className="secondary keyentry-show-btn"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? 'Hide key' : 'Show key'}
            >
              {show ? 'Hide' : 'Show'}
            </button>
          </div>
        )}
      </Field>

      {error && <div className="alert error u-fs-12">{error}</div>}

      <div className="button-row">
        <button type="submit" disabled={submitting || !key.trim()}>
          {submitting ? 'Storing…' : 'Store key'}
        </button>
        <button type="button" className="secondary" onClick={onBack} disabled={submitting}>Back</button>
      </div>
    </form>
  );
}
