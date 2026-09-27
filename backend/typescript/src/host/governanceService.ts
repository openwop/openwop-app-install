/**
 * Governance policy (ADR 0028) — admin-set, tenant-scoped rules that
 * CONFIGURE the enforcement points that already exist; this module is never
 * a second evaluator:
 *
 *   - `isProviderAllowed()` is consulted at BOTH connections seams — the
 *     connect/authorize routes AND the node-exec credential resolver (one
 *     predicate, the `webhookEgressGuard` no-drift discipline);
 *   - `actionPolicyOf()` is consulted at the assistant's enqueue (disabled ⇒
 *     no drafts) and execution (draft-only ⇒ the human decision is recorded,
 *     nothing egresses) seams.
 *
 * Defaults are the T6 posture: every kind `approval-required` — the human
 * approval claim IS the gate; execution follows it. (Correction vs. ADR 0028
 * §"Decision", which sketched draft-only defaults for send kinds: a default
 * under which the Approve button silently does nothing is a UX trap — the
 * restrictive postures exist for admins to opt INTO.)
 *
 * Host-layer module (not a feature): both the connections and assistant
 * features consult it, and features must not import each other (ADR 0001).
 */

import { DurableCollection } from './hostExtPersistence.js';

export type ActionKindPolicy = 'disabled' | 'draft-only' | 'approval-required';

export interface GovernancePolicy {
  tenantId: string;
  /** Absent ⇒ every registry provider is connectable/resolvable. */
  providerAllowlist?: string[];
  /** Per assistant-action kind; absent kinds default `approval-required`. */
  actionPolicy?: Record<string, ActionKindPolicy>;
  /**
   * Retention windows (days), per DataClassification (ADR 0077 P3), enforced by
   * `host/retentionSweepDaemon.ts`. Both are OPT-IN — a window only purges when
   * EXPLICITLY configured (the ADR 0081 P5 footgun fix removed the old implicit
   * `confidential-pii: 365` default). 365 is the recommended value to SET, not a
   * default. Settable via the governance admin route (GOV-2).
   *
   * COS-2 (2026-08-19) — `assistantGraphDays` and `sourceDerivedDays` are GONE
   * from this type. They were declared here and accepted + persisted by the admin
   * route, and a repo-wide grep for either identifier found ZERO readers: an
   * operator could configure an assistant retention window, get a 200, and
   * nothing was ever purged. ADR 0077 recorded the sweep as unbuilt in 2026 and it
   * was still unbuilt. This docblock previously called them "kept for
   * back-compat", which is the shape a dead knob takes when nobody re-checks it —
   * back-compat with a behaviour that never existed.
   *
   * The route now REFUSES a body carrying either, naming the two windows that ARE
   * enforced, rather than silently accepting and dropping them. A gate with no
   * exit is a defect, so the refusal names the exit. Rows persisted before this
   * still carry the dead fields; they are inert and are not read, exactly as
   * before — nothing regressed by removing the declaration.
   */
  retention?: {
    confidentialPiiDays?: number;
    internalDays?: number;
  };
  /** ADR 0106 — per-org media-generation cost budget OVERRIDE. When a field is
   *  present it OVERRIDES the host env default (`OPENWOP_MEDIA_DAILY_{TTS_CHARS,
   *  STT_BYTES}`) for this tenant; an explicit `0` UNCAPS that kind for the org.
   *  Absent fields fall through to the env default. Settable via the superadmin
   *  governance route; consulted by `aiProviders/mediaBudget` through a DI seam
   *  (no direct module coupling). */
  mediaBudget?: {
    ttsChars?: number;
    sttBytes?: number;
    /** ADR 0401 P4 — daily image-generation count (0 = uncapped for the org). */
    images?: number;
    /** ADR 0411 P2 — daily video-generation job count (0 = uncapped for the org).
     *  `resolveBudget` already reads this override key; the governance route now
     *  lets it be SET (previously unsettable — read-with-no-writer). */
    videoJobs?: number;
  };
  /** Campaign gap plan §5B B3 — ad-spend governance. When
   *  `approvalThresholdMinor` is set, a LIVE ad dispatch or budget-set at/above
   *  that daily budget (minor units) requires an approved `campaign-spend`
   *  PendingApproval (host/adsAdapter.ts is the enforcement chokepoint — node
   *  ctx.ads calls bypass the capability-firewall). Unset ⇒ no threshold
   *  (created-PAUSED remains the backstop). Settable via the superadmin
   *  governance route. */
  adSpend?: {
    approvalThresholdMinor?: number;
  };
  /** Ecommerce gap plan §5B B3 — commerce order/refund-value governance. When
   *  `orderApprovalThresholdMinor` is set, an AGENT-PATH order create (workflow
   *  surface / UCP — never operator data-entry) whose total is at/above it
   *  requires an approved `commerce-spend` PendingApproval. When
   *  `refundApprovalThresholdMinor` is set, a refund of an order whose total is
   *  at/above it requires one for EVERY caller. Enforcement lives in
   *  `features/commerce/commerceService.ts` (the adsAdapter placement lesson —
   *  direct node calls bypass the capability-firewall). Unset ⇒ no threshold. */
  commerce?: {
    orderApprovalThresholdMinor?: number;
    refundApprovalThresholdMinor?: number;
    /** ADR 0238 DEF-1 — flat/manual tax + shipping (the default when no tax/shipping
     *  connection pack is configured). `flatTaxRatePercent` (0–100) applies to the
     *  goods subtotal-after-discount; `flatShippingMinor` is a fixed shipping charge in
     *  minor units. Both absent ⇒ zero tax / zero shipping — byte-identical to the
     *  pre-0237 posture. A configured tax/shipping provider overrides these at quote
     *  time; a provider error falls back to them (best-effort, never blocks checkout). */
    flatTaxRatePercent?: number;
    flatShippingMinor?: number;
    /** ADR 0250 — the merchant's ship-FROM origin, required for carrier rate-shopping
     *  (Shippo/EasyPost need an origin + destination + parcel). Absent ⇒ no live rate
     *  quote is attempted and checkout uses the flat shipping rate (best-effort seam). */
    shipFrom?: { postalCode: string; country: string; region?: string; city?: string };
    /** ADR 0240 DEF-8 — when true, a paid order with a linked CRM contact opens (or
     *  links) a WON Deal on the contact's default pipeline, idempotent by orderId.
     *  Opt-in (absent/false ⇒ no Deal is created — the pre-0240 behavior). */
    dealOnPaid?: boolean;
    /** ADR 0240 follow-on — optional target pipeline/stage for the Deal-on-paid Deal.
     *  Absent ⇒ the org's default pipeline's first stage (the shipped behavior). An id
     *  that doesn't belong to the org is rejected by createDeal's resolveStage ⇒ the
     *  best-effort linkage simply skips (never blocks payment). */
    dealOnPaidPipelineId?: string;
    dealOnPaidStageId?: string;
  };
  /** ADR 0178 — per-org BYOK LLM chat spend budget OVERRIDE. When `dailyTokenCap`
   *  is present it OVERRIDES the host env default (`OPENWOP_BYOK_DAILY_TOKEN_CAP`)
   *  for this tenant; an explicit `0` UNCAPS BYOK chat for the org. `softWarningPct`
   *  (0-100) sets the soft-warning threshold (absent ⇒ the 80% default). Absent
   *  fields fall through to env/default. Settable via the superadmin governance
   *  route; consulted by `aiProviders/byokChatBudget` through a DI seam (no direct
   *  module coupling). */
  byokChatBudget?: {
    dailyTokenCap?: number;
    softWarningPct?: number;
  };
  /** BRAND-CODE-6 — tenant-DEFAULT brand compliance policy. Governs an UNBRIEFED
   *  `publishAd` dispatch (no `briefId` ⇒ no bound `brandId`), which was otherwise
   *  ungoverned. When present and `blockPublish !== 'off'` and `defaultBrandId` is
   *  set, the ads-compliance checker sources that brand's rules for full content
   *  scoring (the SAME scorer the briefed path uses). Absent policy / `off` /
   *  no `defaultBrandId` / a `defaultBrandId` whose brand row is gone ⇒ the checker
   *  fails OPEN (allow), matching the resolver-leg posture. Tenant-scoped; an
   *  org-level default is deferred (see ADR 0354 BRAND-CODE-6). */
  brandCompliance?: {
    blockPublish: 'off' | 'critical' | 'threshold';
    blockThreshold?: number;
    defaultBrandId?: string;
  };
  /** ADR 0389 P4 — when true, a session operating in THIS workspace must have
   *  verified a second factor (`req.mfaVerified`, the Firebase
   *  `sign_in_second_factor` claim / SAML-IdP-delegated stamp). Enforced
   *  FAIL-CLOSED at the auth middleware for shared workspaces; the personal
   *  tenant is exempt so the enrollment path stays reachable. */
  requireMfa?: boolean;
  updatedAt: string;
  updatedByUserId?: string;
}

const policies = new DurableCollection<GovernancePolicy>('governance:policy', (p) => p.tenantId);

export async function getGovernancePolicy(tenantId: string): Promise<GovernancePolicy | null> {
  return policies.get(tenantId);
}

/** Tenants that have a governance policy — the EXPLICIT enumeration the retention
 *  sweep iterates (ADR 0077 P3). Never a wildcard: a tenant with no policy is never
 *  swept. */
export async function listGovernedTenants(): Promise<string[]> {
  return (await policies.list()).map((p) => p.tenantId);
}

/** The editable policy fields — ONE list, so no route can drift a hand-kept
 *  preserve list again (grade-pass DEBT-1: that drift class shipped two bugs —
 *  the ADR 0106 wipe and the ADR 0389 requireMfa wipe). */
const POLICY_FIELDS = ['providerAllowlist', 'actionPolicy', 'retention', 'mediaBudget', 'byokChatBudget', 'adSpend', 'commerce', 'brandCompliance', 'requireMfa'] as const;
type PolicyField = (typeof POLICY_FIELDS)[number];

/** Patch contract: a present field SETS, an explicit `null` CLEARS, an absent
 *  field PRESERVES the stored value. (Grade-pass DEBT-1 correction — the old
 *  full-replace contract made every route hand-copy a preserve list.) */
export type GovernancePolicyPatch = { [K in PolicyField]?: GovernancePolicy[K] | null };

export async function setGovernancePolicy(
  tenantId: string,
  patch: GovernancePolicyPatch,
  updatedByUserId?: string,
): Promise<GovernancePolicy> {
  const current = await policies.get(tenantId);
  const next: GovernancePolicy = {
    tenantId,
    updatedAt: new Date().toISOString(),
    ...(updatedByUserId !== undefined ? { updatedByUserId } : {}),
  };
  const assign = <K extends PolicyField>(k: K): void => {
    const v = patch[k];
    if (v === null) return; // explicit clear
    if (v !== undefined) next[k] = v;
    else if (current && current[k] !== undefined) next[k] = current[k];
  };
  for (const k of POLICY_FIELDS) assign(k);
  await policies.put(next);
  // GRADE-PASS 2026-07-17 (DATA-9): the writing instance must see its own
  // requireMfa flip immediately — cross-instance staleness stays ≤30s (TTL).
  mfaCache.delete(tenantId);
  return next;
}

/** ONE allowlist predicate for both the connect routes and the resolver. */
export async function isProviderAllowed(tenantId: string, provider: string): Promise<boolean> {
  const policy = await policies.get(tenantId);
  if (!policy?.providerAllowlist) return true;
  return policy.providerAllowlist.includes(provider);
}

/** Per-kind action policy; unset ⇒ `approval-required` (the T6 posture). */
export async function actionPolicyOf(tenantId: string, kind: string): Promise<ActionKindPolicy> {
  const policy = await policies.get(tenantId);
  const v = policy?.actionPolicy?.[kind];
  return v === 'disabled' || v === 'draft-only' || v === 'approval-required' ? v : 'approval-required';
}

/** ADR 0389 P4 — does this tenant require a second-factor session? Absent ⇒
 *  false. Cached briefly: this sits on the auth middleware hot path, and a
 *  30s-stale read of an admin policy flip is an acceptable propagation lag. */
const mfaCache = new Map<string, { v: boolean; exp: number }>();
const MFA_CACHE_TTL_MS = 30_000;
export async function tenantRequiresMfa(tenantId: string): Promise<boolean> {
  const hit = mfaCache.get(tenantId);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.v;
  const v = (await policies.get(tenantId))?.requireMfa === true;
  mfaCache.set(tenantId, { v, exp: now + MFA_CACHE_TTL_MS });
  return v;
}
/** Test-only. */
export function __resetMfaCache(): void {
  mfaCache.clear();
}

/** Test-only. */
export async function __resetGovernanceStore(): Promise<void> {
  await policies.__clear();
}
