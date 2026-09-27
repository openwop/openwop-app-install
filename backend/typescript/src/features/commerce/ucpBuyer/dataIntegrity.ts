// ADR 0254 — W3C Data-Integrity primitives for the conformant `eddsa-jcs-2022` cryptosuite
// (VC-DI-EDDSA), replacing the prior raw-EdDSA-over-JSON.stringify proof. Self-contained
// (no external dependency): JCS canonicalization (RFC 8785), base58-btc multibase, and
// Ed25519 `did:key` — so a relying party verifies from the proof alone (the did:key IS the
// key; no DID-resolver infra needed).
//
// Scope note: the JCS serializer below is complete for the mandate value space (objects,
// arrays, strings, booleans, and INTEGER numbers — all AP2 amounts are minor-unit
// integers). It rejects non-integer/non-finite numbers rather than risk a non-canonical
// float rendering (RFC 8785 §3.2.2.3 ECMAScript number formatting is out of scope here).

import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ED25519_MULTICODEC = Uint8Array.from([0xed, 0x01]); // multicodec prefix for an Ed25519 public key

// ── JCS canonicalization (RFC 8785, restricted to the mandate value space) ────

export function jcsCanonicalize(value: unknown): string {
  return serialize(value);
}
function serialize(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      throw new Error('jcsCanonicalize: only finite integer numbers are supported in this value space');
    }
    return String(v);
  }
  if (typeof v === 'string') return serializeString(v);
  if (Array.isArray(v)) return `[${v.map(serialize).join(',')}]`;
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    // RFC 8785 §3.2.3 — sort members by UTF-16 code-unit of the key.
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${serializeString(k)}:${serialize(obj[k])}`).join(',')}}`;
  }
  throw new Error(`jcsCanonicalize: unsupported value type ${typeof v}`);
}
function serializeString(s: string): string {
  // RFC 8785 §3.2.2.2 — JSON string escaping with the minimal escape set.
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

// ── base58-btc + multibase ────────────────────────────────────────────────────

export function base58btcEncode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}
export function base58btcDecode(str: string): Uint8Array {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < str.length; i++) {
    const val = BASE58_ALPHABET.indexOf(str[i]);
    if (val < 0) throw new Error(`base58btcDecode: invalid character '${str[i]}'`);
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + bytes.length - 1 - i] = bytes[i];
  return out;
}
/** Multibase base58-btc (the 'z' prefix the VC-DI suites use). */
export function multibase58(bytes: Uint8Array): string { return `z${base58btcEncode(bytes)}`; }
export function multibase58Decode(str: string): Uint8Array {
  if (!str.startsWith('z')) throw new Error("multibase58Decode: expected a 'z' (base58-btc) prefix");
  return base58btcDecode(str.slice(1));
}

// ── Ed25519 did:key ───────────────────────────────────────────────────────────

/** Raw 32-byte Ed25519 public key from a public KeyObject (via its JWK `x`). */
function rawEd25519Public(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('not an Ed25519 public key');
  return new Uint8Array(Buffer.from(jwk.x, 'base64url'));
}
export function ed25519DidKey(publicKey: KeyObject): string {
  const raw = rawEd25519Public(publicKey);
  const prefixed = new Uint8Array(ED25519_MULTICODEC.length + raw.length);
  prefixed.set(ED25519_MULTICODEC, 0);
  prefixed.set(raw, ED25519_MULTICODEC.length);
  return `did:key:${multibase58(prefixed)}`;
}
/** Resolve a `did:key:z…` (or its `#…` fragment) back to an Ed25519 public KeyObject. */
export function publicKeyFromDidKey(didKey: string): KeyObject {
  const id = didKey.split('#')[0];
  const mb = id.replace(/^did:key:/, '');
  const decoded = multibase58Decode(mb);
  if (decoded[0] !== ED25519_MULTICODEC[0] || decoded[1] !== ED25519_MULTICODEC[1]) {
    throw new Error('did:key is not an Ed25519 key (unexpected multicodec)');
  }
  const raw = decoded.slice(2);
  const jwk = { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') };
  return createPublicKey({ key: jwk, format: 'jwk' });
}

// ── eddsa-jcs-2022 sign / verify ──────────────────────────────────────────────

function sha256(s: string): Buffer { return createHash('sha256').update(Buffer.from(s, 'utf8')).digest(); }

/** The VC-DI-EDDSA hashing: SHA-256(JCS(proofConfig)) ‖ SHA-256(JCS(document)). */
function hashData(document: unknown, proofConfig: Record<string, unknown>): Buffer {
  return Buffer.concat([sha256(jcsCanonicalize(proofConfig)), sha256(jcsCanonicalize(document))]);
}

export interface EddsaJcsProof {
  type: 'DataIntegrityProof';
  cryptosuite: 'eddsa-jcs-2022';
  created: string;
  verificationMethod: string; // a did:key resolving to the signing key
  proofPurpose: 'assertionMethod';
  proofValue: string;         // multibase base58-btc of the Ed25519 signature
}

/** Produce an eddsa-jcs-2022 Data-Integrity proof over `document` (which must NOT contain a
 *  `proof`). `privateKeyPem` is a PKCS8 Ed25519 key. */
export function signEddsaJcs2022(document: unknown, privateKeyPem: string, created: string): EddsaJcsProof {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the AP2 signing key must be Ed25519');
  const did = ed25519DidKey(createPublicKey(key));
  const proofConfig: Record<string, unknown> = {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created,
    verificationMethod: `${did}#${did.replace(/^did:key:/, '')}`,
    proofPurpose: 'assertionMethod',
  };
  const signature = edSign(null, hashData(document, proofConfig), key);
  return { ...(proofConfig as unknown as EddsaJcsProof), proofValue: multibase58(new Uint8Array(signature)) };
}

/** Verify an eddsa-jcs-2022 proof against `document` (the secured doc, WITHOUT the proof). */
export function verifyEddsaJcs2022(document: unknown, proof: EddsaJcsProof): boolean {
  try {
    if (proof.type !== 'DataIntegrityProof' || proof.cryptosuite !== 'eddsa-jcs-2022') return false;
    const { proofValue, ...proofConfig } = proof;
    const pub = publicKeyFromDidKey(proof.verificationMethod);
    const signature = multibase58Decode(proofValue);
    return edVerify(null, hashData(document, proofConfig as Record<string, unknown>), pub, signature);
  } catch { return false; }
}
