# ADR 1152 — Node-pack import lifetime

> **Renumbered 2026-11-20 from 1150** (by openwop-app-95, landing Codex's branch while Codex is offline): main already held `1150-cms-split-video-linked-tiles.md`. The commit subjects a385c95148 and cc720c2ae1 still say "ADR 1150"; they mean THIS record.

Status: Accepted

Accepted 2026-11-19 after source and architecture review of the bounded restart-required contract. Implementation is present; current-source native validation and release remain pending.

## Context

A registry install replaces the head directory `<packDir>/<name>` after signature,
namespace, manifest and tree checks. Node's native ESM cache does not discard an
imported module when those files change. Loading the same entry URL again can
therefore return old functions while the loader attaches the newly read manifest
version and provenance. Relative imported helpers have their own cached URLs, so
adding a query string only to the entry does not solve the graph identity problem.

The defect was reproduced with a genuine signed old/new install and the real
loader: the new version and disk bytes were visible while the captured request
still had the old implementation's behavior. A separate plain-Node observation
confirmed the same module reference after same-URL replacement. These historical
focused observations are not current-tree gate, publication or deployment proof.

The marketplace's node-pack install path currently installs disk bytes; it does
not implement whole node-graph activation. The lazy node resolver is installed at
bootstrap but runs on later registry misses, including workflow execution. Agent
registry installs and chain-data reloads do not supply an executable node reload
mechanism. Startup already awaits registry installation before later bootstrap.

## Decision

A node-pack tree imported in this host process belongs to that process until it
exits. Normal replacement of that tree requires a fresh process. This host does
not claim general hot activation of executable node packs.

1. Keep trust admission in `host/packTrust.ts` and the existing verified installer.
   The loader claims an executable tree only after those checks, immediately
   before its first asynchronous native import.
2. `packs/nodePackImportLifetime.ts` owns one module-local lifetime map. A claim
   contains the lexical path, original real directory and standard whole-tree
   `packContentDigest`. The map owns import history, not a new trust tier, tenant
   authority, pin, credential, persistent store or machine-wide lock.
3. Claims survive pending, successful and failed imports. ESM can retain every
   one of those identities; clearing a private map would not clear Node's cache.
   Unchanged-tree reloads and new aliases to the same original real root remain
   permitted.
4. Check the real directory and digest again after import settles and before
   registering modules or publishing new version/provenance labels. An observed
   change refuses registration.
5. The existing installer checks the claimed target immediately before its
   synchronous archive/removal/copy sequence, with no intervening await. A claimed
   lexical or real path is refused before the old installed bytes are touched.
   Its earlier exact-version no-op and an unclaimed cold install retain their
   existing behavior. Agent/data packs not imported by the node loader acquire no
   executable-tree claim.
6. The shared install lane translates the specific typed refusal to the existing
   host-local `conflict` HTTP 409 envelope, with reason `pack_restart_required`.
   The operator is told to configure the desired startup version and restart the
   host; no replacement was installed. The response contains no filesystem root,
   registry topology or key material. No automatic restart or reconfiguration
   occurs.

**Correction to the initial design, 2026-11-18:** comparing only a reused lexical
path's digest is insufficient. An alias can be retargeted to another real root
with identical bytes, and Node can still return the first root's cached module.
A reused claim therefore also retains and compares its original real directory.
A genuine identical-digest retarget regression accompanies that correction.

## Existing ownership and compatibility

This extends the existing pack loader, installer, shared install-error lane and
whole-tree digest. It introduces no second loader/cache, registry reset, worker
protocol, historical archive or dispatch path. Trust and revocation still run
before code is imported. Registry signature, namespace, manifest, closed-world
and install-marker checks remain authoritative; the lifetime map grants nothing.

Host-owned node protection, pack origin and isolation placement, tenant context,
replay/fork selection and invocation behavior remain at their existing owners.
This decision does not add historical node-version execution or change replay
classification. Startup remains an awaited install followed by lazy first use.

This is a host-local safety restriction on an existing operator install surface.
It uses an existing conflict status/code and an optional host-local reason. It
adds no OpenWOP endpoint, event field, capability, normative error semantic or
protocol requirement, so no new RFC is proposed. A loaded-path install that once
appeared successful now reports the truthful conflict instead of claiming new
code is active.

See [ADR 0555](0555-untrusted-pack-trust-tier-and-isolated-execution.md),
[ADR 0826](0826-marketplace-supply-chain-hardening.md), and
[ADR 1014](1014-agent-versions-side-by-side.md) for the unchanged trust, shared
install lane and agent archive owners.

## Alternatives

- **Entry query suffix:** rejected. It gives the entry a new identity while
  relative helpers can remain stale, and does not establish graph provenance.
- **Real hot activation:** would need an immutable verified dependency-graph
  identity and an explicit activation/overlap/lifetime design. The current
  installer, agent archives and isolation adapters do not supply that contract.
- **Only use cold deployment operationally:** useful for rollout, but leaves the
  unsafe in-process install/explicit-load combination available. It does not fix
  a false successful replacement response.
- **Clear registries or force a different execution adapter:** rejected. Neither
  invalidates native ESM correctly, and either changes existing dispatch/trust
  behavior without solving the stated lifetime problem.

## Limits and trade-offs

The guard coordinates this process's existing installer and loader. It is not an
atomic filesystem snapshot, a distributed lock or protection against independent
writers and filesystem ABA. The post-import check detects observed changes; it
does not make external mutation supported. Dependencies outside the standard
pack tree are not newly captured or verified by this decision.

Whole-tree hashing is reused at load, not for every node execution. Claims and
aliases deliberately remain until process exit. Even a failed import can require
restart before replacement. This accepts a bounded operator recovery step in
exchange for truthful identity and unchanged normal cold execution.

The resolver's type index still refreshes on directory-set changes, so an
unimported same-directory manifest change can require restart for discovery of
new types. This decision makes no general catalog-refresh promise and adds no
parallel index. Manually replacing bytes or source mounts while a host runs is
not a supported update procedure.

## Implementation and validation

| Phase | Source / evidence | Status |
|---|---|---|
| Import lifetime | Loader claim/postcheck and corrected lexical/real/digest owner | Source implemented; current checks unrun |
| Normal install | Prewrite refusal and shared safe conflict409 mapping | Source implemented; current checks unrun |
| Loader regressions | Seven cases, including helper-only change, aliases, TLA, failed imports, cold/no-op positives | Unrun on this branch |
| Startup / HTTP | Awaited startup observation and real cookie/operator install/refusal | Unrun on this branch |
| Process boundary | Old host closes, same directory installs on fresh host, real workflow events/output | Unrun on this branch |
| Current-tree gate / release | Native/types, canonical gate, merge, deploy and served regression | Owed |

The original hot-success failure remains historical failure evidence; a
restart-required refusal is not relabelled as that hot-success pass. Existing
focused observations are scoped to their recorded source compositions. No pass,
issue closure or production readiness follows from this source-only branch.

## Open decisions

- [x] Review and accept this bounded restart-required host contract (2026-11-19).
- [x] Independently review the current source and adopted behavioral fixtures (source-only review; automated checks remain pending).
- [ ] Run current-source checks under the normal coordinated process, retaining
      target failures, exact restorations and full-gate evidence.
- [ ] Verify the deployed refusal and fresh-process configured-version behavior
      before closing the node-cache issue.
