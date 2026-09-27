/**
 * Top-level AI tab — gates the chat surface on BYOK being configured.
 *
 * State machine (ADR 0517 — the branches used to collapse into one `!isValid`
 * boolean, which is how a LOGGED-OUT user was shown an "add your API key" wizard
 * and re-entered a key the server still had):
 *   - loading         → BackendStatusCard
 *   - error           → BackendStatusCard (never the wizard: an outage is not
 *                       evidence that a key is missing)
 *   - session-expired → SessionExpiredCard (sign back in; the key is intact)
 *   - needs-key       → wizard, seeded with any stored refs so it can OFFER an
 *                       existing key rather than mint a duplicate
 *   - settings drawer open → wizard (with cancel)
 *   - otherwise       → ChatSidebar
 *
 * The user can always swap providers / models / keys from the chat
 * header without losing their session (the chat session is keyed by id,
 * not by provider).
 */

import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../ui/Notice.js';
import { BYOKWizard } from '../byok/BYOKWizard.js';
import { useBYOKConfig } from '../byok/lib/useBYOKConfig.js';
import { useFeatureAccess } from '../featureToggles/FeatureAccessContext.js';
import { useAuth } from '../auth/useAuth.js';
import { ChatSidebar } from './ChatSidebar.js';

// ADR 0140 — lazy: the multi-tab deck is behind a default-OFF toggle, so it must NOT
// ride in the entry chunk (it would blow the bundle budget). Loaded only when on.
const TabChatDeck = lazy(() => import('./tabDeck/TabChatDeck.js').then((m) => ({ default: m.TabChatDeck })));
import { BackendStatusCard } from './BackendStatusCard.js';
import { SessionExpiredCard } from './SessionExpiredCard.js';
import { registerDefaultCards } from './registry/defaultCards.js';
import { registerA2uiSurfaceCard } from './a2ui/A2uiSurfaceCard.js';
import { registerDefaultArtifactRenderers } from './artifacts/defaultRenderers.js';

// Ensure the 4 built-in interrupt cards + the A2UI surface renderer (ADR 0051)
// + the built-in artifact renderers (ADR 0153 Phase 0) are registered at first render.
registerDefaultCards();
registerA2uiSurfaceCard();
registerDefaultArtifactRenderers();
// ADR 0378 P4 — the chat walkthrough action pack, lazy (never in the entry
// chunk; the campaign-brief idiom).
void import('./walkthroughActions.js').then((m) => m.registerChatWalkthroughActions());

export function ChatTab(): JSX.Element {
  const { t } = useTranslation('chat');
  // ADR 0711 — the operator-only refusal, held so the wizard can SAY which failure it was.
  const [byokError, setByokError] = useState<string | null>(null);
  const { config, status, storedRefs, error, setConfig, refresh, stored: byokStored } = useBYOKConfig();
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
  if (status === 'loading' || status === 'error') {
    return (
      <BackendStatusCard
        error={error}
        backendUrl={import.meta.env.VITE_OPENWOP_BASE_URL}
      />
    );
  }

  // The session lapsed to anonymous. The workspace's key still exists; it is
  // simply invisible to this tenant. Asking for it again would store a duplicate
  // under a throwaway session — the reported bug. Offer sign-in instead, unless
  // the user explicitly asked for the wizard.
  if (status === 'session-expired' && !forceWizard) {
    return (
      <div className="u-flex-1 u-minh-0 u-overflow-y-auto">
        <SessionExpiredCard onUseWizard={() => setForceWizard(true)} />
      </div>
    );
  }

  const needsWizard = status !== 'ready' || forceWizard;

  if (needsWizard) {
    // .app-main--ai is now `overflow: hidden` so the chat surface
    // doesn't double-scroll past the sticky header. The wizard takes
    // its place here, so wrap it in its own scroll container so its
    // content stays reachable on short viewports.
    return (
      <div className="u-flex-1 u-minh-0 u-overflow-y-auto">
        {byokError ? (
          <div className="u-mb-2">
            {/* NO `role` here. `Notice` DROPS its own role when `announce` is set and
                delegates to GlobalLiveRegion (ui/Notice.tsx) — "Delegating AND carrying a
                role would be two regions for one message". Wrapping it in `role="alert"`
                re-created that DS-8 double-announce: an assertive live-region write PLUS an
                alert node inserted with its text already in it. Every other
                `<Notice announce>` in this repo is unwrapped; this was the only exception. */}
            <Notice variant="error" announce={byokError}>{byokError}</Notice>
          </div>
        ) : null}
        <BYOKWizard
          // Seeded so the key step can offer a key this workspace already has
          // instead of minting a duplicate (ADR 0517 fix A).
          storedRefs={storedRefs}
          onComplete={async (cfg) => {
            // Clear FIRST. Re-setting the same string is a no-op for React, so a second
            // refusal re-rendered nothing and `Notice`'s announce effect never re-fired —
            // one announcement for N attempts. Clearing makes each attempt a real transition.
            setByokError(null);
            try {
              await setConfig(cfg);
            } catch (e) {
              // ADR 0711 — C made BYOK writes operator-only. Before this branch a plain
              // member's "Try it free" threw a raw error into the wizard: the 403 it
              // replaced a 400 with was strictly less legible than what it replaced.
              // Option B removes the NEED to click for most members; this is for the
              // ones who still reach the wizard from `/` or the embedded panel.
              if (e && typeof e === 'object' && (e as { forbidden?: boolean }).forbidden === true) {
                setByokError(t('chat:byokForbidden'));
                return;
              }
              throw e;
            }
            setForceWizard(false);
          }}
          onCancel={forceWizard ? () => { setByokError(null); setForceWizard(false); } : undefined}
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
        <TabChatDeck key={user?.uid ?? 'anon'} config={config!} byokStored={byokStored} onReconfigureBYOK={reconfigureBYOK} />
      </Suspense>
    );
  }

  return (
    <ChatSidebar
      byokStored={byokStored}
      config={config!}
      tenantId={user?.uid ?? 'anon'}
      onOpenSettings={() => setForceWizard(true)}
      onRemoveKey={async () => {
        await setConfig(null);
        setForceWizard(false);
      }}
    />
  );
}
