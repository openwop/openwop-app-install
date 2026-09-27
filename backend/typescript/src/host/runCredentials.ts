/**
 * Registering a BYOK credential on a run (ADR 0089 Phase 4 review fix; ADR 0706
 * §3.1 item 1) — the ONE recipe every run starter that binds a stored secret to
 * a run must use.
 *
 * WHY. `executor.ts prepareRunSecrets` gives a run ONLY the secrets listed in
 * `node.config.credentialRefs` or `run.configurable.credentialRefs`; the AI
 * adapter's `resolveCredential` then reads `scope.secrets` — that set, not the
 * tenant's vault. So a ref passed only as a run INPUT never reaches dispatch:
 * the node forwards it to `callAI`, the adapter looks it up in an empty set, and
 * the run dies `byok_required_but_unresolved`. The agent-mention lane hit this
 * first (ADR 0089, `routes/interrupts.ts`), and the Challenge Factory ran with
 * an EMPTY secret set for every run from 2026-07-29 to ADR 0706 — the incident
 * message `Available refs: (none)` is this, not a keyless tenant.
 *
 * A managed ref (`managed:*`) needs no stored secret and `prepareRunSecrets`
 * skips it, so it is not registered.
 */

import { isManagedRef, refNamedProvider } from '../aiProviders/credentialRefLadder.js';
import { resolveSecret } from '../byok/secretResolver.js';

/** The run-level `configurable` that lets `prepareRunSecrets` resolve `ref`
 *  into the run's secret set. Empty for a managed ref or none. */
export function byokRunConfigurable(credentialRef?: string | null): Record<string, unknown> {
  return credentialRef && !isManagedRef(credentialRef)
    ? { credentialRefs: [credentialRef] }
    : {};
}

/**
 * ADR 0712 — the run's credential as the WIRE names it: `configurable.ai.credentialRef`
 * (v1 `run-options.md` and v2 `runs.md` §configurable define the same nested key).
 * A non-string, empty or managed value is not a BYOK run credential. Names only.
 */
export function runAiCredentialRef(configurable: Record<string, unknown> | undefined): string | undefined {
  const ai = configurable?.ai;
  if (!ai || typeof ai !== 'object' || Array.isArray(ai)) return undefined;
  const ref = (ai as Record<string, unknown>).credentialRef;
  return typeof ref === 'string' && ref.length > 0 && !isManagedRef(ref) ? ref : undefined;
}

/**
 * ADR 0712 — the ONE reader of "which stored secrets does this run declare?".
 * `prepareRunSecrets` resolves exactly this list and a parent hands exactly this
 * list to its children, so the two cannot disagree. The wire ref comes FIRST: the
 * dispatcher's prefix rung is first-match, so a run that names its credential
 * wins over a host-set `credentialRefs[]` entry for the same provider.
 */
export function declaredRunCredentialRefs(configurable: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  const aiRef = runAiCredentialRef(configurable);
  if (aiRef) out.push(aiRef);
  const raw = configurable?.credentialRefs;
  if (Array.isArray(raw)) {
    for (const r of raw) if (typeof r === 'string' && r.length > 0 && !out.includes(r)) out.push(r);
  }
  return out;
}

/**
 * ADR 0712 — run-create/fork check for `configurable.ai.credentialRef`, or `null`
 * when there is nothing to refuse. Both majors' specs: the ref MUST reference a
 * credential of a provider in `aiProviders.byok`, else `403 credential_forbidden`.
 *
 * `tenantId` MUST be the tenant the route already authorized, never one read from
 * the body's `configurable`. A ref that does not exist and a ref that belongs to
 * another tenant produce the SAME answer — the resolver only sees this tenant, so
 * the refusal cannot be used to probe for another workspace's key names.
 */
export async function runAiCredentialRefViolation(
  configurable: Record<string, unknown> | undefined,
  tenantId: string,
  byokProviders: readonly string[],
): Promise<string | null> {
  const ai = configurable?.ai;
  if (!ai || typeof ai !== 'object' || Array.isArray(ai)) return null;
  if (!Object.prototype.hasOwnProperty.call(ai, 'credentialRef')) return null;
  const ref = (ai as Record<string, unknown>).credentialRef;
  if (typeof ref !== 'string' || ref.length === 0) {
    return 'configurable.ai.credentialRef must be a non-empty credential reference.';
  }
  if (isManagedRef(ref)) {
    return 'configurable.ai.credentialRef must name a stored BYOK key; the free managed tier is not a BYOK credential.';
  }
  if (refNamedProvider(ref, byokProviders) === null) {
    return `configurable.ai.credentialRef must name a key for one of: ${byokProviders.join(', ')} (e.g. byok:<provider> or <provider>:<label>).`;
  }
  if ((await resolveSecret(ref, { tenantId })) === null) {
    return 'configurable.ai.credentialRef does not resolve to a key in this workspace\'s Secrets Vault.';
  }
  return null;
}
