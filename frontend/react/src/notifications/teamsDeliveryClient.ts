/**
 * Teams approval-delivery preference client (ADR 0198 Phase B) — self-service.
 *
 *   GET/PUT/DELETE /host/openwop-app/approval-delivery/teams
 *
 * Tenant + user scoping is the backend's job; the client never sends them.
 */

import { authedHeaders, config, fetchOpts } from '../client/config.js';

export interface TeamsDeliveryPref {
  connectionId: string;
  chatId: string;
  createdAt: string;
}

const url = `${config.baseUrl}/host/openwop-app/approval-delivery/teams`;

function jsonHeaders(): Record<string, string> {
  return { ...authedHeaders(), 'content-type': 'application/json' };
}

async function orThrow<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(body.message ?? `Request failed (${res.status})`);
  return body;
}

export async function getTeamsDeliveryPref(): Promise<TeamsDeliveryPref | null> {
  const res = await fetch(url, fetchOpts({ headers: authedHeaders() }));
  const body = await orThrow<{ pref: TeamsDeliveryPref | null }>(res);
  return body.pref;
}

export async function setTeamsDeliveryPref(input: { connectionId: string; chatId: string }): Promise<TeamsDeliveryPref> {
  const res = await fetch(url, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(input) }));
  const body = await orThrow<{ pref: TeamsDeliveryPref }>(res);
  return body.pref;
}

export async function clearTeamsDeliveryPref(): Promise<void> {
  const res = await fetch(url, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  await orThrow(res);
}
