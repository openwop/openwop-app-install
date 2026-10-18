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
 *      in chat or Keys), when it names a real BYOK provider. Managed and
 *      subscription bindings are chat-only and are skipped.
 *   3. the host catalog's recommended default (`providers.json`: the first
 *      selectable provider and its `recommended` model).
 *
 * Rungs 2 and 3 can change between runs, so they are resolved ONCE at run
 * creation by a run-start contributor and frozen into `run.metadata.aiDefault`
 * (ADR 0099). A `:fork` reads the source's frozen value verbatim and never
 * re-resolves it (ADR 0604), so replay sees the provider the source ran on.
 */
import { getChatByokConfig } from './chatByokConfig.js';
import { registerRunStartContributor, type RunStartContext } from './runStartContext.js';
import { getDefaultModel, getProviderConfig, listSelectableProviderIds } from '../providers/catalog.js';
import { isManagedRef } from '../aiProviders/credentialRefLadder.js';

export const RUN_AI_DEFAULT_KEY = 'aiDefault';

export interface RunAiDefault {
  provider: string;
  model: string;
  source: 'run' | 'workspace' | 'catalog';
}

/** A BYOK provider this host's catalog knows and lets a person select. */
function isSelectableProvider(id: unknown): id is string {
  return typeof id === 'string' && listSelectableProviderIds().includes(id);
}

/** The model for `provider`: the given one when it is a non-empty string, else the catalog default. */
function modelFor(provider: string, model: unknown): string {
  return typeof model === 'string' && model.trim().length > 0 ? model.trim() : getDefaultModel(provider);
}

/** Rungs 2 then 3 — the default frozen into a new run. `null` only when the catalog lists no provider. */
export async function resolveFrozenAiDefault(tenantId: string): Promise<RunAiDefault | null> {
  const binding = await getChatByokConfig(tenantId).catch(() => null);
  if (binding && !isManagedRef(binding.credentialRef) && !binding.credentialRef.startsWith('subscription:')
    && isSelectableProvider(binding.provider)) {
    return { provider: binding.provider, model: modelFor(binding.provider, binding.model), source: 'workspace' };
  }
  const first = listSelectableProviderIds()[0];
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
  const { provider, model, source } = v as Record<string, unknown>;
  if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) return null;
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
export function withRunAiDefault<T extends { provider?: string; model?: string }>(req: T, def: RunAiDefault | null | undefined): T {
  const named = typeof req.provider === 'string' && req.provider.length > 0;
  if (named) {
    if (typeof req.model === 'string' && req.model.length > 0) return req;
    const model = def && def.provider === req.provider ? def.model : getDefaultModel(req.provider!);
    return { ...req, model };
  }
  if (!def) return req;
  const model = typeof req.model === 'string' && req.model.length > 0 ? req.model : def.model;
  return { ...req, provider: def.provider, model };
}
