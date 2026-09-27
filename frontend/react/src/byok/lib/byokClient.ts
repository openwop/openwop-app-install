/**
 * Thin wrapper around the BE's /host/openwop-app/byok/secrets routes.
 *
 * Routes through the shared `requestJson` helper so auth, credentials, JSON
 * parsing, and structured ApiError handling are consistent with the rest of
 * the client layer (no string-parsed status codes).
 */

import { requestJson } from '../../client/requestJson.js';

const SECRETS_PATH = '/host/openwop-app/byok/secrets';

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

// ── Active chat binding (ADR 0517) ───────────────────────────────────────────
// The tenant's {provider, model, credentialRef} for the AI chat. This used to be
// browser-only localStorage; it is now a durable per-tenant row, so the pointer
// follows the ACCOUNT rather than the browser profile. `valid` and `anonymous`
// are server-computed on purpose — the SPA inferring validity from a ref list is
// exactly what re-prompted users whose keys were fine.
const ACTIVE_CONFIG_PATH = '/host/openwop-app/byok/active-config';

export interface ActiveConfigEnvelope {
  config: { provider: string; model: string; credentialRef: string } | null;
  /** Server's verdict on whether the binding can actually dispatch right now. */
  valid: boolean;
  /** True when the calling session is an `anon:` tenant — i.e. signed out. A null
   *  `config` means "logged out", not "no key", and the two need different UI. */
  anonymous: boolean;
  /** ADR 0711 option B — whether this binding was CHOSEN (a stored row) or is the
   *  effective managed default the host would dispatch on anyway. The SPA must not
   *  present the second as a user's selection, and must never cache it as one.
   *  Optional so an older server (which omits it) reads as "stored", the prior
   *  behaviour, rather than as a default. */
  stored?: boolean;
}

/** ADR 0711 — a 403 on a BYOK write means the workspace reserves this to operators.
 *  Distinguished from a generic failure so the UI can say WHICH, rather than
 *  surfacing a raw error the way it did when the gate first shipped. */
export class ByokForbiddenError extends Error {
  readonly forbidden = true;
  constructor() { super('byok-forbidden'); this.name = 'ByokForbiddenError'; }
}

function isActiveConfigEnvelope(v: unknown): v is ActiveConfigEnvelope {
  if (!v || typeof v !== 'object') return false;
  const e = v as Partial<ActiveConfigEnvelope>;
  return 'config' in e && typeof e.valid === 'boolean' && typeof e.anonymous === 'boolean';
}

export async function getActiveConfig(): Promise<ActiveConfigEnvelope> {
  return requestJson<ActiveConfigEnvelope>(ACTIVE_CONFIG_PATH, { guard: isActiveConfigEnvelope });
}

export async function putActiveConfig(input: {
  provider: string; model: string; credentialRef: string;
}): Promise<ActiveConfigEnvelope> {
  try {
    return await requestJson<ActiveConfigEnvelope>(ACTIVE_CONFIG_PATH, {
      method: 'PUT',
      json: input,
      guard: isActiveConfigEnvelope,
    });
  } catch (e) {
    // ADR 0711 C gated this route to operators. Before this branch a plain member's
    // "Try it free" surfaced as an unexplained failure — the 400 the gate replaced was
    // at least legible. Translate it once, here, so every caller inherits the same copy.
    if (e && typeof e === 'object' && (e as { status?: number }).status === 403) throw new ByokForbiddenError();
    throw e;
  }
}

export async function clearActiveConfig(): Promise<void> {
  await requestJson<unknown>(ACTIVE_CONFIG_PATH, { method: 'DELETE', okStatuses: [404] });
}

// ── Headless AI default (ADR 0110) — the tenant binding used for media OCR/transcription
// when the managed provider isn't multimodal. Points at one of the stored credentialRefs.
const AI_DEFAULT_PATH = '/host/openwop-app/byok/ai-default';

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

// ── RFC 0121 AT-OWN-RISK subscription credential (ADR 0180) ──────────────────
// Binds a user-scoped subscription credential via the §B.8 scope-safety bind
// seam. `acknowledgedRisk` is sent ONLY after the user explicitly acknowledges
// the ToS / account-suspension risk. The value stays on the host (never echoed).
const CREDENTIALS_BIND_PATH = '/host/openwop-app/credentials/bind';

export async function bindSubscriptionCredential(input: {
  provider: string;
  value: string;
  acknowledgedRisk: boolean;
}): Promise<{ bound: boolean; scope: string; credentialRef: string }> {
  return requestJson<{ bound: boolean; scope: string; credentialRef: string }>(CREDENTIALS_BIND_PATH, {
    method: 'POST',
    json: { provider: input.provider, mode: 'subscription', scope: 'user', acknowledgedRisk: input.acknowledgedRisk, value: input.value },
  });
}

// ── RFC 0121 CLEARED provider: GitHub Copilot connect (ADR 0757) ─────────────
// The token is minted by GitHub's OAuth flow and stored host-side at the caller's
// personal user scope; the SPA only navigates to the consent URL and never sees it.
const COPILOT_BASE = '/host/openwop-app/subscription/github.copilot';

export async function connectCopilot(returnTo: string): Promise<{ authorizeUrl: string }> {
  return requestJson<{ authorizeUrl: string }>(`${COPILOT_BASE}/authorize`, { method: 'POST', json: { returnTo } });
}

export async function disconnectCopilot(): Promise<{ disconnected: boolean }> {
  return requestJson<{ disconnected: boolean }>(`${COPILOT_BASE}/disconnect`, { method: 'POST', json: {} });
}
