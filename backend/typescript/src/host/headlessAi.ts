/**
 * Headless AI provider resolution (ADR 0110) — the single owner of "which provider
 * does a HEADLESS (no user-selected provider) operation dispatch to?".
 *
 * Headless ops (KB media → text: image OCR + audio transcription) run outside a
 * conversation, so they have no `run.inputs.{provider,model,credentialRef}`. They
 * default to the host MANAGED provider — but the reference host's managed target is
 * MiniMax (text-only), so media → text needs a multimodal model. This module lets a
 * tenant bind an optional default `{provider, model, credentialRef}` (a pointer into
 * their BYOK store) and resolves a capability-aware, cost-ordered dispatch:
 *   managed-if-capable  →  tenant BYOK default-if-capable  →  null (caller 422s).
 *
 * REPLAY: `resolveHeadlessAi` dispatches a LIVE, non-deterministic provider call —
 * it MUST NOT be used inside a recorded workflow run (no run to fork). Its only
 * caller is `kbService.mediaToTextViaLLM`, which is reached solely on non-recorded
 * service paths (ADR 0108 review). SR-1: the resolved key is captured INSIDE the
 * returned closure and never escapes this module in a return value/event/log.
 *
 * @see docs/adr/0110-headless-ai-provider-default.md
 */

import { DurableCollection } from './hostExtPersistence.js';
import { OpenwopError } from '../types.js';
import { resolveSecret, listSecretRefs, type SecretScope } from '../byok/secretResolver.js';
import {
  dispatchManagedChat, managedProviderIdFromRef, managedUnderlyingProvider, MANAGED_FREE_REF,
} from '../providers/managedProvider.js';
import { dispatchChat, type ChatMessage, type ProviderId } from '../providers/dispatch.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.headlessAi');

/** Dispatch providers a headless default may bind to (must be real `dispatchChat` providers). */
export const HEADLESS_PROVIDERS = ['anthropic', 'openai', 'google'] as const;
export type HeadlessProvider = (typeof HEADLESS_PROVIDERS)[number];

export interface HeadlessAiDefault {
  tenantId: string;
  provider: HeadlessProvider;
  model: string;
  /** A pointer into the tenant's BYOK store — NOT the key. Resolved host-side at dispatch. */
  credentialRef: string;
  updatedBy: string;
  updatedAt: string;
}

/**
 * INTERNAL media-input-modality map — does a provider's chat-parts path accept image /
 * audio input? Deliberately SEPARATE from `modelCapabilityProbe` / the RFC 0031 advertised
 * capability vocabulary (that gates envelope/tool-use behavior; this is an input-modality
 * axis), so it never touches the normative wire. Conservative — `audio: true` only where
 * `dispatch`'s inline-audio path is verified (Gemini). `minimax` (the managed target) is
 * text-only ⇒ media always needs a BYOK default.
 */
const MEDIA_MODALITY: Readonly<Record<string, { image: boolean; audio: boolean }>> = {
  google: { image: true, audio: true },
  anthropic: { image: true, audio: false },
  openai: { image: true, audio: false },
  minimax: { image: false, audio: false },
};

const MODEL_MAX = 100;
const REF_PATTERN = /^[a-zA-Z0-9_.\-:]{1,128}$/;

const defaults = new DurableCollection<HeadlessAiDefault>('host:headlessAiDefault', (d) => d.tenantId);

/** The tenant's headless AI default, or null if unset. */
export async function getHeadlessAiDefault(tenantId: string): Promise<HeadlessAiDefault | null> {
  return (await defaults.get(tenantId)) ?? null;
}

/**
 * Set the tenant's headless AI default. Validates provider/model AND that `credentialRef`
 * already EXISTS + RESOLVES in the caller's own BYOK scope — so the binding can't point at
 * another tenant's secret (IDOR) or at an ephemeral/expired key that would silently fail at
 * use (ADR 0110 review). The key value is never stored here, only the ref.
 */
export async function setHeadlessAiDefault(
  scope: SecretScope,
  input: { provider?: unknown; model?: unknown; credentialRef?: unknown },
  now: string,
): Promise<HeadlessAiDefault> {
  if (typeof input.provider !== 'string' || !(HEADLESS_PROVIDERS as readonly string[]).includes(input.provider)) {
    throw new OpenwopError('validation_error', `provider MUST be one of: ${HEADLESS_PROVIDERS.join(', ')}.`, 400, { field: 'provider' });
  }
  if (typeof input.model !== 'string' || input.model.trim().length === 0 || input.model.length > MODEL_MAX) {
    throw new OpenwopError('validation_error', `model MUST be a non-empty string ≤ ${MODEL_MAX} chars.`, 400, { field: 'model' });
  }
  if (typeof input.credentialRef !== 'string' || !REF_PATTERN.test(input.credentialRef)) {
    throw new OpenwopError('validation_error', 'credentialRef MUST match [a-zA-Z0-9_.-:]{1,128}.', 400, { field: 'credentialRef' });
  }
  // The ref must be one of THIS tenant's stored secrets (scope-bounded) and must resolve now
  // (rejects ephemeral/expired refs up front rather than failing silently at dispatch).
  const refs = await listSecretRefs(scope);
  if (!refs.includes(input.credentialRef)) {
    throw new OpenwopError('validation_error', 'credentialRef is not a stored BYOK secret for this workspace.', 400, { field: 'credentialRef' });
  }
  if (!(await resolveSecret(input.credentialRef, scope))) {
    throw new OpenwopError('validation_error', 'credentialRef does not currently resolve to a usable key.', 400, { field: 'credentialRef' });
  }
  const row: HeadlessAiDefault = {
    tenantId: scope.tenantId,
    provider: input.provider as HeadlessProvider,
    model: input.model.trim(),
    credentialRef: input.credentialRef,
    updatedBy: scope.actorId ?? 'unknown',
    updatedAt: now,
  };
  await defaults.put(row);
  return row;
}

/** Clear the tenant's headless AI default. */
export async function clearHeadlessAiDefault(tenantId: string): Promise<void> {
  await defaults.delete(tenantId);
}

/** A ready-to-call headless dispatch — the resolved key is captured inside; it never escapes. */
export type HeadlessDispatch = (messages: readonly ChatMessage[], opts: { maxTokens: number; timeoutMs?: number }) => Promise<string>;

export type HeadlessModality = 'image' | 'audio' | 'text';

/** Every chat provider handles `text`; `image`/`audio` are gated by the media-modality map. */
function providerSupports(provider: string, modality: HeadlessModality): boolean {
  return modality === 'text' ? true : (MEDIA_MODALITY[provider]?.[modality] ?? false);
}

/**
 * Resolve a dispatch for a headless op needing `modality` input, cost-ordered:
 *   1. managed (cheapest) if its underlying provider supports the modality;
 *   2. else the tenant's BYOK default if its provider supports the modality AND the key resolves;
 *   3. else null ⇒ the caller surfaces an honest 422.
 * Returns a CLOSURE so the apiKey never leaves this module (SR-1). For `text` the managed
 * provider always qualifies, so it behaves exactly like the prior hardcoded managed dispatch
 * plus a BYOK fallback if the managed text call is unavailable.
 */
export async function resolveHeadlessAi(tenantId: string, modality: HeadlessModality): Promise<HeadlessDispatch | null> {
  const managedProvider = managedUnderlyingProvider(MANAGED_FREE_REF);
  if (managedProvider && providerSupports(managedProvider, modality)) {
    return async (messages, opts) => {
      const r = await dispatchManagedChat({ userFacingProvider: managedProviderIdFromRef(MANAGED_FREE_REF), tenantId, messages: messages as ChatMessage[], maxTokens: opts.maxTokens, ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}) });
      return r.completion ?? '';
    };
  }
  const def = await getHeadlessAiDefault(tenantId);
  if (def && providerSupports(def.provider, modality)) {
    const apiKey = await resolveSecret(def.credentialRef, { tenantId });
    if (apiKey) {
      const { provider, model } = def;
      return async (messages, opts) => {
        const r = await dispatchChat({ provider: provider as ProviderId, model, apiKey, messages: messages as ChatMessage[], maxTokens: opts.maxTokens, ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}) });
        return r.completion ?? '';
      };
    }
    log.warn('headless_ai_default_ref_unresolved', { tenantId }); // ephemeral/expired — fall through to null
  }
  return null;
}
