import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig, ProviderModel } from './lib/providers.js';
import { TextField } from '../ui/Field.js';
import { formatNumber } from '../i18n/format.js';

// ── Step 2: model grid ─────────────────────────────────────────────────

export function ModelGrid({
  provider,
  selectedModelId,
  onPick,
  onBack,
}: {
  provider: ProviderConfig;
  selectedModelId: string | undefined;
  onPick: (m: ProviderModel) => void;
  onBack: () => void;
}): JSX.Element {
  const { t } = useTranslation('byok');
  const [customMode, setCustomMode] = useState(false);
  const [customId, setCustomId] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);

  function submitCustom(): void {
    const id = customId.trim();
    if (!id) {
      setCustomError(t('modelIdRequired'));
      return;
    }
    // Construct a synthetic ProviderModel. Capabilities + context
    // window + cost are unknown for custom models — we use neutral
    // placeholders and the chat surface tolerates missing usage data.
    onPick({
      id,
      label: id,
      contextWindow: 0,
      capabilities: ['text'],
    });
  }

  return (
    <div>
      <h2 className="u-m-0 u-fs-14">{t('pickAModel')}</h2>
      <p className="muted u-mt-1 u-fs-12">{t('fromProvider')} <strong>{provider.label}</strong></p>
      <div className="u-flex u-flex-col u-gap-2 u-mt-3">
        {provider.models.map((m) => (
          <button
            key={m.id}
            type="button"
            className="secondary modelgrid-model-btn"
            onClick={() => onPick(m)}
            style={{
              borderColor: m.id === selectedModelId ? 'var(--color-accent)' : 'var(--color-border)',
            }}
          >
            <div className="u-flex u-w-full u-items-center u-gap-2">
              <span className="u-fw-600 u-fs-13">{m.label}</span>
              {m.recommended && <span className="status-badge u-text-success">{t('recommended')}</span>}
              <span className="muted u-ml-auto u-fs-11">{t('contextWindowSuffix', { n: formatNumber(m.contextWindow / 1000, { maximumFractionDigits: 0 }) })}</span>
            </div>
            <div className="u-flex u-gap-1-5 u-mt-1-5 u-wrap">
              {m.capabilities.map((c) => (
                <span key={c} className="status-badge u-fs-10">{c}</span>
              ))}
              {m.cost && (
                <span className="status-badge muted u-fs-10">
                  {t('costPerMillion', { input: formatNumber(m.cost.input * 1000), output: formatNumber(m.cost.output * 1000) })}
                </span>
              )}
            </div>
          </button>
        ))}

        {/* "Other" — escape hatch for models not in the curated list
            (preview releases, fine-tunes, snapshots, future versions
            we haven't bumped the taxonomy for). */}
        {!customMode ? (
          <button
            type="button"
            className="secondary modelgrid-model-btn modelgrid-other-btn"
            onClick={() => setCustomMode(true)}
          >
            <div className="u-flex u-w-full u-items-center u-gap-2">
              <span className="u-fw-600 u-fs-13">{t('otherModel')}</span>
              <span className="muted u-ml-auto u-fs-11">{t('enterModelIdManually')}</span>
            </div>
            <div className="muted u-fs-11 u-mt-1-5">
              {t('otherModelDesc')}
            </div>
          </button>
        ) : (
          <div className="card modelgrid-custom-card">
            <div className="u-fw-600 u-fs-13 u-mb-2">{t('customModel')}</div>
            <TextField
              label={t('customModelIdLabel')}
              value={customId}
              onChange={(e) => { setCustomId(e.target.value); setCustomError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitCustom(); } }}
              placeholder={provider.customModelPlaceholder ?? t('customModelPlaceholderDefault')}
              autoFocus
              spellCheck={false}
              help={provider.customModelHelp ?? t('customModelHelpDefault', { provider: provider.label })}
            />
            {customError && <div className="alert error u-fs-12">{customError}</div>}
            <div className="button-row">
              <button type="button" onClick={submitCustom} disabled={!customId.trim()}>{t('useThisModel')}</button>
              <button type="button" className="secondary" onClick={() => { setCustomMode(false); setCustomId(''); setCustomError(null); }}>
                {t('cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="button-row">
        <button type="button" className="secondary" onClick={onBack}>{t('back')}</button>
      </div>
    </div>
  );
}
