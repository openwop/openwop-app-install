/**
 * KickTodo integrations FE client (ADR 0421 / 0438 A6) — React-free over
 * `/host/openwop-app/kicktodo/integrations/*`.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

const BASE = `${config.baseUrl}/host/openwop-app/kicktodo/integrations`;

/** The HONEST calendar-write transport state for THIS deployment (ADR 0438 A6 /
 *  B20): `transportConfigured` is true only when a production transport is wired.
 *  A deployment-global fact — read, never hardcoded, so the console never claims
 *  a connection that isn't there. */
export async function getCalendarStatus(): Promise<{ transportConfigured: boolean }> {
  const res = await fetch(`${BASE}/calendar-status`, { ...fetchOpts({}), headers: authedHeaders({}) });
  if (!res.ok) throw new Error(`calendar status failed: ${res.status}`);
  return (await res.json()) as { transportConfigured: boolean };
}

/** ADR 0496 D5 — the CALLER's integration consents (kind + revokedAt), the
 *  store-backed half of the §5.5 external-calendar disclosure. */
export interface IntegrationConsent {
  kind: string;
  grantedAt?: string;
  revokedAt?: string;
}
export async function getConsents(): Promise<IntegrationConsent[]> {
  const res = await fetch(`${BASE}/consents`, { ...fetchOpts({}), headers: authedHeaders({}) });
  if (!res.ok) throw new Error(`consents failed: ${res.status}`);
  return ((await res.json()) as { consents: IntegrationConsent[] }).consents;
}

/** ADR 0443 R1 / ADR 0421 — grant or revoke one of the CALLER's integration
 *  consents. `messaging-reminders` is what `routeReminder` requires before a
 *  scheduled reminder reaches the participant outside the app; until this pair
 *  existed no surface could grant it, so a daypart reminder never left the app. */
export async function grantConsent(kind: string): Promise<void> {
  const res = await fetch(`${BASE}/consents`, {
    ...fetchOpts({}),
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ kind }),
  });
  if (!res.ok) throw new Error(`grant consent failed: ${res.status}`);
}
export async function revokeConsent(kind: string): Promise<void> {
  const res = await fetch(`${BASE}/consents/revoke`, {
    ...fetchOpts({}),
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ kind }),
  });
  if (!res.ok) throw new Error(`revoke consent failed: ${res.status}`);
}
