/**
 * ADR 1018 D8 — the ONE answer to "which model credential may a turn spend when the
 * person typing is not a member of the tenant, and whose is it". Moved here from
 * `features/chat-widget/widgetCredential.ts` (ADR 1099 D5) so the host collaborator
 * turn uses the same rule as the public widget, without a host → feature import.
 * The widget keeps its names and copy as thin wrappers.
 *
 * Shaped after `resolveStorefrontSettlement` (ADR 0877): one resolver, a tagged
 * result, a reason on refusal. The user decision (2026-10-31):
 *
 *  - `byok`    — the workspace's active chat binding (ADR 0517) names a stored key of
 *                a selectable provider: the turn runs on THAT key, for any tenant;
 *  - `managed` — no usable own key, and the tenant is listed in
 *                `OPENWOP_SUPERADMIN_TENANTS` (the operator's own workspaces): the
 *                platform-paid lane;
 *  - `refused` — everyone else. There is NO fallback from a refused or unresolvable
 *                BYOK key to the managed key — a binding that flips to managed stops
 *                instead of spending.
 *
 * The outsider never supplies or influences the key: it is always the tenant's.
 * The dev-open toggle switch is NOT consulted (`isListedSuperadminTenant`, never
 * `isSuperadminTenant`), the same as the storefront's platform lane.
 */
import { getChatByokConfig, isManagedRef } from './chatByokConfig.js';
import { resolveUserNamedSecret } from '../byok/userNamedSecret.js';
import { isListedSuperadminTenant } from './superadmin.js';
import { listSelectableProviderIds } from '../providers/catalog.js';
import { dispatchChat, type ChatMessage, type ProviderId } from '../providers/dispatch.js';
import { dispatchManagedChat, dispatchManagedToolsRound } from '../providers/managedProvider.js';
import { toolsRoundDispatcher } from '../aiProviders/aiProvidersHost.js';
import { checkByokChatBudget, recordByokChatUsage } from '../aiProviders/byokChatBudget.js';
import type { ToolDef, ToolUseBlock } from '../providers/dispatchAnthropicTools.js';
import { OpenwopError } from '../types.js';

/** Why an outsider turn may not run: no own key bound, the binding is the managed tier
 *  or a personal subscription (never usable for someone outside the workspace), or the
 *  bound key no longer resolves (an ephemeral key expired). */
export type OutsiderCredentialRefusal = 'no_own_key' | 'managed_binding' | 'subscription_binding' | 'key_unavailable';

export type OutsiderCredential =
  | { kind: 'managed'; userFacingProvider: string }
  | { kind: 'byok'; provider: ProviderId; model: string; credentialRef: string; apiKey: string }
  | { kind: 'refused'; reason: OutsiderCredentialRefusal };

export type UsableOutsiderCredential = Exclude<OutsiderCredential, { kind: 'refused' }>;

/** The host-managed provider id a listed operator tenant dispatches through. */
const MANAGED_PROVIDER = 'openwop-free';

/** The ONE rule. */
export async function resolveOutsiderCredential(tenantId: string): Promise<OutsiderCredential> {
  const binding = await getChatByokConfig(tenantId).catch(() => null);
  const own = binding && !isManagedRef(binding.credentialRef) && !binding.credentialRef.startsWith('subscription:')
    && listSelectableProviderIds().includes(binding.provider) ? binding : null;
  if (own) {
    const apiKey = await resolveUserNamedSecret(own.credentialRef, { tenantId }).catch(() => null);
    // A bound key that no longer resolves is refused — never quietly replaced by managed.
    if (!apiKey) return { kind: 'refused', reason: 'key_unavailable' };
    return { kind: 'byok', provider: own.provider as ProviderId, model: own.model, credentialRef: own.credentialRef, apiKey };
  }
  if (isListedSuperadminTenant(tenantId)) return { kind: 'managed', userFacingProvider: MANAGED_PROVIDER };
  if (!binding) return { kind: 'refused', reason: 'no_own_key' };
  return { kind: 'refused', reason: binding.credentialRef.startsWith('subscription:') ? 'subscription_binding' : 'managed_binding' };
}

/** Who is spending, for metering and for the budget refusal's copy. */
export interface OutsiderSpend {
  /** The feature the managed spend is attributed to (ADR 0821 D4). */
  featureId: string;
  /** The 429 message when the workspace's daily BYOK budget is spent. */
  budgetMessage: string;
}

/** ADR 0178 — the workspace's daily BYOK budget covers outsider turns too (fail-closed). */
async function byokBudgetGate(tenantId: string, provider: string, spend: OutsiderSpend): Promise<void> {
  const budget = await checkByokChatBudget(tenantId, provider);
  if (budget.exceeded) throw new OpenwopError('rate_limited', spend.budgetMessage, 429, { reason: 'byok_budget' });
}

/** One runless completion on the resolved credential. */
export async function outsiderChat(tenantId: string, cred: UsableOutsiderCredential, messages: ChatMessage[], maxTokens: number, spend: OutsiderSpend): Promise<string> {
  if (cred.kind === 'managed') {
    const r = await dispatchManagedChat({ userFacingProvider: cred.userFacingProvider, tenantId, featureId: spend.featureId, messages, maxTokens }); // ADR 0821 D4
    return typeof r.completion === 'string' ? r.completion : '';
  }
  await byokBudgetGate(tenantId, cred.provider, spend);
  const r = await dispatchChat({ provider: cred.provider, model: cred.model, apiKey: cred.apiKey, messages, maxTokens });
  void recordByokChatUsage(tenantId, cred.provider, r.usage?.inputTokens ?? 0, r.usage?.outputTokens ?? 0);
  return typeof r.completion === 'string' ? r.completion : '';
}

/** One tool round on the resolved credential. */
export async function outsiderToolsRound(
  tenantId: string, cred: UsableOutsiderCredential, messages: ChatMessage[], tools: readonly ToolDef[], spend: OutsiderSpend,
): Promise<{ text: string; toolUses: ToolUseBlock[]; finishReason?: string }> {
  if (cred.kind === 'managed') {
    // ADR 0821 D4 — the outsider's spend, billed to the tenant.
    const r = await dispatchManagedToolsRound({ userFacingProvider: cred.userFacingProvider, tenantId, featureId: spend.featureId, messages, tools });
    return { text: r.text, toolUses: r.toolUses, ...(r.finishReason ? { finishReason: r.finishReason } : {}) };
  }
  await byokBudgetGate(tenantId, cred.provider, spend);
  const r = await toolsRoundDispatcher(cred.provider)({ model: cred.model, apiKey: cred.apiKey, messages, tools });
  void recordByokChatUsage(tenantId, cred.provider, r.inputTokens ?? 0, r.outputTokens ?? 0);
  return { text: r.text, toolUses: r.toolUses, ...(r.finishReason ? { finishReason: r.finishReason } : {}) };
}
