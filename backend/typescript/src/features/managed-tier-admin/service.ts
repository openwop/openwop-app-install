/**
 * ADR 0990 — free-tier provider setting service.
 *
 * One durable row (`hostext:managed-tier:default`). `readForCore` is the seam
 * provider the core resolver consults; a save invalidates this instance's memo
 * so the next call uses the new provider, and every other instance follows
 * within the core memo's window. No redeploy.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import {
  describeManagedTierProviders,
  effectiveManagedTierSelection,
  getManagedProviderStatuses,
  invalidateManagedTierSelection,
  isManagedUnderlying,
  MANAGED_UNDERLYING_PROVIDERS,
  refreshManagedTierSelection,
  type ManagedTierSelection,
} from '../../providers/managedProvider.js';
import type { ManagedTierConfig, ManagedTierView } from './types.js';

const store = new DurableCollection<ManagedTierConfig>('managed-tier', (c) => c.id);
const SINGLETON_ID = 'default' as const;

/** The model-id shape the chat binding accepts: no spaces or control characters. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const MAX_DAILY_CAP = 100_000_000;

export async function readForCore(): Promise<ManagedTierSelection | null> {
  const row = await store.get(SINGLETON_ID);
  if (!row) return null;
  return { provider: row.provider, model: row.model, dailyTokenCap: row.dailyTokenCap };
}

export function validateConfig(body: unknown): ManagedTierConfig {
  const fail = (msg: string, field: string): never => { throw new OpenwopError('validation_error', msg, 422, { field }); };
  if (typeof body !== 'object' || body === null) return fail('Body must be an object.', 'body');
  const b = body as Record<string, unknown>;
  if (!isManagedUnderlying(b.provider)) fail(`\`provider\` must be one of: ${MANAGED_UNDERLYING_PROVIDERS.join(', ')}.`, 'provider');
  const model = typeof b.model === 'string' ? b.model.trim() : '';
  if (!MODEL_PATTERN.test(model)) fail('`model` must be a model id (letters, digits and . _ : @ / -, up to 128 characters).', 'model');
  let dailyTokenCap: number | null = null;
  if (b.dailyTokenCap != null && b.dailyTokenCap !== '') {
    const n = Number(b.dailyTokenCap);
    if (!Number.isInteger(n) || n < 1 || n > MAX_DAILY_CAP) fail(`\`dailyTokenCap\` must be a whole number from 1 to ${MAX_DAILY_CAP}, or empty to use the server default.`, 'dailyTokenCap');
    dailyTokenCap = n;
  }
  return { id: SINGLETON_ID, provider: b.provider as string, model, dailyTokenCap };
}

/** D3 — refuse a provider with no key, so a save can never switch the free tier
 *  off by accident. */
export async function saveConfig(config: ManagedTierConfig, savedBy: string): Promise<ManagedTierConfig> {
  const option = (await describeManagedTierProviders()).find((p) => p.provider === config.provider);
  if (!option?.ready) {
    throw new OpenwopError('conflict', `There is no key for ${config.provider}. Add ${option?.vaultRef ?? 'it'} in the Secrets Vault (Host-global) first.`, 409, { reason: 'managed_key_missing', provider: config.provider });
  }
  const next: ManagedTierConfig = { ...config, updatedAt: new Date().toISOString(), updatedBy: savedBy };
  await store.put(next);
  invalidateManagedTierSelection();
  return next;
}

/** Remove the setting: the free tier returns to the env default. */
export async function clearConfig(): Promise<void> {
  await store.delete(SINGLETON_ID);
  invalidateManagedTierSelection();
}

export async function getView(): Promise<ManagedTierView> {
  await refreshManagedTierSelection(true);
  const [config, providers, statuses] = await Promise.all([
    store.get(SINGLETON_ID),
    describeManagedTierProviders(),
    getManagedProviderStatuses(),
  ]);
  const selection = effectiveManagedTierSelection();
  return {
    config: config ?? null,
    effective: {
      provider: selection?.provider ?? null,
      model: selection?.model ?? null,
      source: selection?.source ?? null,
      ready: statuses.find((s) => s.providerId === 'openwop-free')?.ready ?? false,
    },
    providers,
    vaultUsable: process.env.OPENWOP_BYOK_EPHEMERAL !== 'true',
  };
}
