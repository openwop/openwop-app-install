/**
 * Thin wrapper around the BE's /v1/host/openwop-app/byok/secrets routes.
 *
 * Routes through the shared `requestJson` helper so auth, credentials, JSON
 * parsing, and structured ApiError handling are consistent with the rest of
 * the client layer (no string-parsed status codes).
 */

import { requestJson } from '../../client/requestJson.js';

const SECRETS_PATH = '/v1/host/openwop-app/byok/secrets';

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

// ── Headless AI default (ADR 0110) — the tenant binding used for media OCR/transcription
// when the managed provider isn't multimodal. Points at one of the stored credentialRefs.
const AI_DEFAULT_PATH = '/v1/host/openwop-app/byok/ai-default';

export interface HeadlessAiDefault {
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
  credentialRef: string;
}

export async function getAiDefault(): Promise<HeadlessAiDefault | null> {
  const body = await requestJson<{ default: HeadlessAiDefault | null }>(AI_DEFAULT_PATH, {
    guard: (v): v is { default: HeadlessAiDefault | null } => !!v && typeof v === 'object' && 'default' in v,
  });
  return body.default;
}

export async function setAiDefault(input: HeadlessAiDefault): Promise<HeadlessAiDefault> {
  const body = await requestJson<{ default: HeadlessAiDefault }>(AI_DEFAULT_PATH, { method: 'PUT', json: input });
  return body.default;
}

export async function clearAiDefault(): Promise<void> {
  await requestJson<unknown>(AI_DEFAULT_PATH, { method: 'DELETE', okStatuses: [404] });
}
