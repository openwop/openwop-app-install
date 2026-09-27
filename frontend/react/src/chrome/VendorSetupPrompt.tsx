/**
 * First-run vendor setup (day-1 UX P8 / ADR 0188) — one question after
 * sign-in: "What does your org run on?" → the picked vendor's connectors
 * as one-click OAuth consents, seeded from the SSO identity.
 *
 * Self-gating chrome surface (the AutoSeedExampleData precedent — mounted
 * once in App, renders null unless every condition holds):
 *   1. a signed-in user (anonymous sessions never see it),
 *   2. not previously dismissed for this user (localStorage, per-browser —
 *      ADR 0188 records the durable-preference upgrade path),
 *   3. the host can actually connect something: ≥1 OAuth-configured provider
 *      in a recognized vendor group (never a wall of dead Connect buttons).
 *
 * Composition: ui/Modal + the connections client's beginOAuth (the SAME PKCE
 * flow the Access hub uses — no second connect path). Vendor grouping rides
 * the ADR 0185 `vendor` field.
 */
import { Button } from '../ui/Button.js';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/useAuth.js';
import { Modal } from '../ui/Modal.js';
import { Notice } from '../ui/Notice.js';
import type { Provider } from '../features/connections/connectionsClient.js';
// Lazy (entry-chunk structural split): the connections client is only needed once this prompt decides to render.
const connections = () => import('../features/connections/connectionsClient.js');
import { isFirstRunDismissed, dismissFirstRun } from '../onboarding/firstRunFlag.js';

/** The vendor groups the wizard offers, keyed by the ADR 0185 vendor label. */
const VENDOR_KEYS = ['Google', 'Microsoft 365'] as const;
type VendorKey = (typeof VENDOR_KEYS)[number];

export interface VendorGroups {
  /** Vendor → its OAuth-configured providers (only configured ones count). */
  groups: ReadonlyMap<VendorKey, Provider[]>;
  eligible: boolean;
}

/** Pure eligibility/grouping over the provider catalog — unit-tested. */
export function pickVendorGroups(providers: Provider[]): VendorGroups {
  const groups = new Map<VendorKey, Provider[]>();
  for (const key of VENDOR_KEYS) groups.set(key, []);
  for (const p of providers) {
    if (p.kind !== 'oauth2' || !p.oauthConfigured) continue;
    const vendor = p.vendor as VendorKey | undefined;
    if (vendor && groups.has(vendor)) groups.get(vendor)?.push(p);
  }
  const eligible = [...groups.values()].some((list) => list.length > 0);
  return { groups, eligible };
}

/** Seed the vendor pick from how the user signed in. */
export function seedVendor(providerIds: readonly string[]): VendorKey | null {
  if (providerIds.includes('microsoft.com')) return 'Microsoft 365';
  if (providerIds.includes('google.com')) return 'Google';
  return null;
}

export function VendorSetupPrompt(): JSX.Element | null {
  const { t } = useTranslation('chrome');
  const { user, loading } = useAuth();
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [dismissed, setDismissed] = useState(true); // assume dismissed until checked
  const [vendor, setVendor] = useState<VendorKey | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const uid = user?.uid;

  useEffect(() => {
    // No uid → treated as dismissed (never nag); storage errors fail closed
    // inside the shared helper (ADR 0188 pattern, one key scheme).
    setDismissed(isFirstRunDismissed('vendorSetup', uid));
  }, [uid]);

  useEffect(() => {
    if (loading || !user || dismissed || providers !== null) return;
    let cancelled = false;
    void connections().then((m) => m.listProviders())
      .then((rows) => { if (!cancelled) setProviders(rows); })
      .catch(() => { if (!cancelled) setProviders([]); }); // unreachable — stay hidden
    return () => { cancelled = true; };
  }, [loading, user, dismissed, providers]);

  const { groups, eligible } = useMemo(() => pickVendorGroups(providers ?? []), [providers]);

  useEffect(() => {
    if (user && vendor === null) setVendor(seedVendor(user.providerIds));
  }, [user, vendor]);

  if (loading || !user || dismissed || providers === null || !eligible) return null;

  function dismiss(): void {
    dismissFirstRun('vendorSetup', uid);
    setDismissed(true);
  }

  async function connect(providerId: string): Promise<void> {
    setConnecting(providerId);
    setError(null);
    try {
      // Come back to the Access hub's Connections tab, where the new row lands.
      const url = await (await connections()).beginOAuth(providerId, '/access?tab=connections');
      dismiss(); // one consent is the win — don't re-prompt after the redirect
      window.location.href = url;
    } catch {
      setError(t('vendorSetupError'));
      setConnecting(null);
    }
  }

  const picked = vendor ? groups.get(vendor) ?? [] : [];

  return (
    <Modal onClose={dismiss} label={t('vendorSetupTitle')} showClose>
      <div className="u-grid u-gap-4">
        <div className="u-grid u-gap-1">
          <strong className="u-fs-16">{t('vendorSetupTitle')}</strong>
          <p className="muted u-fs-13">{t('vendorSetupBody')}</p>
        </div>

        {error ? <Notice variant="error">{error}</Notice> : null}

        <div className="action-bar" role="group" aria-label={t('vendorSetupTitle')}>
          {VENDOR_KEYS.map((key) => (
            <Button
              key={key}
              variant={vendor === key ? 'primary' : 'secondary'}
              aria-pressed={vendor === key}
              disabled={(groups.get(key) ?? []).length === 0}
              onClick={() => setVendor(key)}
            >
              {key}
            </Button>
          ))}
        </div>

        {vendor && picked.length > 0 ? (
          <ul className="u-flex u-flex-col u-gap-2 u-m-0 u-p-0 u-list-none">
            {picked.map((p) => (
              <li key={p.id} className="action-bar u-justify-between">
                <span>{p.label}</span>
                <Button
                  variant="secondary"
                  disabled={connecting !== null}
                  aria-busy={connecting === p.id}
                  onClick={() => { void connect(p.id); }}
                >
                  {connecting === p.id ? t('vendorSetupConnecting') : t('vendorSetupConnect', { provider: p.label })}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="action-bar u-justify-end">
          <Button variant="quiet" onClick={dismiss}>
            {t('vendorSetupSkip')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
