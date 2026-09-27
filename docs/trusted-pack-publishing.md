# Trusted (Tier-1) plugin packs — review, signing, and operations

> ADR 0367. This is the policy + recipe document the trust tier depends on:
> a Tier-1 pack runs **arbitrary JavaScript in the authenticated main frame**,
> so the signature is the security boundary — and a signature is only as good
> as the review behind it, the custody of the key that made it, and the
> operator's ability to revoke it. All three live here.

## The three tiers (recap)

| Tier | What runs | Gate |
|---|---|---|
| T0 first-party | compiled features (ADR 0001 / ADR 0366 distributions) | code review + CI |
| **T1 reviewed+signed** | a pack's `entry.mjs` dynamic-imported into the MAIN frame | `trusted-plugins` toggle + per-serve pinned-key verification (manifest **and** module bytes) + revocation check |
| T2 community | the ADR 0300 sandbox (opaque-origin iframe, deny-egress CSP, host-RPC allowlist) | `ui-plugins` toggle |

Absence of a valid signature ⇒ T2, always. Every T1 failure path (toggle off,
unsigned, unknown key, tampered, revoked) is a uniform 404 from the trusted
route; the same pack keeps serving its Tier-2 `entry.html` fallback.

## Review checklist (sign NOTHING that hasn't passed this)

Signing a version is a claim that a **human reviewed that exact artifact**.
Per version — an update is unsigned until re-reviewed; there is no auto-carry:

- [ ] **Read every byte of `entry.mjs`** (and anything it inlines). It will run
      with the user's session in the main frame — treat it like a change to
      the app's own source.
- [ ] **No external egress**: no `fetch`/`XHR`/WebSocket/beacon to any origin,
      no dynamic `import()` of remote URLs, no injected `<script>`/`<link>`.
- [ ] **No credential surface**: never reads storage/cookies it doesn't own,
      never touches BYOK material, never exfiltrates DOM contents.
- [ ] **Mount contract honored**: `export function mount(el)` renders inside
      `el` only, returns a cleanup that fully unmounts; no globals leaked, no
      listeners left behind.
- [ ] **Design-system discipline**: token classes only (`surface-card`,
      `chip`, …), no raw color literals, dark-mode parity.
- [ ] **Manifest matches reality**: `pack.json` name/version reflect the
      reviewed artifact; the Tier-2 `entry.html` fallback exists and degrades
      honestly.

## Signing recipe (publisher side)

The private key lives **offline** (`~/.openwop-keys/openwop-team-1.private.pem`
on the steward machine) and never enters the repo, CI, or any container image.

```bash
cd packs/<pack-dir>
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
const key = createPrivateKey(readFileSync(process.env.HOME + '/.openwop-keys/openwop-team-1.private.pem'));
writeFileSync('pack.json.sig', sign(null, readFileSync('pack.json'), key));   // identity+version
writeFileSync('entry.mjs.sig', sign(null, readFileSync('entry.mjs'), key));  // the CODE actually served
"
```

Then write/refresh the `pack.sig.json` sidecar (the manifest schema is
wire-pinned — signing refs live ONLY here):

```json
{
  "alg": "ed25519",
  "keyId": "openwop-team-1",
  "manifest": "pack.json",
  "signatureFile": "pack.json.sig"
}
```

Both signatures cover **exact bytes** — any re-serialization (formatter,
editor, `jq`) invalidates them. The committed reference pack
(`packs/vendor.openwop.trusted-demo`) is pinned end-to-end by
`backend/typescript/test/trusted-pack-committed.test.ts`, so a byte-drift
shows up as a red CI, not a silent fall-back to sandbox.

## Operator enablement (deployment side)

1. **Pin the publisher key(s)** — a directory of PEM public keys plus an
   index, mounted read-only:
   ```
   deploy/trusted-keys/
     index.json                 # [{ "keyId": "openwop-team-1", "file": "openwop-team-1.pub.pem" }]
     openwop-team-1.pub.pem
   ```
   ```bash
   OPENWOP_TRUSTED_PACK_KEYS_DIR=/path/to/trusted-keys
   ```
   Absent/empty keyring ⇒ every pack fails closed to Tier-2.
2. **Turn the lane on** — enable the `trusted-plugins` feature toggle
   (superadmin → Feature toggles; default OFF). This is the kill switch: turn
   it off and every pack is back in the sandbox on the next request — no
   redeploy.
3. **Verify live**: `GET /v1/host/openwop-app/ui-plugin/packs` labels the pack
   `"tier": "trusted"` with a `trustedEntryPath`; the `/ui-plugins` page mounts
   it main-frame.

## Key custody, rotation, revocation

- **Custody**: private keys stay offline with the steward; the repo carries
  ONLY public keys. A leaked private key compromises every deployment that
  pins it — treat it like a signing CA key.
- **Rotation**: mint `openwop-team-2`, add it to the keyring `index.json`
  alongside `-1`, re-sign new versions with `-2`, and drop `-1` from the
  keyring once nothing pinned still needs it. The verifier is multi-key by
  design (`keyId` addresses the ring).
- **Revocation** (compromised or misbehaving version): add
  `"<packName>@<version>"` to the JSON array file named by
  `OPENWOP_TRUSTED_PACK_REVOCATIONS`. Checked at **every serve** (responses
  cache at most 60s), no redeploy. Revoked ⇒ uniform 404 on the trusted lane;
  the sandbox fallback keeps working.
- **Emergency stop**: the `trusted-plugins` toggle turns the whole lane off at
  runtime.

## Stated residual risks

- **Browser module cache**: revocation and the kill switch stop the module
  from being SERVED, but a SPA session that already dynamic-imported it keeps
  the loaded code until the page reloads. Revocation bounds new exposure
  (≤60s serve cache + page lifetime), not code already running.
- **The image does not vendor the keyring**: `deploy/trusted-keys/` is repo
  reference material; a deployment trusts nothing until the operator mounts a
  keys dir and sets `OPENWOP_TRUSTED_PACK_KEYS_DIR` (deliberate — trust is an
  operator decision, never a build artifact).
- **Revocation-file failure fails closed**: if the configured revocation list
  is unreadable/malformed, the verifier empties the keyring — every pack
  drops to the sandbox until the file is fixed (never "no revocations").
