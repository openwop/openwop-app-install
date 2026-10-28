/**
 * ADR 0975 D2 — the Challenge Factory's dedicated AI key (ADR 0910 D8) as the
 * Factory's own binding, shared by the run's pre-flight (`kicktodo-creator`
 * `resolveFactoryAi`) and the readiness report (`kicktodo-core`), so the two can
 * never disagree again.
 *
 * They did: on kicktodo.com (2026-10-25) readiness said `factory.ready: true`
 * because a `kicktodo-factory:google` key existed, while every run refused with
 * `ai_credential_missing` — the run resolved the workspace's ADR 0110 default
 * (`anthropic`, no key) and only consulted the Factory key for THAT provider.
 * An operator who stores the Factory key has said which key the Factory uses;
 * the workspace default answers a different question (headless runs at large).
 *
 * Lives at the `features/` root (beside `featureRoute.ts`) because both KickTodo
 * features read it and neither imports the other.
 */
import { listSecretRefs, resolveSecret } from '../byok/secretResolver.js';
import { getHeadlessAiDefault } from '../host/headlessAi.js';
import { probeProviderCapabilities } from '../host/modelCapabilityProbe.js';

export const FACTORY_CREDENTIAL_PREFIX = 'kicktodo-factory:';

/** Provider order when several Factory keys exist and none is the workspace
 *  default's provider — the Factory key card's own order. */
export const FACTORY_PROVIDER_ORDER = ['google', 'anthropic', 'openai'] as const;

/** ADR 0910 D8 — the Factory's dedicated Vault ref for a provider. */
export function factoryCredentialRef(provider: string): string {
  return `${FACTORY_CREDENTIAL_PREFIX}${provider}`;
}

/** Providers with a stored Factory key that can serve the Factory (every evidence
 *  node sends a `responseSchema`, so `structured-output` is required). */
export function factoryKeyProviders(refs: readonly string[]): string[] {
  return refs
    .filter((r) => r.startsWith(FACTORY_CREDENTIAL_PREFIX))
    .map((r) => r.slice(FACTORY_CREDENTIAL_PREFIX.length))
    .filter((p) => p !== '' && probeProviderCapabilities(p).includes('structured-output'));
}

/**
 * The provider whose Factory key a run uses when the creator names none: the
 * workspace default's provider if it has a Factory key, else the first in
 * `FACTORY_PROVIDER_ORDER`, else the first remaining (sorted, so the choice is
 * deterministic). `null` when the workspace has no usable Factory key.
 */
export async function dedicatedFactoryProvider(tenantId: string, refs?: readonly string[]): Promise<string | null> {
  const providers = factoryKeyProviders(refs ?? await listSecretRefs({ tenantId }));
  if (providers.length === 0) return null;
  const def = await getHeadlessAiDefault(tenantId);
  if (def && providers.includes(def.provider)) return def.provider;
  for (const p of FACTORY_PROVIDER_ORDER) if (providers.includes(p)) return p;
  return [...providers].sort()[0]!;
}

/** Readiness: the reason the Factory cannot run on its dedicated key, or null. */
export async function factoryKeyProblem(tenantId: string): Promise<string | null> {
  const refs = await listSecretRefs({ tenantId });
  const provider = await dedicatedFactoryProvider(tenantId, refs);
  if (!provider) {
    return refs.some((r) => r.startsWith(FACTORY_CREDENTIAL_PREFIX))
      ? `the ${FACTORY_CREDENTIAL_PREFIX}<provider> key in ${tenantId}'s vault is for a provider that cannot return structured JSON — the Factory cannot run on it`
      : `no ${FACTORY_CREDENTIAL_PREFIX}<provider> key in ${tenantId}'s vault — the Factory falls back to the workspace's default AI provider`;
  }
  if (!(await resolveSecret(factoryCredentialRef(provider), { tenantId }))) {
    return `the ${factoryCredentialRef(provider)} key in ${tenantId}'s vault cannot be read right now`;
  }
  return null;
}
