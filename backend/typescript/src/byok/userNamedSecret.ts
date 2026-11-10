/**
 * ADR 0779 D2, run lane — the ONE door for resolving a credential ref a USER
 * named (a run's `credentialRefs`, a chat/voice/image/widget binding, a deferred
 * sensitive variable). It refuses the namespaces another lifecycle owns
 * (`reservedCredentialRefOwner`) with a typed `credential_ref_reserved`, then
 * resolves as `resolveSecret` does. A host-built ref (a Stripe key, a
 * connection's own token read by the connection broker) keeps `resolveSecret`.
 *
 * The ratchet `test/credential-ref-reserved-prefixes.test.ts` classifies every
 * `resolveSecret(` caller, so a new user-named lane cannot skip this door.
 */
import { OpenwopError } from '../types.js';
import { reservedCredentialRefOwner } from './refNamespaces.js';
import { resolveSecret, type SecretScope } from './secretResolver.js';

/** Throw the typed refusal when a user may not name `ref`. */
export function assertUserNameableRef(ref: string): void {
  const owner = reservedCredentialRefOwner(ref);
  if (owner) {
    throw new OpenwopError(
      'credential_ref_reserved',
      `This credential is managed by ${owner} and cannot be named here. Use that feature, or name a key from the Keys page.`,
      403,
      { credentialRef: ref },
    );
  }
}

export async function resolveUserNamedSecret(ref: string, scope?: SecretScope): Promise<string | null> {
  assertUserNameableRef(ref);
  return resolveSecret(ref, scope);
}
