import { useEffect, useState } from 'react';
import { decideSignedOutRedirect, signedOutRedirectTarget } from './signedOutPageRedirect.js';

export type SignedOutRedirectState =
  | { kind: 'none' }
  | { kind: 'pending' }
  | { kind: 'redirect'; to: string };

/**
 * Applies `decideSignedOutRedirect` and, for a candidate, confirms the
 * host-site publishes that page before forwarding. A missing page or a failed
 * read resolves to `none`, so the visitor gets the sign-in wall they would have
 * had without this (fail toward today's behaviour, never toward a 404).
 *
 * `pageExists` is injected (App.tsx passes the system-site page read) so this
 * chrome module takes no import edge into `features/site` (ADR 0630 boundary).
 */
export function useSignedOutPageRedirect(o: {
  pathname: string;
  search: string;
  hash: string;
  gateMode: 'none' | 'password' | 'sign-in';
  hasUser: boolean;
  authLoading: boolean;
  pageExists: (slug: string) => Promise<boolean>;
}): SignedOutRedirectState {
  const decision = decideSignedOutRedirect(o);
  const slug = decision.kind === 'check' ? decision.slug : null;
  const [checked, setChecked] = useState<{ slug: string; exists: boolean } | null>(null);

  useEffect(() => {
    if (slug === null) return;
    let live = true;
    void o.pageExists(slug).catch(() => false).then((exists) => {
      if (live) setChecked({ slug, exists });
    });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one check per slug; the reader is stable in intent
  }, [slug]);

  if (decision.kind === 'none') return { kind: 'none' };
  if (decision.kind === 'wait') return { kind: 'pending' };
  if (checked === null || checked.slug !== decision.slug) return { kind: 'pending' };
  return checked.exists
    ? { kind: 'redirect', to: signedOutRedirectTarget(decision.slug, o.search, o.hash) }
    : { kind: 'none' };
}
