/**
 * The ONE credential-ref ladder (ADR 0706 §3.1 item 4).
 *
 * "Which stored secret does a `provider` dispatch use?" used to be answered in
 * exactly one place — `resolveCredential` in `aiProvidersHost.ts`, at dispatch
 * time, over the run's secret set. The Challenge Factory's run tool now has to
 * answer the SAME question BEFORE a run exists (so it can refuse with "nothing
 * was created" instead of burning a candidate and dying at `extract-claims`),
 * and a second hand-written copy of the ladder would drift: the tool would
 * refuse runs that work, or admit runs that die.
 *
 * So the ladder is a pure function over `(provider, credentialRef,
 * availableRefs)`. The dispatcher calls it with `Object.keys(scope.secrets)`
 * (the refs `prepareRunSecrets` resolved into the run); the pre-flight calls it
 * with `listSecretRefs({ tenantId })` (the tenant's vault). Same rungs, same
 * order, one implementation:
 *
 *   1. an EXPLICIT `credentialRef` — used iff it is present; an explicit ref that
 *      is absent is a distinct failure (`byok_required_but_unresolved`), never a
 *      fall-through to a guessed key;
 *   1b. the RUN's credential (ADR 0712) — v2 `configurable.ai.credentialRef`,
 *      used only when the node names no ref, the run ref NAMES this provider
 *      (`refNamesProvider`), and it is in `availableRefs`. A run ref for another
 *      provider is skipped, never sent to the wrong vendor;
 *   2. the exact provider name (`secrets['google']`);
 *   3. the FIRST ref prefixed `<provider>-` or `<provider>:` in `availableRefs`
 *      order. First-match is the historical dispatch behaviour and is kept
 *      byte-for-byte; a caller that needs determinism across two lists passes
 *      the ref it picked EXPLICITLY (the factory does — ADR 0706 §3.1 item 1).
 *
 * Ref NAMES only ever flow through here — never values.
 */

export type CredentialRefPick =
  | { ref: string; rung: 'explicit' | 'run' | 'exact' | 'prefix' }
  | { ref: null; reason: 'explicit_ref_unresolved' | 'no_default_credential' };

/** Managed-tier sentinels (`managed:*`) need no stored secret; the managed
 *  dispatch path owns its own credential lookup + gating. */
export function isManagedRef(ref: string | undefined | null): boolean {
  return typeof ref === 'string' && ref.startsWith('managed:');
}

/** The provider a ref NAMES, by the host's naming conventions, or `null`.
 *  `google`, `google-work`, `google:prod` (Keys page) and `byok:google`,
 *  `byok:google:…` (the BYOK wizard, ADR 0517 fix B) all name `google`. Pure, so
 *  a dispatch reads the same answer on every attempt and on a fork. A ref whose
 *  name carries no provider (`my-key`) names none — ADR 0712 refuses it as a
 *  run credential rather than guessing which vendor to send it to. */
export function refNamedProvider(ref: string, providers: readonly string[]): string | null {
  const body = ref.startsWith('byok:') ? ref.slice('byok:'.length) : ref;
  for (const p of providers) {
    if (body === p || body.startsWith(`${p}-`) || body.startsWith(`${p}:`)) return p;
  }
  return null;
}

/** Does `ref` name `provider`? The single-provider form of `refNamedProvider`. */
export function refNamesProvider(ref: string, provider: string): boolean {
  return refNamedProvider(ref, [provider]) === provider;
}

/**
 * ADR 0712 OQ4 — does an EXPLICIT ref name a DIFFERENT known provider than the one
 * being called? Returns that provider, or null.
 *
 * The explicit rung of `pickCredentialRef` trusts a node's own `credentialRef`
 * blindly, so a mis-paired ref (a Google key passed to an Anthropic step) used to
 * leave the process for the wrong vendor — the call fails upstream, but the key has
 * already been sent to a third party that should never have seen it.
 *
 * Deliberately narrow, so nothing that works today breaks:
 *  - only a ref whose NAME carries a known provider can mismatch — a provider-less
 *    name (`my-key`) is the operator's choice and stays allowed;
 *  - `compat` (an OpenAI-compatible endpoint) may legitimately take any vendor's key,
 *    and `mock` never sends one — both are exempt;
 *  - a managed ref (`managed:*`) never reaches this rung.
 */
export function explicitRefNamesOtherProvider(
  provider: string,
  credentialRef: string | undefined,
  knownProviders: readonly string[],
): string | null {
  if (!credentialRef || isManagedRef(credentialRef) || provider === 'compat' || provider === 'mock') return null;
  const named = refNamedProvider(credentialRef, knownProviders);
  return named !== null && named !== provider ? named : null;
}

export function pickCredentialRef(
  provider: string,
  credentialRef: string | undefined,
  availableRefs: readonly string[],
  runCredentialRef?: string,
): CredentialRefPick {
  if (credentialRef) {
    return availableRefs.includes(credentialRef)
      ? { ref: credentialRef, rung: 'explicit' }
      : { ref: null, reason: 'explicit_ref_unresolved' };
  }
  if (runCredentialRef && refNamesProvider(runCredentialRef, provider) && availableRefs.includes(runCredentialRef)) {
    return { ref: runCredentialRef, rung: 'run' };
  }
  if (availableRefs.includes(provider)) return { ref: provider, rung: 'exact' };
  for (const ref of availableRefs) {
    if (ref.startsWith(`${provider}-`) || ref.startsWith(`${provider}:`)) return { ref, rung: 'prefix' };
  }
  return { ref: null, reason: 'no_default_credential' };
}
