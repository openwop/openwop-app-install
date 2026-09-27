/**
 * ADR 0139 — frontend client for the menu-config host-extension (Phase 2).
 *
 * Reads and writes throw on transport/server failure. The provider owns the
 * safe declared-menu fallback because it can preserve that fallback while also
 * exposing a distinct degraded state; coercing failure to an empty bundle here
 * would erase the difference between "no overrides" and "unknown".
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import type { MenuConfig, MenuConfigBundle } from './types.js';

const BASE = '/host/openwop-app/menu-config';
let tenantVersion: string | null = null;

async function httpResponse<T>(path: string, init: RequestInit = {}): Promise<{ body: T; response: Response }> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(init),
    headers: { ...(init.headers ?? {}), ...authedHeaders({ 'content-type': 'application/json' }) },
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string };
    throw new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`);
  }
  return { body: body as T, response: res };
}

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await httpResponse<T>(path, init)).body;
}

/** The combined { tenant, user } layers (one round-trip). */
export async function getMenuConfig(): Promise<MenuConfigBundle> {
  // A failed reload may follow an identity/tenant change. Never retain a
  // validator from the previous successful context in that unknown state.
  tenantVersion = null;
  const result = await httpResponse<MenuConfigBundle>(BASE);
  tenantVersion = result.response.headers.get('etag');
  return result.body;
}

/** Save the shared workspace default (superadmin). Throws on failure. */
export async function putTenantMenuConfig(cfg: MenuConfig): Promise<MenuConfig> {
  const result = await httpResponse<{ config: MenuConfig }>(`${BASE}/tenant`, {
    method: 'PUT',
    body: JSON.stringify({ config: cfg }),
    ...(tenantVersion ? { headers: { 'if-match': tenantVersion } } : {}),
  });
  tenantVersion = result.response.headers.get('etag');
  return result.body.config;
}

/** Save the caller's personalization. Throws on failure. */
export async function putMyMenuConfig(cfg: MenuConfig): Promise<MenuConfig> {
  return (await http<{ config: MenuConfig }>(`${BASE}/me`, { method: 'PUT', body: JSON.stringify({ config: cfg }) })).config;
}
