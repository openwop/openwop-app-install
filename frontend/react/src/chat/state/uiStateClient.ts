/**
 * Per-user UI-state client (ADR 0071) — durable, non-authoritative display
 * preferences (selected artifact revision, compare mode, expanded panels,
 * dismissed notices) over the host `/v1/host/openwop-app/ui-state` store. The
 * caller's subject is derived server-side; this client never sends it.
 *
 * Mirrors `host/uiStateStore.ts`. Use this instead of localStorage for state
 * that should survive reload + device changes.
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const BASE = '/v1/host/openwop-app/ui-state';

export type UiStateResourceType = 'conversation' | 'review' | 'artifact' | 'message';

export interface UiStateEntry {
  tenantId: string;
  subjectRef: string;
  resourceType: UiStateResourceType;
  resourceId: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

/** JSON-body request (GET/PUT here — never 204). */
async function httpJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(init),
    headers: { ...(init?.headers ?? {}), ...authedHeaders({ 'content-type': 'application/json' }) },
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string };
    throw new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`);
  }
  return body as T;
}

/** A request whose success is a 204/no-body (DELETE) — no T cast needed. */
async function httpNoContent(path: string, init?: RequestInit): Promise<void> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(init),
    headers: { ...(init?.headers ?? {}), ...authedHeaders({ 'content-type': 'application/json' }) },
  });
  if (!res.ok && res.status !== 204) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`);
  }
}

/** The caller's UI-state rows for a resource (or a whole resourceType). */
export async function listUiState(resourceType?: UiStateResourceType, resourceId?: string): Promise<UiStateEntry[]> {
  const q = new URLSearchParams();
  if (resourceType) q.set('resourceType', resourceType);
  if (resourceId) q.set('resourceId', resourceId);
  const qs = q.toString();
  return (await httpJson<{ items: UiStateEntry[] }>(`${BASE}${qs ? `?${qs}` : ''}`)).items;
}

export async function putUiState(resourceType: UiStateResourceType, resourceId: string, key: string, value: unknown): Promise<UiStateEntry> {
  return httpJson<UiStateEntry>(BASE, { method: 'PUT', body: JSON.stringify({ resourceType, resourceId, key, value }) });
}

export async function deleteUiState(resourceType: UiStateResourceType, resourceId: string, key: string): Promise<void> {
  await httpNoContent(`${BASE}/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}/${encodeURIComponent(key)}`, { method: 'DELETE' });
}
