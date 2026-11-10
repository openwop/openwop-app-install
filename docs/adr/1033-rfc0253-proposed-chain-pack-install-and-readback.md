# ADR 1033 — Proposed workflow-chain and agent packs install per tenant and read back (RFC 0253)

Status: implemented (P1 #5511: chain packs; P2: agent packs and tenant sub-chains).
RFC 0253 is `Active` (openwop #2073, suite 2.46.39; the chain-pack legs need
2.46.42). `Accepted` waits on a certified cut that records the `0253.*` legs
`executed-pass`.

## Context

RFC 0253 adds `getInstalledPack`, `GET /installed-packs/{packName}`. It serves the
`pack.json` that `applyProposal` installed in the caller's tenant. That makes an
applied `workflow-chain-pack` or `agent-pack` proposal byte-comparable, as RFC
0249 already made `prompt-template` (ADR 0972). Certified cut 196 (2.46.41, build
`d2c7e089b`) recorded all ten `0253.*` host legs `inapplicable`, because
`agents.proposals.readback` was `["prompt-template"]` only.

ADR 0938 D7 deferred chain-pack installs: the from-chain lane would be "a second,
unsigned chain ingest door" that "needs its own security decision". It also put
unsigned agent packs out of policy. This ADR takes that decision for chain packs
only.

Two facts about this host shape the design:

- Host chain packs (vendored and registry) load into one process-global map from
  the filesystem. A pack written there by one tenant would be visible to every
  tenant on that instance, and absent on the next Cloud Run instance.
- The wire tenant is the workspace (`tenantOf(req)`). RFC 0253 UQ 6 says a host
  that installs per workspace does not advertise `readback`. Here the store is
  keyed by the wire tenant, which is the tenant the RFC means, so it is
  tenant-wide by definition. This is the same reading ADR 0972 used for
  templates.

## Decision

1. **Security decision (reverses ADR 0938 D7 for chain packs).** A tenant may
   install an unsigned chain pack through the proposal lifecycle, under these
   rules:
   - the name is `private.*`;
   - the pack carries no `signing`;
   - it passes the loader's own rules for chains that are not a host pack
     (`validateChainDocuments`: v2 schema, RFC 0177 §E.1 exact pins with no
     legacy waiver, sub-chain cycles, RFC 0133 composition);
   - it cannot shadow a host pack name or chain id;
   - applying it needs `packs:publish`, the role ADR 0972 already requires for
     apply.

   A chain pack carries no code. Its nodes are host node types, each pinned and
   resolved at instantiation like any template. Instantiating a template already
   warns about uninstalled or mismatched node types (`warnings`, `pinMismatches`),
   so the new door adds no new kind of executable surface. Unsigned agent packs
   remain out of policy (ADR 0938 D7 stands for them).
2. **Store** (`host/tenantInstalledPacks.ts`). The `proposals:installed-packs`
   collection is keyed `${tenant}::${name}` and tenant-indexed. Each row holds the
   applied artifact verbatim, plus its version, the source proposal and the install
   time, all beside the manifest and never inside it. There is one version per
   name (RFC 0253 UQ 4). Every write is a compare-and-swap that returns an undo,
   and `applyProposal` calls the undo if its commit loses (ADR 0938 D4).
3. **Installer** (`features/proposals/installedPacks.ts`). The checks, in order:
   - 422 `validation_error`: the schema, then `private.*`, then `signing`, then
     the chain rules;
   - 409 `proposal_install_conflict` `read-only`: a host pack name or chain id,
     or a chain id another installed pack in the tenant contributes;
   - 409 `version-not-greater`: an equal or higher installed version, or a lost
     compare-and-swap.

   It returns `installedArtifact {kind, operationId: getInstalledPack, id: name,
   version}`. The installer is registered only when the vendored
   `proposal.schema.json` names `getInstalledPack`, which follows ADR 0972 D9.
4. **Read** (`v2Routes.ts`). The checks, in order:
   - unadvertised (404) unless `readback` names a pack kind;
   - then `manifest:read`;
   - then the stored manifest, served unchanged.

   A name that is not installed, one installed in another tenant, and a
   malformed name all get the same `404 not_found`.
5. **Activation.** The chains in an installed pack join that tenant's template
   gallery (`GET /host/openwop-app/workflow-chains`) and `from-chain`. Host chains
   resolve first, and the installer already refuses a chain id that collides with
   one. Other tenants see neither.
6. **Advertisement.** `READBACK_KINDS` gains `workflow-chain-pack`, so
   production advertises it on the next deploy, where `OPENWOP_PROPOSALS_ENABLED`
   is already set.

## Decision, P2 (2026-11-03)

7. **Security decision (reverses ADR 0938 D7 for agent packs).** A proposed
   agent pack installs tenant-owned agents, on the same footing as the agents a
   workspace member already authors through `POST /host/openwop-app/agents`.
   That door already accepts an inline system prompt (≤ 16,000 characters) and a
   tool allowlist (≤ 32 entries) with tenant-only visibility. A proposed agent is
   held to the same caps, is equally tenant-owned (`ownerTenant`), and needs more
   to land: a reviewed proposal plus `packs:publish` to apply. So the door adds
   no authority a tenant member lacks. ADR 0555's trust gate still guards the
   pack directory, which this path never writes. In addition, per RFC 0253 §D:
   - the pack carries no `nodes` and has `runtime.language: "remote"`;
   - `runtime.entry` is never read;
   - every agent is in the pack's namespace (RFC 0003 §B), carries an inline
     `systemPrompt`, and has no `systemPromptRef`, `evalSuiteRef` or handoff
     schema ref;
   - `private.*` and no `signing`, as for chain packs.
8. **Agents.** Each agent of an installed pack registers as a tenant-owned entry
   (`ownerTenant`, `packName` = the pack, `packVersion` = its version). Every
   visibility and dispatch gate that already hides one tenant's agents from
   another applies unchanged. Other instances pick it up as follows:
   - the agent registry's miss path reads the tenant store
     (`hydrateInstalledPackAgent`);
   - the agent inventory merges the store like durable user agents;
   - a replacement or rollback updates this instance's registry and broadcasts an
     eviction for each affected agent id, so other instances re-read.
9. **Conflicts.** An `agentId` that already resolves in the tenant from any other
   pack (host, user-authored or installed) is `409 read-only` (RFC 0253 §E). So
   is a pack name the host's agents carry.
10. **Tenant sub-chains.** `from-chain` passes a tenant chain the ADR 0959 D2
    resolver seam:
    - a sibling ref resolves inside the same installed pack;
    - an external ref resolves only at the exact `{packName, chainId, version}`
      it names, in a host pack or another installed pack.

## Consequences

- A chain-only host runs 7 of RFC 0253's 11 host legs: chain-draft-inert,
  chain-apply-installs, chain-readback-byte-match, namespace-refused,
  signing-refused, install-conflict and cross-tenant-not-found. The four agent
  legs stay `inapplicable`. That meets RFC 0253's acceptance bar ("at least one
  pack kind").
- The suite's `freshChainPack` at 2.46.41 references `core.noop` unpinned, which
  this host correctly refuses (`workflow-chain-packs.md` §Exact pins). The fix
  pins `core.noop@1.0.0` (openwop, suite 2.46.42). The certified cut must run a
  suite that carries it.
- Proposals from workflow graduation (`createProposalFromAcceptedPattern`) carry
  a tool-sequence skeleton, not a manifest. Applying one used to answer `409
  proposal_not_installable`; it now answers `422`, naming the first schema
  failure. That is honest, because the skeleton is not installable as written.
  Revising it into a manifest makes it installable.
- With P2 every RFC 0253 host leg applies here: the 11 legs plus the shape leg.
- Agent replacement reaches another instance through eviction; a missed eviction
  costs at most the registry's user-agent TTL (5 minutes), as for user agents.
- Tenant teardown purges the rows through the collection's tenant index.

## Verification

- `test/adr1033-rfc0253-chain-pack-readback.test.ts` has 12 cases covering:
  - the advertisement;
  - inertness, the byte-match against the revision, conflicts and replacement;
  - the cross-tenant 404 matching an unknown name's 404;
  - the four 422 refusals, the two read-only conflicts and rollback;
  - gallery and from-chain scoping.

  Sabotage-witnessed: dropping the `private.*` check reddened the namespace
  case, and adding a host field to the stored manifest reddened both byte-match
  cases.
- An in-memory boot run against the fixed suite: `v2-proposal-pack-readback`
  had 8 executed-pass (shape and the 7 host legs) and 4 inapplicable (agent).
  `v2-proposal-lifecycle` and `v2-unadvertised-operation-not-found` stayed
  green. With the unfixed (unpinned) suite pack, the same boot fails 4 chain
  legs.
- P2: `test/adr1033-p2-agent-packs.test.ts` has 17 cases covering:
  - agent inertness, install, byte-match and cross-tenant 404 parity;
  - second-instance hydration, replacement, rollback and nine §D refusals;
  - the agent-id conflict, version-not-greater and sibling sub-chain
    instantiation.

  Sabotage-witnessed: dropping `ownerTenant` reddened 5 cases, removing the
  resolver hook reddened the second-instance case, and removing the sub-chain
  resolver reddened the sub-chain case. Against an in-memory boot, the published
  2.46.42 `v2-proposal-pack-readback` leaves no pack leg inapplicable (24
  executed-pass across it, `v2-proposal-lifecycle` and
  `v2-unadvertised-operation-not-found`).
