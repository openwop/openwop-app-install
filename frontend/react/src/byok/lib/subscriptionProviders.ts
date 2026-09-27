/**
 * Providers the host advertises the RFC 0121 `subscription` auth mode for, read
 * from the discovery document. Shared by the keys page (SubscriptionCredentialCard)
 * and the chat provider picker (ADR 0757 follow-up), so "advertised" means the
 * same thing in both places.
 */
import { useEffect, useState } from 'react';
import { getCapabilities } from '../../client/runsClient.js';

export function subscriptionProvidersFrom(caps: unknown): string[] {
  // ADR 0730 C.3 — the v2 `aiProviders` family types `authModes` as a flat mode
  // VOCABULARY, so the per-provider map moved to this host's own extension
  // record rather than being smuggled into a core facet. v1's map is read first
  // and dies with v1.
  const ext = (caps as { extensions?: { 'openwop-app.ai-providers'?: { subscriptionProviders?: string[] } } })?.extensions?.['openwop-app.ai-providers'];
  if (Array.isArray(ext?.subscriptionProviders)) return ext.subscriptionProviders;
  const authModes = (caps as { aiProviders?: { authModes?: Record<string, string[]> } })?.aiProviders?.authModes;
  if (!authModes) return [];
  return Object.entries(authModes)
    .filter(([, modes]) => Array.isArray(modes) && modes.includes('subscription'))
    .map(([provider]) => provider);
}

/** Is `provider` advertised with the `subscription` auth mode? `false` while
 *  loading and on any discovery failure — a tile that might not work stays hidden. */
export function useSubscriptionAdvertised(provider: string): boolean {
  const [advertised, setAdvertised] = useState(false);
  useEffect(() => {
    let live = true;
    void getCapabilities()
      .then((caps) => { if (live) setAdvertised(subscriptionProvidersFrom(caps).includes(provider)); })
      .catch(() => { if (live) setAdvertised(false); });
    return () => { live = false; };
  }, [provider]);
  return advertised;
}
