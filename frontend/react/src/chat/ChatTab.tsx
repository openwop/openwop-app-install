/**
 * Top-level AI tab — gates the chat surface on BYOK being configured.
 *
 * State machine:
 *   - useBYOKConfig is loading → spinner
 *   - no active config OR config's credentialRef missing on BE → wizard
 *   - settings drawer open → wizard (with cancel)
 *   - otherwise → ChatSidebar
 *
 * The user can always swap providers / models / keys from the chat
 * header without losing their session (the chat session is keyed by id,
 * not by provider).
 */

import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { BYOKWizard } from '../byok/BYOKWizard.js';
import { useBYOKConfig } from '../byok/lib/useBYOKConfig.js';
import { useFeatureAccess } from '../featureToggles/FeatureAccessContext.js';
import { useAuth } from '../auth/useAuth.js';
import { ChatSidebar } from './ChatSidebar.js';

// ADR 0140 — lazy: the multi-tab deck is behind a default-OFF toggle, so it must NOT
// ride in the entry chunk (it would blow the bundle budget). Loaded only when on.
const TabChatDeck = lazy(() => import('./tabDeck/TabChatDeck.js').then((m) => ({ default: m.TabChatDeck })));
import { BackendStatusCard } from './BackendStatusCard.js';
import { registerDefaultCards } from './registry/defaultCards.js';
import { registerA2uiSurfaceCard } from './a2ui/A2uiSurfaceCard.js';
import { registerDefaultArtifactRenderers } from './artifacts/defaultRenderers.js';

// Ensure the 4 built-in interrupt cards + the A2UI surface renderer (ADR 0051)
// + the built-in artifact renderers (ADR 0153 Phase 0) are registered at first render.
registerDefaultCards();
registerA2uiSurfaceCard();
registerDefaultArtifactRenderers();

export function ChatTab(): JSX.Element {
  const { config, isValid, isLoading, error, setConfig, refresh } = useBYOKConfig();
  const [forceWizard, setForceWizard] = useState(false);
  // ADR 0140 — when the multi-tab toggle is on, the chat body is the keep-alive deck
  // instead of the single-session sidebar. Default OFF → exactly today's surface.
  const multiTab = useFeatureAccess('multi-tab-chat');
  // ADR 0140 (security) — the deck persists its working set under a PER-USER localStorage
  // key. On a shared browser an IN-PAGE identity switch (logout→login, no reload) would
  // otherwise keep the old user's deck state mounted and let a debounced/flush save write
  // their tab ids under the new user's key. Keying the deck on the uid forces a clean
  // remount (fresh reducer init from the new user's key) per identity, so no state crosses.
  const { user } = useAuth();
  // Stable so it doesn't re-render every keep-alive TabSession on a ChatTab tick
  // (e.g. the visibilitychange refresh) — preserves React.memo on the deck's tabs.
  const reconfigureBYOK = useCallback(() => setForceWizard(true), []);

  // Auto-refresh storedRefs when the tab becomes visible (e.g., after
  // the user resolves an issue in another tab). BACKGROUND refresh — it must
  // not toggle `isLoading`, or the surface gate below would unmount the live
  // chat and flash the loading card on every tab return (the full repaint).
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') void refresh({ background: true }); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  // Unified adaptive card for the loading-OR-error state. Replaces
  // the prior two-card flow (Spinning up → The demo is resting) that
  // flashed two distinct messages at the user. BackendStatusCard
  // reads localStorage `lastSuccessAt` to predict warm/cold, then
  // adapts its copy over elapsed time + on error — same chrome
  // throughout so the transition is invisible. See
  // chat/BackendStatusCard.tsx for the phase machine.
  if (isLoading || error) {
    return (
      <BackendStatusCard
        error={error}
        backendUrl={import.meta.env.VITE_OPENWOP_BASE_URL}
      />
    );
  }

  const needsWizard = !config || !isValid || forceWizard;

  if (needsWizard) {
    // .app-main--ai is now `overflow: hidden` so the chat surface
    // doesn't double-scroll past the sticky header. The wizard takes
    // its place here, so wrap it in its own scroll container so its
    // content stays reachable on short viewports.
    return (
      <div className="u-flex-1 u-minh-0 u-overflow-y-auto">
        <BYOKWizard
          onComplete={async (cfg) => {
            await setConfig(cfg);
            setForceWizard(false);
          }}
          onCancel={forceWizard ? () => setForceWizard(false) : undefined}
        />
      </div>
    );
  }

  if (multiTab.enabled) {
    // P3: the deck replaces the sidebar body wholesale (its own minimal shell). The
    // sidebar LIBRARY integration is P7; BYOK reconfigure is threaded through so a
    // credential error in any tab can still re-open the wizard.
    return (
      <Suspense fallback={<div className="u-flex-1 u-minh-0" />}>
        <TabChatDeck key={user?.uid ?? 'anon'} config={config!} onReconfigureBYOK={reconfigureBYOK} />
      </Suspense>
    );
  }

  return (
    <ChatSidebar
      config={config!}
      onOpenSettings={() => setForceWizard(true)}
      onRemoveKey={async () => {
        await setConfig(null);
        setForceWizard(false);
      }}
    />
  );
}
