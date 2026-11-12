/** Dedicated campaign launch AI options (ADR 0961 correction / ADR 0712).
 * Names only; this owner admits an explicit choice before ignition and projects
 * only source-run AI authority for detached stages. It never enumerates a vault. */
import { advertisedByokProviders } from '../../aiProviders/aiProvidersHost.js';
import { isManagedRef, refNamedProvider } from '../../aiProviders/credentialRefLadder.js';
import { declaredRunCredentialRefs, runAiCredentialRef, runAiCredentialRefViolation } from '../../host/runCredentials.js';
import { RUN_AI_DEFAULT_KEY, runAiDefaultFor } from '../../host/runAiDefault.js';
import { getDefaultModel, getProviderConfig } from '../../providers/catalog.js';
import { OpenwopError } from '../../types.js';

export interface CampaignLaunchAi { provider: string; model: string; credentialRef: string }

/** Undefined is no override. An explicit option must name a currently usable
 * advertised provider key and a coherent catalog model. Scope is server-owned. */
export async function resolveCampaignLaunchAi(tenantId: string, input: unknown): Promise<CampaignLaunchAi | undefined> {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['credentialRef', 'provider', 'model'].includes(key))) {
    throw new OpenwopError('validation_error', 'AI run options must contain only credentialRef, provider and model.', 400, { field: 'ai' });
  }
  const value = input as Record<string, unknown>;
  const providers = advertisedByokProviders();
  const configurable = { ai: value };
  const violation = await runAiCredentialRefViolation(configurable, tenantId, providers);
  if (!Object.hasOwn(value, 'credentialRef') || violation) {
    throw new OpenwopError('credential_forbidden', 'Choose a stored AI provider key that is available in this workspace.', 403, { reason: 'campaign_ai_key_forbidden' });
  }
  const credentialRef = runAiCredentialRef(configurable);
  const provider = credentialRef ? refNamedProvider(credentialRef, providers) : null;
  // This NEW explicit selection seam uses the same exact/colon presentation
  // grammar as Run options; no new global reservation or legacy resolver rule.
  const body = credentialRef?.startsWith('byok:') ? credentialRef.slice(5) : credentialRef;
  if (!provider || !credentialRef || !(body === provider || body?.startsWith(`${provider}:`))) {
    throw new OpenwopError('credential_forbidden', 'Choose a provider-qualified saved AI key.', 403, { reason: 'campaign_ai_key_forbidden' });
  }
  if (value.provider !== undefined && value.provider !== provider) {
    throw new OpenwopError('validation_error', 'The selected AI provider must match the saved key.', 400, { field: 'ai.provider', reason: 'campaign_ai_provider_mismatch' });
  }
  const model = value.model === undefined ? getDefaultModel(provider) : value.model;
  if (typeof model !== 'string' || !getProviderConfig(provider)?.models.some(entry => entry.id === model)) {
    throw new OpenwopError('validation_error', 'Choose a catalog model for the selected AI provider.', 400, { field: 'ai.model', reason: 'campaign_ai_model_mismatch' });
  }
  return { provider, model, credentialRef };
}

export function campaignLaunchConfigurable(ai: CampaignLaunchAi | undefined): Record<string, unknown> | undefined {
  return ai ? { version: 1, ai } : undefined;
}

/** Source row only, after taggedCampaignOf proves tenant/campaign/org access.
 * A new legacy stage with no frozen AI decision refuses rather than acquiring
 * today's workspace default. Existing deterministic stages are resolved first. */
export function projectCampaignStageAi(source: {
  configurable?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}, args: { provider?: string; model?: string }): {
  configurable: Record<string, unknown>;
  metadata: Record<string, unknown>;
  inputs: Record<string, unknown>;
} {
  const choice = runAiDefaultFor(source.configurable, source.metadata);
  if (!choice) throw new OpenwopError('validation_error', 'This source run has no frozen AI choice. Start a new campaign run before creating its drafting stage.', 422, { reason: 'campaign_ai_choice_missing' });
  if ((args.provider && args.provider !== choice.provider) || (args.model && args.model !== choice.model)) {
    throw new OpenwopError('validation_error', 'The stage must keep its source run\'s AI provider and model.', 400, { reason: 'campaign_ai_stage_mismatch' });
  }
  const refs = declaredRunCredentialRefs(source.configurable);
  const managed = choice.source === 'managed' && isManagedRef(choice.credentialRef);
  // Issue #5764 — a source whose default froze the workspace binding's key passes
  // that key on: the stage names its provider on the wire (rung 1), so without it
  // the stage would choose the provider and then have no key.
  const ref = runAiCredentialRef(source.configurable) ?? (choice.source === 'workspace' ? choice.credentialRef : undefined);
  const namedProvider = ref ? refNamedProvider(ref, advertisedByokProviders()) : null;
  if ((managed && ref) || (namedProvider && namedProvider !== choice.provider)) {
    throw new OpenwopError('validation_error', 'The source run has incompatible frozen AI and credential choices.', 422, { reason: 'campaign_ai_source_mismatch' });
  }
  return {
    configurable: {
      ...(refs.length ? { credentialRefs: refs } : {}),
      // A synthetic provider on a managed stage would shadow the inherited
      // sentinel in runAiDefaultFor and turn managed dispatch into missing BYOK.
      ...(!managed ? { ai: { provider: choice.provider, model: choice.model, ...(ref ? { credentialRef: ref } : {}) } } : {}),
    },
    // Existing metadata key, projected explicitly so neither presence nor a
    // source override is re-resolved against a later workspace binding.
    metadata: { [RUN_AI_DEFAULT_KEY]: choice },
    // Managed nodes must leave provider/model empty for sentinel injection.
    inputs: managed ? {} : { provider: choice.provider, model: choice.model },
  };
}
