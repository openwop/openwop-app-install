/**
 * useComposerModifiers — the SHARED next-turn composer controls (ADR 0140 parity).
 *
 * Owns the per-exchange modifier state (web search · workflow tools · model switch)
 * plus the JSX that renders them, so EVERY full chat surface (the standalone
 * `ChatSidebar` and each multi-tab `TabSession`) gets identical controls without
 * copy-pasting them. Before this, the modifiers lived inline in `ChatSidebar` and the
 * tabbed deck shipped without them at all.
 *
 * The hook returns:
 *   - `composerModifiers` — the next-to-the-composer chips (web-search toggle, tools
 *     toggle, the per-conversation lazy `<ConversationToolsControl>` (scope + pending approvals)), gated on the active
 *     model's `supportsWebSearch` / `supportsTools` capability.
 *   - `modelSwitcher` — the per-exchange model selector node (ADR 0124). The standalone
 *     surface renders it in `ChatHeader`; a tab folds it into its composer modifier group.
 *   - `getSubmitExtras()` — the per-turn `SendOptions` the surface merges into
 *     `runCoreSubmit` (`baseSendOptions`): `{ webSearch, model, provider, tools }`.
 *
 * HARD CONSTRAINT (ADR 0073): `ConversationView` stays compact — the modifiers are
 * composed AROUND it by the shell via its existing optional `composerModifiers` prop;
 * the embed (EmbeddedConversation) passes none and stays slim.
 */

import { lazy, Suspense, useCallback, useEffect, useState, type MutableRefObject, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { GlobeIcon, WrenchIcon, KeyIcon, AlertIcon } from '../../ui/icons/index.js';
import { buildAvailableTools } from '../lib/availableTools.js';
import type { ModelChoice } from '../ModelSwitcher.js';
import type { SendOptions } from '../types.js';

// ADR 0124 — the in-chat model switcher is a composer-header control NOT needed for
// first paint; lazy-split it out of the eager chat entry chunk (reclaims entry
// budget). The `null` fallback matches the switcher's own empty state (it renders
// nothing when no models are advertised), so the brief load gap is invisible.
const ModelSwitcher = lazy(() => import('../ModelSwitcher.js').then((m) => ({ default: m.ModelSwitcher })));
// ADR 0132 / ADR 0834 D6 — the conversation tool control (scope + pending approvals);
// lazy for the same entry-budget reason. Its gear appears once the chunk lands.
const ConversationToolsControl = lazy(() => import('../../conversationTools/ConversationToolsControl.js'));

export interface UseComposerModifiersOptions {
  /** The conversation this composer is bound to — scopes the conversation tool control. */
  sessionId: string;
  /** The active model advertises provider-native web search (providers.json). */
  supportsWebSearch: boolean;
  /** The active model advertises tool calling (providers.json). */
  supportsTools: boolean;
  /** ADR 0164 P3 — the conversation's configured provider (`config.provider`). Scopes
   *  the per-exchange model switcher to THAT provider's models. Omitted ⇒ all models. */
  activeProvider?: string;
  /** ADR 0834 D6 / FW2-UX-1 — the conversation's message count and whether a turn is in
   *  flight. The pending tool approvals are re-read when a turn SETTLES: the send adds
   *  rows (a read then is before the hold is recorded) and the completion swaps them 1:1
   *  (the count alone never changes again), so the key is derived from both. */
  messageCount?: number;
  isSending?: boolean;
  /** ADR 0834 D6 — the surface's submit, bound after it is defined, so the approvals
   *  dialog can send a visible "approved, go ahead" turn to the current agent. */
  continueRef?: MutableRefObject<((text: string) => void) | null>;
}

export interface ComposerModifiers {
  /** Next-to-composer modifier chips. Pass to `ConversationView.composerModifiers`. */
  composerModifiers: ReactNode;
  /** The per-exchange model selector node (ADR 0124). */
  modelSwitcher: ReactNode;
  /** Per-turn send options for `runCoreSubmit`'s `baseSendOptions`. */
  getSubmitExtras: () => Partial<SendOptions>;
  /** ADR 0768 D2 — the per-message model override (null = the conversation default),
   *  so the shells judge attachments by the model that will ACTUALLY answer. */
  selectedModel: ModelChoice | null;
}

export function useComposerModifiers({ sessionId, supportsWebSearch, supportsTools, activeProvider, messageCount = 0, isSending = false, continueRef }: UseComposerModifiersOptions): ComposerModifiers {
  const { t } = useTranslation('chat');
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [toolsEnabled, setToolsEnabled] = useState(false);
  const [bypassEnabled, setBypassEnabled] = useState(false); // ADR 0150 — per-conversation permission mode (false = safe, the default)
  const [selectedModel, setSelectedModel] = useState<ModelChoice | null>(null); // ADR 0124 — per-exchange model switch
  // ADR 0834 D3 — the server honours bypass only for the principal the tools act as (the
  // conversation's owner). For anyone else the switch would claim a mode the server
  // silently ignores, so it is not offered. Optimistic until the scope read answers.
  const [mayBypass, setMayBypass] = useState(true);
  // FW2-UX-4 / FW2-CD-7 — both are per CONVERSATION: switching conversation must not carry
  // a bypass (or a non-owner's hidden switch) into the next one.
  useEffect(() => { setBypassEnabled(false); setMayBypass(true); }, [sessionId]);
  const onViewer = useCallback((v: { mayBypass: boolean }) => setMayBypass(v.mayBypass), []);
  const onContinue = useCallback((text: string) => { continueRef?.current?.(text); }, [continueRef]);
  const bypassActive = bypassEnabled && mayBypass;

  // ADR 0164 P3 — when the configured provider changes (the user picked a different
  // provider in the BYOK wizard), drop any per-exchange override held from the OLD
  // provider; otherwise that stale override would still dispatch to the prior provider.
  useEffect(() => { setSelectedModel(null); }, [activeProvider]);

  const composerModifiers = (
    <>
      {supportsWebSearch && (
        <button
          type="button"
          onClick={() => setWebSearchEnabled((v) => !v)}
          title={webSearchEnabled ? t('webSearchOnTitle') : t('webSearchOffTitle')}
          aria-pressed={webSearchEnabled}
          aria-label={t('toggleWebSearch')}
          className="composer-modifier"
        >
          <GlobeIcon size={13} /> {t('webLabel')}{webSearchEnabled ? ` ${t('onSuffix')}` : ''}
        </button>
      )}
      {supportsTools && (
        <button
          type="button"
          onClick={() => setToolsEnabled((v) => !v)}
          title={toolsEnabled ? t('toolsOnTitle') : t('toolsOffTitle')}
          aria-pressed={toolsEnabled}
          aria-label={t('toggleWorkflowTools')}
          className="composer-modifier"
        >
          <WrenchIcon size={13} /> {t('toolsLabel')}{toolsEnabled ? ` ${t('onSuffix')}` : ''}
        </button>
      )}
      {/* ADR 0150 — per-conversation permission mode (core, no toggle). Default safe =
          the agent asks before consequential tools (held for an approval — the pending
          chip below); bypass = it acts directly (sandbox/RBAC/budget still bind; a
          workspace or platform rule still asks — ADR 0834 D2). Offered only to the
          conversation's owner (ADR 0834 D3). */}
      {/* FW2-UX-5 — a non-owner is told why there is no switch, not left to wonder. */}
      {!mayBypass && (
        <span className="muted u-fs-11" role="note" aria-label={t('permissionOwnerOnlyTitle')} title={t('permissionOwnerOnlyTitle')}>
          <KeyIcon size={13} /> {t('permissionSafeLabel')}
        </span>
      )}
      {mayBypass && (
        <button
          type="button"
          onClick={() => setBypassEnabled((v) => !v)}
          title={bypassActive ? t('permissionBypassTitle') : t('permissionSafeTitle')}
          aria-pressed={bypassActive}
          aria-label={t('togglePermissionMode')}
          className={bypassActive ? 'composer-modifier is-bypass' : 'composer-modifier'}
        >
          {bypassActive ? <AlertIcon size={13} /> : <KeyIcon size={13} />} {bypassActive ? t('permissionBypassLabel') : t('permissionSafeLabel')}
        </button>
      )}
      {/* ADR 0724 / PMU-1 — the consequence of bypass, INLINE (the tooltip is hover-only,
          so a keyboard/touch user could enable a security switch without seeing it).
          `role="status"` announces the change to a screen reader as it happens. */}
      {bypassActive && (
        <span className="composer-modifier-hint" role="status" data-testid="permission-bypass-hint">{t('permissionBypassHint')}</span>
      )}
      {/* ADR 0132 — per-conversation tool scope/approvals, beside the tools modifier.
          ADR 0834 D6 — it also shows when a held tool call is waiting on the user. */}
      <Suspense fallback={null}>
        <ConversationToolsControl sessionId={sessionId} refreshKey={isSending ? -1 : messageCount} onViewer={onViewer} {...(continueRef ? { onContinue } : {})} />
      </Suspense>
    </>
  );

  const modelSwitcher = (
    <Suspense fallback={null}><ModelSwitcher value={selectedModel} onChange={setSelectedModel} {...(activeProvider ? { provider: activeProvider } : {})} /></Suspense>
  );

  const getSubmitExtras = useCallback((): Partial<SendOptions> => ({
    webSearch: webSearchEnabled && supportsWebSearch,
    ...(selectedModel ? { model: selectedModel.model, provider: selectedModel.provider } : {}),
    tools: toolsEnabled && supportsTools ? buildAvailableTools() : undefined,
    permissionMode: bypassActive ? 'bypass' : 'safe', // ADR 0150 (+ ADR 0834 D3: owner only)
  }), [webSearchEnabled, supportsWebSearch, toolsEnabled, supportsTools, selectedModel, bypassActive]);

  return { composerModifiers, modelSwitcher, getSubmitExtras, selectedModel };
}
