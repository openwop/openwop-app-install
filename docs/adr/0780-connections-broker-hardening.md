# ADR 0780 — Connections broker hardening: axis authority, owner spellings, revoke integrity, erasure

Status: implemented (P1 + P1-SPA; follow-ups filed below)

**Feature:** `connections` (always-on, no toggle — ADR 0024 § Correction). This ADR
**extends** ADR 0024; it adds no feature-package, route prefix, toggle or wire field.
**Source:** feature loop 2026-10 row 8, `/grade-workflows connections`
(`docs/steward/WORKFLOWS-ASSESSMENT.md` § Connections, ids `CONNWF-`), opening baseline
`80c7b5514`.
**RFC verdict:** host-extension only. Every route touched lives under
`/v1/host/openwop-app/*`; the RFC 0199 behaviours this touches (§A.3 same-user binding,
§C.3 connect lane) keep their current wire shape. No new RFC.

## Context

The grade found the OAuth grant itself sound — PKCE S256 always, a 256-bit state
claimed by its DELETE, RFC 9207 `iss` before exchange, a fixed production redirect URI,
same-origin `returnTo`, tokens never returned or logged. The defects are in **who may
write a credential**, **whether a revoked or erased credential stays gone**, and
**owner comparisons against rows written under a pre-bind identity spelling**.

| Grade id | Where | Defect |
|---|---|---|
| `CONNWF-1` (Blocker) | `routes.ts:215`, `connectionsService.ts:147-148`, `routes.ts:93-101` | `scope` is read from the body unvalidated. `workspace` (or any unknown string) creates a WORKSPACE credential with no authority check, and the broker's fall-through (`connectionsService.ts:374-375`) hands it to every member without a personal row and to every actorless run (inbound, schedules). `authorizeManage` lets any member delete, probe or re-wire the inbound trigger of a workspace row. |
| `CONNWF-2` (Blocker) | `routes.ts:197,243,425` | create, authorize (including write re-consent) and inbound PUT have no `workspace:write` check. |
| `CONNWF-3` (Blocker) | `connectionsService.ts:650-651`, `:251-254`, `:260-278` | a refresh in flight during a revoke re-writes the token after `removeSecret`, leaving a live refresh token with no row; `patchConnection`'s get→put can re-create the deleted row as `active`. |
| `CONNWF-4` (Blocker) | `test/subject-erasure-feature-stores.test.ts:401` | no subject eraser: a DSAR in a workspace leaves the subject's user-scoped OAuth tokens live. |
| `CONNWF-5` (High) | `connectionsService.ts:81,597`; `routes.ts:98,283` | single-spelling owner reads: list, manage, the credential-interrupt `connect` route, and the broker's org-use check. |
| `CONNWF-6` (High) | `routes.ts:443`, `inboundWebhooks.ts:735` | inbound PUT accepts any `workflowId`; an unknown one silently becomes a `nofire:` sentinel on every delivery. |
| `CONNWF-7` (Medium) | `routes.ts:255,367-372` | an authorize without a subject stores a grant with no `userId`, and the callback lands a WORKSPACE OAuth connection. |
| `CONNWF-15` (Nice) | `connectionsService.ts:99-102` | the ADR 0499 consumer comment says the vault can delete `connection:` refs; ADR 0779 made it refuse. |

## Boundaries audit

- **Write gate.** The shared person-or-credential write gate is
  `requireTenantWrite` (`features/featureRoute.ts:362`, ADR 0775 D1), used by every
  agent-area write. Admin authority for connections already exists as
  `host:connections:manage` + `requireConnectionsManage` (`routes.ts:76`, ADR 0024 D2).
  No new scope and no new helper module.
- **Identity.** The request side is canonical: a bound caller presents `user:<id>` as
  both `req.userId` and `principal.principalId` (`middleware/auth.ts:1091`). Rows keep
  whatever spelling their writer carried. The broker already owns the alias
  (`actingUserIds`, `connectionsService.ts:327`, ce #4215). ADR 0779 D1's correction
  (active-tenant MEMBERSHIP needs no second spelling) does NOT carry over: here the
  comparison is against a STORED owner id, not against the member table the middleware
  just validated.
- **Erasure.** The seam is `registerSubjectEraser` + `EXPECTED_SUBJECT_ERASERS`
  (`host/subjectErasure.ts`, `host/subjectEraserManifest.ts`), registered from the
  host-erasers boot step.
- **Workflow resolution.** `resolveLaunchWorkflow` (`host/runStarter.ts:97`) is what
  the inbound run start calls; the PUT validates with the same call.
- **Row CAS.** `DurableCollection.compareAndSwap` (`host/hostExtPersistence.ts:736`).

## Decision

> **Revised after the adversarial `/architect` pass (2026-09-29), before any code.**
> It found 4 Blockers and 5 Highs in the first draft of this section; the draft is
> summarised in § "Architect pass" below so the reasoning trail survives. Every
> decision here is the corrected one.

### D1 — Each scope axis is gated by its own authority, in one provenance-aware helper (`CONNWF-1`, `-2`, `-7`, `-13`)

- `scope` is a closed set `user | org | workspace`; anything else is `400
  validation_error`. The default when omitted stays `user`. A `user` create and an
  `authorize` both REQUIRE a subject (`401`), so no lane can mint a workspace row by
  omission (the POST lane did too: `scope:'user'` with no subject fell through).
- **Create / authorize / inbound PUT** first call `requireTenantWrite(req)`
  (`featureRoute.ts:362`; Viewers refused `403 forbidden_scope`; env keys are the
  tenant owner by provenance, ADR 0601 C4).
- The admin axes (`org` → that org, `workspace` → the workspace-root org
  `orgId === tenantId`) use ONE new helper, `requireConnectionsManage(req, orgId)`,
  rewritten provenance-aware — the first draft reused the old one, which judges
  `actingUserOf` alone, so it refused the env-key operator (`test/governance.test.ts:378`
  would go red) AND locked out a workspace owner whose member row is keyed `oidc:<sub>`
  (B1, B2). Its decision, in order:
  1. wildcard operator principal → allow;
  2. env key (`credentialAuthority` → `tenant-owner`) → `tenantOwnerScopes(tenant)`;
  3. `owk_` key → refused unless its declaration permits `host:connections:manage`,
     then judged as its ISSUER below;
  4. a person (or a key's issuer) → allowed iff `resolveEffectiveAccess(tenant,
     {subject: s, orgId})` includes `host:connections:manage` for SOME `s` in the
     caller's spellings (D2);
  5. no subject → refuse.
  It stays at the ORG, never the tenant-wide union (`callerHoldsTenantScope` would
  let a sub-org admin pass a workspace-root check).
- **Manage** (`authorizeManage`: delete, test, inbound GET/PUT/DELETE) of a WORKSPACE
  row requires the same helper at the workspace-root org instead of falling through.
- **Revoking or testing one's OWN user-scoped connection is NOT write-gated.**
  Withdrawing a credential is the safe direction; a member demoted to Viewer must never
  be trapped with a live token. The worst a Viewer can do via `/test` is refresh their
  own token.
- **The `connect` lane (RFC 0199 §C.3) is not write-gated either, recorded:** it is
  self-only, the caller must own the run and an OPEN `credential` interrupt at that
  node, and the grant it starts can only serve that run's owner.
- `inbound PUT` refuses a `signingSecret` shorter than 16 characters (it is the HMAC
  key and, for whatsapp-cloud, the verify token).

### D2 — Owner comparisons judge the SAME human's spellings (`CONNWF-5`)

> **CORRECTION (2026-09-29, before merge — ce, the #4215 owner): the "global
> `user:` → principal" widening below is REVERTED.** It assumed the User row being
> 1:1 with its principal made the alias safe everywhere. It does not: principal ids
> are NOT issuer-qualified — `oidc:${sub}` (`middleware/auth.ts:982`, `sub` unique
> only per issuer), `saml:${nameId}` (`samlValidationService.ts:175`),
> `scim:${userName.toLowerCase()}` (`scimProvisioningService.ts:41`). User X's home
> row may carry `scim:jsmith` from IdP A while shared workspace T holds a legacy row
> keyed `scim:jsmith` belonging to T's OWN jsmith from IdP B; under the widening a
> run as X in T resolved the other person's credential, `callerOwnerIds` let X list
> and revoke it, and erasing X deleted it. userId→principal is 1:1;
> principal→human is not, across issuers. Every principal↔user mapping is now
> HOME-TENANT-ONLY: `actingUserIds` (which also feeds the org-use check,
> `findByIdentity`, connection readiness and the eraser) and `callerOwnerIds`.
> Witnessed refuse-side by legs 7 and 7b (two IdPs, one `scim:jsmith`, a shared
> workspace). The shared-workspace legacy-row gap this leaves is `CONNWF-5e`. **The
> only safe future design:** resolve through T's OWN user rows —
> `getUserByPrincipal(T, conn.userId)` — and accept it only when that row carries a
> link to X (`linkedIds`, or the same `idpEntityId` + principal). Recorded, not built.
>
> **What the revert does NOT close (grade-code `CONNCD-15`, routed to the users
> row):** a principal-string collision INSIDE one tenant. `callerSubjectSpellings`
> always includes the raw request principal, and `getUserByPrincipal(W, principal)`
> returns whichever User W holds for that string, so two humans from different IdPs
> presenting the same `scim:jsmith` in W resolve to ONE subject there — in every
> feature, not only connections (`userIdFor(W, 'scim:jsmith')` is one user for both).
> Pre-existing; the cure is issuer-qualified principals, which is a users/auth ADR.
> The route half of the revert is witnessed at the HTTP boundary by
> `test/adr0780-connections-route-identity.test.ts` (`CONNCD-16`).

- **Route side.** `callerOwnerIds(req)` = `callerSubjectSpellings(req)` ∪ the durable
  User row's `principalId` for each `user:` spelling (a global 1:1 point read —
  `getUser`). Used by `listConnections` (it takes the set), `authorizeManage`'s owner
  branch, the admin helper (D1 item 4), the `connect` route's owner check, and the
  callback's §A.3 same-user check (`pending.userId ∈ callerOwnerIds`; still a refusal
  for any other human).
- **Broker side.** ~~`actingUserIds` drops its home-tenant restriction for a
  `user:` actor~~ (REVERTED — see the correction above; it stays home-tenant-only). `actingUserHasOrgUse` checks `connections:use` for ANY id
  in that set. **Residue, recorded (`CONNWF-5e`):** an `oidc:<sub>` actor in a `ws:`
  tenant still gets no alias — the only principal→user lookup is keyed by the home
  tenant, which the broker does not have.
- **`connect` binds the grant under the RUN's recorded actor spelling**, not the
  caller's: `assertCredentialAuthorizedResolves` re-checks with
  `run.metadata.actingUserId` (`routes/interrupts.ts:623-631`), so a grant stored
  under the caller's canonical spelling would never satisfy a legacy-stamped run in a
  `ws:` tenant and the interrupt would never resolve (H2).
- Refuse-side witnesses: another user's row stays hidden/403 under every spelling.

### D3 — Revoke means revoked; no writer resurrects or clobbers (`CONNWF-3`, part of `-8`)

The first draft's proof ("delete row first, write-back re-reads and scrubs") was false
under a same-id re-consent: `upsertOAuthConnection` REUSES the existing id with an
unconditional put, so a re-consent that read the row before a revoke re-creates it with
a live token, and a refresh's scrub can delete that legitimate re-consent's secret
(B4). Corrected:

1. **Generation.** Every credential write mints a fresh `generation` on the row AND
   inside the stored secret material (oauth2 JSON; a wrapper is not added for raw
   api_key/bearer secrets, whose only writer is create — they have no refresh).
2. **Row writes are CAS.** `upsertOAuthConnection` swaps against the row it read
   (`compareAndSwap(existing, next)`, or `putIfAbsent` for a new id); on a lost swap
   it re-reads by identity ONCE and, finding no row, mints a NEW id — so an id a
   revoke deleted is never reused. `patchConnection` swaps against its read and on a
   mismatch DROPS the patch (no retry — a retry would re-apply a stale
   `needs-reconsent`/`expiresAt` over a fresh re-consent).
3. **Revoke deletes the row first, then the secret, and a failed secret removal
   THROWS** (it used to be swallowed; with the row already gone that would leave an
   unreachable live token and a DSAR reporting success) (H1).
4. **Secret write-backs are generation-checked.** A refresh re-reads the row before
   writing: a missing row or a changed generation discards the refreshed material
   (never written). After writing it re-reads again; a missing row → it removes the
   secret it wrote. Because ids are never reused (2), that scrub can only ever hit its
   own write.
5. **Readers fail closed on disagreement.** `liveSecretFor` compares the material's
   `generation` with the row's; a mismatch (the residual race where a refresh wrote
   between a re-consent's secret write and its row swap) flips the row to
   `needs-reconsent` rather than injecting a token of unknown provenance. Legacy
   material and rows with no generation compare equal (no migration).

`compareAndSwap` works on this collection (`tenantOf` is optional,
`hostExtPersistence.ts:736`).

### D4 — A DSAR erases the subject's user-scoped connections in the tenant it names (`CONNWF-4`)

`eraseSubjectConnections(tenantId, subjectKey)`: for every connection in `tenantId`
whose `userId` is `subjectKey` or its User row's `principalId` (the legacy spelling,
B3), revoke it through D3 (so a secret-removal failure counts in `failed`), and delete
the subject's `connections:pendingAuth` rows in that tenant (a grant started before the
erasure would otherwise complete afterwards without a session, H5). Org and workspace
rows carry no `userId` and are untouched: a user-scoped row is only ever selected for
its owner, so the "breaks a shared integration" worry in the debt entry does not apply.

**Contract fit (M2):** the eraser runs once per linked key and must be idempotent; the
ADR 0285 revoke consumers fire only when `store.delete` actually removed a row, so a
second key or a re-run fires nothing. The inbound config and its
`connection-inbound:` signing secret survive, disabled, as on any revoke.

**Scope, stated (B3):** the users erase route runs `eraseSubject` for the user's HOME
tenant (`features/users/routes.ts:326,365`), and the consent DSAR passes an email or
visitor key that no resolver maps to a userId. So D4 closes `CONNWF-4` for the tenant a
DSAR names; the subject's user-scoped rows in OTHER shared workspaces are not reached,
and that is filed as `CONNWF-16` (a cross-tenant account-deletion fan-out is a
users/consent decision, not a connections one). `connections:connection` moves out of
`RECORDED_DEBT` into the covered set with that caveat in its entry.

> **CORRECTION (full gate, 2026-09-29) — D4 changed what knowledge-sync told its
> user, depending on eraser ORDER.** `test/knowledge-sync-subject-erasure.test.ts`
> (KSC-21, the host fan-out leg) went red: `connection-revoked` instead of
> `creator-erased`. The connections eraser's revoke fires the ADR 0285 consumers, and
> knowledge-sync paused the creator's source "Connection revoked — reconnect to
> resume". When that ran before `eraseKnowledgeSyncSubject`, the KS eraser (rightly)
> kept an already-paused row's reason, so the source ended up telling an erased
> creator's colleagues to RECONNECT — an exit the tombstoned `createdBy` then refuses.
> **Decision: the revoke carries its cause.** `ConnectionRevokedEvent.cause =
> 'subject-erased'` is set only by the DSAR eraser; knowledge-sync pauses with
> `creator-erased` (its "re-bind" exit) for that cause and `connection-revoked` for an
> ordinary revoke. Both eraser orders now land on `creator-erased`, and KS's own
> contract ("an already-paused source keeps its reason" for an INDEPENDENT prior
> revoke) is untouched — its test stays as written. Rejected: making the KS eraser
> overwrite every `connection-revoked` pause (it would erase the reconnect
> instruction of a revoke that had nothing to do with the DSAR), and editing the
> KSC-21 test to accept either value (the reason is user-visible and the two differ
> in their exit). Other revoke consumers ignore `cause` (optional field).

### D5 — Inbound targets a workflow this tenant may run (`CONNWF-6`)

`PUT` refuses (`400 validation_error`, one uniform "workflow not found" whether it is
missing or foreign — no existence leak) unless `resolveLaunchWorkflow(catalog, tenant,
id, {launch:'published'})` resolves AND `isAuthoredByOtherTenant(tenant, id)` is false
(H4: the catalog is global, so existence alone let a PUT name another tenant's
workflow). The SAME foreign-owner check runs at dispatch in `handleInboundEvent`, so a
config planted before this change fires nothing. A config whose workflow has since been
deleted still accepts deliveries as `nofire:` (unchanged; its status line is
`CONNWF-6b`, filed).

### D6 — Correct the stale consumer comment (`CONNWF-15`).

### Operator step (M3)

Before relying on D1, list rows with neither `userId` nor `orgId` (workspace scope) per
tenant and let an admin confirm each: any created before D1 could have been planted by a
non-admin. Recorded in the deploy note; not automated.

## Architect pass (2026-09-29) — what the first draft got wrong

| Finding | First draft | Correction |
|---|---|---|
| B1 | workspace axis → old `requireConnectionsManage` (refuses the env-key operator) | provenance-aware helper (D1) |
| B2 | the admin gate was single-spelling; D2 did not touch it | helper judges every spelling (D1 item 4) |
| B3 | D4 "closes CONNWF-4" | closes it for the named tenant; cross-tenant filed `CONNWF-16`; principal alias added |
| B4 | row-first + scrub proof | generation + CAS + no id reuse (D3) |
| H1 | swallowed secret removal | throws (D3.3) |
| H2 | broker alias home-tenant-only; connect bound to the caller | alias global for `user:`; connect binds the run's spelling (D2) |
| H3 | "D3 makes CONNWF-8 safe" | false; D3.5 fails closed on the residual, the lease is still filed |
| H4 | existence check only | plus foreign-owner refusal at PUT and dispatch (D5) |
| H5 | pending grants survived erasure | deleted by D4 |
| M1 | `/connect` + subjectless POST unaddressed | recorded exempt; subject required |
| M5 | 1-char signing secret; org rows listed to all members | ≥16 chars; org-row listing recorded (`CONNWF-17`, metadata only) |

## Alternatives weighed

- **Remove workspace-scoped creation from the API.** Rejected: workspace rows are a
  real product concept (image-broker keys, the UCP reference-merchant seed).
- **Gate revoke on `workspace:write` too** (the brief's literal ask). Rejected with
  reason recorded above (D1): it traps a demoted member's live token.
- **Provider-side revocation (RFC 7009) on disconnect.** Deferred (`CONNWF-9`): Google
  revokes the whole (account, client) grant, so revoking one connection would silently
  kill the same account's connection in another workspace. Needs an account identity
  per row first (`CONNWF-11`).
- **A distributed refresh lease for the on-demand lane** (`CONNWF-8`). Deferred: D3
  makes revoke-vs-refresh safe and makes the refresh-vs-re-consent residual FAIL
  CLOSED (D3.5), but two instances can still both mint on a rotating-token provider.

## Phased plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1–D6, backend | route tests: Viewer refused create/authorize/inbound PUT, allowed own revoke; unknown scope 400; member refused workspace create/delete; admin allowed; legacy-spelling owner lists/deletes/connects, other user refused; org-use via alias; revoke-during-refresh leaves no secret and no row; DSAR erases user rows only; inbound PUT unknown workflow 400 |
| P1-SPA | hide or disable create/connect/inbound controls for callers the server refuses; 403 → `common:error_forbidden` | frontend vitest (file list cleared with the lead first) |
| Follow-ups | `CONNWF-8..12`, `-14` | filed below |

## Follow-ups (filed, not in P1)

`CONNWF-8` cross-instance refresh race; `CONNWF-9` RFC 7009 revoke; `CONNWF-10`
cross-tenant `store.list()` scans; `CONNWF-11` account identity per row; `CONNWF-12`
inbound runs carry no actor; `CONNWF-14` the probe checks presence only; `CONNWF-16`
a member REMOVED from a workspace, or a user erased at home, keeps their user-scoped
rows in OTHER workspaces (no member-removal cascade, no cross-tenant erasure fan-out);
`CONNWF-5e` an `oidc:` actor in a `ws:` tenant gets no alias; `CONNWF-6b` a config
whose workflow was deleted reports healthy; `CONNWF-17` `GET /connections` lists every
org row to every member (metadata only).

## Open questions

1. Does account deletion call `eraseSubject` for every workspace the user belonged to,
   or only the personal one? D4 reaches the tenant the DSAR names and claims no more.

## Implementation record

| Phase | Commits | Witness |
|---|---|---|
| P1 backend (D1–D6) | `c5afed1e0`, `d75d783a7`, `123be74ca` | `test/adr0780-connections-broker.test.ts` legs 1–15 |
| grade-code pass 1 (`CONNCD-1..7`, `-10`) | `5f080da5a`, `1bb46976b` | legs 9b, 10–10c, 11–11e, 12b, 13b |
| P1-SPA (`CONNUX-1..6`, `-8`) | `5dba79e4a`, `7a774c678` | `ConnectionsManager.test.tsx`, `connectionsClient.errors.test.ts` |
| D2 correction (revert cross-tenant alias) | `d19371f37`, `04ef3380d` | legs 7, 7b; `adr0780-connections-route-identity.test.ts` |
| grade-code pass 2 (`CONNCD-11..14`, `-16`, `-17`), owner rule, `CONNUX-6` focus | `bcedebac8`, `0dfb911b0`, `f2acedf7f` | legs 10d, 11e–11g; two focus legs |

Every leg above was sabotaged red on committed code (the implementer's probes plus the
code grader's independent ones). Shared helper promoted: `frontend/react/src/lib/writeAccess.ts`
(from `byok/lib/byokWriteAccess.ts`, which now re-exports its names).

**Deploy notes.** Behaviour changes visible to users or integrations: a Viewer is
refused (403) connection create / OAuth authorize / inbound PUT; a WORKSPACE-scoped
connection needs `host:connections:manage` to create, delete, test or re-wire; an unknown
`scope` is 400; inbound PUT refuses an unknown or other-workspace `workflowId` and a
`signingSecret` under 16 characters, and an existing inbound config naming another
workspace's workflow now fires nothing; a DSAR revokes the subject's user-scoped
connections in that tenant; the refresh daemon also sweeps secret tombstones. Operator
step (M3): list workspace-scoped rows (no `userId`, no `orgId`) per tenant and have an
admin confirm each — any created before this change may have been planted by a non-admin.
Rollout: material written by a pre-0780 revision (no `generation`) is accepted, so a
draining revision is safe.

## Follow-ups (closing)

`CONNWF-5e` shared-workspace legacy rows (design recorded in D2); `CONNWF-8` cross-instance
refresh lease; `CONNWF-9` RFC 7009 revoke (needs `CONNWF-11`); `CONNWF-10` / `CONNCD-9`
tenant-indexed store; `CONNWF-11` account identity per row; `CONNWF-12` actorless inbound
runs; `CONNWF-14` presence-only probe; `CONNWF-16` member removal / cross-tenant erasure;
`CONNWF-17` org rows listed to every member; `CONNCD-14` residual (non-atomic guard,
fails closed); `CONNCD-15` issuer-qualified principals — **platform-wide, pre-existing,
routed to the users row**; `CONNUX-7`, `-8` remainder, `-9` remainder, `-10`, `-11`, `-12`;
Reconnect/Grant-write native `disabled`.

