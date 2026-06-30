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
 *     toggle, the per-conversation `<CapabilityScopeButton>`), gated on the active
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

import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { GlobeIcon, WrenchIcon, KeyIcon } from '../../ui/icons/index.js';
import { CapabilityScopeButton } from '../../conversationTools/CapabilityScopePanel.js';
import { buildAvailableTools } from '../lib/availableTools.js';
import type { ModelChoice } from '../ModelSwitcher.js';
import type { SendOptions } from '../types.js';

// ADR 0124 — the in-chat model switcher is a composer-header control NOT needed for
// first paint; lazy-split it out of the eager chat entry chunk (reclaims entry
// budget). The `null` fallback matches the switcher's own empty state (it renders
// nothing when no models are advertised), so the brief load gap is invisible.
const ModelSwitcher = lazy(() => import('../ModelSwitcher.js').then((m) => ({ default: m.ModelSwitcher })));

export interface UseComposerModifiersOptions {
  /** The conversation this composer is bound to — scopes the CapabilityScopeButton. */
  sessionId: string;
  /** The active model advertises provider-native web search (providers.json). */
  supportsWebSearch: boolean;
  /** The active model advertises tool calling (providers.json). */
  supportsTools: boolean;
  /** ADR 0164 P3 — the conversation's configured provider (`config.provider`). Scopes
   *  the per-exchange model switcher to THAT provider's models. Omitted ⇒ all models. */
  activeProvider?: string;
}

export interface ComposerModifiers {
  /** Next-to-composer modifier chips. Pass to `ConversationView.composerModifiers`. */
  composerModifiers: ReactNode;
  /** The per-exchange model selector node (ADR 0124). */
  modelSwitcher: ReactNode;
  /** Per-turn send options for `runCoreSubmit`'s `baseSendOptions`. */
  getSubmitExtras: () => Partial<SendOptions>;
}

export function useComposerModifiers({ sessionId, supportsWebSearch, supportsTools, activeProvider }: UseComposerModifiersOptions): ComposerModifiers {
  const { t } = useTranslation('chat');
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [toolsEnabled, setToolsEnabled] = useState(false);
  const [bypassEnabled, setBypassEnabled] = useState(false); // ADR 0150 — per-conversation permission mode (false = safe, the default)
  const [selectedModel, setSelectedModel] = useState<ModelChoice | null>(null); // ADR 0124 — per-exchange model switch

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
      {/* ADR 0150 — per-conversation permission mode. Always shown (core, no toggle).
          Default safe = the agent asks before consequential tools (the firewall approval
          card); bypass = it acts directly (sandbox/RBAC/budget still bind). */}
      <button
        type="button"
        onClick={() => setBypassEnabled((v) => !v)}
        title={bypassEnabled ? t('permissionBypassTitle') : t('permissionSafeTitle')}
        aria-pressed={bypassEnabled}
        aria-label={t('togglePermissionMode')}
        className="composer-modifier"
      >
        <KeyIcon size={13} /> {bypassEnabled ? t('permissionBypassLabel') : t('permissionSafeLabel')}
      </button>
      {/* ADR 0132 — per-conversation tool scope/approvals, moved here from
          the header as a settings affordance beside the tools modifier. */}
      <CapabilityScopeButton sessionId={sessionId} />
    </>
  );

  const modelSwitcher = (
    <Suspense fallback={null}><ModelSwitcher value={selectedModel} onChange={setSelectedModel} {...(activeProvider ? { provider: activeProvider } : {})} /></Suspense>
  );

  const getSubmitExtras = useCallback((): Partial<SendOptions> => ({
    webSearch: webSearchEnabled && supportsWebSearch,
    ...(selectedModel ? { model: selectedModel.model, provider: selectedModel.provider } : {}),
    tools: toolsEnabled && supportsTools ? buildAvailableTools() : undefined,
    permissionMode: bypassEnabled ? 'bypass' : 'safe', // ADR 0150
  }), [webSearchEnabled, supportsWebSearch, toolsEnabled, supportsTools, selectedModel, bypassEnabled]);

  return { composerModifiers, modelSwitcher, getSubmitExtras };
}
