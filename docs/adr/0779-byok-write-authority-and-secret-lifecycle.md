# ADR 0779 — BYOK: one write authority, system-owned ref namespaces, and a run-secret lifecycle that survives suspend

Status: implemented (P1–P4, 2026-09-29; post-/architect, 5 Blockers corrected in the decision text before code; `BYOKWF-2` falsified at implementation)

Feature-loop round 2, row 7 (`core:byok`). Builds on ADR 0517 (active-config
durability), ADR 0499 (credential-ref referential integrity), ADR 0711 (BYOK
writes are admin-class), ADR 0712 (run `ai.credentialRef` validation + OQ4
wrong-provider refusal), ADR 0757 (no pasted subscription token).

## Context

The row-7 grade (`docs/steward/WORKFLOWS-ASSESSMENT.md` § core:byok) re-measured
the BYOK surface on `origin/main` @ `c0e852b39`. BYOK owns no workflow of its own
(one tutorial checkpoint chain, no secrets in it), so the orchestration grade is
about the **run lane every AI workflow rides**: how a run's key is resolved,
held, persisted and re-resolved across suspend/resume. Measured defects:

| Id | Where | Defect |
|---|---|---|
| BYOKWF-1 | `routes/byok.ts:236,244` | `PUT`/`DELETE /byok/ai-default` have NO write gate. ADR 0711 gated the other four BYOK writes and missed these two, so any member of a shared workspace (a Viewer) can rebind or clear the workspace's headless-AI default. |
| BYOKWF-2 | `features/featureRoute.ts:303` → `accessControlService.ts:1645` | The four gated BYOK writes use `requireTenantScope`, which judges ONE raw spelling of the caller (`callerSubject`). The identity trap rows 4–6 closed: an owner whose membership is keyed `oidc:<sub>` is refused when signed in as `user:<id>` (and vice versa). (Credentials — `owk_` / env keys — never match a member row and are refused outright; see D1.) |
| BYOKWF-3 | `routes/byok.ts:125,156` | The Keys-page `POST`/`DELETE /byok/secrets` accept any ref matching the charset — including refs OWNED by another lifecycle: `connection:*` (OAuth token JSON), `connection-inbound:*`, `subscription:*` (RFC 0121 user-scoped subscription token — ADR 0757 forbids pasting it), `compat-key:*`, `pm-peer:*`, `email-webhook:*`, `auth:*`, `managed:*`. So a workspace admin can overwrite a member's OAuth token or paste a Copilot token into the shared tenant, and the Keys-page delete can remove a connection's token behind the connection's back. The vault route already refuses `connection:` (`adminVault.ts:143`); the Keys route never did. |
| BYOKWF-4 | `routes/byok.ts:329` | The create echo `masked` returns `first4…last4`. For a 9-character value that is 8 of 9 characters; anything under 20 characters exposes ≥ 40 %. |
| BYOKWF-5 | `executor/executor.ts:3123` | `persistSnapshot` writes `nodeOutputs` + `nodeErrors` to `runs.scheduler_snapshot` **unscrubbed**, while every event carrying the same values goes through `stripSecretsFromPersisted`. A node output or provider error that echoes a key reaches the database whenever a run suspends or pauses. |
| BYOKWF-6 | `executor/executor.ts:2063` | Run secrets are prepared only when `!isResume || isForkCheckpointResume` — the comment assumes a resume "already ha[s] the run-secrets bundle in the ephemeral store". That holds only on the same instance before a restart. An interrupt-resumed run (pause-resume already re-prepares) on another instance, or after a deploy, has no secrets and fails `byok_required` telling the user the workspace has no key (false). Conversely on the same instance a run suspended before a key rotation/delete keeps dispatching with the OLD plaintext. |
| BYOKWF-7 | `executor/executor.ts:389,2999` | Run secrets are cleared only on complete/fail. A suspended, paused or cancelled run keeps provider plaintext in process memory indefinitely. |
| BYOKWF-8 | `host/exchange/dispatchTurn.ts:257,380` | The chat BYOK-direct lane resolves the run's `credentialRef` for whatever provider the per-turn resolver picked, with no ADR 0712 OQ4 check. A per-turn provider switch (override / stamped route / tier default) can send a `byok:google` key to OpenAI. The workflow lane refuses this (`aiProvidersHost.ts:1899`); the chat lane — the busiest one — does not. |

Frontend (row-7 grade-ux input, re-measured): no BYOK surface maps a 403 to
`common:error_forbidden` or hides writes a caller cannot make; the Keys-page
delete shows the raw `DELETE … → 409: …` text with no consumers listed and no
override; `ConfiguredProviderCard` and `WebSearchKeyCard` swallow write failures
as unhandled rejections; the vault's 409 renders "Live references: ." when the
backend said `referencesKnown:false`.

## Decision

### D1 — One BYOK write authority, both identity spellings, no widening for credentials

> **CORRECTION (implementation, 2026-09-29) — `BYOKWF-2` is FALSIFIED; D1 keeps
> `requireTenantScope`.** The first witness could not even reach the route: an
> unbound caller whose membership is keyed by the canonical spelling is refused
> at `POST /workspaces/:id/switch` (`routes/workspaces.ts:152`, raw subject). The
> reason generalises: the auth middleware only honours a shared active tenant
> after `isWorkspaceMember(effectiveSubject, …)` for THAT request's spelling
> (`middleware/auth.ts:1071`), and an OIDC bind RE-KEYS member rows
> `oidc:<sub>` → `user:<userId>`. So whenever `tenantOf(req)` is a shared
> workspace, the raw spelling `requireTenantScope` reads is by construction the
> one the membership is keyed under; a second spelling adds no reachable
> authority. Row 4's identity defect was a CANONICAL-only check, which is the
> other direction. D1 therefore is: `requireByokManage(req) =
> requireTenantScope(req, 'host:byok:manage')`, applied to all six writes (the
> `ai-default` pair is the real Blocker, `BYOKWF-1`) and added on top of the
> compat org check. The text below is kept as the reasoning trail; items 1–4
> describe `requireTenantScope`'s existing behaviour, not a new helper.

A single `requireByokManage(req)` in `routes/byok.ts` gates EVERY BYOK write:
`POST`/`DELETE /secrets`, `PUT`/`DELETE /active-config`, and — new —
`PUT`/`DELETE /ai-default`. Its decision, in order:

1. the wildcard operator principal → allowed (unchanged);
2. the caller's OWN personal workspace (`isOwnPersonalWorkspace` — equivalent
   to today's `personalTenant === tenantId && isPersonalTenantId`) → allowed
   (unchanged; keeps the solo + anon-demo flows exactly as ADR 0711 required);
3. a CREDENTIAL (`auth.kind` `api-key` / `env-key`) → **refused, as today**
   (today `callerSubject` is `apikey:<id>` / `bearer:<8>`, which never matches a
   member row);
4. a PERSON → allowed iff `resolveSubjectScopesUnion(tenant, s)` has basis
   `member` and includes `host:byok:manage` for SOME `s` in
   `callerSubjectSpellings(req)`. **No `resolveEffectiveAccess` fallback** — that
   is the single-principal demo sandbox branch, which grants OWNER on `default`
   to a non-member (USERS-19; `requireTenantScope.test.ts:88` pins the denial).

The ONLY widening against `requireTenantScope` is item 4's second spelling —
the defect. It throws the same `403 forbidden_scope` body, so the SPA's
`ApiError.status` mapping is unchanged.

> **/architect correction (pre-code).** The first draft used ADR 0775's
> `callerHoldsTenantScope`. That predicate reads credentials by provenance
> (`credentialScopesIn`), so it would have GRANTED BYOK writes to every
> pre-ADR-0601 `owk_` key (undeclared `scopes: []` reads as the issuer's full
> authority) and to scoped env keys (tenant-owner), and its non-member
> `resolveEffectiveAccess` fallback grants OWNER on `default` in demo mode. The
> draft also claimed an `owk_` key's narrowing "is ignored" — false: keys are
> refused outright today. Letting keys write provider secrets is a product
> decision this ADR does not take (filed `BYOKWF-17`).

**Compat endpoints** (`routes/compatEndpoints.ts`) mint `compat-key:*` into the
same tenant store and are an `admin`-tier Access-hub tab. Their writes KEEP the
existing org-membership check (`requireOrgScope(req, orgId, 'workspace:write')`,
which is what verifies the caller belongs to `body.orgId`) and ADD
`requireByokManage`. This narrows who can write (a non-admin Editor loses it):
a key an editor adds is dispatched for every member, which is the ADR 0711
reason BYOK writes are admin-class, and the UI already shows the tab only to
admins.

`requireTenantScope` itself is NOT changed here (`GEN-BYOK-1`).

### D2 — System-owned ref namespaces: refused on the Keys lane, owned in one place

`byok/refNamespaces.ts` is the ONE list of system-owned prefixes, each with its
owner: `connection:` (OAuth connections), `connection-inbound:` (inbound
webhooks), `subscription:` (RFC 0121 subscriptions), `compat-key:` (compat
endpoints), `pm-peer:` (priority-matrix federation), `email-webhook:` (email
bounce webhooks), `managed:` (managed tier). The owners' ref builders import
their prefix FROM this module, so the list and the refs cannot disagree, and
`adminVault.ts`'s `isConnectionRef` uses it too.

- `POST /byok/secrets` with an owned ref → `400 validation_error`,
  `details: { credentialRef, owner }`, before any read or write. Always.
- `DELETE /byok/secrets/:ref` with an owned ref → `409 conflict`
  (`details.owner`) unless `?force=true`, in which case the existing ADR 0711 C′
  force path runs (audited BEFORE the delete). Refusing delete outright would
  strand orphans nothing else can remove — a legacy pasted `subscription:*` in a
  shared workspace (Copilot disconnect only clears the personal copy), a
  `compat-key:*` whose endpoint row is gone, a `connection:*` whose cleanup
  failed (`connectionsService.ts:262` swallows).

`auth:` (`auth:workload-identity-subject-salt`) is deliberately NOT listed: ADR
0556 §D makes "write the ref" its tenant-admin rotation mechanism.

Enforcement: a ratchet test enumerates every non-test `setSecret(` call site
and fails when a FILE not in its classified map appears (each entry names the
namespace it writes, or `keys-lane` / `vault` / `boot`). A grep of the ref
argument cannot work — most sites pass a variable — so the ratchet is on the
writer, which is where a new namespace is born.

### D3 — The create echo reveals at most the last four characters

`masked` becomes `…` + last 4 when the value is at least 16 characters, else
`••••`. The SPA only displays it (`CredentialViews.tsx:36,66`).

### D4 — A persisted scheduler snapshot never holds a known run secret

`persistSnapshot` builds the serialised snapshot, round-trips it through JSON
(so a Date/Buffer serialises exactly as it does today), and then removes every
KNOWN run-secret value (the Tier-1 exact-value pass, a new exported
`stripKnownRunSecrets`) from `nodeOutputs`, and runs the full
`stripSecretsFromPersisted` over `nodeErrors`.

Why Tier-1 only for outputs: interrupt resume (`routes/interrupts.ts:1444`) and
pause resume (`routes/runs.ts:1632`) read `scheduler_snapshot` as LIVE
downstream inputs, so the Tier-2 shape pass would rewrite a legitimately
credential-shaped value (`Bearer …`, `gho_…`) a node after the gate consumes.
Tier-1 removes exactly the defect — a provider key the run resolved, echoed into
an output — and nothing a workflow could legitimately need. Errors are not
downstream inputs, so they get the full scrub the `node.failed` event already
gets.

> **/architect correction (pre-code).** The draft claimed D4 "aligns the snapshot
> with the event log; replay reads events". Only `:fork` rebuilds from events
> (`snapshotFromEventPrefix`); interrupt and pause resume read the snapshot, so
> a full scrub would have changed what resumed runs compute.

> **CORRECTION (grade-code, 2026-09-29) — "the one persisted copy that bypassed
> the scrub" was false.** `host/variablesRuntime.ts` `persistBag` writes a run's
> variable bag to `runvars:<runId>` unscrubbed, and a node can park a key there via
> `ctx.variables.set` (`BYOKCD-2`). It now gets the same known-secret scrub. And
> Tier 1 matched WHOLE strings only, so a key embedded in an error string survived
> (`BYOKCD-3`); `stripKnownRunSecrets` is now substring-based under the SR-1 rules
> (split/join, longest first, 8-character floor). The vault likewise refused only
> `connection:` (`BYOKCD-1`); D2's refusal now covers its add/reveal/rotate.

> **MEASURED 2026-09-29 — no scrub, no rotation; the writer fix closes it.** A
> read-only prod sizing (peer session openwop-app-ce) over all 1,404 non-null
> `runs.scheduler_snapshot` rows, every one carrying `nodeErrors`/`nodeOutputs`/
> `nodeState`/`schemaVersion`: 0 hits for `sk-ant-`, `sk-proj-`, `sk-<20+>`,
> `AIza`, `xai-`, `gsk_`, `r8_`, `ya29.`; 0 JWT (`eyJ….`) anywhere; 0 32-hex
> inside `nodeErrors`. Pattern-based: a key of a shape not listed would not be
> counted. No data migration.
>
> **MEASURED 2026-09-29 (second pass, both stores): no persisted secret in either
> store; no scrub, no rotation; the writer fixes close it (pattern-based).**
> `runs.scheduler_snapshot` (1,404 rows) and `host_ext_kv` `runvars:%` (17,144
> rows, `BYOKCD-2`) — 0 for every shape above plus `gho_`/`ghp_`, `Bearer <20+>`,
> `access_token`/`refresh_token` JSON and the conformance canary (the 32-hex
> sweep was run on `nodeErrors` only; in outputs it is all ids and hashes).

### D5 — Every resume re-resolves its keys; suspend and cancel release them

- On a resume, `prepareRunSecrets` runs **immediately after the snapshot is
  hydrated and BEFORE the resume-seeding block** (which scrubs `resumeValue`
  and emits the resumed node's `node.completed` with the Tier-1 map in place).
  The ADR 0467 handoff-contract check stays under its original
  `!isResume || isForkCheckpointResume` guard.
- On a resume it runs **tolerant**: it registers every declared ref that
  resolves and skips one that does not, instead of throwing. A run whose
  remaining nodes never dispatch (an approval followed by a non-AI tail, a chat
  conversation closing) still completes; a node that does need the missing key
  fails with its own typed error at dispatch. A fresh run keeps today's strict
  `credential_unavailable`.
- `clearRunSecrets(runId)` runs synchronously right after `persistSnapshot` on
  the suspend disposition and in `pauseRun` (before any await that could let a
  fast same-instance resume prepare first), and on the cancel paths this
  instance observes: the executor's `RunLogClosedError` return and
  `host/runCancel.ts` `cancelRunAndCascade`. A cancel on another instance cannot
  clear this instance's memory; that instance's run ends at its next log append
  (`RunLogClosedError`), which now clears.

What changes: an **interrupt** resume works on another instance or after a
restart for PERSISTED keys, and dispatches with the key as it is NOW (rotation
honoured). **Pause** resume already re-resolved (it has no `resumeNodeId`, so
`isForkCheckpointResume` is true, `executor.ts:2029`). Ephemeral-mode (`anon:`)
keys live in per-process buckets and still do not survive a restart; that is
the ephemeral contract, not a regression.

Trade-off: between suspend and resume a payload echoing the key (e.g. an
`interrupt.resolved` body) is scrubbed only by the Tier-2 shape pass. Accepted:
the alternative is plaintext held for the length of a human wait, and never
rotated.

### D6 — The chat lane refuses a key named for another provider

`dispatchReply` calls `explicitRefNamesOtherProvider(provider, credentialRef,
CREDENTIAL_PROVIDERS)` before `resolveSecret`, and on a hit throws the SAME
refusal the workflow lane and the chat tool loop already give
(`aiProvidersHost.ts:1899`): code `byok_required_but_unresolved`, reason
`explicit_ref_wrong_provider`, 422, ref NAME and provider ids only.
`CREDENTIAL_PROVIDERS` moves to `credentialRefLadder.ts` so both lanes import
one list. (Draft said `credential_forbidden`, which is RFC 0121 §B.8's 403 with
a different meaning.)

> **CORRECTION (implementation).** `byok_required_but_unresolved` is an
> `AiProviderError` code, not an `OpenwopErrorCode`; the chat exchange flattens
> any non-`OpenwopError` to `internal_error` 502 (`conversationExchange.ts:637`).
> So the chat lane throws its own existing `credential_unavailable` (422) with
> `details.reason: 'explicit_ref_wrong_provider'` — the workflow lane's reason,
> this lane's code. And `CREDENTIAL_PROVIDERS` stays in `aiProvidersHost.ts`
> (its source lists live there) and is exported from there rather than moved.

### D7 — The SPA: gate what it offers, say what the server said

Frontend-only, rides existing endpoints (list of files agreed with the lead
before editing; nothing under `src/client/**`):

- A scope-parameterised write-access helper (generalising
  `agents/agentWriteAccess.ts`) — `host:byok:manage` for keys / active-config /
  ai-default / compat. Writes a caller cannot make are not offered; a 403 that
  still happens renders `common:error_forbidden`.
- Keys-page delete: a 409 lists the consumers from `details.references`, or says
  "could not verify what uses this key" for `referencesKnown:false`, and offers a
  confirmed "Delete anyway" (`?force=true`, which the backend audits).
- `ConfiguredProviderCard`, `WebSearchKeyCard`, `AiDefaultCard`, `KeyEntry`:
  every write has a catch that renders a translated message; no unhandled
  rejection.
- Vault: `referencesKnown:false` gets its own copy instead of an empty list.
- System-owned refs listed by `GET /secrets` (the Keys page's legacy bucket)
  offer no delete except through the force path's confirmation.

## Competitive refinement (`/feature-refinement` against `UX_UPGRADE-access-data.md`)

Extension of the always-on `core:byok` surface: no toggle, no feature row change,
no node/agent pack (BYOK is operator config, not a chat-drivable domain — the
chat reaches it only through the ADR 0517 active-config it already reads), no
`ctx.*` surface, no public face. Matrix rows 3–7 are therefore "none", honestly.

| Leader pattern (cited in `UX_UPGRADE-access-data.md`) | Where 0779 lands it |
|---|---|
| **HashiCorp Vault** capability-aware disclosure — the UI renders what the server says the caller may do | D7 gates writes on the server-computed `useEffectiveAccess` scopes (`host:byok:manage`), not on a client role guess; D1 is the server authority those scopes come from |
| **Doppler** honest failure states — a failed read never renders as a fact | D7 adds: `AiDefaultCard`'s initial GET failure currently renders as "no default" (`AiDefaultCard.tsx:29`) — it gets an error state + retry; the compat list's error no longer hides the card as if the feature were off |
| **LaunchDarkly** a blocked action states its reason | D7: a 409 delete names the consumers (or says they could not be checked) and offers the audited override, instead of raw `DELETE … → 409` text |
| **Vercel** audited reveal / **Auth0** audited rotate | Already exceeded by the vault (step-up + audit). 0779 keeps the Keys lane write-only (no reveal) and D2 routes owned-namespace deletes through the audited force path |
| ACC-R2-1 last-used / freshness metadata on refs | **Deferred** (`BYOKWF-20`): needs a write on the resolve hot path (every dispatch); design it with the `BYOKWF-9` cache work so it is one read-modify, not a write per call |

## Alternatives

- **Fix `requireTenantScope` globally (D1).** Right long-term, wrong blast radius
  for a row whose surface is 7 routes. Filed as `GEN-BYOK-1`.
- **Allow-list the Keys lane to `byok:*` / provider refs (D2).** Tighter, but the
  web-search key, legacy `provider:` refs and operator refs (`billing:*` in a
  personal tenant) all ride this route today; an allow-list would break them. A
  deny-list of OWNED namespaces is what the defect needs, and the pin test keeps
  it complete.
- **Keep secrets across suspend but re-resolve on resume (D5).** Fixes the
  restart case but leaves plaintext in memory for days. Rejected.
- **Scrub at the storage adapter (D4).** The `ephemeralRunSecrets` header says
  the adapter "MUST" scrub, but it does not, and moving it there touches every
  `updateRun`. Scrubbing at the one writer of the one unscrubbed column is the
  minimal honest fix.

## Wire / RFC gate

No wire change. All routes are `/v1/host/openwop-app/*` host extensions. D6's
new refusal is a host-internal chat-exchange error on an existing error code.
No capability advert changes.

## Replay / fork

`:fork` rebuilds from the event log and is untouched. Interrupt/pause resume read
the snapshot; D4 removes only known run-secret values from it (a run cannot
legitimately depend on echoing its own provider key). D5 re-resolves keys on
resume, which a `:fork` checkpoint resume and a pause resume already did (ADR
0326 P3b). No recorded payload changes shape.

## Implementation plan

| Phase | Scope |
|---|---|
| P1 | D1 + D2 + D3 (routes/byok.ts, routes/compatEndpoints.ts, byok/refNamespaces.ts) + refuse-side witnesses |
| P2 | D4 + D5 (executor) + witnesses (suspend with a secret-echo node → snapshot scrubbed; resume with an empty ephemeral store → keys re-resolved; rotation honoured; suspended/cancelled run holds no secrets) |
| P3 | D6 (dispatchTurn) + witness |
| P4 | D7 (SPA) after the lead approves the file list |

## Implementation record

| Phase | Commit | Witness (each sabotaged red on committed code) |
|---|---|---|
| P1 D1/D2/D3 | `b5311673d` | `adr0711-byok-operator-gate` legs 5b/5c; `adr0779-byok-keys-lane` legs 1–5; `adr0779-byok-ref-namespaces` |
| P2/P3 D4/D5/D6 | `e8a602d7d`, `1a9643497` | `adr0779-run-secret-lifecycle` legs 1–6; `adr0779-chat-wrong-provider-key` |
| grade-code fixes | `3d0a09c6d` | vault owned-ref leg in `admin-vault`; runvars + embedded-key assertions; pause leg; writer ratchet (new writer file reds it) |
| P4 D7 | `a9b021129` | `KeysPage.writeAccess`, `byokWriteAccess`, `WebSearchKeyCard`, `AiDefaultCard` |
| grade-ux fixes | `53e88d9db` + compat test | `KeysPage.writeAccess` (confirm override, failed-read), `byokReadOnly`, `compatClient.errors` |

Residuals, stated: the executor's `RunLogClosedError` clear and the chat tool
loop's wrong-provider fallback have no dedicated witness (each needs a harness
this row did not build); `BYOKCD-7`/`-8`/`-10`/`-11`, `BYOKUX-5`/`-7`/`-11`/`-13`.

## Follow-ups (filed, not in this ADR)

- ~~`GEN-BYOK-1`~~ — WITHDRAWN (see D1 correction): `requireTenantScope` single-spelling; migrate to the union
  (person-only, no demo fallback — see D1's correction for why not
  `credentialScopesIn`).
- `BYOKWF-17` — should an `owk_` key that DECLARES `host:byok:manage` be able to
  write keys? Product call; refused today and after this ADR.
- `BYOKWF-18` — node-level `config.credentialRefs[]` that do not resolve are
  skipped silently at prepare; the node then fails `byok_required`, which
  reads as "no key" rather than "key deleted".
- `BYOKWF-20` — ACC-R2-1 last-used metadata on BYOK refs (see Competitive refinement).
- `BYOKWF-19` — `executor.ts:1983` comment claims the scrubber strips
  `__secret:*` markers; it does not (fixed in this PR's comment only).
- `BYOKWF-9` — `resolveSecret` plaintext cache (5 min, per instance) outlives a
  delete/rotate on other instances.
- `BYOKWF-10` — Tier-1 redaction is whole-string only; chat-lane keys are never
  registered; shape regex lacks `AIza…`/MiniMax/xAI/Replicate.
- `BYOKWF-11` — v1 clients may set `configurable.credentialRefs[]` freely (only
  `ai.credentialRef` is validated).
- `BYOKWF-12` — a replay-mode fork needs no live key but still fails
  `credential_unavailable` when it is gone.
- `BYOKWF-13` — ADR 0499 consumers miss `config.credentialRefs[]` and suspended
  runs; Copilot disconnect bypasses the consumer check; a forced delete leaves
  the chat pointer dangling (decide: clear it or keep `valid:false`).
- `BYOKWF-14` — creative-briefs reel passes `credentialRef` only in `inputs`, so
  its video node never sees the key (fails closed). Row: creative-briefs.
- `BYOKWF-15` — compat POST stores the key before the endpoint row (orphan on a
  failed save); governance budget audit is fire-and-forget.
- `BYOKWF-16` — `isSuperadmin` treats an allow-listed shared `ws:` tenant as
  superadmin for every member, which reaches the vault reveal.
