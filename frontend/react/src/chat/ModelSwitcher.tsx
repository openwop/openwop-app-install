/**
 * In-chat model switcher (ADR 0124 Phase 2c).
 *
 * A labeled, keyboard-reachable dropdown of the host's advertised provider/model
 * options (from `fetchModelCapabilities`). Selecting one drives the per-EXCHANGE
 * override (SendOptions.model/provider) — it extends the ONE chat composer, never a
 * second chat. Degrades gracefully: while loading or when the host advertises no
 * models, it renders nothing and the composer uses the run's default model.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchModelCapabilities, type ProviderCapabilities } from '../client/chatSessionsClient.js';

export interface ModelChoice { provider: string; model: string }

interface Props {
  value: ModelChoice | null;
  onChange: (choice: ModelChoice | null) => void;
  /** ADR 0164 P3 — the conversation's active (configured) provider. When set, the
   *  switcher offers ONLY that provider's models — a per-exchange override is a
   *  MODEL switch within the configured provider, never a jump to a provider the
   *  user has no credential for. Omitted ⇒ all advertised models (legacy). */
  provider?: string;
}

export function ModelSwitcher({ value, onChange, provider }: Props): JSX.Element | null {
  const { t } = useTranslation('chat');
  const [providers, setProviders] = useState<ProviderCapabilities[] | null>(null);

  useEffect(() => {
    let live = true;
    void fetchModelCapabilities().then((p) => { if (live) setProviders(p); });
    return () => { live = false; };
  }, []);

  // Flatten to (provider, model) options; only providers that advertise models.
  // Scoped to the active provider when given — then the label drops the redundant
  // provider prefix (the adjacent provider card already names it).
  const options = useMemo(() => {
    const scoped = provider ? (providers ?? []).filter((p) => p.provider === provider) : (providers ?? []);
    return scoped.flatMap((p) => (p.models ?? []).map((m) => ({ provider: p.provider, model: m.id, label: provider ? m.label : `${p.provider} · ${m.label}` })));
  }, [providers, provider]);

  if (options.length === 0) return null; // nothing to switch to → composer uses the run default

  const selected = value ? `${value.provider}:${value.model}` : '';
  return (
    <label className="model-switcher">
      {/* Visually hidden — the segment's provider card already names the model;
          this label is for screen readers only. (`u-sr-only` was a no-op class,
          so the eyebrow used to render visibly and collide with the change btn.) */}
      <span className="sr-only">{t('modelSwitcherLabel')}</span>
      <select
        className="model-switcher-select"
        value={selected}
        aria-label={t('modelSwitcherLabel')}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) { onChange(null); return; }
          const [provider, ...rest] = v.split(':');
          onChange({ provider: provider ?? '', model: rest.join(':') });
        }}
      >
        <option value="">{t('modelSwitcherDefault')}</option>
        {options.map((o) => <option key={`${o.provider}:${o.model}`} value={`${o.provider}:${o.model}`}>{o.label}</option>)}
      </select>
    </label>
  );
}
