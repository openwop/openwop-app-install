/**
 * Free-tier provider setting client (ADR 0990, host-extension, superadmin only).
 *
 * Wraps /host/openwop-app/managed-tier/settings: which provider and model the
 * free tier runs on, which providers have a key, and a test message for a
 * candidate. No call sends or receives a key; keys live in the Secrets Vault.
 *
 * @see ../../../backend/typescript/src/features/managed-tier-admin/routes.ts
 */
import { authedHeaders, config, fetchOpts } from './config.js';
import { readErrorMessage } from './errorEnvelope.js';

export type ManagedTierProvider = 'minimax' | 'anthropic' | 'openai' | 'google';

export interface ManagedTierConfig {
  id: 'default';
  provider: string;
  model: string;
  dailyTokenCap: number | null;
  updatedAt?: string;
  updatedBy?: string;
}

export interface ManagedTierProviderOption {
  provider: ManagedTierProvider;
  ready: boolean;
  keySource: 'vault' | 'env' | null;
  vaultRef: string;
  envKeyName: string;
  defaultModel: string;
}

export interface ManagedTierView {
  config: ManagedTierConfig | null;
  effective: {
    provider: string | null;
    model: string | null;
    source: 'setting' | 'env' | 'default' | null;
    ready: boolean;
  };
  providers: ManagedTierProviderOption[];
  vaultUsable: boolean;
}

export interface ManagedTierInput {
  provider: ManagedTierProvider;
  model: string;
  dailyTokenCap: number | null;
}

export type ManagedTierTestResult =
  | { ok: true; provider: string; model: string; latencyMs: number; reply: string }
  | { ok: false; provider: string; model: string; code: string; message: string };

const base = `${config.baseUrl}/host/openwop-app/managed-tier/settings`;

async function readOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    throw new Error(readErrorMessage(body) ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function getManagedTierSettings(): Promise<ManagedTierView> {
  return readOrThrow(await fetch(base, fetchOpts({ headers: authedHeaders() })));
}

export async function saveManagedTierSettings(input: ManagedTierInput): Promise<ManagedTierView> {
  return readOrThrow(await fetch(base, fetchOpts({
    method: 'PUT',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(input),
  })));
}

export async function clearManagedTierSettings(): Promise<ManagedTierView> {
  return readOrThrow(await fetch(base, fetchOpts({ method: 'DELETE', headers: authedHeaders() })));
}

export async function testManagedTierCandidate(input: Pick<ManagedTierInput, 'provider' | 'model'>): Promise<ManagedTierTestResult> {
  return readOrThrow(await fetch(`${base}/test`, fetchOpts({
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(input),
  })));
}
