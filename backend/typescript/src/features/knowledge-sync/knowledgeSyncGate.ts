/**
 * Knowledge-sync spend gate (WF-KB-4) — extracted from the retired
 * `knowledgeSyncDaemon` so the run surface (`ctx.features.knowledgeSync.runOnce`)
 * and the boot backfill can share the ONE fail-closed check without importing the
 * deleted daemon module.
 *
 * WF-KB-4 history: the eight write routes were `requireFeatureEnabled`-gated but
 * the RECURRING sync path was not, so a tenant that enabled → configured →
 * DISABLED kept paying scheduled third-party egress + embedding spend
 * indefinitely. The check is BOTH halves, because `requireFeatureEnabled` gates on
 * both (`features/featureRoute.ts`): the toggle AND — since `knowledge-sync` is in
 * the `content` sellable bundle — the plan entitlement.
 *
 * The feature-surface seam (`host/featureSurfaces.ts` `gate`) already throws
 * `host_capability_disabled` for a toggled-off tenant on every surface method, so
 * a scheduled run can never reach `syncNow` with the toggle off. This function is
 * kept as the defence-in-depth check AT THE SPEND SITE (the daemon's posture): it
 * also covers the entitlement half the seam does not, and it holds even if a
 * future caller ever reached the run path outside the gated surface. Fail-CLOSED
 * on either resolver erroring — a run that cannot PROVE it may spend must not.
 */

import { createLogger } from '../../observability/logger.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { isSellableBundleFeature } from '../../host/featureBundles.js';
import { checkTenantEntitlement } from '../../host/entitlementSeam.js';

const log = createLogger('knowledge-sync.gate');

/** The feature id this surface spends on — the SAME id the eight write routes
 *  pass to `requireFeatureEnabled`, so both gates can never drift apart. */
const KNOWLEDGE_SYNC_TOGGLE_ID = 'knowledge-sync';

/** The values an operator may write to `OPENWOP_KNOWLEDGE_SYNC_DAEMON_ENABLED`
 *  to STOP all knowledge-sync spend. Compared case-insensitively, trimmed. */
const FALSY_ENV = new Set(['false', '0', 'off', 'no', 'disabled']);

/**
 * The operator's GLOBAL kill-switch for knowledge-sync spend (WF-KB-3 preserved it
 * across the daemon deletion). It used to stop the bespoke daemon; it now gates the
 * scheduled surface run, so the documented incident-response command
 * (`--update-env-vars OPENWOP_KNOWLEDGE_SYNC_DAEMON_ENABLED=false`) still stops every
 * source's fired job from spending. Opt-OUT (defaults ON): `0`/`off`/`no`/`false`/
 * `disabled` all stop it; anything else is treated as ENABLED. Kept as a NAMED,
 * TESTED predicate rather than an inline `=== 'false'` so a value a hand types under
 * pressure is honoured.
 */
export function knowledgeSyncKillSwitchEngaged(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return FALSY_ENV.has(raw.trim().toLowerCase());
}

/** May this tenant's scheduled sync spend money right now? (WF-KB-4 + the global
 *  kill-switch.) Fail-closed. */
export async function syncEnabledFor(tenantId: string): Promise<boolean> {
  // Operator kill-switch first — a global STOP must not depend on the toggle store.
  if (knowledgeSyncKillSwitchEngaged(process.env.OPENWOP_KNOWLEDGE_SYNC_DAEMON_ENABLED)) return false;
  try {
    const toggle = await resolveOne(KNOWLEDGE_SYNC_TOGGLE_ID, { tenantId });
    if (!toggle?.enabled) return false;
    // Throws `forbidden` when the plan does not entitle it — caught below, so a
    // de-entitled tenant is skipped exactly like a toggled-off one. No-op until an
    // operator narrows `OPENWOP_BILLING_PLAN_FEATURES`, so unrestricted hosts pay
    // nothing for it.
    if (isSellableBundleFeature(KNOWLEDGE_SYNC_TOGGLE_ID)) await checkTenantEntitlement(tenantId, KNOWLEDGE_SYNC_TOGGLE_ID);
    return true;
  } catch (err) {
    log.warn('knowledge_sync_gate_closed', { tenantId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
