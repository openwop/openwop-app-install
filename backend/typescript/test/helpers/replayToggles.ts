/** ADR 0951 P2.5 — a replay recording is readable and writable only while the
 * `analytics`, `analytics.session-replay` and `consent` toggles resolve ON for its tenant.
 * Store-level tests that are not about the disable fence turn both on globally
 * through the real toggle service (no resolver is mocked). */
import { analyticsFeature } from '../../src/features/analytics/feature.js';
import { consentFeature } from '../../src/features/consent/feature.js';
import { registerToggleDefault } from '../../src/host/featureToggles/registry.js';
import { saveConfig } from '../../src/host/featureToggles/service.js';
import type { ToggleConfig } from '../../src/host/featureToggles/types.js';
import { DurableCollection } from '../../src/host/hostExtPersistence.js';

const REPLAY_TOGGLES = ['analytics', 'analytics.session-replay', 'consent'] as const;

function replayDefaults(): ToggleConfig[] {
  const all = [analyticsFeature.toggleDefault, ...(analyticsFeature.extraToggleDefaults ?? []), consentFeature.toggleDefault]
    .filter((t): t is ToggleConfig => Boolean(t));
  return all.filter((t) => (REPLAY_TOGGLES as readonly string[]).includes(t.id));
}

/** Register the replay toggle defaults and set both to `status`. Also records
 *  every sampled visit (`OPENWOP_REPLAY_SAMPLE_PERCENT=100`) unless a test set
 *  its own sample: store tests are not about sampling (the admission witness is). */
export async function setReplayToggles(status: 'on' | 'off'): Promise<void> {
  process.env.OPENWOP_REPLAY_SAMPLE_PERCENT ??= '100';
  for (const def of replayDefaults()) {
    registerToggleDefault(def);
    await saveConfig({ ...def, status }, 'test');
  }
}

/** Mark a client org eligible for replay (attested not health/finance), so
 *  store tests can record.
 *  Writes the production row shape through the same persistence and touches no
 *  timers. The eligibility witness itself uses `setReplayOrgEligibility`. */
const eligibilityRows = new DurableCollection<{ tenantId: string; orgId: string; notHealthOrFinance: true; attestationId: string; attestedBy: string; attestedAt: string }>(
  'analytics:replay-org-eligibility', (e) => `${e.tenantId}:${e.orgId}`, undefined, (e) => e.tenantId,
);
export async function attestReplayOrg(tenantId: string, orgId: string): Promise<void> {
  // Idempotent like the product: an existing attestation keeps its id.
  if (await eligibilityRows.get(`${tenantId}:${orgId}`)) return;
  await eligibilityRows.put({ tenantId, orgId, notHealthOrFinance: true, attestationId: `test-${tenantId}-${orgId}`, attestedBy: 'test', attestedAt: '2000-01-01T00:00:00.000Z' });
}
