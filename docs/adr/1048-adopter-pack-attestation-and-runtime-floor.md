# ADR 1048 — Adopter pack attestation and a fail-closed runtime side-effect floor

Status: Accepted (David, steward, 2026-11-03)

Designed by the `/architect` review of 2026-11-03 (adopter packs: trust and the
replay floor, written for ADR 1031 P3 and future adopters). It amends **ADR 0555**
(a new trust tier and the reach of "attestation by repo") and **ADR 0572** (a
runtime half of replay.md requirement 4). It is a prerequisite of **ADR 1031 P3**
(#5512): P3 removes KickTodo's packs from the steward manifest, and without this
ADR they would be refused at boot. Host-internal: no wire change (§Wire).

It supersedes the host item queued as Book AI's P49, confirmed by openwop-app-88.

## Context

### 1. Replay classification failed OPEN for every pack node no build scanned

`isSideEffectingNode` (`executor/sideEffects.ts`) returned true only when one of
these held: the typeId is in the generated `MANIFEST_FAST_PATH_SERVED`, the
module self-flags `sideEffecting`, or a hand-kept regex matches. **Nothing at
runtime read a pack manifest's `role`.** `packs/tarballLoader.ts` registered
every pack node as a wrapper with no `sideEffecting` field, so a dispatchable
pack the build never scanned had every node classified "safe to re-execute".
`executor.ts` then ran `replayServed ?? module.execute(ctx)` and the node fired
again on every `mode:'replay'` fork.

The only thing behind it was the ADR 0531 seam backstop (`assertEffectAllowed`),
which covers SMTP, the notification emitter, brokered and webhook egress, and
blob writes — and throws (safe, non-conformant per upstream #999). A node that
inserts a `DurableCollection` row or an approval through a feature service
passes it silently.

**Measured, not inferred.** `test/adr1048-replay-unclassified-pack-node.test.ts`
was written FIRST, against the base (`256dbc874`), as openwop-app-88 asked. The
fixture is an operator-trusted pack (the registry case) whose `insert` node
declares `role: "side-effect"` and mints a record id. openwop-app-88 expected
the fork to fail `replay_source_missing`. **It did not.** The replay fork
completed, the node re-executed, and a second record with a new id was written.
The unknown-role, no-role and undeclared variants did the same (4 of 5 cases
red; the `pure` control was green). Silent duplicate.

Who was exposed:

- **Every registry pack** installed operator-trusted whose nodes are not in
  upstream's build snapshot (measured below).
- **Book AI, today.** Its `vendor.bookai.author-suite.nodes` declares 16
  `side-effect` nodes, none in its `sideEffectFloor.generated.ts` (its
  `gen-side-effect-floor --check` is red). Book AI's own reading, checked here:
  15 of the 16 are AI calls plus reads, and its proposals are written by Book AI
  routes after approval; on a replay their model calls hit the source run's
  invocation log (ADR 0326 P3b, `replayInvocationsFromRunId`). **So for those 15
  the risk is live spend on cache-key misses, not duplicate records.** The
  sixteenth, `yolo-answers`, is not AI: it suspends for the author's answers and
  then runs a read-only receipt check through `surface.yoloAnswerReceipt`
  (`checkYoloReceipt`, Book AI `yoloRuns.ts:232`). That check compares the stored
  receipt and re-verifies the answering user's write role; a Book AI route writes
  the receipt before the answers reach the run. It has no AI reach, so it is
  **served**: a fork reproduces the source run's verified result instead of failing
  on a role that changed since, and anything the fork later applies passes approval
  and role checks again. Served here does not mean "writes".
- **KickTodo after P3.** Seven nodes were served upstream; after P3 only
  `session-reminder` stays covered (through `hostContributions`). The other six —
  `remind-today`, `kickbot-coach-turn`, `calendar-sync`, `apply-revision-commands`,
  `create-candidate`, `propose-plan-change` — would re-execute. The last two mint
  ids, so **they are the duplicate-record case**. This ADR's adopter replay test
  (S11) proves the mechanism on a stub that inserts a record; KickTodo's own
  `propose-plan-change` witness is a downstream test (§Consequences).

### 2. Adopter packs could not be trusted without editing upstream files

`host/packTrust.ts` attests a vendored pack only through
`packs/.steward-manifest.json`, keyed by directory. P3 removes KickTodo's two
entries, so `feature.kicktodo.nodes` gets refusal stubs and
`vendor.openwop-app.kicktodo.agents` registers no agents. The trial tree confirms
it (`gen-steward-manifest --check` in `kicktodo-p3-dry`: "vendored but not
attested"). The only adopter-side fixes were a fifth modified overlay file, or the
`OPENWOP_PACK_TRUST_ALLOW_UNSIGNED` break-glass that `pack-trust-config.test.ts`
forbids in shipped config. Book AI already pays that merge tax: it edits the
steward manifest (two `vendor.bookai.*` entries) on every upgrade.

Both generator `--check`s (`ci.sh` runs them) also scan all of `packs/`, so every
adopter pack is "drift" and an adopter's gate is structurally red.

### 3. The mount was steered by a prefix list

`mountLocalPacks.ts` mounts only `DEFAULT_LOCAL_PACK_PREFIXES`. Book AI sets
`OPENWOP_LOCAL_PACK_PREFIXES`, which REPLACES the list (a typo drops upstream
packs), and is one of the two variables ADR 0555 Correction 3 names as
"redefining what the steward corpus is". DeckTalk's rename PR (#5544) had to add
a `vendor.decktalk.` row — the same tax.

### 4. A classifier defect hid Book AI's AI nodes

`scripts/lib/packNodeReach.mjs` read one file. Book AI's `index.mjs` does
`import { ask } from './ask.mjs'; export { ask } from './ask.mjs';`, so the reach
analysis found no body for `ask` and reported `unresolved: "fn ask not
resolvable"`. Measured on Book AI `63e1b0bb`: **1 invocation-log + 15
unresolved** before; **15 invocation-log + 1 served (`yolo-answers`)** after the
fix in D5. KickTodo's pack is unchanged by it (7 served either way), and so is
upstream's committed snapshot (byte-identical; `gen-served-set --check` green).

## Decision

### D1 — The adopter manifest: `packs/.adopter-manifest.json`

An adopter-owned, generated, committed file in the ADOPTER's repo:

```json
{ "version": 1, "packs": {
  "<dir>": { "version": "1.39.0", "files": 4, "digest": "<sha256>",
             "declared": ["<typeId>", "…"], "served": ["…"],
             "held": { "ai-invocation-log": [], "ai-opaque-not-logged": [],
                       "deferred-role-semantics": [], "declared-pure": [] },
             "servedUnresolved": [], "replayClass": { "<typeId>": "pure" } } } }
```

- **Same digest rule** as the steward manifest (`pack-content-digest`, both twins).
- **Read from the code-anchored location.** `host/adopterPackManifest.ts` locates
  the `packs/` directory exactly as `packTrust.ts` does (walking up from its own
  module path to `packs/.steward-manifest.json`) and reads `.adopter-manifest.json`
  from that directory by its fixed name. No env var — not `OPENWOP_LOCAL_PACKS_DIR`,
  not anything else — can redirect it (S6). It is never searched for on its own,
  so a stray copy higher up the filesystem cannot be found instead.
- **Validated once, at first read, then frozen.**
- **Upstream never tracks one.** `build-whitelabel-zip.sh` adds it to the ADR
  1031 `ADOPTER_PATHS` guard.

Trust and the floor ride in one file bound to one digest per pack: the floor half
is a pure function of the attested bytes.

### D2 — The `adopter` tier, evaluated after the steward check

```
identity → revoked (either source) → install marker → steward digest → ADOPTER → untrusted
```

`adopter` requires all of: the manifest is valid as a whole; it keys
`basename(packDir)`; the pack's own `name` equals that key; the digest matches.
It yields `{ tier: 'adopter', reason: 'adopter_manifest_digest_match', dispatchable: true }`.

**Invariant: no first-party verdict can change.** The steward branch of
`classifyUncached` is byte-identical; the adopter step runs only when it has
already failed, and the manifest may not repeat a steward key. Pinned by a test
that classifies every steward key with no adopter manifest, with a valid one, and
with a rejected one that claims a steward key, and requires identical verdicts.

`adopter` is a trusted tier (`tierIsTrusted`), requires no isolation guarantees
(the adopter's own release artifact, like steward), and the marketplace chip reads
it as "Ships with this app". A revocation wins over it (S7). The break-glass never
promotes to it (S8).

### D3 — Validation: any violation rejects the WHOLE file

| code | rule |
|---|---|
| `shape` | `{ version: 1, packs: {…} }`, typed entries; unparseable is `shape`, never "absent" |
| `shadows_steward` | a key present in the steward manifest |
| `reserved_prefix` | a `core.openwop.*` or `community.openwop.*` key |
| `namespace` | not `vendor.<adopter>.*`, or under an upstream vendor namespace (`vendor.openwop-app.`, `vendor.openwop.`, `vendor.myndhyve.`), unless grandfathered (D7) |
| `name_dir_mismatch` | `packs/<key>/pack.json` `name` ≠ `<key>` |
| `pin_missing` / `pin_version` / `pin_unattested` | keys and versions must EQUAL `ADOPTER_PACK_PINS` (ADR 1031 P1's `src/adopter/packPins.ts`), both ways |
| `typeid_upstream` | a declared typeId in upstream's `MANIFEST_DECLARED_TYPE_IDS` |
| `typeid_namespace` | a declared typeId outside `<key>.` |
| `floor_not_declared` | a served/held typeId the entry does not declare |
| `replay_class` | a declared class for a typeId that is not the pack's own, a wildcard, or a class outside `served` / `ai-invocation-log` / `pure` |

Rejected ⇒ every claimed pack is `untrusted/adopter_manifest_rejected`, does not
dispatch (so none of its nodes can reach a replay unclassified), `log.error`
names the violations, and `packTrustSummary().adopterManifestRejected` is true.
`--check` makes a rejected file unreachable in a gated tree.

The rules exist twice — the generator (`scripts/lib/adopter-pack-manifest.mjs`)
and the runtime (`src/host/adopterPackManifest.ts`) — because the image carries no
`scripts/lib/`, the `pack-content-digest` arrangement; a parity test runs one table
through both.

### D3(c) — An adopter may declare a replay class for its OWN nodes

`replayClass: { "<typeId>": "served" | "ai-invocation-log" | "pure" }`, per typeId,
hand-written into the committed manifest and carried forward by every
`--adopter` run, applied after the derivation:

- `served` — serve the recorded outcome (also for a node outside the floor);
- `ai-invocation-log` — a floor node stays live; its provider call replays from
  the invocation log;
- `pure` — a floor node stays live and re-runs (`held.declared-pure`).

Only the adopter's own declared typeIds (`typeid_upstream` and `replay_class`
make a first-party or steward typeId impossible), never a wildcard, and every
declaration is a reviewed, committed diff that the census prints.

### D4 — Generators: one partition, both `--check`s green in an adopter tree

- `gen-steward-manifest.mjs` (no flag) skips directories the adopter manifest
  claims. Upstream has none: **output byte-identical**.
- `gen-steward-manifest.mjs --adopter` claims every pack directory not in the
  committed steward manifest. It is **inert upstream** (refuses when
  `backend/typescript/src/adopter/` is absent), so a new first-party pack can never
  be mis-claimed. It refuses on a missing role, a cross-pack role conflict, or any
  D3 violation, and never touches the steward file.
- `--check` checks the steward half over unclaimed directories, the adopter half
  (validation, digests, and the floor half), and that every pack directory is in
  exactly one manifest. Messages name the right command.
- `gen-side-effect-floor.mjs` excludes claimed directories from upstream's
  snapshot, but checks role conflicts and missing roles over every pack.
- The shared scan and served-set derivation move to `scripts/lib/side-effect-floor.mjs`.

Measured on a copy of `kicktodo-p3-dry` with this branch's scripts: both checks
red before; `--adopter` writes 2 packs (`feature.kicktodo.nodes`: declared 54,
served the same 7 the upstream floor served; the agents pack: 0 nodes); both
checks green after.

**The census ratchet is the committed manifest itself.** Any added pack or node,
any move between served and held, and any declared class is a diff `--check`
refuses until it is regenerated and committed.

### D5 — The floor merge, and the runtime manifest floor (fails closed)

```
isSideEffectingNode(t, m) =
     t ∈ MANIFEST_FAST_PATH_SERVED     // upstream build (unchanged, first)
  ∨ t ∈ ADOPTER_SERVED                  // adopter build, from the validated manifest
  ∨ m.sideEffecting === true            // programmatic, OR the runtime floor below
  ∨ SIDE_EFFECTING_TYPE_PATTERNS…       // unchanged
```

**The runtime manifest floor** (`classifyUnbuiltPackNode`, applied by
`tarballLoader` to every node of a DISPATCHABLE pack as it is registered):

```
if t ∉ MANIFEST_DECLARED_TYPE_IDS ∧ t ∉ ADOPTER_DECLARED:     // no build classified t
   decl = this pack's manifest entry for t
   served = !decl ∨ role ∉ ROLES ∨ role = 'side-effect'
          ∨ ('side-effectful' ∈ caps ∧ role ∉ {gate, streaming-output})
```

- **Unclassified nodes are SERVED: the recorded result is reproduced, never
  re-executed.** A served node the source never reached fails
  `replay_source_missing` (the ADR 0341 fast path); it never fires.
- **It never reclassifies a typeId a build already knows.** The `∉ declared`
  guard is what keeps upstream's AI holdback and an adopter's `held` typeIds LIVE
  under the invocation log (RFC 0041 §B). Without it, the module flag — a
  decisive arm — would override the holdback. Pinned by a test that re-ships a
  held upstream typeId as `side-effect` and requires it to stay live.
- `gate` and `streaming-output` with the capability stay live, as the build holds
  them (ADR 0572 leaves their fast-path semantics unresolved). One registry node
  is affected (`core.ai.awaitEnvelope`, below); this is a deliberate consistency
  choice, not an oversight, and it is the one point where the runtime floor does
  not serve a `side-effectful` declaration.
- Each pack whose nodes the floor serves logs one WARN naming them;
  `runtimeClassifiedNodes()` exposes every decision.
- It cannot run the build's static AI-reach analysis, so an unknown AI node with a
  side-effect declaration is served rather than run live: no live spend and no
  duplicate, at the cost of §B divergence detection for that node until a build
  classifies it.

**Where the served decision is made** (Book AI's point that "regenerating the
floor alone protects nothing"): `executor.ts` asks `isSideEffectingNode(typeId,
module)` with the REGISTERED module. Adopter floor entries reach it through the
`ADOPTER_SERVED` arm; runtime-floor classes reach it through `module.sideEffecting`,
which `tarballLoader` sets on that module. Both are witnessed end-to-end by a
replay fork, not by set membership (S10, S11).

**Adopter `held: unresolved` fails closed.** The adopter generator SERVES floor
nodes its reach analysis cannot read (`servedUnresolved`), where upstream holds
them behind the backstop: an adopter has no steward reviewing its residue.

**The re-export fix.** `packNodeReach.mjs` follows `import { a as b } from './x.mjs'`
and `export { a } from './x.mjs'` to the sibling module, for the root function and
every helper it calls. Only relative specifiers, only to files that resolve
(symlinks included) inside the pack directory; a bare specifier, an escaping path,
a namespace/default import or a missing file leaves the node `unresolved`.

### D6 — Mounting is the adopter manifest's claim, not a prefix

`shouldMount(name)` is `prefix match ∨ name ∈ adopterClaimedPackDirs()`, the claim
read from the code-anchored manifest. **`DEFAULT_LOCAL_PACK_PREFIXES` is
first-party prefixes only** and no adopter adds a row. Book AI can drop
`OPENWOP_LOCAL_PACK_PREFIXES`. DeckTalk's `vendor.decktalk.` row (#5544) may stay
while DeckTalk is an in-tree first-party feature, and goes when it becomes an
adopter. A mount still confers no trust; a rejected manifest still claims its
directories, so they mount and refuse with the real reason instead of vanishing.

### D7 — Namespace policy

New adopters use **`vendor.<adopter>.*`** (`vendor.bookai.*` already does).
KickTodo keeps **`feature.kicktodo.nodes`** and
**`vendor.openwop-app.kicktodo.agents`** as grandfathered, explicitly listed ids,
because replay pins, typeIds and stored agent ids key on them (ADR 1031
invariant 1). It is a list of two ids, never a prefix. DeckTalk is renamed
separately (#5544).

## Threat model

- **Repo attestation, same class as steward.** Whoever can commit to the adopter
  repo already controls the adopter's image and source; the attack surface does
  not grow. It is weaker than signing, exactly as ADR 0555 says of steward.
- **Env is rejected** (ADR 0555: "no environment flag may promote an unsigned
  pack to trusted"). No env var moves the manifest (S6), and the break-glass
  never yields `adopter` (S8).
- **A community or registry pack cannot ride it.** A registry pack has an install
  marker, checked first, and a tampered marker is never rescued. A hand-dropped
  pack must match a committed digest, so it is the adopter's own bytes. With
  `shadows_steward`, the reserved prefixes and `typeid_upstream`, it cannot shadow
  a first-party pack or typeId.
- **Signing is the successor.** If Cloud Build gains the signing key, adopter packs
  should be signed at release, with this manifest kept as the floor carrier.

## Wire

**None — additive and host-internal.** No run event, endpoint, capability advert or
schema changes. The trust tier and its reasons are host-internal (`RefusedAgentEntry`
only ever carries untrusted or revoked; the marketplace listing that shows the tier
is a host-local route). Replay behaviour moves only in the direction replay.md
requirement 4 permits ("a host may classify additional nodes as side-effecting").
`sideEffectSuppression: 'recorded-outcome'` is unchanged.

**No new `EffectKind`.** Checked as openwop-app-88 asked: `EffectKind`
(`host/runEffectContext.ts`) is a host-internal TypeScript union. ADR 0533 grew it
without an RFC, and it appears in no event, advert or conformance vocabulary. This
ADR adds none anyway: the fix is classification (which nodes are served), not a new
guarded seam, so no RFC is needed.

## Measured population whose replay behaviour changes

Read-only, without production credentials:

| Population | Unknown to upstream's build | Runtime floor now SERVES | Stays live |
|---|---|---|---|
| packs.openwop.dev public index, latest version of every node pack (60 packs, 388 nodes) | 26 nodes in 10 packs | **17 nodes in 7 packs** | 9 |
| in-repo `packs/` (incl. `community.openwop.*`) | 0 — all steward, all in the snapshot | 0 | — |
| in-repo `examples/` (chain + connection packs) | 0 node packs | 0 | — |
| `conformance-fixtures/wasm-packs/misbehaving-*` | 2 (`role: "transform"`) | 2, **if** ever loaded through the JS loader; they are wasm conformance fixtures | — |

The 17 registry nodes: `vendor.myndhyve.ai@1.0.0` `core.ai.generateFromPrompt`,
`core.ai.callPrompt`; `vendor.myndhyve.app-builder@1.0.0` `app-builder.per-screen`,
`app-builder.iterate-tasks`; `vendor.myndhyve.brand@1.1.0` `brand.theme.{analyze,
discovery,generate,templates}`, `brand.persona.{discover,generate,keywordStrategy}`;
`vendor.myndhyve.campaign-sequence-integration@1.0.1`
`campaign.sequence.{email,sms,webhook}`; `vendor.myndhyve.kanban@1.0.0`
`kanban.task.decompose`; `vendor.myndhyve.web-research@1.0.0` `ai.process.synthesize`;
`vendor.openwop.rust-hello@1.0.0` `vendor.openwop.rust-hello.greet` (role
`transform`, outside the taxonomy). `core.ai.awaitEnvelope` (a `gate` with the
capability) stays live by D5.

**Not measured: production's installed population.** Which registry packs
`OPENWOP_INSTALL_PACKS` pins on any live service needs the Cloud Run config, which
this ADR's author did not read (no production credentials were used). The registry
index is the upper bound of what an operator could install; ADR 0713 records that
the installer refuses pins below the vendored version, so for packs vendored here
production serves the steward copy, whose nodes are all in the snapshot.

## Alternatives considered

| Option | Verdict |
|---|---|
| (a) Adopter manifest, same digest, code-anchored | **Chosen** for trust: first-party exactly as strict, zero modified upstream files, no env promotion |
| (b) Generated adopter floor half | **Chosen**, carried inside (a) and disjoint from upstream's typeIds |
| (c) Env digest list or per-adopter signing key | Env is the promotion ADR 0555 forbids; a key is the long-term successor but Cloud Build cannot reach it today |
| (d) Declarative floor, fail-closed, at runtime | **Chosen**: the only option that closes the fail-open for registry and break-glass packs too |
| (e) Sign and registry-install adopter packs | Strongest, but a publish per change, network at boot and a namespace per adopter |
| (f) List nodes in `hostContributions.sideEffectingNodeTypes` | A hand-kept list — the drift class requirement 4 exists to stop |

## Sabotage evidence

Each control was disabled on a committed tree and the named test went red; then
restored. Recorded in the PR body with the failing-case counts.

- S1 digest match removed → digest-mismatch case; S2 `shadows_steward` removed;
  S3 reserved prefixes removed; S4 name = directory removed; S5 pins equality
  removed; S6 manifest located from `OPENWOP_LOCAL_PACKS_DIR`; S9 the `∉ declared`
  guard removed (the held upstream typeId case); S10 the runtime floor removed (the
  witness); S11 the adopter-served arm removed (the adopter replay); S12 the
  re-export walk removed; first-party invariance (steward branch moved after the
  adopter step).

## Consequences

- **Book AI** drops its two modified files (the `.steward-manifest.json` entries and
  its `features/packPins.ts` pins, which move to `src/adopter/packPins.ts`) and
  `OPENWOP_LOCAL_PACK_PREFIXES`, runs `gen-steward-manifest.mjs --adopter`, and its
  `ci.sh` floor check goes green. Its 15 AI nodes stay live under the invocation
  log; `yolo-answers` is served. Book AI adds a downstream test that a replay fork of
  a pinned chain makes zero live model calls.
- **KickTodo** (#142, with P3) commits `packs/.adopter-manifest.json` in the sync
  merge and adds the `propose-plan-change` / `create-candidate` replay witness in
  `backend/typescript/test/adopter/`.
- **Registry packs**: the 17 nodes above stop re-executing on replay; they serve or
  fail closed. An operator whose replays relied on live re-execution of one would
  need a waiver — none is known; if one appears, a per-pack waiver list with its
  own census is the falsifiable next step.
- The ADR 0531 backstop stays; it is now behind a classification that fails closed.
