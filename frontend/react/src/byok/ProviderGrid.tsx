import { Button } from '../ui/Button.js';
import { useTranslation } from 'react-i18next';
import { PROVIDERS, SUBSCRIPTION_PROVIDERS, COPILOT_PROVIDER_ID, COPILOT_CREDENTIAL_REF, type ProviderConfig } from './lib/providers.js';
import { useSubscriptionAdvertised } from './lib/subscriptionProviders.js';
import { useDemoMode } from '../client/useDemoMode.js';
import { useFeatureAccess } from '../featureToggles/FeatureAccessContext.js';

// ── Step 1: provider grid ──────────────────────────────────────────────

/**
 * The no-key on-ramp. Rendered above the BYOK stepper so newcomers see
 * the easiest path first. Visually styled as a prominent recommended
 * panel — clay-soft tint, "recommended" pill, right-arrow affordance —
 * to distinguish it from the BYOK provider tiles below.
 *
 * DEMO-ONLY (ADR 0196 Gate A / DEMO-5): "Try it free / no API key needed"
 * is showcase framing — a clean / white-label install goes straight to the
 * BYOK stepper. The managed provider itself still works there; a neutral
 * enterprise "managed provider" affordance is a separate product decision.
 */
export function TryItFreeCard({
  onPick,
  isAuthed,
}: {
  onPick: (p: ProviderConfig) => void;
  isAuthed: boolean;
}): JSX.Element | null {
  const { t } = useTranslation('byok');
  const demo = useDemoMode();
  const managed = PROVIDERS.filter((p) => p.managed);
  if (!demo || managed.length === 0) return null;
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
  storedRefs = [],
}: {
  onPick: (p: ProviderConfig) => void;
  onCancel?: (() => void) | undefined;
  isAuthed: boolean;
  /** The caller's stored credentialRefs — a connected GitHub Copilot account shows
   *  up here as `subscription:github.copilot` (ADR 0757 follow-up). */
  storedRefs?: readonly string[];
}): JSX.Element {
  const { t } = useTranslation('byok');
  const devTools = useFeatureAccess('developer-tools');
  // ADR 0757 follow-up — the GitHub Copilot tile shows ONLY when the host serves
  // Copilot (discovery advertises `github.copilot` with the subscription mode) AND
  // this user has connected it; otherwise picking it could only fail.
  const copilotAdvertised = useSubscriptionAdvertised(COPILOT_PROVIDER_ID);
  const copilot = copilotAdvertised && storedRefs.includes(COPILOT_CREDENTIAL_REF)
    ? SUBSCRIPTION_PROVIDERS.find((p) => p.id === COPILOT_PROVIDER_ID)
    : undefined;
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
      {/* The TRUST sentence is for the person typing their key in, so it always
          shows. The rest was operator documentation — "set this env var on the
          server", "see this source file for the adapter pattern" — rendered
          UNCONDITIONALLY, so every white-label adopter's end users read our env
          var name and a source path out of THIS repo (`src/byok/secretResolver.ts`)
          on the screen where they paste a credential. They cannot act on either,
          and an adopter should not be shipping our file layout to their customers.
          It rides `developer-tools` now — ADR 0196 Gate B is exactly "engineering
          surfaces", and this is one. */}
      <p className="byok-section-fineprint">{t('byokFineprintTrust')}</p>
      {devTools.enabled && (
        <p className="byok-section-fineprint byok-section-fineprint--operator">
          {/* The seam matters: the sentence above is addressed to the person
              pasting a credential, this one to whoever runs the host. Rendered
              identically they read as one paragraph, so a user is invited to act
              on instructions that are not theirs and that they cannot follow. */}
          <span className="byok-section-fineprint__eyebrow">{t('byokFineprintOperatorEyebrow')}</span>
          {t('byokFineprintBefore')}{' '}
          <code className="providergrid-inline-code">OPENWOP_BYOK_EPHEMERAL=true</code>{' '}
          {t('byokFineprintMid')}{' '}
          <code className="providergrid-inline-code">src/byok/secretResolver.ts</code>{' '}
          {t('byokFineprintAfter')}
        </p>
      )}
      <div
        className="byok-grid providergrid-grid"
        style={{
          gridTemplateColumns: `repeat(${Math.min(byok.length, 3)}, minmax(0, 1fr))`,
        }}
      >
        {byok.map((p) => (
          <div key={p.id} className="byok-tile">
            <Button
              variant="secondary" className="byok-tile-btn"
              onClick={() => onPick(p)}
            >
              <ProviderBadge provider={p} />
              <div>
                <div className="byok-tile-label">{p.label}</div>
                <div className="byok-tile-desc muted">{p.description}</div>
              </div>
            </Button>
            {p.apiKeyConsoleUrl && (
              <a
                className="byok-tile-link"
                href={p.apiKeyConsoleUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('getProviderKey', { provider: p.label })}
              </a>
            )}
          </div>
        ))}
      </div>

      {copilot && (
        <div className="u-mt-4">
          <h3 className="byok-section-title">{t('copilot.pickerTitle')}</h3>
          <div className="byok-grid providergrid-grid">
            <div className="byok-tile">
              <Button variant="secondary" className="byok-tile-btn" onClick={() => onPick(copilot)}>
                <ProviderBadge provider={copilot} />
                <div>
                  <div className="byok-tile-label">{copilot.label}</div>
                  <div className="byok-tile-desc muted">{t('copilot.pickerDesc')}</div>
                </div>
              </Button>
            </div>
          </div>
        </div>
      )}

      {onCancel && (
        <div className="button-row">
          <Button variant="secondary" onClick={onCancel}>{t('common:cancel')}</Button>
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
