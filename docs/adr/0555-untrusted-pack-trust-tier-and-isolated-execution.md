# ADR 0555 — Untrusted-pack trust tier and isolated execution

Status: Accepted — P0 implemented 2026-08-12 (`be62a115e`, #3179; preceded by CORRECTION 1, `b920beddf`, #3172); P1 implemented 2026-08-16 (`f16489a16`, #3288); P2 (first production isolation adapter) implemented 2026-08-17 — see the P2 implementation record, which records network egress as the one gate item this platform cannot meet; P3 (broker hardening) open; P4 (the `sandbox.supported` claim) blocked on **host evidence — the network invariant** (`network-denied: 'not-enforced'`), NOT on RFC 0035 adoption; **CORRECTED 2026-08-18, see CORRECTION 6** — the previous wording contradicted this ADR's own P2 record and its CORRECTION 5. Merge provenance reconciled 2026-08-17 (H44)

Date: 2026-08-11

Composes: ADR 0114/0146 sandbox adapters, ADR 0367 pinned pack signatures, ADR
0397 capability firewall, ADR 0531 effect guard, pack loaders and Operations.
Protocol gate: RFC 0035 must be Accepted before the protocol sandbox capability
is advertised.

> **CORRECTION 5 (2026-08-12) — that gate names the wrong instrument.** A status
> name is not the test. `CLAUDE.md` states the rule, twice-corrected: the bar is
> **the RFC's wire shape is LOCKED + the RFC does not itself gate advertisement
> + this host actually honours the behaviour.** "Accepted" inverts the corpus
> ladder (implementation *produces* `Accepted`), and `Active` is not sufficient
> either — RFC 0121 is `Active` and explicitly forbids advertising until a
> separate review clears. Read RFC 0035, not its rung. P0 advertises nothing, so
> this binds P4 only.

## Context

The app verifies signed packs and has strong code-execution sandbox adapters,
but ordinary pack nodes are dynamically imported and execute in the host
process. `host/runEffectContext.ts:46-53` explicitly relies on that fact for
AsyncLocalStorage propagation and warns that moving across a process boundary
would silently lose the effect guard. Discovery's `node:vm` sandbox is marked
conformance-only (`routes/discovery.ts:1293-1320`).

This is acceptable for steward code and operator-pinned publishers. It is not a
production isolation boundary for adversarial marketplace/community code.

> **CORRECTION 1 (2026-08-12, pre-implementation verification) — the Decision
> says "make trust tier an execution decision, not just installation metadata".
> There is no trust tier at all. Not as execution policy, and not as metadata.**
>
> Verified by inventory: the ONLY trust concept in the backend is
> `verifyPackSignature` (`src/packs/tarballLoader.ts:280`), which answers "is
> this tarball signed by a key we hold". There is no `trustTier` field, no
> `steward` / `operator-trusted` / `untrusted` / `revoked` vocabulary, and no
> consumer of a tier anywhere in `src/`.
>
> That makes P0 substantially larger than "add a gate": it must introduce the
> tier model, decide where a tier is assigned and persisted, and only then gate
> dispatch on it. The framing "not JUST installation metadata" implies the
> metadata half already exists and only the enforcement half is missing. It
> does not, and an implementer trusting that sentence would look for a field to
> read and find nothing.
>
> **Sequencing consequence.** P0's gate is "unknown/invalid/revoked packs cannot
> dispatch; trusted built-ins unchanged" — but "unknown" and "revoked" are not
> currently expressible, so the gate cannot even be written as a test first.
> The tier model has to land before the fail-closed policy it is supposed to
> enforce, and both belong in P0 rather than the policy being bolted onto a
> vocabulary that has to be invented alongside it.
>
> **Status: verified and scoped, NOT implemented.** No code written. This is
> security-critical execution policy on the pack-dispatch path; it should be
> started with room to do the adversarial tests properly, not squeezed in.

> **CORRECTION 2 (2026-08-12, during P0 implementation) — CORRECTION 1 above
> was itself overstated, in the same direction it accused the Decision of.**
>
> "There is no trust tier at all. Not as execution policy, and not as metadata"
> is too strong. `host/packSignature.ts` (ADR 0367) already carried a trust
> VERDICT vocabulary before this ADR existed:
> `PinnedResult = 'trusted' | 'failed' | 'revoked' | 'unsigned'`, plus a
> revocation list (`PinnedKeyring.revoked`, loaded from
> `OPENWOP_TRUSTED_PACK_REVOCATIONS`) keyed `name@version` — the *same key
> format* P0 then went on to invent for its durable store. `verifyPinned()`
> consumes it for workflow-CHAIN packs.
>
> What CORRECTION 1 got right, narrowly: no `steward` / `operator-trusted`
> tier and no execution gate existed for **executable** (node/agent) packs, and
> `verifyPackSignature` is indeed the only thing the node loader consulted. The
> sequencing conclusion stands. But the sweeping claim would have led an
> implementer to build a second revocation system without looking for the first
> — which is exactly what nearly happened: the duplication was caught only when
> an unrelated test's log output printed
> `workflow_chain_pack_signature_revoked`.
>
> **Consequence, implemented:** revocation has TWO legitimate sources — the
> keyring's static operator config and P0's runtime-mutable durable store — and
> `host/packTrust.ts` is the single consumer of both, with a hit in either
> revoking. Neither loader reads either source directly.
>
> The lesson worth keeping is not "check harder". It is that a claim of the form
> "X does not exist anywhere" is a claim about the whole codebase and cannot be
> established by grepping the vocabulary X would use *if it had been named the
> way I would name it*. `revoked` was there the whole time under `PinnedResult`.

## Decision

Make trust tier an execution decision, not just installation metadata.

### Trust tiers

> **CORRECTION 3 (2026-08-12, P0 implementation) — how `steward` is actually
> assigned, because the definition below and the "no environment flag" rule in
> the next section could not both be honoured by any mechanism that existed.**
>
> `steward` was defined as "shipped in the release artifact and covered by its
> provenance". The only runtime signal of that shape was "the pack was mounted
> from the local packs dir" — and `bootstrap/mountLocalPacks.ts` is steered by
> **two** env vars: `OPENWOP_LOCAL_PACKS_DIR` (an arbitrary absolute path) and
> `OPENWOP_LOCAL_PACK_PREFIXES` (a CSV that REPLACES the default allowlist).
> Deriving steward from the mount would not merely have let a flag promote *a
> pack*; it would have let a flag **redefine what the steward corpus is**, which
> is worse than the thing the Decision forbids. Rejected.
>
> Three alternatives were weighed and two rejected:
> - *Image-path steward* (classify by the real path being inside the deployed
>   image's `packs/` root): rejected. There is no compiled-in image root today,
>   so this would introduce a constant that matches only inside Docker. The
>   permit path would then execute **only in production**, where it has never
>   been tested, while dev and CI exercise only the deny path.
> - *Sign the vendored packs at release*: correct, and deferred. It is the
>   successor to what P0 shipped. It needs the Ed25519 key reachable from Cloud
>   Build, and `gcloud run deploy --source .` provides no such path today, so it
>   is infrastructure work rather than a P0 decision.
>
> **Implemented instead — a committed digest manifest.**
> `scripts/gen-steward-manifest.mjs` writes `packs/.steward-manifest.json`: one
> content digest per vendored pack. A pack is `steward` iff its bytes fold to
> the committed digest. This is not env-steerable (a directory nobody committed
> a digest for is not steward, wherever it was mounted from), it behaves
> identically in dev, CI and production, and it reuses the content-hash
> mechanism the install marker already relied on rather than adding a second
> one. `gen-steward-manifest --check` runs in `scripts/ci.sh`.
>
> **Stated limitation, not to be forgotten:** this is attestation BY REPO, not
> by signature. Anyone who can land a commit can add a pack and its digest in
> the same PR. That is the same trust boundary as the source code itself, which
> is the right boundary for a tier named `steward` — but it is strictly weaker
> than signing, and the ADR's own alternatives section is where that upgrade
> lives.

- `steward`: shipped in the release artifact and covered by its provenance.
  **(P0: attested by a committed content digest — see CORRECTION 3.)**
- `operator-trusted`: signature valid under an operator-pinned publisher key,
  version not revoked, and explicitly approved for the tenant/host.
- `untrusted`: unsigned, self-attested, unknown publisher, or community code.
- `revoked`: never loads or executes; historical metadata remains readable.

Production posture permits in-process execution only for `steward` and
explicitly `operator-trusted` packs. `untrusted` packs require an isolation
adapter; absent a healthy adapter they remain installable/quarantined but are
not dispatchable. No environment flag may promote an unsigned pack to trusted.

> **CORRECTION 4 (2026-08-12, P0 implementation) — there is no "production
> posture", and removing it made the phase testable rather than weaker.**
>
> This paragraph presumes a deployment-profile concept. None exists in the
> codebase (ADR 0548 invariant 3 presumes the same one; `storageDurability()`
> is the only helper of that shape and it describes the run store). The obvious
> substitute — an `OPENWOP_PACK_TRUST_ENFORCE` flag — would have made the whole
> phase vacuous the moment it defaulted off: a security gate nobody enables is a
> gate that cannot fail, and this program has already shipped several of those.
>
> It is also unnecessary. Refusing to execute a pack that is neither
> repo-attested nor signature-verified is correct in **every** posture, because
> that pack is unknown code by definition. Under the steward manifest a normal
> dev, CI or production boot classifies every vendored pack `steward`, so the
> policy is **default-ON with no flag and no posture** and breaks nothing. That
> is precisely what makes the deny path observable: drop an unattested
> directory into the pack dir and dispatch must refuse, in a unit test, on a
> laptop.
>
> **The one escape hatch does not violate the rule above.**
> `OPENWOP_PACK_TRUST_ALLOW_UNSIGNED=true` permits dispatch of an untrusted pack
> **without reclassifying it** — the tier stays `untrusted` in every report, log
> and read surface, and `allowedByBreakGlass` is stamped on the verdict. Nothing
> is promoted to trusted, so "no environment flag may promote an unsigned pack
> to trusted" survives verbatim. It is fail-open, so it is loud (a `warn` per
> pack), default-off everywhere including dev, never able to un-revoke a
> `revoked` pack, and `pack-trust-config.test.ts` asserts no shipped config sets
> it.
>
> **Enforcement point, corrected.** The phase table implies a dispatch gate
> ("remain installable but are not dispatchable"). For ES modules that is not a
> boundary: `await import(url)` executes the module's top level, so a pack that
> is malicious has already run before any `execute()` wrapper could refuse it.
> P0 therefore refuses **the import**. Visibility is preserved anyway because
> `host/nodeCatalogBuilder.ts` builds the palette by scanning `pack.json` from
> disk, independent of the node registry — so the pack stays listed and only
> execution is denied. A refusal STUB is registered for each declared typeId, so
> a workflow referencing one fails with `pack_untrusted` / `pack_revoked` rather
> than an unknown-node-type error that would send a debugger hunting a missing
> pack instead of a rejected one.
>
> **Revocation deliberately breaks replay.** A run that used a since-revoked
> pack version will not replay. That contradicts the ARCHITECTURE.md replay
> invariant, on purpose: re-executing code believed compromised in order to
> reproduce an old run is not a trade this host makes. Recorded here so a later
> reader does not "fix" revocation into preserving replay and quietly restore
> the hole. (This is also the sharp line against `packTombstones`, whose header
> guarantees the opposite — a tombstoned pack still runs.)

### Isolated worker contract

The host sends a closed request containing pack/content digest, node type,
validated inputs, resource ceilings, allowed host-call capabilities and a
signed short-lived execution context (tenant, run, node, replay/effect mode,
principal and trace ids). The worker has no ambient host filesystem, env,
network or credentials. All effects are RPC calls back through the host's
capability firewall/effect broker; responses are size/time bounded and marked
with trust provenance.

Every invocation uses a clean isolate or a cryptographically bound immutable
image. CPU, memory, wall clock, output and host-call budgets are enforced by the
isolation boundary. Cancellation kills the isolate. Crash/timeout yields a
typed node failure and cannot leave a privileged worker reusable.

## Boundaries audit

| Concept | Owner |
|---|---|
| Publisher identity/revocation | existing `host/packSignature.ts` |
| Tenant enablement/tombstone | existing pack visibility/tombstone owners |
| Execution routing | pack loader/executor node dispatch seam |
| Isolation implementations | existing sandbox-adapter family, generalized for pack nodes |
| Host effects | existing capability firewall and `runEffectContext` broker |
| Operator policy/health | existing Operations surface |

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Core pack runtime; no feature package. |
| 2 | Toggle | No tenant experiment. Trust policy is operator security configuration and fails closed. |
| 3 | Workflow surface | Same workflow definitions; execution placement is host policy. |
| 4 | Node pack | Applies to all node packs; adds no product pack. |
| 5 | Envelopes | Worker RPC is internal and signed; outputs remain untrusted by provenance. |
| 6 | Agent pack | Agent code/tool handlers follow the same trust-tier routing where executable. |
| 7 | Public surface | No new wire until accepted RFC 0035 capability vocabulary. |
| 8 | RBAC | Install, trust, revoke and tenant-enable are distinct operator permissions. |
| 9 | Replay/fork | Signed execution context carries replay mode; every effect still returns through the host guard. |
| 10 | Frontend | Marketplace/Operations show trust tier, quarantine reason, adapter health and revoke control. |

## Phases and verification

| Phase | Scope | Gate |
|---|---|---|
| P0 **(done)** | Trust-tier model + fail-closed policy for unsigned/unpinned executable packs. Scope grew per CORRECTION 1: the tier vocabulary had to land with the policy. | Unknown/invalid/revoked packs cannot dispatch; trusted built-ins unchanged. **Met** — see Implementation record; each guard falsified before being claimed. |
| P1 **(done)** | Version-neutral isolated-worker contract | Contract tests with a fake worker and dispatch-binding tamper tests. **Met** — see Implementation record; every guard falsified before being claimed. The gate's phrase "signed context" was replaced by a per-dispatch capability binding: see the P1 decision below for why signing the host's own envelope is the weaker threat model. |
| P2 **(done)** | First production isolation adapter | Filesystem/env/network/process/CPU/memory/timeout/cross-pack escape suite. **Met, with ONE gate item honestly unmet: network.** Node has no network permission and Cloud Run exposes no seccomp/netns, so egress is attenuated, not contained — the suite asserts that it is still reachable and the adapter reports `network-denied: 'not-enforced'`, so the gap is machine-readable rather than glossed. See the P2 record. |
| P3 | Host-call broker **policy surface** + sabotage | **NARROWED 2026-08-18 (CORRECTION 6).** The second half of the original gate — "replay guard survives process boundary" — is ALREADY witnessed: `pack-isolation-guards.test.ts:132-230` and `pack-isolation-child-adapter.test.ts:194-260` fire LIVE and refuse REPLAY across the real process boundary, and the P1 record says so. What P3 still owes is the host-call POLICY surface (which operations a grant may name, and the sabotage that proves an unnamed one is refused) — `packHostCallBroker.ts` already denies unknown operations; the gap is the declarative policy, not the deny path. |
| P4 | Capability claim | **RECLASSIFIED 2026-08-18 (CORRECTION 6): the blocker is HOST EVIDENCE — the network invariant — not RFC 0035 adoption.** RFC 0035's Parked tripwire (a non-steward host advertising) is a reason the RFC does not graduate; it is not a reason this host may not advertise. Under CLAUDE.md's three-part test the failing part is the third: this host does not honour the behaviour, because `node-pack-sandbox-network-gated` (`SECURITY/invariants.yaml:1069`, protocol tier, critical) is exactly the guarantee the adapter reports `not-enforced`. Closable by a runtime decision (Deno / WASM / brokered-only egress). |

> **CORRECTION 6 — 2026-08-18 (A+ audit): the P4 blocker was mis-classified, and this
> ADR contradicted itself about it.**
>
> The status line said P4 was "blocked on RFC 0035 ADOPTION, not on host work",
> while the P2 record in this same document says network "is the one gate item
> P2 does not meet, and it is not closable here", and CORRECTION 5 already warns
> "read RFC 0035, not its rung". The status line then did the thing CORRECTION 5
> warns against.
>
> RFC 0035 is `Active` with a locked schema. Its Parked tripwire wants a
> NON-STEWARD host to advertise `sandbox.supported` and pass the §B probes —
> that is a condition for the RFC to graduate, not a prohibition on this host.
> Applying CLAUDE.md's three-part wire-advert test, parts 1 and 2 pass (shape
> locked; the RFC does not gate advertisement); part 3 fails: **this host does
> not honour the behaviour.** `SECURITY/invariants.yaml:1069` registers
> `node-pack-sandbox-network-gated` at protocol tier, severity critical, and
> `isolation/childProcessAdapter.ts:132` reports `network-denied:
> 'not-enforced'` because Node 22's permission model has no network dimension.
>
> Why the distinction is worth a correction rather than a word change:
> `adoption` said the blocker was *outside* this host, so nobody here owned it
> and no work would have been scheduled against it. `host-evidence` says it is
> ours and names what would close it — a runtime decision between a Deno or WASM
> worker and a brokered-only egress channel. That decision is now the P4 item.
>
> Reclassified in three places that must agree: this status line, the P4 gate row
> above, `docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md:95`, and the tripwire in
> `test/agrade-wire-blocked-residue.test.ts` — whose register↔test agreement leg
> went red when only two of them had been changed, which is the guard working.
>
> Two smaller things fixed alongside: the register cell still said P2 was open
> (P2 shipped in `1f422e383` 1h43m after H44 reconciled the register, which did
> not touch it), and the P3 row claimed a gate half of which was already
> witnessed.

### P1 — grounding survey, 2026-08-13

> **Citation refresh (P1 implementation, 2026-08-16).** Five line citations in
> this ADR had drifted and were corrected in place:
> `runEffectContext.ts:39-46` → `:46-53`, `discovery.ts:1173-1195` → `:1293-1320`,
> `tarballLoader.ts:192` → `:280`, `tarballLoader.ts:142-159` → `:146-181`,
> `tarballLoader.ts:163` → `:181`. Line citations rot; the surrounding prose
> names the SYMBOL in each case, which is what a later reader should grep for.

The contract must be defined against how packs execute TODAY, which
`packs/tarballLoader.ts:146-181` makes concrete: a pack node is a plain function
invoked **in-process** as `fn(ctx)`, and `ctx` is the spec's `NodeContext`
carrying live host-capability **functions** — `callAI`, `callAIWithTools`,
`emit`, `secrets` (`spec/v1/host-capabilities.md`).

That single fact sets P1's shape. **Those functions cannot cross a process
boundary**, so a "version-neutral isolated-worker contract" is not a transport
detail — it is the decision about which parts of `NodeContext` become
serializable data and which become **host-call RPC** (P3's broker). Anything
left neither serialized nor brokered is silently unavailable inside the worker,
and a pack that relies on it fails only in isolation, which is the worst place
to discover it.

Two further constraints the survey fixes:

- **`SuspendSignal` is control flow, not an error.** `tarballLoader.ts:181`
  rethrows it deliberately so the executor converts it to a suspended outcome.
  Across a process boundary an exception is just a serialized value, so the
  contract needs an explicit `suspended` outcome — otherwise HITL interrupts
  degrade into `pack_node_error` and the run fails instead of pausing.
- **Error CODES must survive the boundary.** The same block preserves a thrown
  error's `code` rather than flattening it to `pack_node_error`, precisely so
  policy-denied and model-not-allowed reach the run event log with their
  canonical codes. A naive `{ message }` serialization would erase exactly the
  codes that carry policy meaning.

Not yet decided, and the reason P1 gets an architect pass before code: what
"signed context" protects against. Signing the context the HOST sends detects a
worker tampering with its own inputs, which is weak — a compromised worker can
simply lie about the result instead. The stronger reading is that the RESPONSE
and any brokered host-call must be bound to the dispatch identity, so a worker
cannot replay another node's context or attribute effects to a different pack.
Those are different threat models and they imply different contracts.

## Alternatives weighed

- Treat signatures as sandboxing: rejected; publisher identity does not contain
  a compromised or malicious publisher.
- Use `node:vm` for production: rejected; it is not the required OS/runtime
  isolation boundary and is already documented as conformance-only.
- Ban all third-party packs: secure but defeats the open ecosystem; quarantine
  plus isolated execution preserves both safety and extensibility.
- Derive `steward` from the dev mount: rejected — two env vars steer the mount,
  so this would let configuration redefine the trusted corpus (CORRECTION 3).
- Classify `steward` by a compiled-in image path: rejected — the permit path
  would execute only in production and never in dev or CI (CORRECTION 3).

## Implementation record

### Merged-tree provenance — reconciled 2026-08-17 (H44)

Phase → PR → **merge commit on `origin/main`**, verified with
`git show <sha> --stat`:

| Phase | PR | Merge commit | Merged | Witness tests |
|---|---|---|---|---|
| CORRECTION 1 — there is no trust tier to make an execution decision from | [#3172](https://github.com/openwop/openwop-app/pull/3172) | `b920beddf` | 2026-08-12 | docs-only; it is what grew P0's scope to carry the tier vocabulary with the policy |
| P0 — trust tier + fail-closed policy (a pack's code does not execute unless something attests it) | [#3179](https://github.com/openwop/openwop-app/pull/3179) | `be62a115e` | 2026-08-12 | `pack-trust-tier.test.ts`, `pack-trust-enforcement.test.ts`, `pack-trust-config.test.ts`, `pack-content-digest-parity.test.ts` (+ `agent-loader`, `agents`, `parked-pack-dirs-not-loaded`, `subject-erasure-coverage` extended; `test/setup/attestPackFixture.ts` is the shared attestation harness) |
| P1 — the version-neutral isolated-worker contract + fake adapter + dispatch registry + host-call broker | [#3288](https://github.com/openwop/openwop-app/pull/3288) | `f16489a16` | 2026-08-16 | `pack-isolation-guards.test.ts`, `pack-isolation-executor.test.ts`, `pack-isolation-eligibility.test.ts`, `pack-worker-runner.test.ts`, `pack-dispatch-tamper.test.ts` |
| P2 — the first PRODUCTION adapter (forked, permission-modelled Node worker per dispatch) + the enforced-vs-attested `guarantees` record | _pending merge_ | _pending_ | 2026-08-17 | `pack-isolation-escape.test.ts`, `pack-isolation-child-adapter.test.ts`, `pack-isolation-build-wiring.test.ts` (+ shared harness `test/support/isolatedPack.ts`; `pack-isolation-eligibility.test.ts` extended for the new default) |
| P3 (broker hardening), P4 (the `sandbox.supported` claim) | — | — | **open** | — |

**Re-measured at `fb6cbbcba` (H44):** the five P1 witness files are **5 files /
69 tests green** — the same count #3288 records, so the phase still holds on
today's tree. The four P0 witness files are **4 files / 34 tests green**.

**Sabotage evidence from #3288, with the honest part kept:** five breaks, and
**two could not go red by construction** — the fake adapter and the in-process
path behave identically by design, so a sabotage aimed at the difference has no
difference to find. Recorded rather than dropped, because a table reading "5 red"
would have been the more flattering lie. The three that did discriminate:
dropping `runWithEffectContext` + `runWithAuthority` from the broker → 6 red;
`resolveIsolationPlan` never returning `isolate` → 3 red; the terminal-state CAS
always passing → 3 red.

**A correction P1 produced, worth carrying:** `structuredClone` does **not**
reject a class instance — MEASURED, it flattens it (prototype dropped, own data
kept, silently); only functions and platform objects throw. So the clone
predicate is not a complete guard for a surface that returns behaviour, and
`NEVER_BROKERED` is what does that job.

**P4 has NOT moved, and this reconciliation does not move it.** Its row in
`docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md` is `adoption` on RFC 0035, whose
tripwire is a NON-STEWARD host advertising `capabilities.sandbox.supported: true`
and passing the §B probes. Shipping a contract does not close an adoption gate,
and `sandbox.supported` is still absent from this host's advert.

### P0 — implemented 2026-08-12

| Piece | Where |
|---|---|
| Content digest (one algorithm, two impls) | `src/packs/packContentDigest.ts`, `scripts/lib/pack-content-digest.mjs` |
| Steward manifest + `--check` gate | `scripts/gen-steward-manifest.mjs`, `packs/.steward-manifest.json`, `scripts/ci.sh` |
| Tier authority | `src/host/packTrust.ts` |
| Runtime revocation store | `src/host/packRevocations.ts` (+ contrast note in `packTombstones.ts`) |
| Boot ordering | `src/index.ts` — `loadPackRevocations()` beside `loadPackTombstones()`, above the mount |
| Node enforcement | `src/packs/tarballLoader.ts` — refuses the import, registers refusal stubs |
| Agent enforcement | `src/packs/agentLoader.ts` — refuses registration (this path had NO verification at all before) |

Tests, each constructing its condition rather than reading the ambient pack dir:
`pack-trust-tier.test.ts` (15), `pack-trust-enforcement.test.ts` (10),
`pack-content-digest-parity.test.ts` (6), `pack-trust-config.test.ts` (3).

Every guard was falsified before being claimed: sabotaging the dispatch policy
reddens 6 tier tests; dropping the keyring revocation source reddens 1; changing
the fold separator in one digest implementation reddens 3 parity tests; adding
the break-glass to the Dockerfile reddens the config pin; mutating a vendored
pack, adding an unattested pack dir, and deleting the manifest each redden
`gen-steward-manifest --check`.

### P0 residue (not done, deliberately)

- **The install marker covers two files.** `registryInstaller` writes
  `contentHashes` for `pack.json` + `index.mjs` only, so an auxiliary module
  that `index.mjs` imports is not covered by `verifyInstalledPack()`. Pre-existing
  and out of P0's scope, but it is why `steward` (every byte) and
  `operator-trusted` (two files + a signature) are not interchangeable evidence.
- **An untrusted pack's agents are invisible rather than visibly refused.** An
  agent has no execute seam to stub the way a node does — being in the
  `AgentRegistry` *is* being dispatchable — so the loader refuses registration.
  Surfacing them with tier + reason needs an `AgentRegistry` field: P1.
- **`preferLocal` defaults true** (`mountLocalPacks.ts:97`), so an unsigned local
  pack can rename a signed registry install aside and take its place, after
  which the marker tamper-check never runs for it. `DEPLOY.md` documents
  production setting `OPENWOP_STRICT_REGISTRY=true`, which disables this — but
  that was NOT verified against the live service (gcloud auth had expired), and
  CLAUDE.md warns DEPLOY.md snapshots go stale. Under P0 the trust model makes
  this moot for *trust* purposes (a shadowing vendored pack is steward-attested;
  a non-vendored one cannot be), but a security property depending on an unset
  env var with no test asserting it is worth closing separately.
- **Operations/marketplace surfacing** of tier, reason and revocation control
  (feature matrix row 10) — `packTrustSummary()` exists to feed it; no route yet.
  > **CORRECTION (2026-09-25, `CLNP-2(a)`) — the gap is wider than "no route".** The
  > runtime store has **no product writer either**: `revokePack`, `listPackRevocations`
  > and `unrevokePack` (`host/packRevocations.ts`) are all reachable only from tests.
  > Today a revocation can only come from the STATIC `OPENWOP_TRUSTED_PACK_REVOCATIONS`
  > list, which likewise has no lister. So: enforcement is real, but neither source can
  > be created, listed or lifted from the product. The three functions are kept as this
  > row's seams — not deleted as dead code — and this row is where they get a caller.


### P1 — implemented 2026-08-16

**The decision, and why not the workload JWT.** P0's grounding survey left one
question open: what "signed context" protects against. Signing the envelope the
HOST sends detects a worker tampering with its own inputs — which is weak,
because a compromised worker can simply lie about the RESULT instead. P1
therefore binds the other direction. The host is **authoritative per dispatch**:
the worker gets non-authority DATA plus a per-dispatch **capability token**;
every host-call and the terminal result present that token; the host looks the
dispatch up BY ID in a process-local registry and reads tenant / run / node /
pack / grant / authority from **its own record**. Worker-supplied ids are never
read for a decision.

The token is a host-local 256-bit random bearer, **not** a
`host/workloadIdentity.ts` credential, for three reasons that are properties of
that mechanism rather than preferences:

- its `aud` is host-global and its claims carry no run/node/pack — it says "some
  worker of this host", where the thing to authenticate is "THIS dispatch of
  THIS node". Adding those claims would be a second identity scheme wearing the
  first one's name;
- its `jti` is never consumed, so it is replayable within its TTL BY DESIGN,
  while the result channel here must be single-use;
- it is a cross-process identity assertion verified against a trust root; this is
  a process-local capability handle with no verifier outside the minting process.

Workload identity **is** reused, for ATTRIBUTION: the dispatch record carries the
run's RECORDED `AuthorityFacts` when it has them, else a
minted-and-round-tripped `worker/pack-isolate` identity — the
`runDispatchSweeper.ts` `sweeperAuthority` precedent, same order, `null` when the
profile is not configured.

#### The split — what became data, what became RPC, what is unsupported

The P1 survey's central point is that `fn(ctx)` receives host-capability
FUNCTIONS, so the contract IS the decision about which `NodeContext` members
become serializable data and which become host-call RPC. Anything left neither
is silently unavailable in the worker.

| `NodeContext` member | Lane | Why |
|---|---|---|
| `runId, nodeId, tenantId, scopeId, inputs, config, nodeAgent, configurable, triggerData, attempt, interactiveSession, compaction, userId, actingUserId` | **DATA** (envelope) | plain values; `structuredClone`-safe |
| `trustBoundary` | **DATA, widened to `'untrusted'`** | a deliberate widening, not a copy — isolated code is additionally code the host does not vouch for, and more `<UNTRUSTED>` fencing is one-way safe |
| `emit`, `callAI*`, `callSpeechSynthesizer`, `callTranscriber`, `callImage*`, `callVideoGenerator`, `runSandboxedCode`, `respondToWebhook`, and every method-map surface (`storage.*`, `db.*`, `fs`, `queueBus`, `observability`, `a2a`, `kanban`, `knowledge`, `features.*`, `chat`, `canvas`, `webResearch`, `launchStudio`, `slack`, `ads`, `email`, `messaging`, `notification`, `connectors`, `mcp.*`) | **RPC** via the broker | the broker calls the *very same* live ctx member the in-process path calls — no second implementation to drift |
| `variables` | **snapshot in / write-behind out** | its `get`/`set` are SYNCHRONOUS by contract; a Promise cannot preserve that |
| `interrupt` / `suspend` | **result arm** | control flow, not a call — realised as the closed union's `suspended` arm |
| `secrets` | **UNSUPPORTED** | cleartext BYOK; shipping it to a worker hands it to the code isolation exists to contain |
| `mcp.subscribeResource` | **UNSUPPORTED** | takes a CALLBACK; a request/response contract cannot carry a function |
| `http.safeFetch` | **UNSUPPORTED** | returns a live `Response`, which `structuredClone` rejects outright |

#### Shapes

- **Envelope** — `protocol, dispatchId, token, typeId, packName, packVersion,
  entryUrl`, the data members above, `budget{wallClockMs,maxHostCalls,maxResultBytes}`,
  `capabilityGrant: string[]` (`'surface.method'` or a bare `'method'`),
  `variablesSnapshot`, optional `suspendResolution`. **No `secrets` key exists on
  the type.**
- **Host call** — `{dispatchId, token, seq, surface, method, args}` →
  `{ok:true,value} | {ok:false,error:{code,message}}`.
- **Result** — a closed three-arm union
  `success{outputs} | failure{error{code,message}} | suspended{kind,resumeKey,data,resumeSchema?,timeoutMs?}`,
  each plus `variablesWrites`. Submitted with the dispatch id + token and CAS'd
  `pending → completed|failed|suspended`, which is what makes both a replayed
  envelope and a second result inert.
- **Failure codes** — the worker applies the loader rule verbatim (any string
  `.code`, else `pack_node_error`); the HOST validates against
  `^[a-z][a-z0-9_]{2,63}$` after lowercasing, with a 2000-char message cap.
  Broker-originated errors carry canonical codes because the broker maps them,
  and the grammar is what stops a Node errno code (`ENOENT`, SCREAMING_SNAKE)
  leaking — the same leak the executor's class allowlist guards against.

#### Eligibility, and the fail-closed arm

Decided from the MANIFEST at load time, never by reading pack source:
`peerDependencies['secrets.resolveInPack']` ⇒ `secrets_unsupported`; the node
typeId `core.openwop.mcp.subscribe-resource` ⇒ `callback_stream_unsupported`.
Placement then follows: no origin (a host built-in) ⇒ in-process; mode `off` ⇒
in-process; eligible ⇒ isolate; **ineligible AND `untrusted` ⇒ refused with
`pack_isolation_ineligible`**; ineligible but trusted ⇒ in-process, because
isolation contains code the host does not vouch for rather than imposing a
requirement on its own steward corpus.

That refusal is a LIVE path today, not a branch waiting for P2: P0's
`OPENWOP_PACK_TRUST_ALLOW_UNSIGNED` break-glass makes an untrusted pack
dispatchable *without reclassifying it*, so a genuinely `untrusted` module
reaches the policy. `pack-isolation-eligibility.test.ts` drives exactly that
through the real loader.

#### Guard propagation is host-side, and structural

`runEffectContext.ts`'s header names the tripwire for this whole program: ALS
does not cross a process boundary, so "the host side of that boundary must
re-establish it." The broker wraps EVERY host-call in
`runWithEffectContext(record.effectCtx, () => runWithAuthority(record.authority, seam))`
— one wrapper, one place, one dispatcher — so `assertEffectAllowed`,
`observedEffectKinds` (ADR 0554 P2) and `recordAuthorityAction` (ADR 0556 P3)
fire at identical seams with identical values. The ADR 0341 replay fast path
stays AHEAD of dispatch, and under replay the broker surfaces `ReplayEffectError`
whose `replay_source_missing` code round-trips to the node failure.

The isolated branch is deliberately **not** nested inside the executor's own
`runWithEffectContext`. Nesting it would let the fake in-process adapter inherit
the ambient context and make the sabotage below pass vacuously.

| Piece | Where |
|---|---|
| Contract types, code grammar, caps, clone assertion | `src/host/packWorkerContract.ts` |
| Per-dispatch record, token, CAS, budgets | `src/host/packDispatchRegistry.ts` |
| The ctx projection + guard re-establishment | `src/host/packHostCallBroker.ts` |
| Transport-agnostic worker shim | `src/host/packWorkerRunner.ts` |
| Adapter interface + fake in-process adapter | `src/host/isolationAdapter.ts` |
| Eligibility + placement | `src/host/packIsolationPolicy.ts` |
| Executor-facing dispatch entry | `src/host/packIsolationDispatch.ts` |
| Origin stamped at registration | `src/packs/tarballLoader.ts` |
| The seam | `src/executor/executor.ts` (`:958-990`) |
| P0 residue (b): refused agents visible with tier + reason | `src/executor/agentRegistry.ts`, `src/packs/agentLoader.ts` |

Tests: `pack-dispatch-tamper.test.ts` (18), `pack-isolation-guards.test.ts` (9),
`pack-worker-runner.test.ts` (20), `pack-isolation-eligibility.test.ts` (15),
`pack-isolation-executor.test.ts` (7 — a real pack, real loader, real executor,
each behaviour asserted in BOTH placements).

#### Sabotage table — every guard falsified before it was claimed

| Sabotage | Expected | Observed |
|---|---|---|
| Drop `runWithEffectContext` **and** `runWithAuthority` from the broker | replayed effects FIRE; no authority recorded | 6 red in `pack-isolation-guards` |
| `resolveIsolationPlan` never returns `isolate` | the e2e isolated arms run in-process | 3 red in `pack-isolation-executor` |
| Grant check always true | a denied call reaches the seam | 1 red in `pack-dispatch-tamper` |
| Token comparison always true | a wrong token is accepted | 1 red in `pack-dispatch-tamper` |
| Terminal-state CAS always passes | a second result overwrites the first; a replayed envelope works | 3 red in `pack-dispatch-tamper` |

#### CORRECTIONS made while implementing P1

1. **The grant cannot be `pack requires ∩ ctx members ∩ tenant toggles` as
   written.** Taken literally that is the EMPTY set for every pack in this repo,
   and no isolated pack could call anything: `tarballLoader.ts` never stamps
   `NodeModule.requires`, and the manifests that DO declare `requires` use
   host-capability keys (`net.dns`, `net.outbound`) that are not ctx members.
   Implemented instead: the grant is ENUMERATED structurally from the live ctx
   (minus the never-brokered members), narrowed by `requires` only over entries
   that actually name a ctx surface. The tenant-toggle half is not re-evaluated
   either — `host/featureSurfaces.ts` already gates every
   `ctx.features.<id>.<method>` per call and throws `host_capability_disabled`,
   which the broker propagates verbatim; a second evaluation would be a second
   allowlist over the same fact.
2. **`structuredClone` does not reject a class instance — it flattens it.**
   MEASURED: a plain class instance loses its prototype and arrives as its own
   data properties, silently; only functions and platform objects (`Response`)
   throw. So the clone predicate is not a complete guard for a surface whose
   return value carries behaviour — `NEVER_BROKERED` is. Recorded in the
   contract's docblock and pinned by test, because the failure mode is silent.
3. **Variable writes are applied on SUCCESS only.** In-process, `ctx.variables.set`
   lands the instant it is called, so a node that fails midway leaves partial
   writes behind. Isolation makes it atomic instead: a failed or suspended
   isolated node contributes NO variable writes. A deliberate divergence, listed
   below as a pack-facing consequence.
4. **The fake adapter cannot enforce a wall clock by termination.** Its worker
   runs on this event loop and cannot be killed, so a timeout ABANDONS the
   dispatch (record cancelled ⇒ every later host-call refused, result refused by
   the CAS) and fails the node `pack_isolation_timeout`. "Cancellation kills the
   isolate" is P2's property, not P1's, and is not claimed here.

#### Pack-facing consequences

- A pack that declares `secrets.resolveInPack` **cannot be isolated**. Untrusted
  such packs are refused outright; the migration is host-injected credentials
  (the `ctx.callAI` / connectors model, where cleartext never re-enters the node).
- `ctx.mcp.subscribeResource` is unsupported in isolation; its node is refused
  rather than degraded.
- `ctx.http.safeFetch` is never granted in isolation (a live `Response` cannot
  cross); a pack reaching for it gets `host_capability_denied`. Closing this is
  P2 work — it needs a serializable response projection, which is a contract
  addition, not an adapter detail.
- `ctx.variables` keeps its synchronous semantics exactly; only the failure-path
  atomicity differs (correction 3).
- `ctx.trustBoundary` reads `'untrusted'` inside isolation regardless of the run.

#### What P2 and P3 own

P1 deliberately ships **no** OS/process/CPU/memory boundary and advertises
nothing (`sandbox.supported` stays absent — the AGRADE-WIRE-BLOCKED-RESIDUE row
for P4 is untouched). **P2** ships the first real isolation adapter behind this
same two-method interface and flips the default for untrusted tiers; the
escape suite (filesystem/env/network/process/CPU/memory/timeout/cross-pack) is
its gate, and killing the isolate on cancel is its property. **P3**'s "replay
guard survives the process boundary" is already STRUCTURAL here — the broker is
the only path to a host seam and it re-establishes both contexts — so P3
narrows to proving it against the real adapter plus the host-call policy surface.

### P2 — implemented 2026-08-17

**The decision: one forked Node process per dispatch, under the runtime's
permission model** (`src/host/isolation/childProcessAdapter.ts`), registered
beside P1's fake behind the unchanged two-method `IsolationAdapter`.

The alternatives were not close, and the reason is a platform fact this ADR's
own family already recorded. ADR 0146 §33 states the deploy target: Cloud Run
gen2 — no `/dev/kvm`, no nested virtualisation, no Docker-in-Docker, gVisor
already underneath. Firecracker, a container-per-dispatch and nsjail are
therefore *unavailable*, not merely unbuilt. The two out-of-process runtimes this
host does have (`sandboxAdapters/e2bAdapter.ts` and the Code-API adapter) belong
to the ADR 0114/0146 family, whose unit of work is a SOURCE STRING evaluated
remotely: they cannot import a pack's ESM module graph, and shipping pack bytes
to a third party is a data-egress decision that would need its own ADR. What
remained was the option needing no infrastructure that does not exist — Node
forking itself — which is also the only one available on a laptop and in CI, so
the escape suite runs everywhere rather than only where an operator has
provisioned something.

#### What is ENFORCED versus what is only ATTESTED

This is the part the phase exists to get right, so it is a machine-readable
record and not a paragraph. `src/host/isolationGuarantees.ts` defines a closed
`IsolationGuarantee` vocabulary and `AdapterGuarantees = Record<Guarantee,
'enforced' | 'not-enforced'>` — a total `Record`, deliberately not a `Set` of
enforced names, because absence from a set reads identically as "this adapter
does not enforce it" and "nobody considered it", and only one of those is safe
to ship. Adding a guarantee is a compile error in every adapter until each states
its position.

MEASURED on Node 22.13.1, and each line has a test that watches it deny:

| Guarantee | Mechanism | Level |
|---|---|---|
| `separate-process` | `child_process.fork` | enforced |
| `scrubbed-env` | `env: {}` at spawn | enforced |
| `filesystem-allowlist` | `--permission` + `--allow-fs-read/write` | enforced |
| `no-subprocess` | permission model (no `--allow-child-process`) | enforced |
| `no-worker-threads` | permission model (no `--allow-worker`) | enforced |
| `no-native-addons` | permission model ⇒ `ERR_DLOPEN_DISABLED` | enforced |
| `no-dynamic-code` | `--disallow-code-generation-from-strings` | enforced |
| `memory-cap` | `--max-old-space-size` ⇒ SIGABRT | enforced |
| `cpu-wall-clock-kill` | parent timer + **SIGKILL** | enforced |
| `cross-dispatch-isolation` | per-dispatch `mkdtemp` cwd + per-pack read grant | enforced |
| **`network-denied`** | **none available** | **not-enforced** |

**Network is the one gate item P2 does not meet, and it is not closable here.**
The record, in the exact terms it must be read in: *the worker bootstrap deletes the network GLOBALS (`fetch`, `WebSocket`, `EventSource`); `node:net` remains reachable; this is ATTENUATION and is NOT a guarantee.* `pack-isolation-escape.test.ts` asserts POSITIVELY that a socket still opens from inside the isolate, so the attenuation cannot later be read as denial — the residue is pinned, not the block.
Node's permission model has no network dimension (`node:net` connects from
inside the isolate — asserted positively by the escape suite, so a future change
that DOES contain egress must flip the guarantee in the same commit). Cloud Run
exposes no seccomp or network-namespace control to the workload. The one
in-realm route to refusing the module — `module.register()`, the only ESM
resolve hook on 22.13 — itself requires the WorkerThreads permission, so buying
it would cost `no-worker-threads`: a strictly worse trade. The worker entry
deletes `fetch` / `WebSocket` / `EventSource`, which raises the cost and changes
nothing about the guarantee, and is labelled attenuation everywhere it appears.

`unmetGuarantees(tier, adapter)` compares a tier's requirements against the
record; non-empty ⇒ `pack_isolation_guarantee_unmet`, a REFUSAL. There is no
downgrade arm and no in-process fallback, because a silent downgrade is how
"untrusted code is isolated" acquires an exception nobody can find. The
`untrusted` tier requires everything the adapter can actually deliver and
deliberately NOT `network-denied` — requiring a property no adapter provides
would make the tier permanently undispatchable, which is a gate nobody can
enable rather than one that fails closed. The comparison is kept falsifiable
instead by a test that requires `network-denied` and watches even the child
adapter be refused.

#### Defaults, and why they moved

`OPENWOP_PACK_ISOLATION` gains `untrusted` (new default) and `all`; `off` and
P1's `fake` keep their meanings verbatim. `OPENWOP_PACK_ISOLATION_ADAPTER`
selects `child` (default) or `fake`. Unrecognised values fall back to the
CONTAINING option in both cases — a typo must not be the thing that disables
containment or swaps a real boundary for a harness.

P1 defaulted to `off`. CORRECTION 4 of this ADR is explicit that a security gate
nobody enables is a gate that cannot fail, and `off` would have made P2 exactly
that. `untrusted` changes the behaviour of one population: packs that are both
untrusted AND dispatchable — which, under P0's default-ON policy, means the
operator has explicitly set the fail-open `OPENWOP_PACK_TRUST_ALLOW_UNSIGNED`
break-glass. That is precisely the set isolation exists for. Every trusted tier
is byte-identical to P1: a steward pack is not isolated, and a steward pack that
is *ineligible* (e.g. declares `secrets.resolveInPack`) is not refused either,
because `untrusted` mode never reaches the eligibility question for it.

#### Cancellation kills the isolate

The phase's named property, and real here for the first time. The parent owns
every deadline; the worker owns none (a worker that could set its own timeout
could also decline to have one). SIGKILL, not SIGTERM, so a pack installing a
signal handler cannot decline to die. The kill runs in `finally` on EVERY exit
path — result, throw, timeout alike — and additionally fires early when the
adapter relays a terminal broker refusal (`dispatch_cancelled` /
`_expired` / `_completed` / `_budget_exceeded`), so a refused dispatch stops
burning CPU instead of running out its wall clock. `dispatch_token_invalid` and
`dispatch_unknown` are deliberately NOT in that set: they describe a bad CALL,
and a host-side relay bug must not become a way to kill healthy work.

The P1 two-method interface is unchanged (`guarantees` is an added DATA field).
An `AbortSignal` was considered and rejected as churn: nothing in the host drives
a cancel today, and an interface parameter no caller passes is a capability
that only looks present.

#### The worker entry, and the gate that would not have failed

The worker must exist as a runnable file at spawn time, and the two runtimes
disagree about what exists: production ships only `lib/` and `npm ci --omit=dev`
(no esbuild); vitest has TypeScript sources and esbuild as a devDependency. The
obvious shape — build it for prod, bundle it lazily for tests — is two
configurations for one artifact where only the test lane is ever exercised, so a
divergence in the production options ships green.

Implemented instead: ONE shared options module
(`scripts/lib/isolation-worker-build.mjs`) imported by both `scripts/build.mjs`
and `src/host/isolation/workerEntry.ts`, so there is no second configuration to
drift; `pack-isolation-build-wiring.test.ts` pins the one remaining fact — that
`build.mjs` calls it — plus that the dev lane carries no esbuild options of its
own and that the worker's import list stays free of host modules.

The artifact is `.mjs`, not `.js`, and that is load-bearing: Node decides a
`.js` file's module system from the nearest `package.json`, which works beside
`lib/index.js` and fails as CJS in the temp directory the dev lane writes to.

| Piece | Where |
|---|---|
| Guarantee vocabulary + tier requirements + comparison | `src/host/isolationGuarantees.ts` |
| The adapter (spawn, relay, kill, classify) | `src/host/isolation/childProcessAdapter.ts` |
| Pure spawn-options function | `childProcessAdapter.ts` `childSpawnOptions()` |
| Worker entry (realm hardening + run) | `src/host/isolation/packIsolationWorkerEntry.ts` |
| IPC framing + the serialization constant | `src/host/isolation/workerChannel.ts` |
| Two-lane entry resolution | `src/host/isolation/workerEntry.ts` |
| Shared esbuild options (both lanes) | `scripts/lib/isolation-worker-build.mjs` + `scripts/build.mjs` |
| Modes, adapter selection, the tier gate | `packIsolationPolicy.ts`, `packIsolationDispatch.ts` |
| Metric | `openwop.pack.isolation.dispatch` (`observability/metrics.ts`, `metricSeams.ts`) |
| Adapter `guarantees` field | `src/host/isolationAdapter.ts` |

Tests: `pack-isolation-escape.test.ts` (25), `pack-isolation-child-adapter.test.ts`
(17), `pack-isolation-build-wiring.test.ts` (5), shared harness
`test/support/isolatedPack.ts`.

#### Sabotage table — 17 falsifications, every one observed red

| Sabotage | Expected | Observed |
|---|---|---|
| IPC `serialization` `advanced` → `json` | typed values mangled | 1 red (serialization fidelity) |
| Drop the `--permission` flag block | escapes become ALLOWED | 1 red (fs read outside) |
| `env: {}` → `process.env` | host env reaches the isolate | 1 red (**structural** pin — see below) |
| Remove SIGKILL on the wall clock | a busy loop is abandoned, not killed | 1 red (CPU) |
| Drop `--max-old-space-size` | our ceiling is not the one that bites | 1 red structural + 1 red behavioural |
| Fake adapter claims every guarantee | the fake could run untrusted code | 1 red |
| Remove the guarantee gate from dispatch | the comparison never runs | 1 red (WIRED test) |
| Broker drops `runWithEffectContext` | replayed effects FIRE | 1 red |
| Broker drops `runWithAuthority` | no authority recorded | 1 red |
| Worker keeps `process.send` | a pack can speak the protocol | 1 red |
| Worker keeps the network globals | `fetch` present in the isolate | 1 red |
| Re-add the duplicate `<dir>` grant | Node aborts at flag application | 1 red |
| Unavailable adapter falls back | a refusal becomes a downgrade | 1 red |
| One shared scratch dir for all dispatches | cross-dispatch reads succeed | 1 red |
| `build.mjs` stops emitting the worker | production has no worker | 1 red |
| Isolation default back to `off` | the gate nobody enables | 1 red |

#### CORRECTIONS made while implementing P2

1. **Two tests passed while sabotaged, and both were mine.** Replacing `env: {}`
   with `process.env` left the env test GREEN, because the worker entry ALSO
   blanks `process.env` in-realm and a probe reading its own environment sees an
   empty bag either way — the cosmetic attenuation was masking the enforced
   guarantee, so the test that looked like it proved `scrubbed-env` proved only
   the half that does not matter. Deleting `--max-old-space-size` left the memory
   test green for a different reason: V8 still has a default ceiling and the bomb
   hit THAT, so the test proved "some limit exists", not "we set one". Both were
   fixed by extracting `childSpawnOptions()` as a pure function and pinning the
   two flags structurally. **Neither kind of test is sufficient alone** — the
   structural one cannot show the flags work, the behavioural one cannot show
   which mechanism produced the denial.
2. **A duration bound is not a discriminator, and nearly became a flake.**
   The first fix for the memory case was "assert the OOM is fast": measured
   standalone, a 32MB ceiling aborts in 96ms and the default in 2374ms. Under
   the test runner the sabotaged path came back in **890ms**, because V8 sizes
   its default heap from available memory and vitest's workers had eaten it. Any
   threshold between those is a flake waiting for a quiet box. Replaced with a
   BOUNDED ~120MB allocation — above a 32MB ceiling, far below any plausible
   default — which needs no timing at all and was measured both ways
   (`pack_isolation_memory_exceeded` with the ceiling, `success` without).
3. **A Node bug shapes the filesystem allowlist.** Granting BOTH a directory and
   its wildcard (`--allow-fs-read=/d` with `--allow-fs-read=/d/*`) ABORTS the
   process during flag application — `FSPermission::RadixTree::Node::CreateChild,
   Assertion failed: !path_prefix.empty()`. The child dies with SIGABRT before
   running a line, so it surfaced as `pack_isolation_worker_crashed` on every
   dispatch and read as a broken worker rather than a malformed flag. The
   redundant grant looked like belt-and-braces; it was a total outage of the
   isolated path. One form per path, and `OPENWOP_PACK_ISOLATION_EXTRA_FS_READ`
   is passed through verbatim so an operator's `/opt/shared/*` is not silently
   paired with `/opt/shared`.
4. **`process.channel` cannot be removed.** Deleting it stops the child
   RECEIVING messages at all — the worker booted, said `ready`, then sat silent
   through its whole wall clock, so every dispatch failed `pack_isolation_timeout`
   and the suite read as "isolation is broken". It is left in place, and the
   escape suite asserts its MEASURED shape instead of pretending it is absent:
   `ref` / `unref` / `refCounted` / `unrefCounted` / `fd`, no callable member, no
   reachable handle symbol. A pack holding it cannot speak the protocol — and
   even hand-framing bytes onto `fd` gains nothing, because the per-dispatch
   token is never on `ctx` nor in any scope pack code can reach, and the broker
   authenticates every call and the result against its own record.
5. **Module resolution realpaths, and realpath is a READ.** Granting only the
   resolved pack path is not enough: the isolate must also be ASKED for the
   resolved path, or it dies inside `toRealPath`. The adapter therefore rewrites
   the envelope's `entryUrl` to its realpath before dispatch. Not a macOS
   curiosity — `~/.openwop-packs` entries are symlinks into a checkout, so the
   unresolved form is the NORMAL case on this host.
6. **`fork()` inherits the parent's `execArgv`.** Observed for real while
   verifying the built artifact: an inherited `--input-type=module` made the
   worker refuse to boot. `execArgv` is always passed explicitly, which under
   vitest also stops the runner's own flags leaking into the isolate.

#### Operator notes and known limits

- `slots × --max-old-space-size` must stay under the Cloud Run instance memory
  limit, or the CONTAINER is OOM-killed instead of the child — which presents as
  a platform fault rather than a contained pack. Concurrency is bounded by
  `OPENWOP_PACK_ISOLATION_MAX_CONCURRENT` (default 4) through the existing
  `util/asyncSemaphore.ts`, NOT the ADR 0114 `withSandboxConcurrency` cap:
  sharing that would couple two unrelated budgets and it fail-fasts
  `resource_exhausted` where a workflow needs queueing.
- No warm pool. Pooling would break "every invocation uses a clean isolate", so
  the fork cost is paid per dispatch by design.
- The wall-clock kill is a parent-side timer. Cloud Run throttles CPU once a
  response is flushed, so the timer is best-effort in that window; the dispatch
  record's CAS remains the authoritative bound on what a late worker can do.
- An isolated pack can import only its own directory and Node builtins. A pack
  reaching for a shared module outside its pack dir needs
  `OPENWOP_PACK_ISOLATION_EXTRA_FS_READ`.
- P2 advertises NOTHING. `sandbox.supported` stays absent; the P4 wire claim is
  still gated on RFC 0035, and the network gap above is exactly the kind of
  thing that claim would have to be honest about.

#### P2 addendum — the two failures only the deployed image can have

Both were added after the phase looked done, and one of them found a real bug I
had already written. They share a shape: **a laptop cannot observe either**, so
a green suite was never evidence about them.

**(a) The worker artifact must be IN the image.** Vitest never uses the built
lane — there is no `lib/` during a test run — so a Dockerfile that stopped
copying `lib/`, or a build that stopped emitting the worker, would leave
untrusted packs undispatchable in production with every local gate green.
`pack-isolation-deployability.test.ts` reads the Dockerfile as TEXT (the
`pack-trust-config.test.ts` precedent) and pins three facts: the runtime stage
copies `--from=builder /app/lib ./lib`; it installs `npm ci --omit=dev` (which
is WHY esbuild is absent at runtime, and therefore why the dev lane cannot
quietly become production's lane and paper over a missing artifact); and the
builder stage copies both `src/` and `scripts/`, which the worker build needs.

The refusal arm is proved by DELETING THE FILE rather than by mocking the
resolver. `OPENWOP_PACK_ISOLATION_WORKER` names an explicit worker path — a real
operator knob for an image with a different layout — and the test copies the
worker there, dispatches successfully (so "refused" below cannot mean "that path
never worked"), deletes it, and dispatches again: `pack_isolation_adapter_unavailable`,
with nothing executed. An override that is set but absent is a hard refusal and
never falls through to a discovered worker, because an operator who named a path
meant that path.

**(b) The memory arithmetic must fit the instance — and P2's first defaults did
not.** `DEPLOY.md` runs Cloud Run at `--memory=512Mi --cpu=1`. P2 originally
shipped `MAX_CONCURRENT=4` with a 128MB ceiling: **4 × 128 = 512MB, the entire
instance**, with nothing left for the process doing the spawning. Nothing in the
escape suite could have found it — every test passes on a 32GB laptop.

The failure it produces is the reason this is code and not a doc line: N isolate
heaps are charged to the CONTAINER, so exceeding the instance OOM-kills the whole
service rather than the pack. The symptom is the backend restarting under load,
which an operator reads as a platform fault or a traffic spike and never as a
pack-isolation knob — and every mechanism in this adapter for containing a
pack's memory is defeated, because the thing that dies is the host.

`checkIsolationMemoryBudget()` asserts `concurrency × per-isolate heap ≤
OPENWOP_PACK_ISOLATION_MEMORY_BUDGET_MB`. Defaults are now **2 × 96 = 192 ≤
192**, with the budget itself held to ≤256MB of the 512Mi instance so ~320MB
remains for the host — which is not spare capacity, it is where the executor,
the SPA shell cache and every in-memory store live. Concurrency 2 also suits
`--cpu=1`, where four forked V8 heaps contend for one core.

It REFUSES; it does not throw. Crashing the host at boot over a pack-isolation
knob would be a worse outage than declining to isolate. `index.ts` logs
`pack_isolation_memory_budget_unsafe` at boot (so a mis-sized deploy is
attributable on the day it ships, not hours later from a failed run) and
`dispatchInChild` refuses with `pack_isolation_budget_unsafe` before spawning —
**both from the one function**, with a test asserting the two answers agree,
because a host that boots clean and then refuses every dispatch is worse than
either answer alone.

| Sabotage (addendum) | Expected | Observed |
|---|---|---|
| Dockerfile stops copying `lib/` into the runtime stage | production has no worker | 1 red |
| Dockerfile installs dev deps too | the dev lane could mask a missing artifact | 1 red |
| Budget check always returns ok | an over-budget config is admitted | 1 red |
| Defaults back to 4 × 128 | the shipped config exceeds the instance | 1 red |
| Adapter skips the budget refusal | it spawns anyway | 1 red |
| A missing `OPENWOP_PACK_ISOLATION_WORKER` falls through | a refusal becomes a silent discovery | 1 red |
| Boot report diverges from the dispatch check | the two can disagree | 1 red |

Operator knobs, all defaulted for the documented 512Mi instance:
`OPENWOP_PACK_ISOLATION_MAX_CONCURRENT` (2), `OPENWOP_PACK_ISOLATION_MAX_OLD_SPACE_MB`
(96), `OPENWOP_PACK_ISOLATION_MEMORY_BUDGET_MB` (192),
`OPENWOP_PACK_ISOLATION_WALL_MS` (60000), `OPENWOP_PACK_ISOLATION_BOOT_MS` (15000),
`OPENWOP_PACK_ISOLATION_EXTRA_FS_READ` (empty; verbatim, a directory needs its own
trailing `/*`), `OPENWOP_PACK_ISOLATION_WORKER` (unset; explicit worker path).
