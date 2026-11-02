/**
 * ADR 1018 D8 — the ONE answer to "which model credential may this tenant's public
 * widget spend, and whose is it". Shaped after `resolveStorefrontSettlement`
 * (ADR 0877): one resolver, a tagged result, a reason on refusal, and every caller
 * — create, PATCH and the public message turn — asks it rather than re-deriving it.
 *
 * Until this decision every widget answered visitors on the platform's MANAGED key,
 * whoever owned it. The widget token is public, so any tenant could point an
 * unbounded audience at platform spend. The user decision (2026-10-31):
 *
 *  - `byok`    — the workspace's active chat binding (ADR 0517) names a stored key of
 *                a selectable provider: the widget answers on THAT key, for any tenant;
 *  - `managed` — no usable own key, and the tenant is listed in
 *                `OPENWOP_SUPERADMIN_TENANTS` (the operator's own workspaces): today's
 *                platform-paid lane;
 *  - `refused` — everyone else. Create and PATCH return a 400; the public turn stops
 *                answering. There is NO fallback from a refused or unresolvable BYOK
 *                key to the managed key — a widget whose binding flips to managed
 *                stops instead of spending.
 *
 * The dev-open toggle switch is NOT consulted (`isListedSuperadminTenant`, never
 * `isSuperadminTenant`), the same as the storefront's platform lane.
 */
import { getChatByokConfig, isManagedRef } from '../../host/chatByokConfig.js';
import { resolveSecret } from '../../byok/secretResolver.js';
import { isListedSuperadminTenant } from '../../host/superadmin.js';
import { listSelectableProviderIds } from '../../providers/catalog.js';
import { dispatchChat, type ChatMessage, type ProviderId } from '../../providers/dispatch.js';
import { dispatchManagedChat, dispatchManagedToolsRound } from '../../providers/managedProvider.js';
import { toolsRoundDispatcher } from '../../aiProviders/aiProvidersHost.js';
import { checkByokChatBudget, recordByokChatUsage } from '../../aiProviders/byokChatBudget.js';
import type { ToolDef, ToolUseBlock } from '../../providers/dispatchAnthropicTools.js';
import { OpenwopError } from '../../types.js';
import type { LogReasonCode } from '../../observability/logReasonCodes.js';

/** Why a widget may not answer: no own key bound, the binding is the managed tier or a
 *  personal subscription (never usable by anonymous visitors), or the bound key no longer
 *  resolves (an ephemeral key expired). */
export type WidgetCredentialRefusal = 'no_own_key' | 'managed_binding' | 'subscription_binding' | 'key_unavailable';

export type WidgetCredential =
  | { kind: 'managed'; userFacingProvider: string }
  | { kind: 'byok'; provider: ProviderId; model: string; credentialRef: string; apiKey: string }
  | { kind: 'refused'; reason: WidgetCredentialRefusal };

/** The host-managed provider id a superadmin widget dispatches through. */
const MANAGED_PROVIDER = 'openwop-free';

/** The code the operator console maps to "This widget needs your own model key."
 *  Never splice the server's English into translated copy (grade-ux CW68U-19). */
export const WIDGET_BYOK_REQUIRED = 'widget_byok_required';

/** The ONE rule (create, PATCH and the public turn all call this). */
export async function resolveWidgetCredential(tenantId: string): Promise<WidgetCredential> {
  const binding = await getChatByokConfig(tenantId).catch(() => null);
  const own = binding && !isManagedRef(binding.credentialRef) && !binding.credentialRef.startsWith('subscription:')
    && listSelectableProviderIds().includes(binding.provider) ? binding : null;
  if (own) {
    const apiKey = await resolveSecret(own.credentialRef, { tenantId }).catch(() => null);
    // A bound key that no longer resolves is refused — never quietly replaced by managed.
    if (!apiKey) return { kind: 'refused', reason: 'key_unavailable' };
    return { kind: 'byok', provider: own.provider as ProviderId, model: own.model, credentialRef: own.credentialRef, apiKey };
  }
  if (isListedSuperadminTenant(tenantId)) return { kind: 'managed', userFacingProvider: MANAGED_PROVIDER };
  if (!binding) return { kind: 'refused', reason: 'no_own_key' };
  return { kind: 'refused', reason: binding.credentialRef.startsWith('subscription:') ? 'subscription_binding' : 'managed_binding' };
}

/** Create / PATCH — a 400 naming the field, with the code the console translates. */
export async function assertWidgetCredential(tenantId: string): Promise<void> {
  const c = await resolveWidgetCredential(tenantId);
  if (c.kind !== 'refused') return;
  throw new OpenwopError('validation_error',
    'This widget needs your own model key: public widgets answer on the workspace\'s own AI key, and this workspace has none set up.',
    400, { field: 'credential', code: WIDGET_BYOK_REQUIRED, reason: c.reason });
}

/** ADR 0900 D2 — the closed-vocabulary log code per refusal (`reason` is PII-masked). */
export const WIDGET_REFUSAL_LOG_CODE: Readonly<Record<WidgetCredentialRefusal, LogReasonCode>> = {
  no_own_key: 'widget_no_own_key',
  managed_binding: 'widget_managed_binding',
  subscription_binding: 'widget_subscription_binding',
  key_unavailable: 'widget_key_unavailable',
};

type Usable = Exclude<WidgetCredential, { kind: 'refused' }>;

/** ADR 0178 — the workspace's daily BYOK budget covers visitor turns too (fail-closed). */
async function byokBudgetGate(tenantId: string, provider: string): Promise<void> {
  const budget = await checkByokChatBudget(tenantId, provider);
  if (budget.exceeded) throw new OpenwopError('rate_limited', 'This widget has reached its usage limit.', 429, { reason: 'byok_budget' });
}

/** One runless completion on the resolved credential. */
export async function widgetChat(tenantId: string, cred: Usable, messages: ChatMessage[], maxTokens: number): Promise<string> {
  if (cred.kind === 'managed') {
    const r = await dispatchManagedChat({ userFacingProvider: cred.userFacingProvider, tenantId, featureId: 'chat-widget', messages, maxTokens }); // ADR 0821 D4
    return typeof r.completion === 'string' ? r.completion : '';
  }
  await byokBudgetGate(tenantId, cred.provider);
  const r = await dispatchChat({ provider: cred.provider, model: cred.model, apiKey: cred.apiKey, messages, maxTokens });
  void recordByokChatUsage(tenantId, cred.provider, r.usage?.inputTokens ?? 0, r.usage?.outputTokens ?? 0);
  return typeof r.completion === 'string' ? r.completion : '';
}

/** One tool round (the anon tool lane) on the resolved credential. */
export async function widgetToolsRound(tenantId: string, cred: Usable, messages: ChatMessage[], tools: readonly ToolDef[]): Promise<{ text: string; toolUses: ToolUseBlock[]; finishReason?: string }> {
  if (cred.kind === 'managed') {
    // ADR 0821 D4 — anonymous visitor spend, billed to the owner.
    const r = await dispatchManagedToolsRound({ userFacingProvider: cred.userFacingProvider, tenantId, featureId: 'chat-widget', messages, tools });
    return { text: r.text, toolUses: r.toolUses, ...(r.finishReason ? { finishReason: r.finishReason } : {}) };
  }
  await byokBudgetGate(tenantId, cred.provider);
  const r = await toolsRoundDispatcher(cred.provider)({ model: cred.model, apiKey: cred.apiKey, messages, tools });
  void recordByokChatUsage(tenantId, cred.provider, r.inputTokens ?? 0, r.outputTokens ?? 0);
  return { text: r.text, toolUses: r.toolUses, ...(r.finishReason ? { finishReason: r.finishReason } : {}) };
}
