/**
 * ADR 0903 — the provider and model a node uses when it names neither.
 *
 * Node packs used to fill a missing provider with a hard-coded `'anthropic'`
 * and a pack-local Claude model id, so a workflow could only ever run on
 * Anthropic unless its chain froze another vendor in — and the Campaign Studio
 * chains never did (measured 2026-10-17: a Gemini run failed `byok_required`
 * for an Anthropic key the user never chose). The packs now pass what they were
 * given and leave the gap to this one resolver, in this order:
 *
 *   1. the run's own choice — `configurable.ai.provider` / `.model` (the wire
 *      field, `runs.md` §configurable). Read from the run record at call time:
 *      it is fixed when the run is created, so reading it is replay-stable.
 *   2. the workspace's active AI binding (ADR 0517, the provider + model picked
 *      in chat or Keys), when it names a real BYOK provider. Subscription
 *      bindings are chat-only and are skipped.
 *   3. the free managed tier, when this host holds its key and the binding IS
 *      the managed tier or the workspace holds no key for any selectable
 *      provider (ADR 0903 correction,
 *      2026-11-02). Until then a keyless workspace was frozen onto the catalog's
 *      first provider and every AI step failed `byok_required` for a key nobody
 *      chose, although chat and agent steps already ran on the free tier.
 *   4. the host catalog's recommended default (`providers.json`: the first
 *      selectable provider the workspace HOLDS a key for, else the first one,
 *      with its `recommended` model).
 *
 * Rungs 2 to 4 can change between runs, so they are resolved ONCE at run
 * creation by a run-start contributor and frozen into `run.metadata.aiDefault`
 * (ADR 0099). A `:fork` reads the source's frozen value verbatim and never
 * re-resolves it (ADR 0604), so replay sees the provider the source ran on.
 */
import { getChatByokConfig } from './chatByokConfig.js';
import { registerRunStartContributor, type RunStartContext } from './runStartContext.js';
import { getDefaultModel, getProviderConfig, listManagedProviderIds, listSelectableProviderIds } from '../providers/catalog.js';
import { isManagedRef, refNamedProvider } from '../aiProviders/credentialRefLadder.js';
import { listSecretRefs } from '../byok/secretResolver.js';
import { getManagedProviderStatuses } from '../providers/managedProvider.js';
import { isAnonTenantId } from './requestSubject.js';

export const RUN_AI_DEFAULT_KEY = 'aiDefault';

export interface RunAiDefault {
  provider: string;
  model: string;
  source: 'run' | 'workspace' | 'managed' | 'catalog';
  /** Only on `source: 'managed'`: the `managed:*` sentinel the call dispatches
   *  on. A sentinel, never a stored key, so it is safe on run metadata. */
  credentialRef?: string;
}

/** A BYOK provider this host's catalog knows and lets a person select. */
function isSelectableProvider(id: unknown): id is string {
  return typeof id === 'string' && listSelectableProviderIds().includes(id);
}

/** The model for `provider`: the given one when it is a non-empty string, else the catalog default. */
function modelFor(provider: string, model: unknown): string {
  return typeof model === 'string' && model.trim().length > 0 ? model.trim() : getDefaultModel(provider);
}

/** The free managed tier as a run default, or null when the catalog lists none
 *  or this host holds no key for it. A host without a managed key keeps the
 *  catalog answer, so its users still hear "add a key" rather than
 *  `provider_unavailable` for a tier that cannot answer. */
async function managedDefault(credentialRef?: string): Promise<RunAiDefault | null> {
  const id = listManagedProviderIds()[0];
  if (!id) return null;
  const statuses = await getManagedProviderStatuses().catch(() => []);
  if (!statuses.some((st) => st.providerId === id && st.ready)) return null;
  const ref = credentialRef && isManagedRef(credentialRef) ? credentialRef : `managed:${id}`;
  return { provider: id, model: getDefaultModel(id), source: 'managed', credentialRef: ref };
}

/** Rungs 2 to 4 — the default frozen into a new run. `null` only when the catalog lists no provider. */
export async function resolveFrozenAiDefault(tenantId: string): Promise<RunAiDefault | null> {
  const binding = await getChatByokConfig(tenantId).catch(() => null);
  if (binding && !isManagedRef(binding.credentialRef) && !binding.credentialRef.startsWith('subscription:')
    && isSelectableProvider(binding.provider)) {
    return { provider: binding.provider, model: modelFor(binding.provider, binding.model), source: 'workspace' };
  }
  const selectable = listSelectableProviderIds();
  // An anonymous sandbox never reaches the managed tier (it needs a signed-in
  // caller), so it keeps the old catalog answer and its old error.
  if (!isAnonTenantId(tenantId)) {
    if (binding && isManagedRef(binding.credentialRef)) {
      const managed = await managedDefault(binding.credentialRef);
      if (managed) return managed;
    }
    // `null` when the vault cannot be read: then we cannot tell whether the
    // workspace has a key, and keep the catalog answer rather than guess.
    const refs = await listSecretRefs({ tenantId }).catch(() => null);
    if (refs) {
      const held = selectable.find((p) => refs.some((r) => refNamedProvider(r, [p]) === p));
      if (held) return { provider: held, model: getDefaultModel(held), source: 'catalog' };
      const managed = await managedDefault();
      if (managed) return managed;
    }
  }
  const first = selectable[0];
  return first ? { provider: first, model: getDefaultModel(first), source: 'catalog' } : null;
}

/** ADR 0099 run-start contributor. A derived (`:fork`) run inherits the source's value, present or absent. */
export async function runAiDefaultContributor(ctx: RunStartContext): Promise<Record<string, unknown>> {
  if (ctx.derivedFromRun) return {};
  const frozen = await resolveFrozenAiDefault(ctx.tenantId);
  return frozen ? { [RUN_AI_DEFAULT_KEY]: frozen } : {};
}

let wired = false;
/** Register the contributor once per process (the `wireAuthorityRunStamping` shape). */
export function wireRunAiDefaultStamping(): void {
  if (wired) return;
  wired = true;
  registerRunStartContributor(runAiDefaultContributor);
}

/** The frozen value on a run's metadata, when it has a usable shape. */
function frozenOn(metadata: Record<string, unknown> | undefined): RunAiDefault | null {
  const v = metadata?.[RUN_AI_DEFAULT_KEY];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const { provider, model, source, credentialRef } = v as Record<string, unknown>;
  if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) return null;
  if (source === 'managed') {
    // Only ever a `managed:*` sentinel; anything else is not a managed default.
    return typeof credentialRef === 'string' && isManagedRef(credentialRef) ? { provider, model, source, credentialRef } : null;
  }
  return { provider, model, source: source === 'workspace' || source === 'catalog' ? source : 'catalog' };
}

/**
 * The default for one run: rung 1 from `configurable.ai`, else the value frozen
 * at creation. `null` for a run created before ADR 0903 that names no provider —
 * the caller then keeps its old behaviour (a missing provider is refused).
 */
export function runAiDefaultFor(
  configurable: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
): RunAiDefault | null {
  const ai = configurable?.ai;
  if (ai && typeof ai === 'object' && !Array.isArray(ai)) {
    const provider = (ai as Record<string, unknown>).provider;
    if (typeof provider === 'string' && provider.length > 0 && getProviderConfig(provider)) {
      return { provider, model: modelFor(provider, (ai as Record<string, unknown>).model), source: 'run' };
    }
  }
  return frozenOn(metadata);
}

/**
 * Fill a call's missing provider and model from the run default. A node that
 * names a provider keeps it; its model, when missing, is that provider's own
 * default — the run default's model belongs to the run default's provider only.
 */
export function withRunAiDefault<T extends { provider?: string; model?: string; credentialRef?: string }>(req: T, def: RunAiDefault | null | undefined): T {
  const named = typeof req.provider === 'string' && req.provider.length > 0;
  if (named) {
    if (typeof req.model === 'string' && req.model.length > 0) return req;
    const model = def && def.provider === req.provider ? def.model : getDefaultModel(req.provider!);
    return { ...req, model };
  }
  if (!def) return req;
  if (def.credentialRef) {
    // The managed default fills provider, model AND its sentinel ref together.
    // A call that already carries its own key keeps it and is left as it was:
    // the managed provider must never be paired with a stored key.
    if (typeof req.credentialRef === 'string' && req.credentialRef.length > 0) return req;
    return { ...req, provider: def.provider, model: def.model, credentialRef: def.credentialRef };
  }
  const model = typeof req.model === 'string' && req.model.length > 0 ? req.model : def.model;
  return { ...req, provider: def.provider, model };
}
