/**
 * The tenant's ACTIVE chat BYOK binding (ADR 0517) — which
 * `{provider, model, credentialRef}` does this workspace's AI chat dispatch to?
 *
 * WHY THIS EXISTS. The binding used to live ONLY in the browser, under a bare
 * `localStorage` key (`openwop-app.byok.activeConfig`). The stored KEY was durable
 * and tenant-scoped on the server; the POINTER to it was not. Any of the routine
 * ways a browser loses `localStorage` — a second browser or profile, private
 * browsing, cleared site data, Safari ITP's 7-day eviction — dropped the pointer
 * while the key sat perfectly intact server-side. The chat then showed the
 * first-run BYOK wizard, the user re-entered the same key, and (because the ref
 * was minted `byok:<provider>:${Date.now()}`) a BRAND-NEW secret row was created
 * rather than the existing one re-bound. One real workspace accumulated SEVEN
 * `byok:google:*` rows over five weeks that way — the defect this module closes.
 *
 * The pointer now lives where the key lives: a per-tenant durable row. The browser
 * keeps a copy only as a first-paint cache; the server is the authority.
 *
 * SECURITY. This stores a credentialRef — a NAME, never a key value. `setChatByokConfig`
 * refuses a ref that is not already a stored secret in the CALLER's own scope, so the
 * binding can never point at another tenant's secret (the IDOR guard `headlessAi.ts`
 * established) and can never be saved pointing at a key that no longer resolves.
 *
 * @see docs/adr/0517-byok-active-config-durability.md
 */

import { DurableCollection } from './hostExtPersistence.js';
import { OpenwopError } from '../types.js';
import { listSecretRefs, resolveSecret, type SecretScope } from '../byok/secretResolver.js';
import { registerCredentialRefConsumer } from './credentialRefRegistry.js';
import { createLogger } from '../observability/logger.js';
import { managedProviderIdFromRef, managedUnderlyingProvider } from '../providers/managedProvider.js';
import { COPILOT_PROVIDER_ID, copilotSubscriptionConfigured } from '../aiProviders/copilotSubscription.js';
import { resolveSubscriptionCredential, subscriptionCredentialRef } from '../byok/subscriptionCredential.js';

/** Providers a chat binding may name. Mirrors the SPA's `byok/lib/providers.ts`
 *  ids; a managed binding carries the `managed:` sentinel ref instead of a stored one. */
export const CHAT_BYOK_PROVIDERS = ['anthropic', 'openai', 'google', 'minimax'] as const;
/** ADR 0757 follow-up — the RFC 0121 CLEARED subscription provider a chat may bind.
 *  Not a BYOK key provider: its credential is the user's OAuth-connected
 *  `subscription:github.copilot` token, validated below by its own rule. */
export const CHAT_SUBSCRIPTION_PROVIDERS = [COPILOT_PROVIDER_ID] as const;
export type ChatByokProvider = (typeof CHAT_BYOK_PROVIDERS)[number] | (typeof CHAT_SUBSCRIPTION_PROVIDERS)[number];

export interface ChatByokConfig {
  tenantId: string;
  provider: ChatByokProvider;
  model: string;
  /** A pointer into the tenant's BYOK store, or a `managed:<provider>` sentinel.
   *  NEVER a key value. */
  credentialRef: string;
  updatedAt: string;
}

const MODEL_MAX = 100;
const REF_PATTERN = /^[a-zA-Z0-9_.\-:]{1,128}$/;

/** The managed-provider sentinel prefix. A managed binding names no stored secret —
 *  the key lives host-side under a synthetic admin tenant (`managedProvider.ts`), so
 *  the stored-ref existence check below MUST NOT be applied to it. */
const MANAGED_PREFIX = 'managed:';

export function isManagedRef(ref: string): boolean {
  return ref.startsWith(MANAGED_PREFIX);
}

const log = createLogger('host.chatByokConfig');

const configs = new DurableCollection<ChatByokConfig>('host:chatByokConfig', (c) => c.tenantId);

/** The tenant's active chat binding, or null if unset. */
export async function getChatByokConfig(tenantId: string): Promise<ChatByokConfig | null> {
  return (await configs.get(tenantId)) ?? null;
}

// ADR 0499 — this store holds a credentialRef, so deleting the underlying secret
// must SEE the binding rather than silently orphaning the chat. Registering here
// is what makes `DELETE /byok/secrets/:ref` refuse (409) while the chat still
// points at it, exactly as the realtime-voice binding does.
registerCredentialRefConsumer({
  id: 'host:chatByokConfig',
  async describe(tenantId, ref) {
    const row = await configs.get(tenantId);
    return row?.credentialRef === ref
      ? [`active chat binding (${row.provider}${row.model ? `/${row.model}` : ''})`]
      : [];
  },
});

/**
 * Set the tenant's active chat binding.
 *
 * Validates that `credentialRef` already EXISTS and RESOLVES in the caller's own
 * BYOK scope, so a binding can never be persisted pointing at another tenant's
 * secret or at a key that would fail at first dispatch. Managed sentinels skip the
 * stored-secret check (they name no stored row) but are still shape-validated.
 */
export async function setChatByokConfig(
  scope: SecretScope,
  input: { provider?: unknown; model?: unknown; credentialRef?: unknown },
  now: string,
): Promise<ChatByokConfig> {
  // A MANAGED binding arrives from the SPA's wizard as the managed tile's own id
  // (`provider: 'openwop-free', credentialRef: 'managed:openwop-free'`): providers.json
  // deliberately hides the underlying provider from the browser, so the wizard cannot
  // send `minimax`. Resolve it here to the dispatch provider the managed target runs
  // on. Before this, the wizard's "Try it free" activation was refused 400 on every
  // workspace, and a shared workspace (kicktodo.com, 2026-09-16) could only reach the
  // managed tier through a hand-written binding.
  if (
    typeof input.provider === 'string'
    && typeof input.credentialRef === 'string'
    && isManagedRef(input.credentialRef)
    && input.provider === managedProviderIdFromRef(input.credentialRef)
  ) {
    const underlying = managedUnderlyingProvider(input.credentialRef);
    if (underlying && (CHAT_BYOK_PROVIDERS as readonly string[]).includes(underlying)) {
      input = { ...input, provider: underlying };
    }
  }
  // ADR 0757 follow-up — a GitHub Copilot binding names the user's OAuth-connected
  // subscription token, not a stored BYOK key. It is accepted only when the host
  // actually serves Copilot (RFC 0121 §B.9) AND the connected token resolves in THIS
  // tenant — the connect flow stores it in the user's personal workspace, so a
  // shared workspace cannot bind it (dispatch would fail closed there anyway).
  if (input.provider === COPILOT_PROVIDER_ID) {
    return setCopilotChatBinding(scope, input, now);
  }
  if (typeof input.provider !== 'string' || !(CHAT_BYOK_PROVIDERS as readonly string[]).includes(input.provider)) {
    throw new OpenwopError('validation_error', `provider MUST be one of: ${CHAT_BYOK_PROVIDERS.join(', ')}.`, 400, { field: 'provider' });
  }
  if (typeof input.model !== 'string' || input.model.trim().length === 0 || input.model.length > MODEL_MAX) {
    throw new OpenwopError('validation_error', `model MUST be a non-empty string ≤ ${MODEL_MAX} chars.`, 400, { field: 'model' });
  }
  if (typeof input.credentialRef !== 'string' || !REF_PATTERN.test(input.credentialRef)) {
    throw new OpenwopError('validation_error', 'credentialRef MUST match [a-zA-Z0-9_.-:]{1,128}.', 400, { field: 'credentialRef' });
  }
  if (!isManagedRef(input.credentialRef)) {
    const refs = await listSecretRefs(scope);
    if (!refs.includes(input.credentialRef)) {
      throw new OpenwopError('validation_error', 'credentialRef is not a stored BYOK secret for this workspace.', 400, { field: 'credentialRef' });
    }
    if (!(await resolveSecret(input.credentialRef, scope))) {
      throw new OpenwopError('validation_error', 'credentialRef does not currently resolve to a usable key.', 400, { field: 'credentialRef' });
    }
  }
  const row: ChatByokConfig = {
    tenantId: scope.tenantId,
    provider: input.provider as ChatByokProvider,
    model: input.model.trim(),
    credentialRef: input.credentialRef,
    updatedAt: now,
  };
  await configs.put(row);
  // The credentialRef is a NAME, never a value — safe to log, and necessary:
  // `secretResolver` logs `secret_set` for the KEY, but nothing recorded which key
  // the chat was BOUND to. An operator debugging "the chat is using the wrong
  // provider" had no trail at all.
  log.info('chat_byok_binding_set', {
    tenantId: row.tenantId, provider: row.provider, model: row.model, credentialRef: row.credentialRef,
  });
  return row;
}

async function setCopilotChatBinding(
  scope: SecretScope,
  input: { provider?: unknown; model?: unknown; credentialRef?: unknown },
  now: string,
): Promise<ChatByokConfig> {
  if (!copilotSubscriptionConfigured()) {
    throw new OpenwopError('validation_error', 'GitHub Copilot is not available on this host.', 400, { field: 'provider' });
  }
  if (typeof input.model !== 'string' || input.model.trim().length === 0 || input.model.length > MODEL_MAX) {
    throw new OpenwopError('validation_error', `model MUST be a non-empty string ≤ ${MODEL_MAX} chars.`, 400, { field: 'model' });
  }
  const ref = subscriptionCredentialRef(COPILOT_PROVIDER_ID);
  if (input.credentialRef !== ref) {
    throw new OpenwopError('validation_error', `a GitHub Copilot binding MUST use credentialRef ${ref}.`, 400, { field: 'credentialRef' });
  }
  if (!(await resolveSubscriptionCredential(ref, scope.tenantId))) {
    throw new OpenwopError('validation_error', 'GitHub Copilot is not connected for this workspace — connect it from your personal workspace first.', 400, { field: 'credentialRef' });
  }
  const row: ChatByokConfig = { tenantId: scope.tenantId, provider: COPILOT_PROVIDER_ID, model: input.model.trim(), credentialRef: ref, updatedAt: now };
  await configs.put(row);
  log.info('chat_byok_binding_set', { tenantId: row.tenantId, provider: row.provider, model: row.model, credentialRef: row.credentialRef });
  return row;
}

/** Clear the tenant's active chat binding. */
export async function clearChatByokConfig(tenantId: string): Promise<void> {
  await configs.delete(tenantId);
  log.info('chat_byok_binding_cleared', { tenantId });
}

/**
 * Is the stored binding still usable? A binding whose secret was deleted out from
 * under it (the force-delete path) must report FALSE rather than be silently served
 * to the SPA, which would dispatch and fail at the provider.
 *
 * Managed sentinels are reported usable here: authority for "is the managed key
 * present?" belongs to `managedProvider.ts`, which surfaces `managed_unavailable`
 * at dispatch. Claiming otherwise from this module would be a guess.
 */
export async function isChatByokConfigUsable(scope: SecretScope, config: ChatByokConfig): Promise<boolean> {
  if (isManagedRef(config.credentialRef)) return true;
  if (config.provider === COPILOT_PROVIDER_ID) {
    return copilotSubscriptionConfigured() && (await resolveSubscriptionCredential(config.credentialRef, scope.tenantId)) !== null;
  }
  return (await resolveSecret(config.credentialRef, scope)) !== null;
}

/**
 * The stored refs that belong to `provider`, newest-plausible LAST.
 *
 * This is the ADOPTION seam. Refs are minted `byok:<provider>` (deterministic, since
 * ADR 0517) but five weeks of history left `byok:<provider>:<epoch-ms>` rows behind, so
 * both shapes are matched. The boundary check is exact-or-colon-delimited so
 * `byok:google` never captures a hypothetical `byok:google-vertex`.
 *
 * Sorted so a caller taking the LAST element gets the most recently minted timestamped
 * ref; the bare deterministic ref sorts first and is superseded by any timestamped one
 * only when the timestamped one is what the user actually last stored. Callers that want
 * the canonical ref should prefer an exact `byok:<provider>` match — see the SPA's
 * `preferredRefForProvider`.
 */
export function refsForProvider(refs: readonly string[], provider: string): string[] {
  const base = `byok:${provider}`;
  return refs.filter((r) => r === base || r.startsWith(`${base}:`)).sort();
}
