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
import {
  resolveOutsiderCredential, outsiderChat, outsiderToolsRound,
  type OutsiderCredential, type OutsiderCredentialRefusal, type UsableOutsiderCredential, type OutsiderSpend,
} from '../../host/outsiderTurnCredential.js';
import type { ChatMessage } from '../../providers/dispatch.js';
import type { ToolDef, ToolUseBlock } from '../../providers/dispatchAnthropicTools.js';
import { OpenwopError } from '../../types.js';
import type { LogReasonCode } from '../../observability/logReasonCodes.js';

// ADR 1099 D5 — the rule itself moved to `host/outsiderTurnCredential.ts`, shared with
// the collaborator turn. These are the widget's names for it, with the widget's copy.

/** Why a widget may not answer (see `OutsiderCredentialRefusal`). */
export type WidgetCredentialRefusal = OutsiderCredentialRefusal;
export type WidgetCredential = OutsiderCredential;

/** The code the operator console maps to "This widget needs your own model key."
 *  Never splice the server's English into translated copy (grade-ux CW68U-19). */
export const WIDGET_BYOK_REQUIRED = 'widget_byok_required';

const WIDGET_SPEND: OutsiderSpend = { featureId: 'chat-widget', budgetMessage: 'This widget has reached its usage limit.' };

/** The ONE rule (create, PATCH and the public turn all call this). */
export function resolveWidgetCredential(tenantId: string): Promise<WidgetCredential> {
  return resolveOutsiderCredential(tenantId);
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

/** One runless completion on the resolved credential. */
export function widgetChat(tenantId: string, cred: UsableOutsiderCredential, messages: ChatMessage[], maxTokens: number): Promise<string> {
  return outsiderChat(tenantId, cred, messages, maxTokens, WIDGET_SPEND);
}

/** One tool round (the anon tool lane) on the resolved credential. */
export function widgetToolsRound(tenantId: string, cred: UsableOutsiderCredential, messages: ChatMessage[], tools: readonly ToolDef[]): Promise<{ text: string; toolUses: ToolUseBlock[]; finishReason?: string }> {
  return outsiderToolsRound(tenantId, cred, messages, tools, WIDGET_SPEND);
}
