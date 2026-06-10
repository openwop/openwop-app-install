/**
 * Thin wrapper around the BE's /v1/host/sample/byok/secrets routes.
 *
 * Routes through the shared `requestJson` helper so auth, credentials, JSON
 * parsing, and structured ApiError handling are consistent with the rest of
 * the client layer (no string-parsed status codes).
 */

import { requestJson } from '../../client/requestJson.js';

const SECRETS_PATH = '/v1/host/sample/byok/secrets';

export async function listStoredRefs(): Promise<readonly string[]> {
  const body = await requestJson<{ credentialRefs: string[] }>(SECRETS_PATH, {
    guard: (v): v is { credentialRefs: string[] } =>
      !!v && typeof v === 'object' && Array.isArray((v as { credentialRefs?: unknown }).credentialRefs),
  });
  return body.credentialRefs;
}

export async function storeKey(credentialRef: string, value: string): Promise<{ credentialRef: string; masked: string }> {
  return requestJson<{ credentialRef: string; masked: string }>(SECRETS_PATH, {
    method: 'POST',
    json: { credentialRef, value },
  });
}

export async function deleteKey(credentialRef: string): Promise<void> {
  await requestJson<unknown>(`${SECRETS_PATH}/${encodeURIComponent(credentialRef)}`, {
    method: 'DELETE',
    okStatuses: [404],
  });
}
