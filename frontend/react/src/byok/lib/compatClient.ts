/**
 * Compat (self-hosted / OpenAI-compatible) endpoint client — RFC 0108 + ADR 0121.
 * Wraps the host-extension `/v1/host/openwop-app/compat-endpoints` surface (config
 * that rides the BYOK/Connections area, NOT a feature-package).
 *
 * The whole surface 404s when the operator opt-in `OPENWOP_COMPAT_PROVIDER_ENABLED`
 * is off — `listCompatEndpoints` returns null in that case so the card hides.
 *
 * §D: `baseUrl` is owner-private (returned only to the owning org over this authed
 * route); the stored key is NEVER returned (only `hasKey`).
 *
 * @see docs/adr/0121-local-model-provider-support.md
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface CompatCapabilities { vision: boolean; tools: boolean; longContext: boolean }

export interface CompatEndpointView {
  id: string;
  orgId: string;
  label: string;
  baseUrl: string;
  hasKey: boolean;
  capabilities: CompatCapabilities;
  models?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CompatCreateInput {
  orgId: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  capabilities?: Partial<CompatCapabilities>;
  models?: string[];
}

const BASE = `${config.baseUrl}/v1/host/openwop-app/compat-endpoints`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/** An error carrying the HTTP status, so callers can branch on 403 (no scope) etc. */
export interface CompatHttpError extends Error { status: number }

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw Object.assign(new Error(detail || `${ctx} returned ${res.status}`), { status: res.status });
  }
  return (await res.json()) as T;
}

/** List the org's configured compat endpoints. Returns null when the surface is
 *  disabled for the deployment (404 — operator opt-in off). */
export async function listCompatEndpoints(orgId: string): Promise<CompatEndpointView[] | null> {
  const res = await fetch(`${BASE}?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ headers: authedHeaders() }));
  if (res.status === 404) return null;
  return (await asJson<{ endpoints: CompatEndpointView[] }>(res, 'listCompatEndpoints')).endpoints;
}

/** Create a compat endpoint (server SSRF-validates the base URL + stores the key via BYOK). */
export async function createCompatEndpoint(input: CompatCreateInput): Promise<CompatEndpointView> {
  const res = await fetch(BASE, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<CompatEndpointView>(res, 'createCompatEndpoint');
}

/** Delete a compat endpoint (and its stored key). */
export async function deleteCompatEndpoint(id: string): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) throw new Error(`deleteCompatEndpoint returned ${res.status}`);
}
