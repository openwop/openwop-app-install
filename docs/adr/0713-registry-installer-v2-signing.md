# ADR 0713 — The registry installer reads a v2 manifest's signing block; production has installed zero registry packs

Status: **implemented** 2026-09-17 — Phases 1, 1b, 2 and 3 shipped (backend `8f43dfe12`, revision 00709); people-hr resolved by §2 Phase 3 correction; corpus schema defect filed as openwop#1367 (people-hr resolved by §2 Phase 3 correction; corpus schema defect filed upstream)
Authors: Claude (session with David), from a production log measurement during ADR 0706 follow-up work
Relates: ADR 0663 (registry endpoint resolution; corrected by this ADR), ADR 0660 (namespace authorization), ADR 0655 D5 (never downgrade a vendored pack), ADR 0555 P0 (pack trust classification), `spec/v2/core/packs.md` §Signing

## 1. Context — what production actually runs

`OPENWOP_STRICT_REGISTRY=true` is set in production, and two scripts
(`check-pack-pin-drift.mjs`, `preflight-deploy.sh`) described its effect as "the
installer serves the PINNED registry version over the vendored one". MEASURED on the
production boot of 2026-09-16T22:34Z (commit `108f166fe`), component
`bootstrap.installRegistryPacks`:

| outcome | count | cause |
|---|---|---|
| `registry pack ready` | **0** | — |
| `manifest_fetch_failed (404)` | 37 | the pin names a version that exists only in the v1 tree; the host (major 2) resolves the v2 tree (ADR 0663) |
| `pack_signature_unverifiable: no signing.publicKeyRef in manifest` | 16 | the version exists in v2, whose manifests carry `signing: { keyId, scheme }` |
| `registry pin below vendored — install refused` | 4 | `ai`, `http`, `integration`, `mcp` — ADR 0655 D5 |

`mountLocalPacks` runs first on a fresh container and symlinks all 206 vendored
packs, so every refusal and failure left the vendored copy in place. **Every pack in
production is the image-vendored copy; the signed registry is unused.**

The two failure classes hide each other. Re-pinning alone turns the 37 404s into
signature failures; fixing the reader alone leaves the 37 pins unresolvable.

`spec/v2/core/packs.md` §Signing: `signing` is `{ keyId, scheme }`, both REQUIRED;
`scheme` MUST be `ed25519-canonical-json` ("a detached 64-byte Ed25519 signature over
the canonical-JSON `pack.json` inside a deterministic tarball"); "`publicKeyRef` does
not exist"; a manifest carrying `method` fails validation. The registry is correct
(`registry/scripts/verify-signatures.mjs` verifies v2 over the `pack.json` bytes
extracted from the tarball — the same bytes `extractPackJsonFromTarball` returns). The
defect is this host's reader. **No RFC**: the wire is locked and the host was not
honouring it.

## 2. Decision

### Phase 1 — read the signing block the tree defines (implemented)

`registryInstaller.ts manifestSigningKeyId(signing, tree)`, called with the tree the
manifest was resolved from:

- **v2**: `keyId` (non-empty) and `scheme === 'ed25519-canonical-json'` are required;
  a block that also carries `method` / `publicKeyRef` is refused. All
  `pack_signature_unverifiable`.
- **v1 / flat / legacy constructed paths**: `publicKeyRef`, unchanged.

Signature verification, the ADR 0660 namespace authorization and the canonical
manifest gate run exactly as before on the resolved key id. The install marker's
`publicKeyRef` field keeps its name (the marketplace listing reads it) and holds the
key id.

Alternatives rejected: accepting either shape on either tree (a v2 manifest with a
v1 block is spec-invalid, and silent acceptance is how this went unseen);
`OPENWOP_REGISTRY_TREE=v1` in production (the 16 v2-only pins would 404, and the v1
versions declare `engines <2.0.0`, inadmissible on a major-2 host per ADR 0663).

### Phase 2 — re-pin production to v2 versions (ops, after Phase 1 deploys)

41 pins name v1-only versions; each has exactly one v2 version, the next patch
(`ai 1.3.3`, `data 1.2.2`, `http 2.0.1`, `mcp 1.1.2`, `integration 1.1.1`, `a2a 1.1.1`,
`agents 1.0.2`, `crypto 1.0.5`, the rest +0.0.1). Advance `OPENWOP_INSTALL_PACKS` with an
incremental `gcloud run services update --update-env-vars` (never `--set-*`), then read
the boot log for `registry pack ready`. Where the v2 version is still below the
vendored one (`ai`, `http`, `integration`, `mcp` today) the ADR 0655 D5 refusal
continues and the vendored copy serves until Phase 3.

### Phase 3 — publish the packs the app is ahead on (openwop-registry)

`core.openwop.ai 1.4.0`, `http 2.1.0`, `integration 1.2.0`, `mcp` as **1.1.3** (1.1.2 is
already published in v2 with different content — the app's `<UNTRUSTED>` sampling
fence is missing there), `workflows.people-hr 1.5.0` (after deciding
`triggerEventName`'s default: the app's default is the 4-segment event name registry
#56 flagged invalid). Reconcile each with canon (`engines <3.0.0`, `kind`), open a
`packs/**` PR so `registry-v2-sign` signs in CI, merge, re-pin.

> **Implementation record (2026-09-16/17).**
> - openwop-registry#61 published `ai 1.4.0`, `http 2.1.0`, `integration 1.2.0`,
>   `mcp 1.1.3`; #62 `ai 1.4.1`, `http 2.1.1`, `integration 1.2.1` — patch bumps,
>   because the app's `check-pack-version-bump` correctly refused the canon fields as
>   a same-version content change. CI-signed (`registry-v2-sign`), `registry:check OK`
>   (187 v2 packs verified), live-installed with the Phase 1 installer.
> - openwop-app#3908 makes the vendored copies identical (+ steward manifest).
>
> **CORRECTION — people-hr 1.5.0 is NOT publishable, by design (architect pass
> 2026-09-17).** The app's 1.5.0 differs from canon 1.4.3 in exactly one thing: the
> `triggerEventName` default `host.users.user.deactivated`, which the registry
> forbids. There is no unpublished work in it — only the violation. Options weighed:
> (A) family-wide rename of the `host.*` host-event family to a registered
> 3-segment org — the correct end state, but a wire-visible rename for webhook
> consumers and stored bindings with its own migration; its own ADR, not this gate;
> (B) users-only rename — inconsistent family; (C) a host param-default seam —
> a new expansion seam for a lane the pack README marks NOT SAFE TO BIND (UAUWF-7);
> (D) optional param, empty event name — **rejected by evidence**:
> `core.openwop.triggers/schemas/event.config.json` sets `eventName` `minLength: 1`;
> (E) **chosen**: canon 1.4.3 is the correct published shape; production pins it
> (Phase 2) and the vendored 1.5.0 wins locally as the newer release until (A) lands
> and the app converges.

### Phase 1b — the chain-pack loader rejected every v2 chain pack (found in production after Phase 1 shipped)

> **Added 2026-09-17.** Phase 1 deployed (`28a675148`, revision 00704) and the
> installer began landing v2 chain packs; the NEXT reader refused them. On revision
> 00705 `host/workflowChainPackLoader.ts` rejected all 16 registry-installed
> `core.openwop.workflows.*` packs: `workflow_chain_pack_manifest_invalid —
> /signing must NOT have additional properties (keyId)`. The vendored copies kept
> serving, so no chain was lost (chain sets diffed 00703 → 00705: 0 lost), but no
> registry chain pack could ever load.
>
> Cause is a **corpus inconsistency**, not a host misreading: `packs.md` §Signing
> (normative) says `signing` is `{ keyId, scheme }` and "`publicKeyRef` does not
> exist", and the registry publishes exactly that inside v2 `pack.json` — but the
> v2 `workflow-chain-pack-manifest`, `node-pack-manifest` and
> `artifact-type-pack-manifest` schemas (spec-artifacts 2.2.0, openwop `main`)
> still carry the closed v1 `Signing` def. The prose wins; the schema needs an
> errata in `openwop`.
>
> Host fix: `manifestForCorpusSchema` checks a v2 block against the prose (the
> installer's `manifestSigningKeyId`, one reader) and validates the rest of the
> manifest against the schema; a v1 block or none goes to the schema unchanged.
> `test/adr0713-chain-loader-v2-signing.test.ts` (4) includes a TRIPWIRE that fails
> when the pinned corpus schema admits `keyId` — the day to delete the workaround.
> **CORRECTED 2026-09-21 (suite 2.32.0 bump) — that tripwire could not fire, and
> did not.** It compiled the ROOT `schemas/workflow-chain-pack-manifest.schema.json`
> — the v1 schema, which is also the only one the loader reads — while the corpus
> fix (openwop#1367) landed in `schemas/v2/`. A closed v1 `Signing` def never
> admits `keyId`, so the condition it waited for was unreachable. MEASURED: on
> the bump that vendors the fix, all 4 tests stayed green. It is replaced by two
> pinned facts — the v2 schema now admits `{ keyId, scheme }` (reddens on the
> pre-2.32.0 file), and the schema the LOADER reads still rejects it, so
> `manifestForCorpusSchema` remains load-bearing. "The day to delete the
> workaround" is therefore not the corpus release; it is the day the loader
> routes v2-shaped manifests to the v2 schema — `WHD-15`.
>
> **RETIRED 2026-09-21 (`WHD-15`).** `manifestForCorpusSchema` is deleted. The loader
> now routes a v2-shaped manifest (a `signing` block carrying `keyId` or `scheme` —
> the same predicate the function used) to `schemas/v2/workflow-chain-pack-manifest`
> with the signing block LEFT IN, and everything else to the v1 schema unchanged.
> MEASURED before the change: 143 manifests (62 in-repo + all 81 published v2 chain
> packs, registry `c510721`), zero verdict changes in either direction, probe
> validated on 8 synthetic controls. The prose-side `manifestSigningKeyId` check was
> dropped at this gate only after a 7-row table pinned that the v2 schema refuses
> every block it threw on. New fail-closed code: `workflow_chain_pack_schema_unavailable`
> — if the v2 schema cannot compile, v2-shaped packs are refused BY NAME and nothing
> falls back to v1. **What changes going forward:** the v2 schema also closes
> `engines` and tightens the typeId/chainId/keyId grammars; no pack in today's
> population violates them, but a future v2-signed pack that does is now refused at
> load where strip-and-v1 would have admitted it.
>
> Sabotage: bypassing the call reddens 1. Load-time `verifyPinned` still reports
> v2 installs `unsigned` (it looks for `signatureRef`); the install-time signature
> + namespace verification (Phase 1) is what attests them — see OQ3.

### Phase 1b → production incident: stale same-version registry chains won (2026-09-17, ~30 min)

> **CORRECTION to Phase 1b.** Shipping the loader fix was a behaviour change, not a
> repair with no side effects. While every registry chain pack was rejected, the
> image-vendored copies served. Once they loaded, the loader's same-pack-version
> tie-break kept the REGISTRY copy — and for three packs the registry held
> DIFFERENT, OLDER content at the app's version: `approvals 1.0.4`,
> `data-ops 1.1.4`, `research 1.0.3` carried the pre-ADR-0582 chains (e.g.
> `approvals.request-sign-off@1.0.0` wires `gate -> notify`; the app's `1.0.1`
> wires `gate.decision -> notify.message`). The app had bumped approvals
> 1.0.3 -> 1.0.4 WITH the gate fixes (#3601) while the registry's v2 wave published
> a different 1.0.4.
>
> | step | revision | evidence |
> |---|---|---|
> | loader fix live | 00707 | 57 ready; **4 `workflow_chain_pack_duplicate_content_drift`** (the only signal) |
> | mitigation: un-pin the three | 00708 | 54 ready, 0 drift — vendored gated chains serve |
> | fix: registry#63 publishes approvals 1.0.5 / data-ops 1.1.5 / research 1.0.4 (+ `research.web-brief` 1.0.0 -> 1.0.1); app #3911 matches | — | CI-signed, `registry:check OK` (190 v2) |
> | re-pin | 00709 | probed on a tag: **57 ready, 0 drift, 0 rejected**; served approvals 1.0.5 carries the gated edge |
>
> Exposure: only chains INSTANTIATED from the gallery during the window (existing
> tenant workflow instances are frozen definitions). Lesson, now procedure: after
> any fix that makes a previously-failing source participate, probe the new
> revision on a tag and treat `*_content_drift` as a blocker before traffic moves.
> OQ5 below is the structural half.

## 3. Gate claims corrected in this change

- `scripts/check-pack-pin-drift.mjs`: the header's "the installer OVERWRITES … merging
  ships NOTHING" and the failure message's "the registry copy wins and the vendored one
  is ignored" have been false since ADR 0655 D5 (2026-09-11): in exactly the drift case
  the installer refuses and the vendored copy serves. Now says so. The exit code is
  unchanged — drift still means production runs code the registry never verified.
- `scripts/preflight-deploy.sh` Gate comment, same claim.
- ADR 0663 Consequences: "Production can now be re-pinned" — correction note added.

## 4. Test record

`test/adr0713-registry-v2-signing.test.ts` (7): the live v2 block yields its key id;
missing keyId / wrong scheme / v1 fields on v2 refused; v1 unchanged and a v2 block is
not a v1 one; a v2-tree install (registry serving both trees, v1 answering 404) lands
and records the key id; a v2 block over bytes the key did not sign → `pack_signature_invalid`;
a v2 key not permitted for the namespace → `pack_signature_invalid`; a v1 block served
from the v2 tree → refused. `registry-install-namespace-authz.test.ts` (6, v1 tree)
unchanged and green.

**Sabotage** (each reddens ≥1): ignore the resolved tree (4 red), drop the scheme check
(1), drop the v1-field refusal (1).

**Live witness** (network, not a CI test): the Phase 1 installer installed
`core.openwop.rag@1.0.2` and `core.openwop.workflows.data-ops@1.1.4` from
`packs.openwop.dev` into a temp dir with signature + namespace verification; the same
script against `origin/main`'s installer failed both with the exact production error.

## 5. Open questions

- **OQ1** 16 pins already name v2 versions — someone began the ADR 0663 re-pin and it
  failed silently at the reader. The boot logs a `warn` per failed install and
  continues; nothing alerts. Should a STRICT boot with zero successful installs fail
  readiness, or at least log `error`? (Recommend `error` + a readiness detail; failing
  boot would take the app down for a registry outage.)
- **OQ2** `scripts/check-registry-parity.sh` measures the v1 tree only (ADR 0663 already
  noted it); it should measure the resolved tree.
- **OQ3** Load-time `verifyPinned` (`host/packSignature.ts`) still reads v1 `signatureRef`
  and so reports every v2 chain install `unsigned`; with
  `OPENWOP_REQUIRE_CHAINPACK_SIGNATURES=true` they would be refused. Install-time
  verification (Phase 1) plus the install marker's content hashes are the current
  attestation; teaching load-time verification the v2 shape is the follow-up.
- **OQ4** The corpus schema errata (v2 pack-manifest `Signing` → `{ keyId, scheme }`)
  belongs in `openwop`; the Phase 1b tripwire forces the host workaround out when it lands.
- **OQ5** A same-PACK-version tie-break cannot see a per-CHAIN version difference: the
  loader kept registry `approvals 1.0.4` (chains @1.0.0) over vendored `approvals 1.0.4`
  (chains @1.0.1). Either the registry publish flow must refuse a version the app
  already vendors with different content (a registry-side `check-pack-version-bump`
  against the app), or the loader must refuse to serve on `content_drift` rather than
  warn. Decide before the next registry wave.

  > **CLOSED 2026-09-17 (the loader half).** `loadWorkflowChainPacks` now compares the
  > per-CHAIN `version` when two copies of a pack share a pack version but differ in
  > content: a higher chain version wins regardless of root
  > (`workflow_chain_pack_duplicate_chain_upgraded`, WARN with both versions and roots),
  > with the same operator-override exception the pack-version rule has. Equal chain
  > versions keep the precedence winner and the `duplicate_content_drift` warning, as
  > before. On the 2026-09-17 incident shape the vendored gated chains (@1.0.1) would have
  > won with no un-pin. Witness: `test/chain-pack-duplicate-drift.test.ts` (+2: higher
  > chain version in the lower-precedence root wins; a lower one does not). Sabotage
  > reddens 1. The registry-side half (refusing to publish a version the app already
  > vendors with different content) is not taken here.