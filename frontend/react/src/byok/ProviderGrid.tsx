import { useTranslation } from 'react-i18next';
import { PROVIDERS, type ProviderConfig } from './lib/providers.js';

// ── Step 1: provider grid ──────────────────────────────────────────────

/**
 * The no-key on-ramp. Rendered above the BYOK stepper so newcomers see
 * the easiest path first. Visually styled as a prominent recommended
 * panel — clay-soft tint, "recommended" pill, right-arrow affordance —
 * to distinguish it from the BYOK provider tiles below.
 */
export function TryItFreeCard({
  onPick,
  isAuthed,
}: {
  onPick: (p: ProviderConfig) => void;
  isAuthed: boolean;
}): JSX.Element | null {
  const { t } = useTranslation('byok');
  const managed = PROVIDERS.filter((p) => p.managed);
  if (managed.length === 0) return null;
  // The reference app ships a single managed provider. If a future fork
  // adds more, this renders them all in a vertical stack.
  return (
    <div className="byok-try-free u-mb-5">
      {managed.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onPick(p)}
          className="byok-try-free-card"
        >
          <div className="byok-try-free-body">
            <div className="byok-try-free-headline">
              <span className="byok-try-free-title">{t('tryItFreeTitle')}</span>
              <span className="byok-try-free-suffix">{t('tryItFreeSuffix')}</span>
            </div>
            <div className="byok-try-free-desc">
              {t('tryItFreeDesc')}
            </div>
            {!isAuthed && p.signedInHint && (
              <div className="byok-try-free-hint">{t('tryItFreeHint', { hint: p.signedInHint })}</div>
            )}
          </div>
          <span className="byok-try-free-arrow" aria-hidden="true">→</span>
        </button>
      ))}
    </div>
  );
}

export function ProviderGrid({
  onPick,
  onCancel,
}: {
  onPick: (p: ProviderConfig) => void;
  onCancel?: (() => void) | undefined;
  isAuthed: boolean;
}): JSX.Element {
  const { t } = useTranslation('byok');
  // BYOK-only — the managed "Try it free" path renders above the
  // stepper in BYOKWizard via <TryItFreeCard>. `hidden` providers
  // (e.g., MiniMax sitting behind the managed openwop-free entry)
  // are excluded from the user-facing picker.
  const byok = PROVIDERS.filter((p) => !p.managed && !p.hidden);

  return (
    <div className="byok-section">
      <h2 className="byok-section-title">{t('byokTitle')}</h2>
      <p className="byok-section-lede">
        <abbr title={t('byokAbbrTitle')}><strong>BYOK</strong></abbr>{' '}
        {t('byokLedeBefore')}
      </p>
      <p className="byok-section-fineprint">
        {t('byokFineprintBefore')}{' '}
        <code className="providergrid-inline-code">OPENWOP_BYOK_EPHEMERAL=true</code>{' '}
        {t('byokFineprintMid')}{' '}
        <code className="providergrid-inline-code">src/byok/secretResolver.ts</code>{' '}
        {t('byokFineprintAfter')}
      </p>
      <div
        className="byok-grid providergrid-grid"
        style={{
          gridTemplateColumns: `repeat(${Math.min(byok.length, 3)}, minmax(0, 1fr))`,
        }}
      >
        {byok.map((p) => (
          <div key={p.id} className="byok-tile">
            <button
              type="button"
              className="secondary byok-tile-btn"
              onClick={() => onPick(p)}
            >
              <ProviderBadge provider={p} />
              <div>
                <div className="byok-tile-label">{p.label}</div>
                <div className="byok-tile-desc muted">{p.description}</div>
              </div>
            </button>
            {p.apiKeyConsoleUrl && (
              <a
                className="byok-tile-link"
                href={p.apiKeyConsoleUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Get a {p.label} API key →
              </a>
            )}
          </div>
        ))}
      </div>

      {onCancel && (
        <div className="button-row">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function ProviderBadge({ provider }: { provider: ProviderConfig }): JSX.Element {
  return (
    <span className="providergrid-badge">
      {provider.label.charAt(0)}
    </span>
  );
}
