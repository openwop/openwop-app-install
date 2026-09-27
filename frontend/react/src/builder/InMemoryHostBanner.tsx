/**
 * Top-of-page dismissible banner disclosing NON-DURABLE anonymous sessions.
 * Stay-quiet defaults:
 *   - Hidden when the host has no in-memory storage surfaces (a real
 *     production host — the disclosure doesn't apply).
 *   - Hidden for signed-in users and once dismissed (localStorage, ~30d).
 *
 * ADR 0196 Gate A / DEMO-9 (correction to the ADR's "replace the regex"
 * plan): the surface probe SURVIVES — any anonymous visitor on a host whose
 * storage is in-memory deserves the non-durability warning, demo or not
 * (e.g. a laptop eval install). What forks on the demo flag is the COPY:
 *   - demo host  → the original anonymous-demo framing (24h reset, /privacy);
 *   - clean host → a neutral "data on this host is not durable" disclosure,
 *     with no demo or "signup coming soon" language.
 * The old regex also matched `brute-force` (a rate-limiter implementation,
 * not storage) — that arm was a bug and is dropped.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getCapabilities } from '../client/runsClient.js';
import { useAuth } from '../auth/useAuth.js';
import { InfoIcon, XIcon } from '../ui/icons/index.js';
import { announce } from '../ui/announce.js';
import { useDemoModeStatus } from '../client/useDemoMode.js';

const DISMISS_KEY = 'openwop:demo-banner:dismissed';

interface HostSurfaceAd {
  name: string;
  supported: boolean;
  implementation?: string;
}

/**
 * The banner shell. Both render branches below emit an identical
 * `role="status"` live region, icon and dismiss button, and differ ONLY in the
 * text. Duplicating that shell meant the a11y attributes existed twice — the
 * exact kind of pair where one gets a fix and the other silently does not.
 */
function BannerShell({ children, onDismiss, dismissLabel, closeLabel }: {
  children: React.ReactNode;
  onDismiss: () => void;
  dismissLabel: string;
  closeLabel: string;
}) {
  return (
    <div className="demo-host-banner" role="status" aria-live="polite">
      <span className="demo-host-banner-icon" aria-hidden><InfoIcon size={16} /></span>
      <span className="demo-host-banner-text">{children}</span>
      <button
        className="demo-host-banner-close"
        type="button"
        onClick={onDismiss}
        aria-label={dismissLabel}
        title={closeLabel}
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}

export function InMemoryHostBanner() {
  const { t } = useTranslation('builder');
  const { user } = useAuth();
  // CAPUX-1 — the STATUS, not the boolean. `useDemoMode()` collapses "clean
  // host" and "we could not ask" into the same `false`, and this is a
  // DISCLOSURE surface: `client/demoMode.ts` already argues the case for
  // `/privacy` ("telling someone about the cookie you gave them is not
  // something to decide from an unread flag") and ships this exact tri-state
  // for it. The banner was the other surface that needed it.
  const demoStatus = useDemoModeStatus();
  const [hidden, setHidden] = useState<boolean>(() => {
    try { return localStorage.getItem(DISMISS_KEY) === 'true'; }
    catch { return false; }
  });
  // Three states, not two. `null` previously meant BOTH "the probe has not
  // resolved yet" and "the probe failed", and the render treated both as
  // "nothing to disclose" — which is how a failed capability read became an
  // invisible non-disclosure on a host that genuinely loses your work.
  const [probe, setProbe] = useState<'unresolved' | 'failed' | number>('unresolved');

  // Probe the host's capability advertisement regardless of sign-in
  // state so the hook count stays stable across renders (Rules of
  // Hooks: every hook call MUST run on every render — moving an early
  // return ABOVE this useEffect would skip it on the signed-in path
  // and trip React error #300 the next time the user signs in).
  useEffect(() => {
    if (hidden) return;
    let aborted = false;
    void (async () => {
      try {
        // Routes through the SDK's `client.discovery.capabilities()` per
        // `sdk/PARITY.md`. The SDK handles auth + cookie credentials
        // uniformly with the rest of the SPA's client layer.
        // ADR 0730 C.2 — read BOTH homes through the overlap. v1 nests this
        // under `capabilities.hostSurfaces`; the v2 root is closed and carries
        // it at `extensions['openwop-app.host-surfaces'].surfaces`. The v1 read
        // is first because it is the shape this host still serves on the
        // header-less default contract; when v1 retires, the first arm goes.
        const caps = (await getCapabilities()) as {
          capabilities?: { hostSurfaces?: HostSurfaceAd[] };
          extensions?: { 'openwop-app.host-surfaces'?: { surfaces?: HostSurfaceAd[] } };
        };
        const surfaces =
          caps?.capabilities?.hostSurfaces
          ?? caps?.extensions?.['openwop-app.host-surfaces']?.surfaces
          ?? [];
        // Storage impls only — `brute-force` (a rate-limiter impl) was a
        // false-positive arm that made real hosts show a demo banner.
        const inmem = surfaces.filter((s) => s.supported && /in-memory|sqlite-in-memory/.test(s.implementation ?? '')).length;
        if (!aborted) setProbe(inmem);
      } catch {
        // A failed read is REPORTED, not swallowed. The old comment here said
        // "keep banner hidden, don't surface noise" — reasonable for a feature
        // affordance, wrong for a disclosure: the noise it suppressed was the
        // only signal that the durability of the visitor's work is unknown.
        if (!aborted) setProbe('failed');
      }
    })();
    return () => { aborted = true; };
  }, [hidden]);

  // Signed-in users get persistent storage — the demo-host disclosure
  // doesn't apply to them. Hide the banner AFTER all hooks have run.
  // ANNOUNCE, because this region mounts ALREADY CONTAINING its text — and a
  // live region mounted with content announces only later MUTATIONS, so a
  // screen-reader user hears nothing. `SyncFailureBanner` hit the same thing and
  // routes through this primitive; that banner gets it via `<Notice announce>`,
  // and this one is a raw div, so it calls `announce` itself.
  //
  // A disclosure nobody hears is not a disclosure, which is the whole point of
  // CAPUX-1 — so this covers the two PRE-EXISTING branches as well, not just the
  // new one. Derived above the early returns so the hook order stays fixed.
  const spoken = (() => {
    if (user || hidden) return null;
    if (probe === 'failed' || demoStatus === 'unknown') {
      return `${t('hostDurabilityUnknownStrong')} ${t('hostDurabilityUnknownBody')}`;
    }
    if (probe === 'unresolved' || probe === 0) return null;
    const isDemo = demoStatus === 'demo';
    return `${t(isDemo ? 'demoSessionStrong' : 'hostNonDurableStrong')} ${t(isDemo ? 'demoSessionBody' : 'hostNonDurableBody')}`;
  })();
  useEffect(() => { if (spoken) announce(spoken); }, [spoken]);

  const dismiss = () => {
    setHidden(true);
    try { localStorage.setItem(DISMISS_KEY, 'true'); } catch { /* private mode */ }
  };

  if (user) return null;
  if (hidden) return null;
  // Still loading — render nothing briefly. This is the ONE state where silence
  // is correct, because it resolves on its own.
  if (probe === 'unresolved' && demoStatus === 'unresolved') return null;

  // Could not determine. Say so rather than implying durability by omission,
  // and say it WITHOUT the demo/non-durable text fork below — picking either
  // variant here would state a fact we do not have. Mirrors the
  // `auditCapsUnknown` line in `runs/RunOpsPanel.tsx`.
  const undetermined = probe === 'failed' || demoStatus === 'unknown';
  if (undetermined) {
    return (
      <BannerShell onDismiss={dismiss} dismissLabel={t('dismissNotice')} closeLabel={t('common:close')}>
        <strong>{t('hostDurabilityUnknownStrong')}</strong>{' '}
        {t('hostDurabilityUnknownBody')}
      </BannerShell>
    );
  }
  // Resolved, and nothing to disclose: this host's storage is durable.
  if (probe === 'unresolved' || probe === 0) return null;
  const demo = demoStatus === 'demo';


  return (
    <BannerShell onDismiss={dismiss} dismissLabel={t('dismissNotice')} closeLabel={t('common:close')}>
      <strong>{t(demo ? 'demoSessionStrong' : 'hostNonDurableStrong')}</strong>{' '}
      {t(demo ? 'demoSessionBody' : 'hostNonDurableBody')}{' '}
      {demo && <Link to="/privacy">{t('demoSessionPrivacyLink')}</Link>}
    </BannerShell>
  );
}
