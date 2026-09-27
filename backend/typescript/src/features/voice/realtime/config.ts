/**
 * Tenant-wide real-time voice config (ADR 0141) — which realtime provider the workspace
 * uses + the BYOK `credentialRef` for it. Admin-set; `off` (default) → the ADR 0138
 * walkie-talkie fallback. The BYOK secret value lives in the secret store (ADR 0024); this
 * record holds only the opaque `credentialRef`.
 */
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { registerCredentialRefConsumer } from '../../../host/credentialRefRegistry.js';
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

// ADR 0499 — THE config that went dangling in production: this row kept naming
// `google:myndhyve-key` for a month after that secret was replaced, and live
// voice 400'd at mint time with nothing tying it back to the vault edit. The
// retired hand-kept consumer list never knew this store existed.
registerCredentialRefConsumer({
  id: 'voice:realtime-config',
  async describe(tenantId, ref) {
    const row = await configs.get(tenantId);
    return row?.credentialRef === ref ? [`realtime voice provider (${row.provider})`] : [];
  },
});

/**
 * ADR 0322 — the BYOK credential + provider the WALKIE/board path should use for
 * host STT (`callTranscriber`) and TTS (`callSpeechSynthesizer`), derived from the
 * tenant's realtime voice config. The realtime BYOK key is the SAME key those
 * managed dispatchers accept: `gemini-live` → the `google` provider (Gemini API
 * key, used by both Gemini Live AND generateContent/TTS), `openai-realtime` → the
 * `openai` provider (Whisper + TTS). So a tenant with realtime voice configured
 * gets working board transcription + spoken replies on their existing key — with
 * NO managed STT/TTS key on the host. Null when unconfigured (→ honest-unsupported).
 */
export function walkieProviderCredential(config: TenantRealtimeConfig): { provider: string; credentialRef: string } | null {
  if (!config.credentialRef) return null;
  const provider = config.provider === 'gemini-live' ? 'google'
    : config.provider === 'openai-realtime' ? 'openai'
      : null;
  return provider ? { provider, credentialRef: config.credentialRef } : null;
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
