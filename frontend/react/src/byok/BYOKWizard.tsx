/**
 * 3-step BYOK wizard: provider → model → key.
 *
 * State-machine layout (per MyndHyve BYOKPanel.tsx pattern):
 *   - Initial:    provider grid
 *   - After:      model grid (within provider)
 *   - Then:       API key input (masked + eye toggle + trust alert)
 *   - On success: parent re-renders to the chat / configured view
 *
 * The credentialRef is DETERMINISTIC — `byok:{provider}` (ADR 0517 fix B), or the
 * provider's existing ref when the workspace already has one. It used to carry a
 * `${Date.now()}` suffix, which meant every pass through this wizard minted a new
 * secret row rather than replacing the old one; combined with a browser-local
 * pointer that could go missing, one workspace ended up with seven Google keys.
 * When a stored key exists for the picked provider the key step OFFERS it instead
 * of asking (fix A).
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PROVIDERS, COPILOT_CREDENTIAL_REF, COPILOT_DEFAULT_MODEL, type ProviderConfig, type ProviderModel } from './lib/providers.js';
import { useAuth } from '../auth/useAuth.js';
import { preferredRefForProvider, type BYOKActiveConfig } from './lib/useBYOKConfig.js';
import { BYOKStepper } from './BYOKStepper.js';
import { TryItFreeCard, ProviderGrid } from './ProviderGrid.js';
import { ModelGrid } from './ModelGrid.js';
import { KeyEntry } from './KeyEntry.js';

interface Props {
  onComplete: (cfg: BYOKActiveConfig) => void | Promise<void>;
  /** Optional cancel — present when the wizard is opened from a settings drawer. */
  onCancel?: (() => void) | undefined;
  /**
   * The workspace's already-stored credentialRefs (ADR 0517 fix A). Supplied by
   * the caller, which has already fetched them, so the wizard adds no round trip.
   * When the picked provider has one, the key step offers it instead of asking
   * for a key the user has given us before.
   */
  storedRefs?: readonly string[];
}

const MANAGED_PENDING_KEY = 'openwop-app.byok.pendingManaged';

/** Sentinel credentialRef for managed providers. The BE recognizes this
 *  prefix and routes through `managedProvider.ts` instead of looking up
 *  a tenant-scoped BYOK row. The value is purely a routing marker —
 *  the real key lives encrypted in `byok_tenant_secrets` under a
 *  synthetic admin tenant. */
function managedCredentialRef(providerId: string): string {
  return `managed:${providerId}`;
}

export function BYOKWizard({ onComplete, onCancel, storedRefs = [] }: Props): JSX.Element {
  const { t } = useTranslation('byok');
  const { user, signIn } = useAuth();
  const [step, setStep] = useState<'provider' | 'model' | 'key'>('provider');
  const [provider, setProvider] = useState<ProviderConfig | null>(null);
  const [model, setModel] = useState<ProviderModel | null>(null);

  // On each step transition, move focus to the new step's heading so a keyboard /
  // screen-reader user lands on the new panel instead of being stranded on the
  // (now-removed) control they just activated (UX ADM-4). Skip the initial mount.
  const wizardRef = useRef<HTMLDivElement>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) { firstStep.current = false; return; }
    const heading = wizardRef.current?.querySelector<HTMLElement>('h2, h3');
    if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus(); }
  }, [step]);

  // After the sign-in redirect returns, auto-activate the managed
  // provider the user clicked pre-sign-in. Without this, the user
  // would land back on the wizard and have to click the tile again.
  useEffect(() => {
    if (!user) return;
    const pendingId = localStorage.getItem(MANAGED_PENDING_KEY);
    if (!pendingId) return;
    localStorage.removeItem(MANAGED_PENDING_KEY);
    const p = PROVIDERS.find((x) => x.id === pendingId && x.managed);
    if (!p) return;
    const m = p.models[0];
    if (!m) return;
    void onComplete({ provider: p.id, model: m.id, credentialRef: managedCredentialRef(p.id) });
  }, [user, onComplete]);

  async function activateManaged(p: ProviderConfig): Promise<void> {
    if (!user) {
      // Stash the picked provider so we can resume after the redirect.
      localStorage.setItem(MANAGED_PENDING_KEY, p.id);
      await signIn.google();
      return;
    }
    const m = p.models[0];
    if (!m) return;
    await onComplete({ provider: p.id, model: m.id, credentialRef: managedCredentialRef(p.id) });
  }

  return (
    <div className="card byok-wizard" ref={wizardRef}>
      {/* "Try it free" is the no-key on-ramp — render it ABOVE the
       * BYOK stepper since the stepper's three steps (Provider / Model
       * / API key) don't apply to the managed path. Only visible on
       * the first step; once the user commits to BYOK we hide it to
       * keep the flow focused. */}
      {step === 'provider' && (
        <>
          <TryItFreeCard
            isAuthed={user !== null}
            onPick={(p) => { void activateManaged(p); }}
          />
          <div className="byok-or-divider" role="separator" aria-label={t('orDivider')}>{t('orDividerText')}</div>
        </>
      )}

      <BYOKStepper current={step} />

      {step === 'provider' && (
        <ProviderGrid
          isAuthed={user !== null}
          storedRefs={storedRefs}
          onPick={(p) => {
            if (p.managed) {
              void activateManaged(p);
              return;
            }
            // ADR 0757 follow-up — a connected subscription provider (GitHub
            // Copilot) needs no model or key step: its credential is the user's
            // OAuth connection, and `default` lets Copilot pick the plan's model.
            if (p.subscription) {
              void onComplete({ provider: p.id, model: COPILOT_DEFAULT_MODEL, credentialRef: COPILOT_CREDENTIAL_REF });
              return;
            }
            setProvider(p);
            const rec = p.models.find((m) => m.recommended) ?? p.models[0]!;
            setModel(rec);
            setStep('model');
          }}
          onCancel={onCancel}
        />
      )}

      {step === 'model' && provider && (
        <ModelGrid
          provider={provider}
          selectedModelId={model?.id}
          onPick={(m) => {
            setModel(m);
            setStep('key');
          }}
          onBack={() => setStep('provider')}
        />
      )}

      {step === 'key' && provider && model && (
        <KeyEntry
          provider={provider}
          model={model}
          // Store INTO the provider's existing ref when it has one, so a
          // deliberate replacement overwrites rather than orphaning (ADR 0517 fix B).
          targetRef={preferredRefForProvider(storedRefs, provider.id) ?? `byok:${provider.id}`}
          existingRef={preferredRefForProvider(storedRefs, provider.id)}
          onBack={() => setStep('model')}
          onStored={async (credentialRef) => {
            await onComplete({ provider: provider.id, model: model.id, credentialRef });
          }}
        />
      )}
    </div>
  );
}
