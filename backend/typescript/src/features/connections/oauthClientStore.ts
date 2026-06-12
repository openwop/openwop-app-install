/**
 * Host-managed OAuth *client* credentials (ADR 0024 § host-managed OAuth client
 * config). Lets a superadmin operator configure each provider's OAuth app
 * (client id + secret) through the admin UI instead of `OPENWOP_OAUTH_*` env
 * vars — so adding Google / Slack is self-service, no redeploy.
 *
 * Boundary discipline:
 *  - The non-secret metadata (clientId, updatedAt/By) lives in a per-entity
 *    DurableCollection row keyed by provider.
 *  - The client SECRET is sealed with the BYOK envelope (`sealHostSecret`,
 *    AES-256-GCM, host-global — NOT the tenant-scoped setSecret) and stored as
 *    the row's `secret` ciphertext. Plaintext never lands in our store, and is
 *    NEVER returned on any read surface (only `getHostOAuthClient`, the internal
 *    resolver, decrypts it).
 *  - This is host-global config: one row per provider, no tenant axis.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { sealHostSecret, openHostSecret } from '../../byok/secretResolver.js';
import type { EncryptedRecord } from '../../byok/encryption.js';

interface OAuthClientRecord {
  provider: string;
  clientId: string;
  /** The client secret, sealed with the BYOK master key. Never returned. */
  secret: EncryptedRecord;
  updatedAt: string;
  updatedBy?: string;
}

/** What a read surface may expose — metadata + `configured: true`, NEVER the secret. */
export interface OAuthClientConfigSummary {
  provider: string;
  clientId: string;
  configured: true;
  updatedAt: string;
  updatedBy?: string;
}

const store = new DurableCollection<OAuthClientRecord>('connections:oauth-client', (r) => r.provider);

/** Upsert a provider's host OAuth client (idempotent — keyed by provider id). */
export async function setHostOAuthClient(input: {
  provider: string;
  clientId: string;
  clientSecret: string;
  updatedBy?: string;
}): Promise<void> {
  const record: OAuthClientRecord = {
    provider: input.provider,
    clientId: input.clientId,
    secret: sealHostSecret(input.clientSecret),
    updatedAt: new Date().toISOString(),
    ...(input.updatedBy ? { updatedBy: input.updatedBy } : {}),
  };
  await store.put(record);
}

/**
 * Resolve the host-configured OAuth client for a provider, or `null`.
 * Fails CLOSED: a decrypt failure (corruption / rotated master key) returns
 * `null` so the provider falls back to env / reads as unconfigured — never a
 * thrown 500 mid-authorize.
 */
export async function getHostOAuthClient(
  provider: string,
): Promise<{ clientId: string; clientSecret: string } | null> {
  const record = await store.get(provider);
  if (!record) return null;
  try {
    return { clientId: record.clientId, clientSecret: openHostSecret(record.secret) };
  } catch {
    return null;
  }
}

/** List configured providers as metadata summaries — the secret is never included. */
export async function listHostOAuthClients(): Promise<OAuthClientConfigSummary[]> {
  return (await store.list()).map((r) => ({
    provider: r.provider,
    clientId: r.clientId,
    configured: true as const,
    updatedAt: r.updatedAt,
    ...(r.updatedBy ? { updatedBy: r.updatedBy } : {}),
  }));
}

/** Remove a provider's host OAuth client. Returns whether it existed. After
 *  this the provider falls back to env vars (or reads as unconfigured). */
export async function deleteHostOAuthClient(provider: string): Promise<boolean> {
  return store.delete(provider);
}

/** Test-only: clear the store. */
export async function __resetOAuthClientStore(): Promise<void> {
  await store.__clear();
}
