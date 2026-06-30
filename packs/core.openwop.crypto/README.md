# core.openwop.crypto

Pure cryptographic primitives that workflow authors reach for: hashing, HMAC, AEAD encryption, signing, JWT, TOTP, x509 parsing. Built entirely on `node:crypto` (Node 20+ — zero npm deps).

These nodes are **pure with respect to keys passed in via inputs**. They are NOT a key store. If you need long-lived signing keys, resolve them via the host secret resolver (see `spec/v1/auth.md` and `node-packs.md` §"Per-node `requiresSecrets[]`") and pass them in as inputs.

Webhook signature verification (Stripe / GitHub / Slack style) lives in `core.openwop.http` as `http.webhook.verify` — this pack provides the raw HMAC primitive it composes on top of.

## TypeIds

| typeId | role | purpose |
|---|---|---|
| `core.crypto.hash` | pure | sha-256 / sha-384 / sha-512 / sha-1 / md5 / blake2b512. |
| `core.crypto.hmac-sign` | pure | HMAC-SHA-256/384/512 sign. Hex or base64 output. |
| `core.crypto.hmac-verify` | pure | Constant-time HMAC verify against a provided signature. |
| `core.crypto.aead-encrypt` | side-effect | AES-256-GCM / ChaCha20-Poly1305 encrypt with optional AAD. Non-deterministic (fresh random nonce/call) → `side-effectful`, not `cacheable`. |
| `core.crypto.aead-decrypt` | pure | Authenticated decrypt; rejects tampered ciphertext. |
| `core.crypto.sign` | pure | Asymmetric sign (Ed25519, RS256, ES256). |
| `core.crypto.verify` | pure | Asymmetric verify. |
| `core.crypto.jwt-mint` | side-effect | Mint a JWT (HS256/384/512, RS256, ES256, EdDSA). Time-dependent (`iat`/`exp`) → non-deterministic. |
| `core.crypto.jwt-verify` | side-effect | Verify a JWT including `exp`/`nbf`/`iss`/`aud` claim checks. Reads the wall clock → non-deterministic. |
| `core.crypto.totp-generate` | side-effect | RFC 6238 TOTP code generator. Time-step-dependent → non-deterministic. |
| `core.crypto.totp-verify` | side-effect | TOTP verify with configurable drift window. Reads the wall clock → non-deterministic. |
| `core.crypto.x509-parse` | pure | Parse a PEM x509 cert and return issuer / subject / SAN / fingerprint / validity. |
| `core.crypto.x509-verify-chain` | pure | Verify a leaf cert chains to one of N trust roots. |

## Replay & caching

The deterministic primitives (hash, HMAC, sign/verify, x509) are `cacheable`: a workflow that computes the same hash/HMAC twice gets the same result by construction. The non-deterministic nodes are `role: side-effect` / `side-effectful` instead — their output is recorded, so a replay/fork reads the recorded result rather than recomputing:

- `core.crypto.aead-encrypt` — fresh random nonce per call (re-encrypting would yield different ciphertext);
- `core.crypto.jwt-mint`, `core.crypto.jwt-verify`, `core.crypto.totp-generate`, `core.crypto.totp-verify` — all read the wall clock (`iat`/`exp`/`nbf`, the TOTP time-step), so the same inputs verify/mint differently as time passes.

## Compliance posture

Algorithms exposed are the IETF-recommended modern set; deprecated algorithms (SHA-1, MD5) are kept available behind an explicit `algorithm` choice for legacy interop but are flagged in spec docs. RSASSA-PKCS1-v1_5 is offered as `RS256`; PSS is `PS256`. Curve selection: `P-256` for ES256, `Ed25519` for EdDSA.
