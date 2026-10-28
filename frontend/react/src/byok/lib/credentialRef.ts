/**
 * KEYS-REF-1 — which provider a stored credential ref NAMES, for the Keys page.
 *
 * The Keys page used to split a ref at its FIRST colon, so the BYOK wizard's own
 * ref shape `byok:<provider>` (ADR 0517 fix B) grouped under a provider called
 * `byok`. No section renders that, and it is not the unscoped bucket either: the
 * key counted in the Total tile, was listed nowhere, and could not be deleted
 * from the page.
 *
 * `refNamedProvider` MIRRORS the backend's naming rule
 * (`backend/typescript/src/aiProviders/credentialRefLadder.ts#refNamedProvider`):
 * `google`, `google-work`, `google:prod`, `byok:google` and `byok:google:…` all
 * name `google`; a ref whose name carries no known provider names none. The
 * parity test runs BOTH functions over one fixture list, so the two cannot drift.
 */

/** The provider `ref` names among `providers`, or `null`. Same rule as the backend. */
export function refNamedProvider(ref: string, providers: readonly string[]): string | null {
  const body = ref.startsWith('byok:') ? ref.slice('byok:'.length) : ref;
  for (const p of providers) {
    if (body === p || body.startsWith(`${p}-`) || body.startsWith(`${p}:`)) return p;
  }
  return null;
}

/** Does `ref` name `provider`? The single-provider form, mirroring the backend's
 *  `refNamesProvider` (CRED-PICKER-REF-1: the builder's credential picker filters with it). */
export function refNamesProvider(ref: string, provider: string): boolean {
  return refNamedProvider(ref, [provider]) === provider;
}

export interface ParsedCredentialRef {
  ref: string;
  /** The provider the ref names, or null (the Keys page's unscoped bucket). */
  providerId: string | null;
  /** What follows the provider (`prod` in `google:prod`, `work` in `google-work`), or null. */
  label: string | null;
}

export function parseCredentialRef(ref: string, providers: readonly string[]): ParsedCredentialRef {
  const providerId = refNamedProvider(ref, providers);
  if (providerId === null) return { ref, providerId: null, label: null };
  const body = ref.startsWith('byok:') ? ref.slice('byok:'.length) : ref;
  const rest = body.slice(providerId.length);
  return { ref, providerId, label: rest.length > 1 ? rest.slice(1) : null };
}

/** Refs a dedicated card owns, so the unscoped bucket must not list them: the
 *  web-search key (ADR 0101 P3), subscription credentials (ADR 0180) and managed
 *  sentinels. Every other ref is listed under a provider or as unscoped — none is
 *  counted and then shown nowhere. */
export const WEB_SEARCH_REF = 'web-search';
/** ADR 0910 D8 — the Challenge Factory's dedicated key, owned by its card on
 *  KickTodo's AI & connections page; listed here it would read as an unscoped key. */
const FACTORY_REF_PREFIX = 'kicktodo-factory:';
export function isCardOwnedRef(ref: string): boolean {
  return ref === WEB_SEARCH_REF || ref.startsWith('subscription:') || ref.startsWith('managed:') || ref.startsWith(FACTORY_REF_PREFIX);
}
