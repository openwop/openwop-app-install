import { useState } from 'react';
import type { ProviderConfig, ProviderModel } from './lib/providers.js';
import { TextField } from '../ui/Field.js';

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
  const [customMode, setCustomMode] = useState(false);
  const [customId, setCustomId] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);

  function submitCustom(): void {
    const id = customId.trim();
    if (!id) {
      setCustomError('Model id is required.');
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
      <h2 className="u-m-0 u-fs-14">Pick a model</h2>
      <p className="muted u-mt-1 u-fs-12">From <strong>{provider.label}</strong></p>
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
              {m.recommended && <span className="status-badge u-text-success">recommended</span>}
              <span className="muted u-ml-auto u-fs-11">{(m.contextWindow / 1000).toFixed(0)}K ctx</span>
            </div>
            <div className="u-flex u-gap-1-5 u-mt-1-5 u-wrap">
              {m.capabilities.map((c) => (
                <span key={c} className="status-badge u-fs-10">{c}</span>
              ))}
              {m.cost && (
                <span className="status-badge muted u-fs-10">
                  ${m.cost.input * 1000}/1M in · ${m.cost.output * 1000}/1M out
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
              <span className="u-fw-600 u-fs-13">Other…</span>
              <span className="muted u-ml-auto u-fs-11">enter model id manually</span>
            </div>
            <div className="muted u-fs-11 u-mt-1-5">
              For preview releases, fine-tunes, snapshots, or any model not in the list above.
            </div>
          </button>
        ) : (
          <div className="card modelgrid-custom-card">
            <div className="u-fw-600 u-fs-13 u-mb-2">Custom model</div>
            <TextField
              label="Model id (as the provider expects it)"
              value={customId}
              onChange={(e) => { setCustomId(e.target.value); setCustomError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitCustom(); } }}
              placeholder={provider.customModelPlaceholder ?? 'provider-model-id'}
              autoFocus
              spellCheck={false}
              help={provider.customModelHelp ?? `Whatever model id ${provider.label}'s API accepts.`}
            />
            {customError && <div className="alert error u-fs-12">{customError}</div>}
            <div className="button-row">
              <button type="button" onClick={submitCustom} disabled={!customId.trim()}>Use this model</button>
              <button type="button" className="secondary" onClick={() => { setCustomMode(false); setCustomId(''); setCustomError(null); }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="button-row">
        <button type="button" className="secondary" onClick={onBack}>Back</button>
      </div>
    </div>
  );
}
