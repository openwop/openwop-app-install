/**
 * packSignature (ADR 0367 Phase 1) — the ONE Ed25519 pack-signature owner.
 *
 * Two honestly-named modes, because they answer different questions:
 *
 *  - `verifySelfAttested`: the pre-existing semantics extracted from
 *    `promptPackLoader` — the pack ships its OWN public key + signature.
 *    Proves integrity (the manifest matches what the key-holder signed) but
 *    NOT identity: any author can mint a key. Status/logging only; it MUST
 *    NEVER gate a trust decision.
 *
 *  - `verifyPinned`: the ADR 0367 trust boundary — verification against
 *    HOST-HELD publisher keys (a keyring of key-id → PEM), with a
 *    revocation list checked by pack id + version. This is what the Phase-2
 *    T1 lane serves against. Fail-closed on every path: unknown key id,
 *    missing/invalid signature, revoked version, or a thrown crypto error
 *    all yield `'failed'`/`'revoked'`, never a pass.
 *
 * Keyring + revocation both load from operator-controlled config (env paths),
 * never from pack content — the whole point is that the pack cannot vouch
 * for itself.
 */
import { fetchRegistryDocument, resetRegistryEndpointCache } from '../packs/registryEndpoints.js';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.packSignature');

export type SelfAttestedResult = 'verified' | 'skipped' | 'failed';

export interface SigningRefs {
  publicKeyRef?: string;
  signatureRef?: string;
  /** ADR 0367: names the PINNED publisher key this signature claims. */
  keyId?: string;
}

/** The pre-existing pack-supplied-key check (integrity, not identity). */
export function verifySelfAttested(packDir: string, signing: SigningRefs | undefined, packName: string): SelfAttestedResult {
  if (!signing) return 'skipped';
  const { publicKeyRef, signatureRef } = signing;
  if (!publicKeyRef || !signatureRef) return 'failed';
  const pubKeyPath = join(packDir, publicKeyRef);
  const sigPath = join(packDir, signatureRef);
  if (!existsSync(pubKeyPath) || !existsSync(sigPath)) return 'failed';
  try {
    const pubKeyPem = readFileSync(pubKeyPath, 'utf8');
    const signature = readFileSync(sigPath);
    const manifestBytes = readFileSync(join(packDir, 'pack.json'));
    const publicKey = createPublicKey({ key: pubKeyPem, format: 'pem' });
    return edVerify(null, manifestBytes, publicKey, signature) ? 'verified' : 'failed';
  } catch (err) {
    log.warn('pack_signature_verify_error', { packName, err: err instanceof Error ? err.message : String(err) });
    return 'failed';
  }
}

export type PinnedResult = 'trusted' | 'failed' | 'revoked' | 'unsigned';

export interface PinnedKeyring {
  /** key id → PEM public key. Operator-held (env/file), NEVER pack content. */
  keys: Record<string, string>;
  /** Revoked `<packName>@<version>` entries (exact match). */
  revoked: ReadonlySet<string>;
}

/** Load the keyring + revocation list from operator config. Absent config ⇒
 *  an EMPTY keyring (everything fails closed to untrusted).
 *
 *  Failure semantics are asymmetric BY DESIGN: an unreadable keyring index
 *  degrades to no keys (nothing trusted — already closed), but an unreadable
 *  REVOCATION file must not degrade to "no revocations" — that would keep a
 *  revoked pack trusted (fail-open on the one axis that exists to kill a bad
 *  version). A configured-but-unreadable revocation list therefore empties
 *  the keyring: nothing serves until the operator fixes the file. */
export function loadPinnedKeyring(): PinnedKeyring {
  const keys: Record<string, string> = {};
  const keyDir = process.env.OPENWOP_TRUSTED_PACK_KEYS_DIR;
  if (keyDir && existsSync(keyDir)) {
    try {
      const index = JSON.parse(readFileSync(join(keyDir, 'index.json'), 'utf8')) as { keyId: string; file: string }[];
      for (const f of index) {
        const p = join(keyDir, f.file);
        if (existsSync(p)) keys[f.keyId] = readFileSync(p, 'utf8');
      }
    } catch (err) {
      log.warn('trusted_keyring_load_failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }
  const revoked = new Set<string>();
  const revPath = process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS;
  if (revPath && existsSync(revPath)) {
    try {
      for (const entry of JSON.parse(readFileSync(revPath, 'utf8')) as string[]) revoked.add(entry);
    } catch (err) {
      log.warn('trusted_revocations_unreadable_failing_closed', { err: err instanceof Error ? err.message : String(err) });
      return { keys: {}, revoked };
    }
  }
  return { keys, revoked };
}

/** ADR 0367 P2 — verify arbitrary payload BYTES (the served plugin module)
 *  against a detached signature by a PINNED key. The manifest signature alone
 *  does not cover the code the T1 lane actually serves into the main frame;
 *  this closes that gap. Fail-closed: unknown key id or any crypto error ⇒ false. */
export function verifyDetachedPinned(bytes: Buffer, signature: Buffer, keyId: string, keyring: PinnedKeyring): boolean {
  const pem = keyring.keys[keyId];
  if (!pem) return false;
  try {
    return edVerify(null, bytes, createPublicKey({ key: pem, format: 'pem' }), signature);
  } catch {
    return false;
  }
}

/** The ADR 0367 trust boundary: verify `pack.json` against a PINNED key.
 *  Every failure path is closed; only a valid signature by a known key on a
 *  non-revoked version yields 'trusted'. */
export function verifyPinned(packDir: string, manifest: { name: string; version: string; signing?: SigningRefs }, keyring: PinnedKeyring): PinnedResult {
  const signing = manifest.signing;
  if (!signing?.signatureRef || !signing.keyId) return 'unsigned';
  if (keyring.revoked.has(`${manifest.name}@${manifest.version}`)) return 'revoked';
  const pem = keyring.keys[signing.keyId];
  if (!pem) return 'failed'; // unknown key id — the pack cannot vouch for itself
  const sigPath = join(packDir, signing.signatureRef);
  if (!existsSync(sigPath)) return 'failed';
  try {
    const signature = readFileSync(sigPath);
    const manifestBytes = readFileSync(join(packDir, 'pack.json'));
    const publicKey = createPublicKey({ key: pem, format: 'pem' });
    return edVerify(null, manifestBytes, publicKey, signature) ? 'trusted' : 'failed';
  } catch (err) {
    log.warn('pinned_signature_verify_error', { packName: manifest.name, err: err instanceof Error ? err.message : String(err) });
    return 'failed';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR 0660 D0/D1 — registry namespace authorization (the spec's step 4).
//
// `spec/v1/registry-operations.md:405-409` gives the resolver FOUR steps. This
// host implemented three: fetch the manifest, read `signing.keyId`, fetch that
// key from the issuing registry and verify. Step 4 — "The resolver MUST also
// verify the pack's name matches the key's allow-list" — had ZERO
// implementation (`permittedNamespaces` occurred nowhere in src), and it is the
// ONLY thing separating one publisher's namespace from another's, because steps
// 1-3 accept ANY key the registry serves. So a key issued for `acme.*` signed
// `core.openwop.*` and installed as `operator-trusted`.
//
// This lives here, not in `registryInstaller`, because `packSignature` is
// already the one owner of key material; the installer calls it and owns only
// fetch/extract, and `packTrust` stays the sole DISPATCH authority. One module,
// one namespace predicate.
//
// Note the direction: this is the ISSUING REGISTRY's allow-list, fetched from
// the registry, exactly as `registry-operations.md:398` requires ("NOT against
// a globally-trusted key store"). Trust roots are per-registry BY DESIGN; an
// operator restricting keys mirrors into a private registry (`:411`), and that
// mirror's `signingKeys[]` then IS the trust boundary.

/** One entry of a registry's `.well-known/openwop-registry.json` `signingKeys[]`. */
export interface RegistrySigningKey {
  keyId: string;
  permittedNamespaces?: string[];
}

/** Process-lifetime cache, keyed by registry base URL: a boot installs packs in
 *  parallel and must not fetch the same discovery doc N times. */
const discoveryCache = new Map<string, Promise<RegistrySigningKey[]>>();

/** Test affordance — never routed. */
export function __resetRegistryDiscoveryCache(): void { discoveryCache.clear(); resetRegistryEndpointCache(); }

async function fetchSigningKeys(registry: string): Promise<RegistrySigningKey[]> {
  // ONE fetch of this document per registry (ADR 0663): the installer reads
  // `endpoints` from the same body. This function keeps its OWN error
  // vocabulary — an unreachable registry or a document without `signingKeys[]`
  // is `pack_registry_unreachable` and fails closed, which is a different
  // question from whether `endpoints` is present.
  const url = `${registry}/.well-known/openwop-registry.json`;
  const doc = await fetchRegistryDocument(registry);
  if (!doc) throw new Error(`pack_registry_unreachable: ${url}`);
  if (!Array.isArray(doc.signingKeys)) {
    throw new Error(`pack_registry_unreachable: ${url} declares no signingKeys[]`);
  }
  return doc.signingKeys as RegistrySigningKey[];
}

/**
 * ADR 0660 D1 — refuse unless the registry authorizes this key for this pack's
 * namespace.
 *
 * Fail-closed on EVERY path, including an unreachable or unparseable discovery
 * document. A check that degrades to "allow" when the network hiccups is not a
 * check — it is the defect this decision exists to close, with a nondeterministic
 * trigger. `pack_signature_invalid` is the canonical code the spec names for a
 * namespace mismatch (`registry-operations.md:409`).
 *
 * Matching is prefix-with-dot-boundary or exact: `acme.*` and `acme` both admit
 * `acme.widgets` and neither admits `acmecorp.widgets`.
 */
export async function assertKeyPermittedForPack(
  registry: string,
  keyId: string,
  packName: string,
): Promise<void> {
  let keys: RegistrySigningKey[];
  const cached = discoveryCache.get(registry) ?? fetchSigningKeys(registry);
  discoveryCache.set(registry, cached);
  try {
    keys = await cached;
  } catch (err) {
    discoveryCache.delete(registry); // a failure must not be cached as a verdict
    throw err;
  }
  const entry = keys.find((k) => k.keyId === keyId);
  if (!entry) {
    throw new Error(`pack_signature_invalid: key ${keyId} is not in ${registry} signingKeys[]`);
  }
  const allowed = entry.permittedNamespaces ?? [];
  if (!allowed.some((ns) => namespaceAdmits(ns, packName))) {
    throw new Error(
      `pack_signature_invalid: key ${keyId} is not authorized for the namespace of ${packName}`,
    );
  }
}

/** `acme.*` / `acme` admit `acme` and `acme.widgets`, never `acmecorp.widgets`. */
function namespaceAdmits(ns: string, packName: string): boolean {
  const base = ns.endsWith('.*') ? ns.slice(0, -2) : ns === '*' ? '' : ns;
  if (base === '') return ns === '*';
  return packName === base || packName.startsWith(`${base}.`);
}
