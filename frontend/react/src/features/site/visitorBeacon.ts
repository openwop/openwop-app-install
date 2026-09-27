/**
 * Anonymous visitor key + experiment beacon for the PUBLIC front page
 * (ADR 0236 — campaign gap D1).
 *
 * The SPA had no analytics beacon (ingest is the backend's public
 * `/public-analytics/:orgId/collect`, normally embedded by externally-served
 * published sites). For experiment measurement the front page carries the SAME
 * anonymous `sessionKey` the beacon contract defines: minted once per browser,
 * stored locally, sent as `vk` on the public page read. CONSENT IS ENFORCED
 * SERVER-SIDE (the one ADR 0020 `isAllowed` gate): without analytics consent
 * the read returns the plain published page (no assignment) and the collect
 * endpoint records nothing (202) — the client never implements a second
 * consent rule. Only when the response carries an experiment stamp does the
 * page fire ONE stamped pageview, so non-experiment visitors generate no
 * beacon traffic (today's behavior).
 */
import { config } from '../../client/config.js';

const STORAGE_KEY = 'owp:vk';

/** The browser's stable anonymous visitor key (minted once), or null when
 *  storage is unavailable (private mode etc. — honest degradation: no key ⇒
 *  no experiment exposure). */
export function getVisitorKey(): string | null {
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const minted = `vk-${crypto.randomUUID()}`;
    window.localStorage.setItem(STORAGE_KEY, minted);
    return minted;
  } catch {
    return null;
  }
}

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
        experiment: { id: experiment.experimentId, variant: experiment.variant },
      }),
    }).catch(() => undefined);
  } catch { /* never break the page for measurement */ }
}
