# ADR 1065 — Template connection guidance from pack-owned usage metadata

Status: Accepted

## Problem and scope

The workflow gallery calls templates with no literal `config.connectionRef`
“zero connections” and “ready to go”. Campaign metrics and budget reallocation
use the actor's Connections accounts through feature surfaces without declaring a
literal reference. Empty-work branches can complete, but do not establish that a
useful sync or budget change needs no account.

This decision changes host-local advisory guidance only. Existing Connections,
node catalog and workflow-template projection remain the owners. No executor,
authorization, secret resolution, run admission, replay, provider mapping,
canonical schema or capability behavior changes.

## Decision

A node pack may declare exactly one recognized extension, `x-usesConnections`,
with an exact JSON boolean. True means a supported path uses Connections,
including an indirect or conditional path; false means the author has audited
that all supported paths do not. Missing or malformed values mean unknown.

The existing node catalog projects a recognized value as optional
`usesConnections`. `chainRequirements` aggregates installed-node metadata into
`connectionUsage: uses | none | unknown`: literal references always imply uses;
otherwise any true implies uses; any unknown or an empty graph implies unknown;
only all explicitly false implies none. Existing literal connection rows, node
availability, pins and feature requirements remain separate and unchanged.

Only explicit none may receive a no-connected-accounts label. Older servers and
unannotated packs remain browseable, but get no positive readiness claim. Replace
unconditional ready/guaranteed-first-win copy with setup guidance. For indirect
usage the existing Connections destination offers review; do not guess provider
IDs from platform names or mark arbitrary active accounts sufficient.

Pack-authored metadata is untrusted: parse only the exact boolean, never raw
markup, URLs, expressions or provider names. It grants no capability, permission
or usable credential, and is never an execution gate. Other unknown vendor
fields remain opaque. Account usage does not assert AI access, source data,
quota, approvals, configuration or eventual success.

## Protocol and extension boundary

Accepted RFC 0138 permits vendor extensions on PackNode entries. The checked-in
node-pack schema already allows `^(x-|vendor\.)`. This host recognizes one
advisory hint; foreign consumers may ignore it. Correct handling of canonical
fields never depends on it, and its presence is not capability negotiation. All
new response fields are on existing non-normative host-extension routes. No
upstream RFC or schema change is needed. A future portable admission mechanism
would require its own protocol decision.

## Alternatives

- Inferring from names/descriptions or a second provider map misses indirect
  surfaces and duplicates Connections ownership.
- Canonical `requiresSecrets` controls dispatch-time SecretResolver behavior and
  does not model dynamically selected actor Connections accounts.
- Treating absent metadata as false preserves the original overclaim.
- A new provider/readiness registry creates another owner and is unnecessary.

## Publication and compatibility

This rollout changes no production pack coordinates, node versions, runtime pins,
chain references or steward digests. Existing installed manifests remain unknown;
removing a false readiness claim does not depend on publishing metadata. Public
registry publication is neither authorized nor required for this fix.

Loader evidence at base e4f93f0ae: `index.ts` mounts local packs before
`ensureRegistryPacksInstalled`. `mountLocalPacks.ts` does not overwrite different
content at the same immutable version; strict registry mode prevents newer local
packs shadowing registry pins. `installRegistryPacks.ts` installs environment pins
and can overwrite mounted source packs. `buildNodeCatalog` reads the installed
pack directory only. DEPLOY.md documents strict registry and environment pins on
the demo. Therefore vendored source changes alone would not establish live
metadata, and pointing runtime pins at unpublished versions could strand startup.
No source overlay or loader precedence workaround is introduced.

Deferred optional registry enhancement: audit and declare true on connectors
sync/audience-sync/push-catalog-feed/dispatch-conversions, intel
enforce-caps/propose-reallocation/apply-reallocation, and conditional channels
publish-ad-variants. Other 18 entries remain unknown until all delegated paths
are audited. At the observed base the roots are connectors 1.7.0, intel 1.8.0,
channels 1.19.0 and campaign-sync 1.8.0. An authorized future registry release must
refresh remote versions, patch every changed root and node entry, then update
feature pins, steward digests and the five directly affected chain versions/pins
consistently. Publish and verify availability before a deployment depends on new
coordinates. Historical published coordinates and stored definitions stay intact.
Synthetic test manifests exercise declarations without claiming live annotations.

## Implementation phases and evidence

1. Add catalog/requirements projection; exercise schema-valid metadata in isolated fixtures.
2. Present conservative gallery/preflight guidance and older-server behavior.
3. Witness original red/fixed green for catalog, real host listing, actual
   gallery/preflight, malformed/unknown/false controls and unchanged no-op
   startability. Check pack schemas/pins/steward data and relevant lint.
4. Independent architecture/code/UX review, DCO draft, then root-owned canonical
   exact-tree gate and deployed acceptance. Focused diagnostics do not replace
   full gate evidence; do not invoke real account/provider actions to test a hint.

| Phase | Commit / evidence | State |
|---|---|---|
|1–3|Original FE 6/6 red → fixed 17/17 pass; original BE 3/3 red → fixed 10/10 pass; pack parity 81/81; scoped frontend lint and three pack static checks exit 0|Focused diagnostics complete|
|4|Root-owned release queue|Pending|

### Correction — advisory Builder image expectations (2026-11-07)

The pinned six-chain browser fixture carries `connectionUsage: unknown` for every
entry, with empty connections, missing-node and pin-mismatch lists. The former
Darwin image expectations nevertheless displayed “Start here” and “Zero
connections” for all six. That conflicts with this ADR’s explicit-`none` rule.
An unchanged two-case local diagnostic reproduced both canonical advisory reds:
1032×1320 actual versus 1032×1361 expected, with all six cards and Use template
controls retained. A separate normal same-origin catalog read under the same
local fixture confirmed all six unknown values; it used the existing synthetic
session seam, not a deployed user or real provider.

After independent visual review, update only the two Darwin Builder expected
PNGs from the preserved canonical Pro actual images. Keep the production code,
fixture, assertions, masks, tolerance, timeouts and renderer settings unchanged.
Old expected images and hashes are retained in the task evidence packet. PNG
byte differences between local and canonical captures are not evidence of decoded
pixel identity; no such identity is claimed. The same two unchanged advisory
cases then passed once against the reviewed expectations (2 passed, no retries,
no snapshot-update flags). This focused result does not establish full-gate,
merge, deployment or real-user acceptance. Initial local routing and observer
filter mistakes remain diagnostic harness limitations, not product findings.

## Decisions checklist

- [x] Existing host-owned catalog/requirements and Connections seams only.
- [x] One exact boolean extension, unknown stays conservative.
- [x] Metadata never changes dispatch, admission or authority.
- [x] Accepted extension hatch; no canonical wire change.
- [x] Original/fixed behavioral witnesses; unchanged production pack/pin/trust checks.
- [x] Independent architect/code/UX source review clear; no public publication.
- [ ] Independent review, composed full gate and deployed retest.
