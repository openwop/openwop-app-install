/**
 * Experiment beacon for the PUBLIC front page (ADR 0236 — campaign gap D1).
 *
 * The SPA had no analytics beacon (ingest is the backend's public
 * `/public-analytics/:orgId/collect`, normally embedded by externally-served
 * published sites). For experiment measurement the front page carries the SAME
 * anonymous `sessionKey` the beacon contract defines, sent as `vk` on the public
 * page read. CONSENT IS ENFORCED SERVER-SIDE (the one ADR 0020 gate): without
 * analytics consent the read returns the plain published page (no assignment)
 * and the collect endpoint records nothing (202). Only when the response carries
 * an experiment stamp does the page fire ONE stamped pageview.
 *
 * > CORRECTED 2026-10-07 (ADR 0860 D5): the key used to be minted and stored on
 * > every page load, before any consent check — the device write is itself the
 * > non-essential storage, so a server-side refusal did not cure it. The key now
 * > lives in `visitorConsent.ts` and exists only once the visitor's decision
 * > allows it; the beacon sends the visitor's consent-lane token beside it.
 */
import { config } from '../../client/config.js';
import { consentTokenFor, repairConsentTokenFrom } from './visitorConsent.js';

export { getVisitorKey } from './visitorConsent.js';

/** Fire-and-forget: record one experiment-stamped pageview on the public
 *  analytics beacon. Failures are silent — measurement never breaks the page. */
export function sendExperimentPageview(
  orgId: string,
  visitorKey: string,
  experiment: { experimentId: string; variant: string },
): void {
  try {
    const url = `${config.baseUrl}/host/openwop-app/public-analytics/${encodeURIComponent(orgId)}/collect`;
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        type: 'pageview',
        path: window.location.pathname,
        sessionKey: visitorKey,
        ...(consentTokenFor(orgId) ? { consentToken: consentTokenFor(orgId) } : {}),
        experiment: { id: experiment.experimentId, variant: experiment.variant },
      }),
    }).then((res) => repairConsentTokenFrom(orgId, res)).catch(() => undefined); // grade-code M4
  } catch { /* never break the page for measurement */ }
}
