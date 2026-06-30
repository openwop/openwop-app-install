/**
 * Tenant-wide real-time voice config (ADR 0141) — which realtime provider the workspace
 * uses + the BYOK `credentialRef` for it. Admin-set; `off` (default) → the ADR 0138
 * walkie-talkie fallback. The BYOK secret value lives in the secret store (ADR 0024); this
 * record holds only the opaque `credentialRef`.
 */
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import type { RealtimeProvider, RealtimeProviderId } from './types.js';
import { openaiRealtimeProvider } from './openaiRealtime.js';
import { geminiLiveProvider } from './geminiLive.js';

export interface TenantRealtimeConfig {
  tenantId: string;
  provider: RealtimeProviderId | 'off';
  credentialRef?: string;
  /** Optional model override; the adapter's default is used when unset. */
  model?: string;
  updatedAt: string;
}

const PROVIDERS: Record<RealtimeProviderId, RealtimeProvider> = {
  'openai-realtime': openaiRealtimeProvider,
  'gemini-live': geminiLiveProvider,
};

export function realtimeProvider(id: RealtimeProviderId): RealtimeProvider {
  return PROVIDERS[id];
}

const configs = new DurableCollection<TenantRealtimeConfig>('voice:realtime-config', (c) => c.tenantId);

/** The tenant's realtime config (point-get). Defaults to `off`. */
export async function getRealtimeConfig(tenantId: string): Promise<TenantRealtimeConfig> {
  return (await configs.get(tenantId)) ?? { tenantId, provider: 'off', updatedAt: new Date(0).toISOString() };
}

export interface SetRealtimeConfigInput {
  provider: RealtimeProviderId | 'off';
  credentialRef?: string;
  model?: string;
}

export async function setRealtimeConfig(tenantId: string, input: SetRealtimeConfigInput): Promise<TenantRealtimeConfig> {
  const config: TenantRealtimeConfig = {
    tenantId,
    provider: input.provider,
    ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
    ...(input.model ? { model: input.model } : {}),
    updatedAt: new Date().toISOString(),
  };
  await configs.put(config);
  return config;
}
