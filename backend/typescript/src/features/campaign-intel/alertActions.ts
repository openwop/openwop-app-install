/**
 * ADR 0952 D4 — pacing and cap alerts carry the actions that answer them.
 *
 * A notification never applies a change. Each action is a deep link that opens
 * Campaign Intelligence with that action STAGED (`stage=` on the URL); a person
 * confirms it there, through the same governed paths as everywhere else:
 *  - `pause`: ungated (stopping spend is the safe direction), workspace:write;
 *  - `reallocate`: proposes ONE plan that a human approves (D3);
 *  - `raise-cap`: opens the caps panel; raising needs the org owner (P1),
 *    and through the ADR 0942 gate once it lands.
 * At most three actions per alert, most useful first.
 */

export type AlertAction = 'pause' | 'reallocate' | 'raise-cap';
export type AlertKind = 'pacing-over' | 'pacing-warning' | 'cap-breached' | 'cap-stale';
export interface AlertActionLink { action: AlertAction; url: string }

const ACTIONS: Record<AlertKind, AlertAction[]> = {
  'pacing-over': ['pause', 'reallocate'],
  'pacing-warning': ['reallocate'],
  // The watchdog has already paused the covered campaigns.
  'cap-breached': ['raise-cap', 'reallocate'],
  'cap-stale': ['raise-cap'],
};

export function alertActions(kind: AlertKind, ids: { orgId: string; campaignId?: string; capId?: string }): AlertActionLink[] {
  return ACTIONS[kind].slice(0, 3).map((action) => {
    const q = new URLSearchParams({ tab: 'campaign-intelligence', org: ids.orgId });
    if (ids.campaignId) q.set('campaign', ids.campaignId);
    if (ids.capId && action === 'raise-cap') q.set('cap', ids.capId);
    q.set('stage', action);
    return { action, url: `/campaigns?${q.toString()}` };
  });
}
