/**
 * ADR 0139 — frontend client for the menu-config host-extension (Phase 2).
 *
 * `getMenuConfig` swallows errors into the empty bundle so a 401 (anonymous
 * first paint) or a transient network failure never breaks the nav rails — the
 * resolver just falls back to the declared menu. The PUT helpers throw so the
 * editor can surface a save failure.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { EMPTY_MENU_CONFIG_BUNDLE, type MenuConfig, type MenuConfigBundle } from './types.js';

const BASE = '/v1/host/openwop-app/menu-config';

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(init),
    headers: { ...(init.headers ?? {}), ...authedHeaders({ 'content-type': 'application/json' }) },
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string };
    throw new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`);
  }
  return body as T;
}

/** The combined { tenant, user } layers (one round-trip). Never throws. */
export async function getMenuConfig(): Promise<MenuConfigBundle> {
  try {
    return await http<MenuConfigBundle>(BASE);
  } catch {
    return EMPTY_MENU_CONFIG_BUNDLE;
  }
}

/** Save the shared workspace default (superadmin). Throws on failure. */
export async function putTenantMenuConfig(cfg: MenuConfig): Promise<MenuConfig> {
  return (await http<{ config: MenuConfig }>(`${BASE}/tenant`, { method: 'PUT', body: JSON.stringify({ config: cfg }) })).config;
}

/** Save the caller's personalization. Throws on failure. */
export async function putMyMenuConfig(cfg: MenuConfig): Promise<MenuConfig> {
  return (await http<{ config: MenuConfig }>(`${BASE}/me`, { method: 'PUT', body: JSON.stringify({ config: cfg }) })).config;
}
