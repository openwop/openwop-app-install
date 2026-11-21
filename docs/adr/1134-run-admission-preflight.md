# ADR 1134 — Run admission preflight

Status: Accepted (2026-11-16, by the user in the Campaign Studio acceptance session). Proposed 2026-11-15. Closes Campaign Studio ledger CC-CHAIN-9 and
CC-ORCH-2; ADR 1126 D1 (film creative's "no silent half-on state") depends on it.

## Context

A run can start that is certain to fail, and it spends money and asks people to approve work
before it does. Two cases were observed on production on 2026-11-15:

- **CC-CHAIN-9: a required chain parameter was not enforced.** `market-intel.shift-digest`
  declares `previous` required. `POST …/workflows/from-chain` without it returned 201, and
  `POST /api/runs` returned 201. The run spent on AI discovery, and the shift node's inputs were
  `{}` (run 198f9325).
- **CC-ORCH-2: a required feature toggle was not enforced** (CasaVoga, v0.14.0). With
  `production` off, `campaign-studio.campaign-orchestration` generated and gated every channel,
  and failed `host_capability_disabled` only after people had approved drafts (run 7f156976).
  CC-CHAN-3 is the same root at node level: a node tested that a surface *exists*, which is always
  true, instead of whether the feature is *enabled*.

### What the host already computes, and why none of it stops a run

| Check | Where | Behaviour today |
|---|---|---|
| Unfilled template params | `findUnfilledExpansionParams` (`host/workflowChainPackLoader.ts:1215`); from-chain `unfilledParams` (`routes/workflows.ts:1106-1123`) | reported in the 201 body only |
| Required features | `chainRequirements().requiredFeatures` (`workflowChainPackLoader.ts:1016-1026`) | derived only from the chain's **own** `feature.<id>.nodes.*` type ids: misses sub-chain nodes and features a node reaches through **another** feature's surface; shown in the gallery, never enforced |
| Node version pins | gallery `pinMismatches` (`:1011`), from-chain `pinGaps` (`routes/workflows.ts:1089`), run insert (`host/runInsert.ts:163-172`) | stamps `metadata.nodePinMismatches` and logs `run_node_pin_mismatch`; never refuses. `unmetNodePins` (`host/chainPinRule.ts:226`) has no caller |

Instantiation is **deliberately permissive**: grade-ux TPI-3 decided that "just copy" a template
with blanks is right, so it can be finished in the builder (`routes/workflows.ts:1091-1097`).
This ADR keeps that.

## Decision

### D1 — One preflight, at run admission

A pure-over-inputs host module, `host/runPreflight.ts`, is called from
`insertRunWithStartContext` (`host/runInsert.ts:121`) **before the run row is written**. Every
run-start path already funnels through that function: the runs route, `startWorkflowRun`, agent
tools, schedules, triggers and sub-chain dispatch. A failing preflight throws
`OpenwopError('validation_error', …, 422, {reason:'run_preflight_failed', findings:[…]})`. No row
is written, no provider is called and no gate is raised. Each finding is
`{kind:'param_required'|'feature_disabled'|'node_pin_unmet', …}` with a sentence a person can
act on.

**Scope by run kind:**
- **Fresh runs:** all three checks.
- **Replay and `:fork` in replay mode:** no checks. They read recorded outputs, and refusing them
  would break replay determinism.
- **Branch forks:** the feature check only. They re-execute later nodes, and a disabled feature
  would fail there too.

> **§Correction (2026-11-16, P0 implementation) — D1's refusal ships in SHADOW first.**
> This ADR did not engage ADR 0504, which built a run-start refusal for unfilled
> params, measured it, and withdrew it because it would have refused most of the
> gallery. D2 is narrower (declared-required params with no value from any
> source), but its population is not small: **MEASURED on `e3d757de6a`, 150 of
> 261 chains declare at least one required param, none with a default**, and many
> are supplied at run time (campaign orchestration's `briefId` is a run input).
> So P0 records what it would refuse on `run.metadata.preflightFindings` and the
> `run_preflight_findings` log line, and refuses only under
> `OPENWOP_RUN_PREFLIGHT=enforce` (`off` disables it). Flipping the default to
> `enforce` needs the shadow population read on production first, by name: every
> finding either a true defect or a fixed false positive. D3 and D4 inherit the
> same rollout.

### D2 — Required parameters

For a definition with `metadata.expandedFrom` (a chain instantiation), each chain parameter in
`parameters.required` must be satisfied, using the existing `findUnfilledExpansionParams` over
the definition:
- **Frozen mode:** by a frozen value.
- **RFC 0124 deferred mode:** by a run input or variable.

A parameter with a `default` is satisfied by its default. Sub-chain children are checked against
their own required parameters. A missing one gives `param_required` with the parameter's name and
description. This is the check CC-CHAIN-9 needed: shift-digest without `previous` is refused
before discovery spends anything.

### D3 — Required features, transitively and explicitly

The required feature set is the union of:
1. `feature.<id>.nodes.*` node type ids in the definition **and in every co-registered sub-chain
   definition** (today's rule, made recursive);
2. a new **node-level declaration** in node pack manifests: `requiresFeatures: string[]` on a node
   that calls another feature's surface (for example a campaign-channels node that writes through
   `production` or `creative-briefs`). The node's own feature is implied;
3. a chain-level `requiresFeatures` for features a chain needs that no node names. This is an
   additive manifest field on our chain packs, not a wire change (see the RFC verdict).

A feature listed with `optional: true` in a node declaration (the node skips cleanly when it is
off, like CC-CHAN-3's corrected node) is not required. Each required, toggle-gated feature must be
enabled for the tenant **and** entitled (`requireFeatureEnabled` semantics, both halves). Always-on
features drop out, as today. A miss gives `feature_disabled` naming the feature's label.

**Ratchet:** a static census test fails if a `packs/feature.*.nodes` node reads
`ctx.features[<other>]` without declaring `<other>` in `requiresFeatures` (required or optional).
That makes D3.2 complete by construction, not by memory.

> **§Correction (2026-11-16, P1 implementation) — D3.2's declarations live in a host table first.**
> D3.2 put `requiresFeatures` in the node pack manifests. Every manifest edit is a pack
> version bump, a packPins and steward-manifest update, and a registry publish that needs
> the user's yes, so P1 records the cross-feature reads in a host table
> (`host/nodeFeatureRequirements.ts`) and also reads the manifest fields
> `x-requiresFeatureSurfaces` / `x-optionalFeatureSurfaces`, so a pack can move its
> declarations into its own manifest with its next ordinary release. The chain-level field
> is `x-requiresFeatures`. The census ratchet reads both sources. Child workflows started
> by id are followed up to four levels; a channel dispatched at run time with no
> `workflowId` cannot be followed statically. Every finding stays SHADOW until
> `OPENWOP_RUN_PREFLIGHT=enforce`.

### D4 — Node pins: refuse what cannot run, warn on the rest

Wire `unmetNodePins` (`host/chainPinRule.ts:226`) into the preflight:
- **Pin unmet:** a pinned node type that is not installed, or is installed at a **different major
  version** than pinned, gives `node_pin_unmet`, which refuses. The node's contract changed.
- **Minor or patch difference:** stays advisory, exactly as today: stamped on
  `metadata.nodePinMismatches` and logged. Packs ship minor fixes constantly, and refusing on them
  would block every run after each publish.

### D5 — Surfaces

- `POST /api/runs` and the builder Run button return the findings. The builder shows them in the
  existing preflight banner.
- Agent tools that start runs (Campaign Strategist, Film Director) return the typed refusal to the
  model, which tells the person what to enable or fill.
- Scheduled and trigger-started runs write the refusal as a failed *start* event in the
  schedule/trigger history, not a run row, and notify the owner once per distinct finding set.
- From-chain keeps returning `unfilledParams` and `pinMismatches`, and adds the D3 feature set as
  `requiredFeatures`, so the client can warn before the first run.

## Phases

| Phase | Scope |
|---|---|
| P0 | `runPreflight.ts` + the D2 param check at `insertRunWithStartContext`; fresh runs only; tests (shift-digest without `previous` refused, nothing written) |
| P1 | D3: recursive node-id derivation + node `requiresFeatures` + chain `requiresFeatures` + entitlement half; census ratchet; declare the existing cross-feature reads (campaign-channels → production, creative-briefs, …) |
| P2 | D4: `unmetNodePins` wired for major/missing; minor stays advisory |
| P3 | D5 surfaces: builder banner, agent tool refusals, schedule/trigger start-failure history + notification |

## Alternatives weighed

- **Refuse at from-chain.** Rejected: it reverses grade-ux TPI-3 ("just copy"), and a deferred
  parameter is legitimately filled at run time.
- **Each chain adds its own preflight node.** Rejected: it is easy to forget (it already was) and
  cannot see the run-kind rules in D1. The CC-ORCH-2 chain had none.
- **Refuse on any pin mismatch.** Rejected: minor pack fixes would block every run after each
  publish.

## RFC verdict

**Host extension, no RFC.** The refusal uses the existing error envelope with a host reason code.
`requiresFeatures` lives in this host's node- and chain-pack manifests. Feature toggles are host
concepts, never advertised on the OpenWOP wire, so the field is a host-namespaced manifest
extension that other hosts ignore. If a portable "chain requires capability X" claim is ever
wanted, that would be an RFC 0013 revision.

## Open questions

1. A branch fork after a feature is turned off: refuse up front (as proposed) or let it fail at
   the node? Proposed: refuse up front, with the same finding.
2. Default notification channel for scheduled-run start refusals: the owner's inbox (assumed).
