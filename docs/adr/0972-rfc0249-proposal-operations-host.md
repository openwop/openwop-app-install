# ADR 0972 — RFC 0249 proposal operations, the host half (phase 1, prompt-template)

Status: implemented (2026-10-24: P1 #5168 `bf513c3e3`, P2 #5173 `34bfefddc`, live on
revision 01032-9ff, certified in cut 209c). The wire shape was locked by openwop-7a
2026-10-24, and the user approved this program, confirmed by the release manager.

> **Renumbered 2026-10-24:** this ADR was reserved as 0970, and ADR 0970 (platform
> competitive gap closure, #5169) merged first. Peer messages and the #5168 thread
> before this date call it ADR 0970.

Amends ADR 0938 (proposals: honest apply) and builds on ADR 0755 (key-lane
extension scopes). Implements openwop RFC 0249 phase 1. It is wire-facing, and the
RFC is locked and Active, so no new RFC is needed.

## Context

RFC 0096 says a proposal is inert until a person applies it, and that what gets
installed is byte-for-byte what they reviewed. ADR 0938 made this host honest about
that. It found no installer for any kind, so every apply now ends `409
proposal_not_installable`, and `agents.proposals` is no longer advertised. The routes
are host-extension only (`/host/openwop-app/proposals/*`).

RFC 0249 gives v2 seven normative operations for the same lifecycle. It adds a
client-submitted draft, so the suite can create a proposal it controls, and a closed
`activation.installedArtifact` naming the v2 GET that serves the installed bytes.
Phase 1 covers `prompt-template` only.

Measured on `origin/main` before this ADR:

- `host/promptStore.ts` is in-memory and process-global. Its user layer has no tenant
  key. Installing a tenant's proposal there would leak it to every tenant, and on a
  multi-instance Cloud Run service a read routed to another instance would not see
  it. ADR 0938 rejected this store for the first reason.
- `POST /prompts:render` resolves the template through `getTemplate` and then
  composes through the built-in fixture map, not the template it found. A
  user-layer template therefore renders `404 template_not_found`.
- Production runs with `OPENWOP_PROPOSALS_ENABLED=true`. Registering any installer
  would advertise `agents.proposals` on the next deploy.
- The in-process conformance harness mints its low-scope key in a separate tenant
  (`conformance-low-scope`), holding `runs:read` only.

## Decision

### D1 — Seven v2 routes beside the host-extension ones, one service

`GET /proposals`, `GET /proposals/{id}`, `POST /proposals`, `PATCH /proposals/{id}`,
`POST /proposals/{id}:apply`, `POST /proposals/{id}:reject` and `DELETE
/proposals/{id}`. They are registered in `features/proposals/v2Routes.ts` and call the
same `proposalsService` functions as `/host/openwop-app/proposals/*`, which stay as
they are. When `agents.proposals` is not advertised, every one answers `404
not_found` (core `errors.md` §Unadvertised operations; ec's second correction to the
locked shape). `submitProposal` also answers that when `clientDrafts` is not
advertised.

The lifecycle is ADR 0938 D4's table, unchanged. Applied, rejected and archived are
terminal for revise, apply and reject (`409 proposal_state_conflict`, details
`{state, action}`). Archive is accepted from draft, revised and rejected, and refused
on applied and archived. ec ruled that last rule a MUST in RFC 0249, 2026-10-24: an
applied record relabelled `archived` would misreport a template that is still served
(PRB-4).

At v2 the three 409s carry their reason as the error code (`proposal_state_conflict`,
`proposal_stale`, `proposal_install_conflict`). The host-extension routes keep
`conflict` + `details.reason`. Until the pin registers those codes in the vendored
v2 error registry, `v2ErrorCode` vendor-prefixes them.

### D2 — Three scopes, checked on both lanes

`proposals:read`, `proposals:write` and `proposals:apply` join
`KEY_LANE_EXTENSION_SCOPES`. An `owk_` key that declared scopes is refused any of
them it did not declare, with `403` and `WWW-Authenticate: Bearer
error="insufficient_scope"`. As on the prompts routes, this check runs before the
capability gate (ADR 0755).

Membership authority is read from the credential's provenance (`credentialScopesIn`,
ADR 0601 C4), so an env key acts as the tenant owner and an `owk_` key acts as its
issuer, narrowed to what the key declared. Reads need `workspace:read`, writes need
`workspace:write`, and apply needs `packs:publish`, the ADR 0938 apply gate. A
browser session keeps the ADR 0938 predicates.

**Correction (2026-10-24, release-manager review of #5168):** the first draft added
the three scopes to `scopes_supported` unconditionally. They now join it only once
the RFC 0249 wire is available (`scopesSupported()`, D9). Before that, every
`/proposals` route answers `404` ahead of any scope check, so no route refuses a
caller for a scope the list does not publish, and discovery is byte-identical to
today until the pin. The scopes stay MINTABLE (`keyPolicy.ts`), so the evidence
cut's low-scope key (D10) can be issued on either side of the switch.

### D3 — Tenancy: a foreign id is an unknown id

Every operation loads the proposal by `(tenant, id)`. A row owned by another tenant
answers exactly as a missing one does: `404 not_found`, with the same message.

### D4 — A tenant-scoped, durable layer for installed templates

> **AMENDED 2026-10-27 (ADR 0993 D5): this is now THE tenant layer, not one of two.**
>
> - **One layer.** The collection moved to `host/tenantPromptTemplates.ts`, keeping
>   its namespace name so no row is orphaned. `POST`/`PUT /v1/prompts` write it
>   too: the process-global `user` map those routes wrote was shared by every tenant
>   and lost on restart.
> - **Global first.** Resolution reads the global layers, then this one.
> - **Dispatch.** Run dispatch resolves through it, so an installed template is
>   usable by a workflow, not only listed by REST. Before this, the "ahead of the
>   user, pack and host layers" lookup below existed only in the REST doors.

A new `DurableCollection` named `proposal-installed-prompts`, keyed
`${tenant}::${templateId}::${version}`, with a tenant resolver so tenant teardown
reaches it. `getPromptTemplate`, `listPromptTemplates` and `:render` consult it for
the caller's tenant only, ahead of the user, pack and host layers.

`:render` composes an installed template from what it resolved. The fixture map it
otherwise composes from holds only the host's built-ins. The global user layer's
render is unchanged and still `404`s; that is a pre-existing gap, out of scope here.

### D5 — The installer and its refusals

(The refusal codes below are ec's first correction to the locked shape:
`version_conflict` already means something else in the registry.)

`registerProposalInstaller('prompt-template', …)`, run in the applying tenant:

1. The artifact must validate against the vendored v2 `prompt-template.schema.json`.
   Otherwise `422 validation_error` (RFC 0096 G5).
2. If `templateId` names a host or pack template: `409 proposal_install_conflict`,
   details `{reason: "read-only"}`.
3. If a stored version, in this tenant's installed layer or the global user layer,
   is equal to or higher than the artifact's: `409 proposal_install_conflict`,
   details `{reason: "version-not-greater"}`.
4. Otherwise the artifact is written verbatim, with only `meta.source: "user"` added.

On any refusal nothing is installed and the proposal's state is unchanged. The
installer writes first and the proposal's CAS commits second. If the CAS loses the
race, the install is rolled back, so `applied` and an installed template only ever
exist together.

### D6 — Apply returns the closed `installedArtifact`

On success, apply returns `200` with the proposal in `state: applied` and `activation:
{approvalId: null, installedArtifact: {kind: "prompt-template", operationId:
"getPromptTemplate", id: templateId, version}, installedArtifactRef:
"prompt:<templateId>@<version>"}`. The ref is a real PromptRef, not the hash ADR 0938
removed. The id is always `artifact.templateId`, never minted.

### D7 — The digest is `sha256:` + hex of the JCS bytes, and apply requires it

`artifactDigestOf` changes from bare hex to `sha256:<hex>`, the RFC 0249 form,
everywhere it is served. Clients bind to the value they read, so the host-extension
routes are unaffected. v2 apply **requires** `{artifactDigest}`, as the RFC permits:
missing → `400 validation_error`, `details.field: "artifactDigest"`; a mismatch →
`409 proposal_stale`, with nothing installed. This keeps ADR 0938 D5's
approve-what-you-see guarantee. The v2 path binds the digest and not the revision,
because the digest covers the bytes that get installed.

### D8 — The v2 projection follows the closed schema

v2 reads return the stored proposal plus `artifactDigest`, and omit the host's
`revision` counter (`proposal.schema.json` is closed). Lists return `{items,
nextCursor?}`, paged by `limit` and an opaque offset `cursor`.

### D9 — Advertising waits for the pinned suite to carry the wire

The installer is registered, and `agents.proposals` gains `clientDrafts: true` and
`readback: ["prompt-template"]`, only when the vendored v2 schemas carry RFC 0249:
`proposal-submit.schema.json` exists and `proposal.schema.json` defines
`installedArtifact`. This follows the RFC 0246 precedent (`rfc0246FieldsAvailable`).
Until the pin moves, production advertises exactly what it does today, which is no
`agents.proposals`, and all seven routes answer `404 capability_not_provided`. The
pin-bump PR that vendors the suite release is the PR that turns this on.

**Correction (2026-10-24, train 202):** the routes are registered unversioned, the
same way as `/prompts`; the negotiator serves a protocol root's major-2 operations
at the bare path. The mount-collision guard test excludes protocol roots by reading
the vendored path manifest, which does not declare `/proposals` until the pin, so it
reported `/proposals` as a new host-own root. It is not one, and adding it to
`HOST_OWN_UNVERSIONED_MOUNTS` would make the boot guard throw once the manifest
declares it. The guard test instead lists `/proposals` as a pending protocol root,
with a case that fails as soon as the manifest declares it. P2 deletes the entry.

### D10 — The harness low-scope key holds `proposals:read` and `proposals:write`

Both the in-process harness (`conformance/run.ts`) and `scripts/publish-evidence.sh`
mint it with `["runs:read", "proposals:read", "proposals:write"]`. It never holds
`proposals:apply` or `approvals:respond`. The in-process key stays in its own
tenant: the key-lane scope check runs before any load, so its apply is refused `403
insufficient_scope` and never reaches a foreign-tenant 404.

## Alternatives considered

- **Install into the global prompt store.** Rejected: a cross-tenant leak, and it
  breaks on a second instance (D4).
- **Make the v2 apply body optional.** Rejected: it would drop ADR 0938 D5 on the
  path the suite exercises, and the RFC lets a host require the digest.
- **A new env flag for the advertisement.** Rejected in favour of D9. The capability
  turns on with the pin that carries its schemas, so the advertisement cannot run
  ahead of the wire, and production needs no env change.

## Open questions

- [ ] Inertness when another tenant installs the same `templateId`: tenant-keyed
  storage keeps them apart, but the global user layer (`POST /prompts`) is still
  process-wide. That is out of scope here and noted for the prompts owner.

## Plan and checklist

- [x] P1 — dormant implementation (D1–D8, D10):
  `test/adr0972-rfc0249-proposal-ops.test.ts`, 16 cases. Five sabotages were each
  witnessed red: a tenant-blind installed read, no digest binding, no schema
  validation, no rollback, and a list that ignores the installed layer.
- [x] P2 — suite 2.46.21 (tag `v2.46.21`, `297d53ea`): both packages pinned
  `^2.46.21`, schemas and fixtures synced at the tag (the manifest now declares
  `/proposals`; four new `proposal-*` schemas), the wire test flipped to true, the
  three 409 codes asserted bare, and `/proposals` deleted from the guard test's
  `PENDING_PROTOCOL_ROOTS`. Production already sets `OPENWOP_PROPOSALS_ENABLED=true`
  (read from the live service 2026-10-24), so this PR's deploy is the switch-on and
  needs no env change.
- [x] Deploy, then a certify cut; `0249.*` rows `executed-pass`. Deploy 207b
  (`34bfefddc`, revision 01032-9ff): `agents.proposals` advertised as `{artifactKinds:
  ["prompt-template"], duplicationDetection: false, activation: "direct-rbac",
  clientDrafts: true, readback: ["prompt-template"]}`, and `scopes_supported` gained
  the three proposal scopes. Cut 209c, bundle `major-2.json` sha256 `be2aba738161`:
  480/0/11/373 = 864 rows, suite and spec-artifacts 2.46.21. Against 169c, exactly
  the 13 rows new since 2.46.19 were added (nine `0249` legs, the
  `v2-proposal-lifecycle` scenario and two `0081` rows `executed-pass`;
  `0249.unadvertised-not-found` inapplicable), no existing row moved, and
  `claimedProfiles` were identical.
- [x] ec checks in the bundle; RFC 0249 → Accepted. ec verified 209c and flipped
  RFC 0249 and RFC 0096 to Accepted in openwop #2037 (`2db5b3ce9`), 2026-10-24; 209c
  is the canonical `openwop-workflow-engine.json`. Suite 2.46.22 is register-only (no
  assertion changes), so this host stays pinned at `^2.46.21`.

P2 needed two follow-ups that its own checks missed, both caught by the merge train:
a test's facet read was typed `{}` (the backend typecheck covers `test/`), and the
new v2 root `/proposals` needed Firebase rewrites ahead of the SPA catch-all
(`check-hosting-wire-rewrites`). A new v2 manifest root needs both the route and the
hosting rewrite.
