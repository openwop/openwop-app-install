# ADR 0660 — Marketplace: the registry's namespace allow-list is unimplemented

Status: implemented (2026-09-11, feature loop it.13 — D0/D1/D3/D4/D6/D7 shipped; D2 withdrawn as non-conformant, D5's full cure gated on an RFC 0177 revision). Headline corrected pre-implementation after `/architect` — see the Context correction and the review record.
Date: 2026-09-11
Feature: Marketplace (FEATURES.md ordinal 13 of 71; toggle `marketplace`) · feature loop 2026-09 it.13
Plan input: `/grade-*` recon 2026-09-11, rows `MKT2-20`..`MKT2-30` (numeric — the letter forms `MKT2-B1/B2/M1/M2` are already taken by `docs/steward/UX_UPGRADE-marketplace.md` and cited in 12 source files)
Related: RFC 0168 §E.2 (the host's OWN bundle signing keys, outbound — the opposite direction), ADR 0657/0659 (the two prior iterations whose Blockers also lived in the decision text)

## Context

> ### CORRECTION (2026-09-11, before any code) — this ADR's first draft was titled
> **"the registry is not the trust anchor"** and treated registry-supplied key resolution as
> the headline defect. **That was wrong, and the `/architect` review caught it.**
> `../openwop/spec/v1/registry-operations.md:398` makes it a normative MUST *in the opposite
> direction*: "Resolvers MUST verify a fetched pack's signature against the public key URL
> declared in THAT pack's version manifest (which points back at the issuing registry's
> `/keys/<keyId>.pub`), **NOT against a globally-trusted key store**." `spec/v2/core/packs.md:56`
> (Stable, v2.1.0, RFC 0177) repeats it. **Trust roots are per-registry BY DESIGN**, and
> `registry-operations.md:411` names the operator's remedy: mirror the packs into a private
> registry that lists only the keys you trust.
>
> So "every link is supplied by the same party" is an accurate *description* of the model and
> not a defect — the on-disk key directory really is the cache its code comment says it is.
> Likewise, that the signature covers `pack.json` and not tarball bytes is deliberate:
> `packs.md:56` says "A signature over tarball bytes is not a v2 signature".
>
> **The narrative was compelling and one grep from the spec would have falsified it.** The
> real finding survives, and is narrower and sharper.

**The finding.** The spec's trust model has four operational steps
(`registry-operations.md:405-409`). This host implements three:

| Step | Implemented? |
|---|---|
| 1. Fetch the version manifest from registry R | yes |
| 2. Manifest declares `signing.keyId` + `publicKeyUrl` | yes |
| 3. Fetch R's public key, verify the signature | yes (`registryInstaller.ts:141-162`) |
| 4. **Verify the pack's name against that key's `permittedNamespaces`** in R's `.well-known/openwop-registry.json` | **NO — zero implementation** |

**MEASURED: `permittedNamespaces` occurs 0× in `backend/typescript/src`.** The installer never
fetches `.well-known/openwop-registry.json` and never reads `signingKeys[]`. Every
`signingKeys` hit in the backend is `routes/discovery.ts`, where the host advertises its OWN
bundle keys outbound (RFC 0168 §E.2) — the opposite direction, and easy to mistake for
coverage.

Step 4 is the **only** thing separating one publisher's namespace from another's, because
steps 1–3 accept any key the registry serves. So today **a key legitimately issued for
`acme.*` signs `core.openwop.*`**, installs, and is minted `operator-trusted`
(`packTrust.ts:31`). The spec is explicit that this fails with `pack_signature_invalid`
(`registry-operations.md:409`). This is a normative MUST violated, and a privilege
escalation inside the model the spec defines.

### Why no test would catch it, or any sibling
`installPackFromRegistry` is **mocked in every test that touches it**
(`marketplace-route.test.ts:20`, `workflow-chain-pack-install-route.test.ts:19`);
`marketplace-install-error.test.ts` covers only error-string mapping. There is no witness
that a bad signature, a wrong-namespace key, or a tampered tarball is refused.

### What is genuinely weak, stated precisely (and NOT over-claimed)
- The tarball's expected hash (`integrity`) lives in the registry's **unsigned** version
  manifest (`registry-version-manifest.schema.json:153`). The signed artifact is `pack.json`.
  So the tarball is authenticated only transitively.
- `index.mjs` **is** bound after install: `registryInstaller.ts:209-231` records its hash in
  the install marker and `packTrust.ts:283-296` re-verifies it on every load. It is bound to
  *the bytes we installed*, not to a publisher signature — a real distinction, and a much
  smaller one than the first draft claimed.

## Decision

### D0 — one owner for key material and namespace authorization (review S2)

`packTrust.ts:1-8` already declares itself "the SOLE authority on whether a pack's code may
execute". To avoid a second trust owner: **`packSignature.ts` owns key material and namespace
authorization** behind one `resolveInstallKey(keyRef, packName, registry)`;
`registryInstaller.ts` calls it and owns only fetch/extract; `packTrust.ts` remains the sole
*dispatch* authority. No module gets a second copy of the namespace predicate.

### D1 — implement step 4: enforce `permittedNamespaces` (`MKT2-30`, Blocker)

The installer fetches `${registry}/.well-known/openwop-registry.json`, finds the entry for the
manifest's `keyId`, and verifies the pack name against that key's `permittedNamespaces`.
A mismatch is `pack_signature_invalid` — the canonical code the spec names
(`registry-operations.md:409`).

**Failure semantics, stated (review B4 — the document exists nowhere today: no fixture in
either repo, and this host has never fetched it):** a *reachable* document is authoritative;
an *unreachable or unparseable* one is a **typed refusal**, never a pass, because a check that
degrades to allow is the defect this ADR exists to close. The document is cached per-registry
for the process lifetime, so a boot's parallel installs (`installRegistryPacks.ts:109`) make
one fetch, not N. **A checked-in fixture ships with the witnesses in D6, before the gate.**

### D2 — the operator's control is the spec's own: a private mirror (REPLACES the first draft)

> **The first draft of D2 said: delete the registry key fetch, resolve through the host's
> pinned keyring, refuse when none is configured. The review found two independent Blockers
> and it is withdrawn.**
>
> **(B2, wire)** It contradicts `registry-operations.md:398`'s normative MUST and
> `spec/v2/core/packs.md:56`. Shipping it would make this host non-conformant on the packs
> family while the ADR claimed to be "implementing the spec".
> **(B1, outage)** It would refuse every install in every environment that exists today.
> `OPENWOP_TRUSTED_PACK_KEYS_DIR` is read at exactly one site (`packSignature.ts:79`), nothing
> under `packs/` imports `loadPinnedKeyring`, and the two speak different formats (flat
> `<keyRef>.pub` vs `index.json` + `{keyId,file}[]`). All three installer callers pass a
> hard-coded cwd-relative `../../../registry/keys` that exists in neither repo nor the image,
> so **the fetch has always been the only key source**. `deploy/trusted-keys/` holds one
> frontend-plugin key and the `Dockerfile` never COPYs it. Boot installs feature-declared
> `requiredPacks` even under `OPENWOP_INSTALL_PACKS='none'` and swallows failures at `warn`
> (`installRegistryPacks.ts:39-42,122-128`) — so the outage would present as a missing
> feature, not a trust refusal.

The conformant control, which the spec names at `registry-operations.md:411`: an operator who
wants a subset of keys **mirrors** the packs into a private registry listing only those keys,
and pins `OPENWOP_REGISTRY_URL` to it. With D1 shipped, the mirror's `signingKeys[]` IS the
trust boundary — exactly as `registry-operations.md:413` says. This ADR therefore ships
**documentation + the pin**, not a host keystore. A host-side trust-anchor override remains
defensible but needs an **RFC 0177 revision** first; recorded, not built.

### D3 — verify-one / install-another (`MKT2-23`, Improvement-high)

`extractPackJsonFromTarball` returns the FIRST root `pack.json` entry (`:292`) while
`tar -xzf` lets the LAST win on disk, so the signature and `assertCanonicalManifest` can both
validate a file that is then overwritten. After extraction, re-hash `destDir/pack.json` against
the verified bytes and refuse on any difference. Verified implementable: `copyAllowlistedFiles`
(`:324-339`) is a byte copy and `packJsonSha` is already computed at `:208`, so this cannot
spuriously fail. **Scope, stated:** this binds `pack.json` only — `index.mjs` has no verified
reference bytes to compare against, and is covered by the install marker (D5), not a signature.

### D4 — the third install lane (`MKT2-22`, Blocker)

`routes/workflows.ts:929-948` passes only `{ packDir }`: no `isSafePackName` (so the name
reaches `rmSync(destDir,{recursive,force})` at `:204`), no tombstone check, no registry URL.
It gets the same call shape as its two siblings. Superadmin-gated, so this is an operator
footgun and a tombstone bypass, **not** tenant-reachable — say so rather than inflating it.
Verified safe: `isSafePackName` (`:424-435`) admits dotted names like
`core.openwop.workflows.approvals`, so the guard does not break the legitimate use.

### D5 — say what the trust tier actually means (REWRITTEN per review B3)

> **The first draft said `packTrust.ts` "stops minting `operator-trusted`". Withdrawn — the
> premise was wrong and the change was a self-inflicted outage.** `operator-trusted` is minted
> on the install-marker **content-hash re-verification** (`packTrust.ts:283-296`), and the
> marker **does** cover `index.mjs` (`registryInstaller.ts:209-231`). It is also the only tier
> a registry-installed pack can reach — `steward` requires a `.steward-manifest.json` entry and
> **zero of 211 rows are registry-installed** — and `tierIsTrusted` is what sets
> `dispatchable: true` (`:75,201-203,232-233`). Deleting it would make every registry pack
> `untrusted` and non-dispatchable.

`packTrust.ts` **keeps** minting `operator-trusted`. What changes is honesty about what it
attests: `install_marker_verified` means "matches the bytes we installed", and those bytes were
authenticated by a signature over `pack.json` plus a tarball hash from an **unsigned** version
manifest. The listing stops presenting `integrity`/`publicKeyRef` as a verification claim
(`MKT2-27`, `listingService.ts:42,219-242`) — it is an unverified marker read, and
`verifyInstalledPack()` exists and is never called there.

### D6 — stop mocking the thing under test (`MKT2-25`, Improvement)

Real refusal witnesses, all writable without network by stubbing `fetch` (the installer already
takes `registry` as an option): wrong-namespace key, unreachable well-known document,
duplicate-`pack.json` tarball, traversal pack name, bad signature, bad SRI. Plus a ratchet
asserting `installPackFromRegistry` is NOT in the `vi.mock` factory of at least one route test,
so this decision cannot silently regress.

### D7 — the model-facing lanes and the error mapping (`MKT2-26`, `-27`, `-29`, review S1)

`tombstoned` is dropped by `project()` in BOTH model lanes (`surface.ts:18-33`,
`agentTools.ts:34-59`) — the identical shape already fixed once for `origin` — so the
recommender recommends a pack the operator removed. Carry it.

**Every new refusal string is added to BOTH error mappers** (`marketplace/routes.ts:295-310`
and its separately-drifting copy `routes/workflows.ts:74`), or to a shared one, and lands as
`validation_error` 422. Today an unmapped string falls through to `runner_unavailable` **502
carrying the raw message** — so a security refusal would be indistinguishable from a network
blip *and* would leak the registry URL.

## `/architect` review record (2026-09-11, before code)

Four Blockers, five SHOULD/NITs — the fourth iteration running where the Blockers lived in the
decision text rather than the diff, and the first where a Blocker **overturned the ADR's own
headline**:

1. **B2 (wire)** — D2 contradicted a normative MUST the ADR claimed to be implementing. Trust
   roots are per-registry by design; the private mirror is the spec's prescribed operator
   control. The title and the entire framing were wrong.
2. **B1 (outage)** — D2 would have refused every install everywhere: no keyring exists at any
   path, the named env var feeds a different module with an incompatible format, and boot
   failures are swallowed at `warn`, so it would present as a missing feature.
3. **B3 (security)** — D5's premise was false. The install marker DOES cover `index.mjs`, and
   `operator-trusted` is the only tier a registry pack can reach, so removing it was a
   dispatch outage rather than a hardening.
4. **B4 (failure modes)** — D1 depended on a document that exists in neither repo, with no
   stated semantics for absent-or-unparseable.

Also folded: S1 (both error mappers, or a security refusal reads as a 502 blip and leaks the
registry URL), S2 (D0, one owner for the namespace predicate), S3 (D3's scope qualifier), S4
(RFC **0177 revision**, not a new RFC — `spec/v2/core/packs.md` is Stable v2.1.0), N1 (delete
the three dead `trustedKeysDir` literals).

**What survived attack:** `MKT2-30` — step 4 of the spec's own trust model is unimplemented,
and it is the only thing separating publisher namespaces. That is the real finding, and D1
closes it as a conformance fix rather than as invented policy.

**Lesson for this file:** the first draft assembled a compelling chain-of-custody narrative
out of four separately-true observations and never checked the document that defines the
model. The spec was one grep away, and it says the opposite. A narrative that explains
everything is the shape most in need of a falsifying read.

## Open questions

1. ~~D2's migration~~ — **withdrawn with D2.** The conformant control is the private mirror.
2. ~~Does any deployment rely on the fetch fallback?~~ — **ANSWERED by measurement, not a
   question:** every one does. The local key branch has never resolved in dev, CI or the
   image, so the fetch is the only key source that has ever fired.
3. **ANSWERED (review S4): record it, file separately.** The artifact is an **RFC 0177
   revision** amending `spec/v2/core/packs.md` §Signing — not a new RFC into empty space — and
   it is not on the critical path for D1/D3/D4/D6/D7.
4. Should the mirror posture be documented in `README.md` § pack registry, or only in this
   ADR? (Leaning README — it is operator-facing configuration, not a host decision.)

## Implementation record (2026-09-11)

| Decision | Landed in | Witness (born red, sabotage-proven) |
|---|---|---|
| D0/D1 — `packSignature` owns key material AND namespace authorization; the installer calls it; `packTrust` stays the sole dispatch authority | `host/packSignature.ts` (`assertKeyPermittedForPack`, `RegistrySigningKey`, per-registry cache, `__resetRegistryDiscoveryCache`), `packs/registryInstaller.ts` step 5a | `test/registry-install-namespace-authz.test.ts` — wrong namespace refused; **control**: same key + same signature + authorized namespace installs; key absent from `signingKeys[]` refused; unreachable discovery doc is a typed refusal; `acme.*` does not admit `acmecorp.*`. Sabotage: remove the call ⇒ 4 red, and the wrong-namespace pack **installs** |
| D3 — re-hash `pack.json` after extraction | `registryInstaller.ts` (post-`copyAllowlistedFiles`) | duplicate-root-`pack.json` tarball (benign first, hostile last) ⇒ `pack_integrity_mismatch`. Sabotage: no-op the compare ⇒ red |
| D4 — the third install lane's missing guards | `routes/workflows.ts:929-948` (`isSafePackName`, `isTombstoned`, registry override) | `workflow-chain-pack-install-route.test.ts` — traversal names 400 **before** the installer is reached; a tombstoned pack 409, with a restore **control**. Sabotage: disable both guards ⇒ 2 red |
| D7 — `tombstoned` survives both model projections | `marketplace/{surface,agentTools}.ts` | carried in the projection + the tool description now tells the model never to recommend one |

**Deliberately not shipped, and why:**
- **D2 (the first draft's centrepiece) is WITHDRAWN** — it contradicted a normative MUST
  (`registry-operations.md:398`) and would have refused every install in every environment.
  The conformant control is the private mirror the spec itself prescribes (`:411`).
- **D5's full cure** needs an **RFC 0177 revision** amending `spec/v2/core/packs.md` §Signing;
  `packTrust` correctly keeps minting `operator-trusted` (removing it was a dispatch outage
  on a false premise). `MKT2-24`, `-27`, `-28`, `-29` and the rest of `-25` stay open.

**Gate:** 1949 passed; 3 failures, all contention (two 15 s test timeouts and the shell
harness under a peer fleet) — all three green alone (13 tests).

**Lesson, recorded because it cost the headline:** the first draft assembled four
separately-true observations into a chain-of-custody narrative that explained everything,
and never read the document defining the model. It was one grep away and said the opposite.
A narrative that explains everything is the shape most in need of a falsifying read.
