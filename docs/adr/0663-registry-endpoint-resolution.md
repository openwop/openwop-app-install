# ADR 0663 — registry paths are RESOLVED through the registry's endpoints map, never constructed

Status: Accepted (implemented in this PR)

## Context

`spec/v2/core/packs.md` §"The registry tree" is explicit:

> The registry is versioned by tree, not by header. It publishes
> `registry/v2/packs/<name>/-/<version>.{json,sbom.json,sig,tgz}` as a parallel
> tree of re-signed manifests with regenerated SBOMs and index; the v1 tree is
> served read-only through the overlap. … `.well-known/openwop-registry.json`
> `endpoints` is the negotiation: it names both trees, and **a client MUST
> resolve every registry path through `endpoints` rather than constructing
> one.**

This host constructed them. `registryInstaller.ts` built
`${registry}/v1/packs/{name}/-/{version}.json` (and the `.tgz`, `.sig` and
`/keys/{id}.pub` siblings) inline, with the tree as a hardcoded path segment
and no override. Two consequences, one normative and one operational:

- The MUST was violated on every install path that reaches the registry.
- The host was pinned to the **frozen v1 tree**, where no major-2-admissible
  version is published. Measured against `packs.openwop.dev` on 2026-09-11:
  `v1 …/rag/-/1.0.1.json` (this host's production pin) declares
  `engines.openwop: ">=1.0.0 <2.0.0"`; `v1 …/exec-ops/-/1.1.3.json` declares an
  unbounded `">=1.0.0"`, which `packs.md` requires a v2 host to read as
  `<2.0.0`; the v2-tier counterparts declare `">=1.0.0 <3.0.0"`; and
  `v1 …/rag/-/1.0.2.json` is a **404** — the admissible version exists only
  under `/v2/`. All 57 of this host's production pins are v1-tier versions, so
  re-pinning production to an admissible version would have answered
  `manifest_fetch_failed (404)`.

That ordering matters: **re-pinning is blocked on this change**, and turning on
the `packManifestV2Gate` admission check before re-pinning would refuse every
installed pack with no reachable replacement.

Found while answering the corpus steward's question about pack drift
(crosstalk `5983` → `cbff`).

## Decision

1. **One fetch of the discovery document, one owner.** `packs/registryEndpoints.ts`
   fetches and caches `.well-known/openwop-registry.json` per registry.
   `host/packSignature.ts` was **already** fetching that same document for
   `signingKeys[].permittedNamespaces` (ADR 0660); it now reads through the
   shared fetch rather than making a second request with a second cache. Each
   consumer keeps its own error vocabulary, because they ask different
   questions of the same body.
2. **The tree is chosen, not guessed.** `preferredTree()` returns the `v2` tree
   for a host whose protocol major is ≥ 2 when the registry advertises one,
   `v1` when it does not (the read-only overlap tree), and honours an explicit
   `OPENWOP_REGISTRY_TREE` pin for an operator mid-migration. The host major is
   derived from `PROTOCOL_VERSION_V2`, not written as a literal.
3. **Two failure causes, two codes.** A registry that did not answer is
   `pack_registry_unreachable` — the vocabulary the install path already uses
   for exactly that, so ADR 0660's typed refusal keeps its meaning. A registry
   that answered but publishes no `endpoints` map is
   `registry_endpoints_unresolvable`. Collapsing them would report an outage as
   a conformance gap and a conformance gap as an outage; the first cut of this
   change did collapse them, and the ADR 0660 test caught it.
4. **Constructed paths survive only as an explicit opt-in.**
   `OPENWOP_REGISTRY_LEGACY_V1_PATHS=true` restores the pre-v2 shapes for a
   registry that predates the well-known. Off by default: without it, an
   unresolvable registry is a refusal, not a guess.
5. **Template expansion percent-encodes every variable.** A template is
   registry-supplied; `{name}` and `{version}` are encoded so a hostile or
   careless registry cannot turn expansion into path traversal.

## Consequences

- Production can now be re-pinned to v2-tier versions, which is the prerequisite
  for wiring `packManifestV2Gate` onto all four install paths (it is currently
  wired on one).

  > **CORRECTED 2026-09-16 — ADR 0713.** "Production can now be re-pinned" was
  > false: this change moved the PATHS onto the v2 tree and left the signing
  > reader on v1. v2 manifests carry `signing: { keyId, scheme }` ("`publicKeyRef`
  > does not exist", `spec/v2/core/packs.md` §Signing), and `registryInstaller.ts`
  > read only `publicKeyRef`, so every v2-tree install threw
  > `pack_signature_unverifiable`. MEASURED on the 2026-09-16 production boot: 16
  > such failures, 37 404s (pins still on v1-only versions — the re-pin never
  > happened), 4 downgrade refusals, and **zero** successful installs; every pack
  > served was the image-vendored copy. The 7 legs above never saw it because the
  > shared test fixture serves v1 manifests from v1 endpoints only. ADR 0713 reads
  > the block per tree and pins it against a v2-tree fixture and the live registry.
- A registry that serves no `endpoints` map stops working for this host unless
  the operator opts in. That is the intended reading of the MUST.
- `scripts/check-registry-parity.sh` still measures the v1 tree only; it is the
  next unit and its numbers (29 stale / 16 unpublished) are withdrawn until it
  measures the resolved tree.

## Implementation record

| what | where |
|---|---|
| shared document fetch, tree preference, template expansion, discriminated resolution | `backend/typescript/src/packs/registryEndpoints.ts` |
| manifest / tarball / signature / public-key URLs resolved; legacy opt-in; two error codes | `backend/typescript/src/packs/registryInstaller.ts` |
| reuses the shared fetch instead of its own | `backend/typescript/src/host/packSignature.ts` |
| 7 legs: tree by host major, v1 fallback, explicit pin, unversioned key endpoint, unreachable vs no-endpoints, encoded expansion, single fetch | `backend/typescript/test/adr0663-registry-endpoints.test.ts` |
| fixture serves the one document both readers consume | `backend/typescript/test/registry-install-namespace-authz.test.ts` |

11 suites touching the installer or pack signatures pass (97 tests).

## Addendum 2026-09-18 — the SECOND constructed `/v1/` path, in a check nobody thought of as a client

This ADR moved `packs/registryInstaller.ts` off constructed `/v1/…` paths and
onto `.well-known/openwop-registry.json` `endpoints`, on the grounds that
constructing a path "pinned this host to the frozen tree, where no major-2-
admissible version is published".

**A second constructor survived, in `scripts/check-registry-parity.sh`.** It read
`${REGISTRY_URL}/v1/index.json` directly. It is not an installer, so it was not
in scope when this ADR swept the install path — but it is a *client* of the
registry tree in the only sense that matters here: it decides what is true about
what is published, and it decided it against the frozen tree.

The consequence was not a silent no-op. The check REPORTED, confidently and in
strong language, that packs were `STALE ON REGISTRY (the published copy SHADOWS
this repo's fix for every non-vitest boot)` — a claim that is false for those
rows, because after this ADR the host does not install from that tree at all.

**MEASURED against the live registry:**

| compared against | stale | local-only | findings |
| --- | ---: | ---: | ---: |
| `/v1/index.json` (what the script read) | 31 | 18 | **49** |
| `/v2/index.json` (what the host installs) | 17 | 18 | **35** |

**14 of the 49 were fiction**, and they were the loudest ones. The reason the bug
survived is worth stating: both trees hold exactly 156 packs and differ only in
version, so the v1 answer has no degraded quality to notice. A wrong-tree read
does not look like a failed read — it looks like a finding.

The script now resolves `endpoints.v{major}.registryIndex` through the same
document the installer uses, and **refuses rather than falling back** when the
tree is not named. The flat top-level keys are deliberately not a fallback: the
discovery document says they are the v1-era aliases, so falling back to them
restores precisely this defect while appearing to degrade gracefully.

**The transferable part.** When a decision retires a way of addressing something,
the sweep has to cover every *reader* of that address, not every component of the
type that prompted the decision. "Installer" was the category in scope; "anything
that resolves a registry path" was the real one. A checker that reads the wrong
source does not fail — it produces findings, and findings are trusted more than
silence.
