# ADR 0826 — Marketplace supply chain: a pack gets only what it ships, curation is a write, and revocation exists

Status: Accepted (2026-10-05) — implemented on `feat/fl2-17-marketplace` (D1–D8, plus the /architect, /grade-code and /grade-ux rounds). See § Implementation record. Feature-loop 2026-10 row 17 (`docs/steward/FEATURE-LOOP-2026-10.md`).

- **Extends:** `marketplace` (ADR 0022), so the toggle id is unchanged and there is no new toggle. It also extends the core
  registry seam `core:registry` (`packs/registryInstaller.ts`, `host/packTrust.ts`, `host/packRevocations.ts`).
- **Composes:** ADR 0555 (pack trust tiers, revocation store), ADR 0660 (namespace authorization, verify-one/install-another),
  ADR 0663/0713 (v2 registry tree + signing), ADR 0194 (enablement, tombstones), ADR 0775 (`requireTenantWrite`),
  ADR 0815 (ws: authority), ADR 0385/0574 (paid-listing approval: verified, not changed).
- **Supersedes nothing.**
- **Wire:** untouched. Every route is under `/v1/host/openwop-app/*`. `MKT2-21` (the signature covers `pack.json` only, not
  `index.mjs`) stays **RFC-gated**: `spec/v2/core/packs.md` §Signing defines the signed bytes, and a host cannot widen
  them unilaterally.

## Context — what was measured

Round 1 graded this feature B− / B+ / B−, with security at **C+**. The prior pass's open rows (`MKT2-24/-27/-28/-29`) and a
fresh probe pass are recorded in `docs/steward/WORKFLOWS-ASSESSMENT.md` § "Marketplace + pack registry (2026-10-05)". Three probes
ran RED on `origin/main f4b07997f` (real installer, real `tar`, real HTTP app):

| Probe | Result on main |
|---|---|
| **P1** A signed pack ships `prompts/sys.md` → a symlink to a host file | **Installs.** `copyAllowlistedFiles` copies subdirs with `cp -R`, which keeps symlinks (`packs/registryInstaller.ts:470`). `agentLoader.resolveRef` checks containment *lexically*, then `statSync`/`readFileSync` follow the link (`packs/agentLoader.ts:59-77`). The host file's bytes become the agent's `systemPrompt`, which `/v1/packs/export` serves (`routes/packs.ts:45`). A **data-only** pack (agent persona, prompts) gains host file read it never declared. |
| **P2** A **Viewer** in a shared `ws:` workspace calls `PUT /marketplace/pack-enablement/:pack {enabled:false}` | **200**, and the owner then sees the pack disabled. The route checks only `resolveCallerUser` (`features/marketplace/routes.ts:153`). A read-only member curates authoring availability for everyone. |
| **P3** Anonymous `GET /v1/host/openwop-app/registry/agent-packs` | **200** (`routes/agentPackRegistry.ts:54`): there is no auth check. It discloses first-party pack names and personas only. |

Measured by reading the code:

- **Revocation is a documented kill switch with no handle.** `revokePack` has **zero non-test callers**
  (`host/packRevocations.ts:65`). Its header says the store is "a RUNTIME action that propagates across instances", but the
  cache reloads only on the instance that wrote it. The installer never consults it. And a node pack that is already imported
  keeps dispatching after a revocation until the process restarts, because the trust verdict is taken once at import
  (`packs/tarballLoader.ts:118`) and is never re-read at `execute`.
- **The install marker covers two files** (`MKT2-24`). `contentHashes` binds `pack.json` and `index.mjs`, and binds
  `index.mjs` only `if (existsSync(...))`. So editing `prompts/`, `schemas/` or `keys/`, or adding an `index.mjs` after the
  install, leaves the pack `operator-trusted`. ADR 0555 already built the right hasher (`packs/packContentDigest.ts`, whole
  tree, symlink-aware). The install marker just never used it.
- **Three install lanes, three hand-copied preflights** (`GEN-MKT-1`, the fifth sibling-lane drift in this program):

  | Check | marketplace `/install` | agent-pack lane | chain-pack lane |
  |---|---|---|---|
  | `isSafePackName` | yes | yes | yes |
  | semver `version` | **no** | yes | **no** |
  | tombstone | yes | **no** | yes |
  | `trustedKeysDir` | yes | yes | **no** |
  | error mapping | yes | **no** | **no**: raw message with registry URL (`MKT2-29`) |

- **The listing claims a verification it never performed** (`MKT2-27`). `installed: marker !== null` and the `integrity` /
  `publicKeyRef` it shows come from a raw marker *read* (`listingService.ts:213-221`). `classifyPackDir`, the sole trust
  authority, is never asked.
- **The recommender ignores the workspace's own curation** (`MKT3-4`). The agent tool and `ctx.features.marketplace` project
  every listing, including packs the workspace disabled.
- **Paid-listing approval gate: verified, not changed.** Both paid lanes (`external-link`, `native-paid`) enter `pending`
  (`commerce-connect/listings.ts:142-151`). Browse annotates approved rows only (`listingPricingFor`, `:309-317`). Seller
  writes run `assertFoldEligibleTenant` first (`:105`), so an `anon:` tenant cannot list. Pricing is approved by a
  superadmin, never by the seller. No change.
- **Registry SSRF: no tenant-reachable surface.** The registry URL comes only from `OPENWOP_REGISTRY_URL` (operator env).
  No route accepts a registry URL, and `certify` lints a manifest body without fetching anything. So no egress guard is
  needed, and none is added.
- **Stored XSS: none found.** Listing text, reviews and seller fields render as React text. The one `href`
  (`externalPaymentUrl`, `MarketplaceViews.tsx:164`) is `^https://`-validated at write (`listings.ts:122`), and shown only
  after operator approval.

### Competitive frame (what the leaders do that we lacked)

| Leader | Mechanism | Our gap → decision |
|---|---|---|
| VS Code Marketplace | Kill list: a verified-malicious extension is removed and **auto-uninstalled from every client** ([Extension runtime security](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security); [Security and Trust in Visual Studio Marketplace](https://developer.microsoft.com/blog/security-and-trust-in-visual-studio-marketplace/)). | Revocation has no handle, doesn't propagate, doesn't stop a loaded pack → **D5** |
| VS Code Marketplace | Whole-package signature verified at install. | Our signature covers `pack.json` only (RFC-gated, `MKT2-21`). The host binds the whole installed tree at install → **D3** |
| npm | `npm audit signatures`: registry signature + provenance verification; a visible provenance badge ([npm provenance walkthrough](https://safeguard.sh/resources/blog/npm-provenance-attestations-walkthrough-2026)). | The listing shows "installed" from marker presence, not verification → **D6** (show the real trust tier) |
| Shopify App Store | Declared access scopes are approved at install, and re-approved on scope change ([Manage access scopes](https://shopify.dev/docs/apps/build/authentication-authorization/app-installation/manage-access-scopes)). | A data-only pack reads host files it never declared → **D2** (closed world: a pack gets only the bytes it ships). An install-time capability-consent screen is **deferred** (OQ-1). |
| Zapier / Shopify | Public listings pass a review queue. | Already true for both paid lanes (verified above). |

## Decision

### D1 — Curation is a workspace write

`PUT /marketplace/pack-enablement/:pack` calls `requireTenantWrite(req)` (ADR 0775 D1: `workspace:write` in the active
tenant; the personal-workspace owner passes through `isOwnPersonalWorkspace`; a person is judged by both identity
spellings). `GET` stays readable by any member. Both `GET /pack-enablement` and `GET /listings` gain a
`viewer: { canCurate, canAdminister }` block. `canCurate` is computed by **the same** `callerHoldsTenantScope`
predicate, and `canAdminister` by the same `isSuperadmin`, so the UI never offers a control the route refuses.
`canAdminister` covers install, remove, restore, purge and revoke.

### D2 — A pack gets only the bytes it ships (closed world at install, and contained at read)

1. **Install refuses** any staged entry that is not a regular file or a directory, i.e. symlinks, hardlinks (`nlink > 1` on a
   regular file) and fifos/devices. It walks the extracted pack root with `lstat` **before** anything is copied. The error is
   `pack_content_refused: <relpath> is a <kind>`, mapped to 422. No published first-party pack ships a link (verified in P1
   below), so nothing legitimate regresses.
2. **Copy without following.** The subdir copy moves from `cp -R` to `fs.cpSync(…, { recursive: true, dereference: false,
   verbatimSymlinks: true })` behind (1). Removing the subprocess removes the platform-dependent `cp` semantics.
3. **Readers contain by REAL path.** `agentLoader.resolveRef` resolves `realpathSync(abs)` and requires it to sit under
   `realpathSync(packDir)`. This defends dev mounts, where the pack dir itself is a symlink into the checkout, as well as
   anything planted after install.

### D3 — The install marker binds the whole installed tree

At install the marker gains `contentDigest: packContentDigest(destDir)`. This is the ADR 0555 hasher: whole tree,
symlink-aware, marker excluded. `classifyPackDir` verifies `contentDigest` **when present**, so adding, editing or
swapping any file makes the pack `install_marker_tampered`. `contentHashes` stays written for the readers that use it
(`verifyInstalledPack`).

*(Corrected by /architect A2/A3/A4.)* The hasher excludes `node_modules`/`.git`, so the installed dir must ALSO have
the installer's exact top-level shape (⊆ `pack.json`, `index.mjs`, `schemas`, `keys`, `prompts`, the marker); any other
entry is `install_marker_tampered` (`detail: unexpected_entry:<name>`). After writing the marker, the installer
invalidates that dir's cached verdict. A **legacy marker** (no `contentDigest`) still verifies under the old two-file
rule, with the same stable reason `install_marker_verified` and `detail: 'legacy_two_file_marker'`, so it never
masquerades as the full check. Production installs into the container FS
at every cold start, so prod markers are rewritten on the first boot of the new revision. Only long-lived dev pack dirs
carry legacy markers.

### D4 — One install lane

New core module `packs/installLane.ts`. Core, because two of the three callers are core routes and core must not import a
feature. It exports:

- `assertInstallable({ name, version })`: `isSafePackName`, the semver check, tombstone → 409, revoked
  (`isPackRevoked(name, version)`) → 409 `pack_revoked`.
- `installFromConfiguredRegistry(target)`: reads `OPENWOP_REGISTRY_URL` and resolves the trusted-keys dir **once**, here,
  not per route. It calls `installPackFromRegistry` and maps every failure through `translateInstallError`, which moves
  here from `features/marketplace/routes.ts` and stays re-exported for its test. The registry URL never reaches the client
  (`MKT2-29`).

All three routes call both. A ratchet test pins that no file outside `packs/installLane.ts` and the boot installer calls
`installPackFromRegistry`. The installer also refuses a key id that is not `^[A-Za-z0-9._-]+$` before joining it onto the
keys dir or a URL (`pack_signature_unverifiable`).

### D5 — Revocation is a real, propagating, enforced kill switch

- **Operator surface** (marketplace, `requireSuperadmin`, deliberately **not** toggle-gated, the ADR 0575 "operator
  remediation" class — a kill switch must not vanish because the feature is off):
  - `GET  /marketplace/revocations`
  - `POST /marketplace/packs/:packName/revocations { version: <semver> | "*", reason }` (reason required, ≤ 500 chars)
  - `DELETE /marketplace/packs/:packName/revocations/:version`
  Each write logs `marketplace_pack_revoked` / `_unrevoked` with actor, pack, version and reason.
- **Propagation:** `startPackRevocationRefresh()` reloads the store every 30 s (unref'd timer, started at boot after the first
  load; `OPENWOP_PACK_REVOCATION_REFRESH_MS`). Every reload that changes the set clears the `packTrust` verdict cache. The
  window is stated in the UI: "takes effect on every instance within ~30 s".
- **Enforcement at dispatch, not just at load** *(corrected by /architect A1)*: the executor's ONE dispatch site
  (beside `resolveIsolationPlan`, `executor.ts:1115`) checks `isPackRevoked(packOrigin.packName, packOrigin.packVersion)`
  and fails the node with `pack_revoked`. That one check covers BOTH placements (in-process and isolated). The agent
  registry's `lookup` treats a revoked pack's agent as absent. The ES module stays imported, because Node cannot unload
  it, but nothing reaches it.
- **Install refuses a revoked version** (D4).
- **Replay:** revocation deliberately breaks replay of runs that used the version (ADR 0555 records the trade). Unchanged.

### D6 — The listing reports the real trust tier

`Listing.trust = { tier, reason }` comes from `classifyPackDir` (`steward | operator-trusted | untrusted | revoked`).
`integrity` / `publicKeyRef` are emitted **only** when `tier === 'operator-trusted'`. `installed` keeps its narrow meaning
(a marker exists), and its docblock now says so. The UI shows one chip per tier ("Signature verified", "Ships with this
app", "Unverified", "Revoked"), and the agent lanes project `trust.tier` so a model can say "unverified". `getListing`
reads one dir instead of scanning all of them (`MKT2-28`).

### D7 — The recommender respects curation

`agentTools` and `ctx.features.marketplace` mark each listing `disabledInWorkspace: true` (from `disabledPacks(tenantId)`).
They mark it rather than filter it, because a filtered row is the "silent narrowing" `MKT2-26` already fixed once. The
recommender agent's prompt says not to recommend those packs. `agent-prompt-tool-ids` and the marketplace
`promptCatalogParity` must stay green.

### D8 — The agent-pack list requires a caller

`GET /registry/agent-packs` calls `resolveCallerUser` (401/403 for anonymous), matching `/listings`.

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Marketplace routes stay in `features/marketplace/`. The install lane, marker and trust work sit in core `packs/` / `host/` (already core-owned). Core imports no feature. |
| 2 | Toggle | `marketplace`, unchanged. The revocation routes are deliberately not toggle-gated (D5). |
| 3 | `ctx.features.marketplace` | Read-only, unchanged except `trust` + `disabledInWorkspace` (additive). |
| 4 | Node pack | `feature.marketplace.nodes` describes outputs only, so the version is bumped only if its schemas change. Install and revoke stay deliberately NOT nodes. |
| 5 | Envelopes | None. |
| 6 | Agent pack | `vendor.openwop-app.marketplace.agents`: the prompt gains the curation and unverified-tier rule, so its version is bumped. |
| 7 | Public surface | None added. D8 removes an accidental anonymous one. |
| 8 | RBAC | D1 (`workspace:write`), D5 (superadmin), D8 (authed). Each gets a real-HTTP witness; each viewer-refusal row has its own success control. |
| 9 | Replay | Read surfaces are pure. Revocation breaks replay by design (ADR 0555). |
| 10 | Frontend | `canCurate` hides or disables the availability switch for viewers. `canAdminister` gates install/remove/purge/revoke. Trust chip. A revoke dialog (danger, reason required). 4 locales. |

## Phased plan

| Phase | Scope | Witness (each must be RED on `f4b07997f`, except new surfaces) |
|---|---|---|
| P1 | D1 + D8 | viewer PUT → 403 and the owner still sees it enabled; editor → 200 (control); anonymous agent-packs → 401 |
| P2 | D2 + D3 | symlink/hardlink pack → `pack_content_refused`, nothing on disk; a legit pack installs (control); `realpath` escape in `resolveRef` refused; post-install edit to `prompts/` → `install_marker_tampered`; legacy marker → `install_marker_verified_legacy` |
| P3 | D4 | the ratchet (only the lane calls the installer); bad semver on every lane → 400; revoked → 409; the chain lane never echoes the registry URL |
| P4 | D5 | revoke route (superadmin 200, admin 403); a loaded node's dispatch → `pack_revoked` without a restart; a second "instance" (a cache reset plus refresh) sees the revocation within one refresh tick; unrevoke restores |
| P5 | D6 + D7 + frontend | the listing tier matches `classifyPackDir`; a tampered pack shows `untrusted` with no `integrity`; the recommender marks disabled packs; UI gating |

## Alternatives weighed

- **Pin publisher keys host-side and stop fetching keys from the registry.** Rejected, and already withdrawn once (ADR 0660,
  `MKT2-20`): the spec makes trust roots per-registry by a normative MUST. An operator who wants a narrower root mirrors into
  a private registry.
- **Allow symlinks that stay inside the pack.** Rejected. No shipped pack needs one, and every in-pack link is one `..` away
  from an out-of-pack link. Refusing the class is simpler to verify than containing it at every reader. D2.3 still contains
  at the reader for the dev-mount case.
- **Filter disabled packs out of the recommender.** Rejected, for the silent-narrowing reason above (D7).
- **Revocation by pub/sub.** Rejected for now. There is no cross-instance bus in this host. A 30 s poll of a tiny table is
  honest, bounded and testable. Revisit when a bus exists.
- **Put the install lane in the marketplace feature.** Rejected: two callers are core routes (feature-boundary rule).

## Open questions

- **OQ-1 (deferred):** an install-time capability-consent screen (Shopify scopes) showing the pack's declared
  `peerDependencies` before an operator installs it, with re-consent when an upgrade widens them. It is deferred because
  install is operator-only (no per-tenant consent unit) and the meaningful closed-world property is D2. It needs a
  preview route that verifies without installing. Tracked as `MKT3-6`.
- **OQ-2:** `MKT2-21` (sign the executable) needs an RFC amending `spec/v2/core/packs.md` §Signing. Out of scope here.
- **OQ-3:** should a revocation also tombstone the pack (hide it from authoring)? Proposed: no, they are orthogonal (ADR 0555
  header). The listing's `revoked` chip is the signal.

## /architect round (2026-10-05, before code)

An adversarial `/architect` pass (Track A) ran on this draft against `f4b07997f`. It found **2 Blockers, 4 Highs and 4
Mediums**. Each one is either folded into the decisions above or dispositioned here. The corrections are written
inline in the decisions they change.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| A1 | **Blocker** | D5 put the dispatch check in `tarballLoader`'s `execute` wrapper. The **isolated** lane never calls `module.execute`: `executor.ts:1148-1159` routes `isolationPlan.kind === 'isolate'` straight to the adapter with `module.packOrigin`. So a revoked untrusted pack, which is exactly the isolated population, would keep running. | **D5 corrected:** the check sits at the ONE dispatch site, beside `resolveIsolationPlan` (`executor.ts:1115`), keyed on `module.packOrigin`. It covers both placements. Agents: the registry's `lookup` treats a revoked pack's agent as absent, so `get` and `resolve` both refuse. |
| A2 | **Blocker** | D3 claimed the digest "binds the whole installed tree". `packContentDigest` **excludes** `node_modules`, `.git` and `.DS_Store` (`packContentDigest.ts:59`). A `node_modules/` planted beside an installed `index.mjs` changes no digest, and a bare-specifier import then loads unverified code. | **D3 corrected:** an installed pack must also have the installer's exact shape: top-level entries ⊆ `{pack.json, index.mjs, schemas, keys, prompts, .openwop-installed.json}`. Anything else is `install_marker_tampered` (detail `unexpected_entry:<name>`). The shared hasher is left unchanged (the steward-generator parity test pins it). |
| A3 | High | D3's new reason `install_marker_verified_legacy` changes a stable string (`PackTrustReason` reaches logs and Operations, and `pack-trust-tier.test.ts` asserts it). | **D3 corrected:** the reason stays `install_marker_verified`. A legacy marker carries `detail: 'legacy_two_file_marker'`. |
| A4 | High | The verdict cache is keyed by `packDir` and never invalidated on install. After an upgrade, or a refused-then-fixed reinstall, the dir keeps its OLD verdict until restart. This is pre-existing, and D3 makes it matter. | The installer invalidates that dir's verdict (`invalidatePackTrustVerdict(dir)`) after writing the marker. A revocation-set change clears the whole cache (D5). |
| A5 | High | D4's ratchet allowlisted the boot installer (`bootstrap/installRegistryPacks.ts`), so a REVOKED version listed in `OPENWOP_INSTALL_PACKS` would still install at every cold start. | The boot installer calls `assertInstallable` too. Only the registry fetch itself (`installFromConfiguredRegistry`) is shared differently, because boot iterates a list. |
| A6 | High | A superadmin can revoke `core.openwop.ai@*`, which every AI feature pins. That is legitimate for a compromised core pack, but the blast radius has to be visible before the click. | Not refused (a kill switch must work). The revoke response and the UI confirm both name `requiredBy` (the feature ids that pin the pack). The dialog is `danger`, and the reason is required. |
| A7 | Medium | Where does the refresh timer live? `loadPackRevocations` runs in `createApp` (`index.ts:449`), and the suite builds hundreds of apps. | One process-wide timer: a module singleton, `unref`'d, started on first boot load and idempotent across `createApp` calls. Tests drive it through an exported `refreshPackRevocationsNow()`. |
| A8 | Medium | D2 relies on `tar`'s defaults to refuse `../` and absolute entries at extraction, before the link walk runs. bsdtar (macOS) and GNU tar (the `node:22-slim` image) both refuse by default, but `PROBE-MKT2-2` style: read, not run on GNU. | A witness with a hand-built `../escape` header pins the behaviour on whichever `tar` the lane runs. GNU-tar confirmation in the image is listed in the probe checklist. |
| A9 | Medium | The form-content, canvas-content, artifact-type and prompt-pack loaders read registry-installed files without consulting `packTrust`. | D2.1 removes the install-time vector. What remains needs filesystem write, which is outside this model (the marker exists to *detect* it, and D3 now does). Recorded as residue `MKT3-7`, not fixed here. |
| A10 | Medium | Revoking a chain pack: its chains leave the gallery on reload, but workflows already instantiated from it are tenant-owned **copies** and keep running. | Stated, not changed: a chain is data. Its node packs carry the executable risk and are covered by A1. The revoke dialog says so. **CORRECTED by /grade-code (`MKT4-1`): "leave the gallery on reload" was false.** The chain loader never consulted the revocation store, so a revoked chain pack stayed listed and instantiable until restart. `getChain`/`listChains` now treat a revoked pack version as absent at READ time, which reaches every instance within one refresh tick with no reload. |

**Verified, no change:** D1's predicate honours the ADR 0815 root-row rule (`resolveSubjectScopesUnion`,
`host/accessControlService.ts:2035`, filters sub-org rows in a shared tenant). `owk_` keys are narrowed by provenance
inside `callerHoldsTenantScope`. The personal-workspace owner passes. D6's cost: the first `/listings` after boot digests
each not-yet-classified pack once (the verdict cache memoises), and it is measured in P5.

## Implementation record

| Phase | Commit (by subject — the shas move with every rebase) | Witness (RED on `f4b07997f` unless a new surface) | Sabotage |
|---|---|---|---|
| P1 D1 + D8 | the `feat(marketplace): supply-chain hardening` commit | `adr0826-marketplace-authz.test.ts`: viewer PUT → 403 + unchanged; editor 200 (control); `viewer` block per role; anonymous agent-packs → 401/403 | `requireTenantWrite` removed → red; `resolveCallerUser` removed → red |
| P2 D2 + D3 | the `feat(marketplace): supply-chain hardening` commit | `adr0826-install-closed-world.test.ts`: prompts symlink / symlinked subdir / hardlink refused with nothing on disk; malformed key id refused; legit pack installs with `contentDigest`; post-install prompt edit → `content_digest_mismatch`; planted `node_modules` → `unexpected_entry`; legacy marker → `legacy_two_file_marker`; reinstall clears the cached verdict; real-path containment in `resolveRef`; a `../` tar entry never escapes | closed-world call, real-path check, shape check and digest check each removed → red |
| P3 D4 | the `feat(marketplace): supply-chain hardening` commit | `adr0826-install-lane.test.ts`: the ratchet (only the lane and boot call the installer; every route calls the lane); name/semver/tombstone/revoked refusals; error scrub; boot refuses a revoked pin without fetching | boot revoked check removed → red |
| P4 D5 | the `feat(marketplace): supply-chain hardening` commit, `fix(marketplace): a revoked chain pack leaves the gallery`, `fix(marketplace): audit revocations` | `adr0826-revocation-dispatch.test.ts`: a loaded pack's node fails `pack_revoked` in BOTH placements with no restart, then runs again after unrevoke; a revoked pack agent is absent from get/has/resolve/list; another instance's write arrives via the refresh and clears verdicts; a revoked chain pack leaves `getChain`/`listChains`. `adr0826-marketplace-authz.test.ts`: routes are superadmin-only, validated, not toggle-gated, and audited | executor check, registry filter, verdict-clear listener and chain read filter each removed → red |
| P5 D6 + D7 + FE | the `feat(marketplace): supply-chain hardening` commit, `fix(marketplace): grade-ux pass` | listings carry `trust` (`integrity` only when operator-trusted; revoked shows `revoked`); `adr0826TrustAndCapabilities.test.tsx` (role gating, chips, the dialog arms on a reason, `*` scope, honest unrevoke) | FE curation gate and covering filter each removed → red |

Fixtures reshaped deliberately: `pack-trust-tier.test.ts` (a marker dir now has the installer's shape, plus a new leg
proving a planted `lib/` is untrusted) and `marketplace-catalog-honesty.test.ts` (`getListing` reads the pack's own dir
first, so a failed catalog scan no longer decides a pack whose dir reads fine; the scan-dependent case still throws).

Measured: the trust projection over 212 packs costs 58 ms cold and 5 ms warm (memoised per dir). `getListing` takes
0.06 ms, down from a full scan.

**Residue:** `MKT2-21` (RFC: sign the executable), `MKT3-6` (consent screen, OQ-1), `MKT3-7` (four content loaders
don't consult `packTrust`), `MKT4-4` (the refresh is a 30 s poll, not a push).
