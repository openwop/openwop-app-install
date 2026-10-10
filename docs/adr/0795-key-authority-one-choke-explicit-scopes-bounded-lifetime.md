# ADR 0795 — API key authority: one choke, explicit scopes, bounded lifetime

Status: Accepted (2026-10-01; D1–D6 implemented — see § Implementation record. Production runs the three runtime switches in `report` until the measurement in § Rollout is read)

- **Follows:** ADR 0800 (a key cannot manage keys; the API keys tab). Tracker
  rows `KEY-1` … `KEY-6` in `docs/steward/TODO.md`.
- **Composes:** ADR 0270 (developer keys), 0601 (a key's authority is its
  issuer's — `credentialAuthority` / `credentialScopesIn`), 0745 / 0755 (a key
  is narrowed to what it declares), 0617 (`assertTenantScope`), 0464 (subject
  erasure), 0750 (credential-less calls are `401`).
- **Toggle:** none. Each enforcement step ships behind an env switch that starts
  in `report` mode (log what WOULD be refused), per the lesson recorded in
  memory as "measure blast radius before enforcing".
- **Wire:** untouched. Scopes on the protocol routes are already advertised
  (`scopes_supported`); this ADR changes how this host reads a key on its own
  `/v1/host/openwop-app/*` routes and at mint. No RFC.

## Context

An `owk_` key is a delegation: it should hold some of what its issuer holds, for
a bounded time, and stop when the issuer does. Today that is true on three
lanes and false on the rest.

MEASURED on `8c5dbd16f` plus ADR 0800:

| Fact | Evidence |
|---|---|
| A key is narrowed to its declaration on protocol routes, the key-lane extension scopes and MCP | `requireProtocolScopeIn` → `keyNarrowingRefuses`; `credentialScopesIn` (two callers: MCP gate, kanban board write) |
| Elsewhere a key is judged as the subject `apikey:<keyId>`, with no reference to its issuer or declaration | 78 sites in 56 files read `req.userId ?? req.principal?.principalId`; `resolveEffectiveAccess` has 114 call sites in 87 files; `credentialAuthority` has none outside `protocolAuthorization.ts` |
| In demo mode that subject is OWNER of a single-principal tenant | `accessControlService.ts` LEAK-9 fallback; production runs `OPENWOP_DEMO_MODE=true`. This is how ADR 0800's list/revoke hole worked |
| A key that declares nothing holds its issuer's whole authority | `keyDeclarationPermits`: `declared.length === 0` ⇒ permitted |
| Any non-empty string is accepted as a scope | `normalizeScopes`. In use today: the protocol scopes, `workspace:read|write` (MCP), `events:write` (CDP ingest seed), the Claude Code device-key set |
| `expiresAt` is stored unvalidated; an unparseable value never expires | `verifyApiKey`: `Date.parse(x) <= now` is `false` for `NaN` |
| A key is accepted from `?apiKey=` on every route | `middleware/auth.ts` bearer extraction |
| Nothing at authentication asks whether the issuer still exists or is still a member | the `owk_` branch of `authMiddleware`; with RFC 0049 enforcement off, `requireProtocolScopeIn` returns after the narrowing check |
| No erasure handler names the key collections | search for `devkey:` outside the service and the demo seed: none (not test-proven) |

## Decision

### D1 — a key's authority is resolved once, from its issuer and its declaration (`KEY-1`)

`resolveEffectiveAccess` (114 call sites) and `assertTenantScope` (reached
through `requireTenantScope`, `requireOrgScope`, `requireTenantWrite` and
`authorizeOrgScope`, 321 call sites together) are where most vendor-route
authority checks already end up. How many routes reach neither is a Phase 0
count; D2 is the floor under those. The two resolvers learn one thing: a subject of the form `apikey:<keyId>` is not a member to
look up and not an unknown stranger. It is resolved by reading the key record
and answering **the issuer's current access in that tenant, filtered by the
key's declaration** — the rule `credentialScopesIn` already implements for MCP.

- A key that declares scopes gets `roles: []`. A delegation holds scopes, not
  roles; role-keyed checks (`roles.includes('owner')`) must not pass for it.
- The demo-mode owner fallback never applies to an `apikey:` subject. It applies
  to the ISSUER, exactly as it would if the person called directly.
- A key whose record is missing, revoked or expired resolves to nothing.

Alternatives weighed:

- *Rewrite the 78 call sites to pass the principal instead of an id.* Correct in
  the long run and unreviewable in one PR; the first missed site is the next
  ADR 0800. Rejected as the mechanism; the sites can migrate afterwards.
- *Set `req.userId` to the issuer in the auth middleware, so a key "is" the
  person.* One line, and it silently WIDENS every non-demo deployment: today a
  key holds nothing on most vendor routes there, and it would hold everything
  its issuer does, including routes written on the assumption that `userId`
  means a present human. Rejected.
- *A method gate in front of the vendor space (GET needs `workspace:read`,
  anything else `workspace:write`).* Kept as D2, because D1 alone does nothing
  for a route that performs no scope check at all.

### D2 — a key reaches a vendor route only through a declared scope (`KEY-1`)

One middleware, for `auth.kind === 'api-key'` on `/v1/host/openwop-app/*` (and
its v2 twin): a safe method requires the declaration to permit
`workspace:read`; any other method requires `workspace:write`. This is the
vocabulary the MCP tab already mints. It is deliberately coarse: it is the floor
under routes that check nothing themselves, not a replacement for the checks
D1 makes honest.

**Decided (2026-10-01): the narrow presets stay narrow, and the tab gains a CLI
preset.** Giving `run` and `read` `workspace:read` would quietly turn a key for
a script into "can read every record in the workspace". So:

- `run` (the default) and `read` stay protocol-only, and say so: commands such
  as `openwop agents list` need the CLI key.
- `cli` replaces "Everything the API offers": every protocol scope plus
  `workspace:read` and `workspace:write`. It is what someone at a terminal wants.

Routes that own a finer key gate are left to it, by an exact list
(`ownsKeyGate`): the developer-key routes (refuse every key), the MCP mount
(per-tool gate; a read-only client POSTs), the entities API (its own
`entities:` grammar on every route), and the vendor mirrors of protocol
operations that gate on protocol scopes — the review inbox, a run's interrupt
list, the running-conversations index, run re-drive. The list is exact because
an entry that is too wide exempts a sibling that checks nothing.

### D3 — scopes are explicit at mint and come from a registry (`KEY-2`, `KEY-3`)

- `POST /developer-keys` requires `scopes`. Unrestricted is a named choice
  (`["*"]`), never the result of omitting a field.
- A scope must be one some gate reads: the RBAC vocabulary a resolver can grant
  (`PROTOCOL_SCOPES`, `MANAGEMENT_SCOPES`), `SCOPES_SUPPORTED`, `*`, and any
  grammar a feature registers (`registerMintableScopePattern` — entities
  registers `entities:<type>:read|write` and `entities:admin`). An unknown scope
  is a `400` naming it and the valid ones.
- This is the ROUTE's rule. `issueApiKey` stays permissive for the host's own
  callers (device pairing, the demo seed's `events:write`, the conformance
  seam), which declare their own scopes.
- Existing keys are not rewritten. A stored `[]` keeps meaning "undeclared" (the
  ADR 0601 reading), is labelled Unrestricted in the tab, and is reported by
  the Phase 0 inventory.

### D4 — lifetime is validated, defaulted and capped (`KEY-4`)

**Decided (2026-10-01): 90 days by default, 366 at most, both the operator's to
change.** `expiresAt` must parse, lie in the future, and not exceed
`OPENWOP_API_KEY_MAX_LIFETIME_DAYS` (366). Omitting it applies
`OPENWOP_API_KEY_DEFAULT_LIFETIME_DAYS` (90) rather than "never". `null` asks for
no expiry and is refused unless `OPENWOP_API_KEY_ALLOW_NO_EXPIRY=true` — off on
the hosted demo, there for a self-hosting operator with long-lived integrations.
`verifyApiKey` treats an unparseable stored value as EXPIRED, so a row written
before the validation fails closed. The tab offers the lifetimes the server
will accept (`GET /developer-keys` → `policy`) and shows each key's date.

A default lifetime only works if expiry is not a surprise, so the reminder is
part of this decision, not polish: a key that is STILL IN USE inside its last 14
days tells its issuer once, in the inbox (`apikey.expiring`). It is triggered by
use rather than by a sweep — the keys worth warning about are exactly the ones
something is still calling with — and rides the same compare-and-swap as the
last-used stamp, which is now written at five-minute resolution instead of on
every request (`KEY-13`). The tab flags a key in the same window.

Device-pairing keys keep their own, shorter lifetime (they are minted through
the service, not this route).

### D5 — a key travels in a header (`KEY-5`)

`?apiKey=` stops authenticating an `owk_` key, except on the run-events stream
routes, where `EventSource` cannot set a header. The preferred form there is the
run-scoped `?streamToken=` the SPA already uses. Operator env keys keep the
query form for now; whether anything depends on it is a Phase 0 count.

### D6 — a key stops when its issuer does (`KEY-6`)

**Decided (2026-10-01): revoke, do not suspend; delete on erasure.** A suspended
credential that comes back to life when someone is re-added is a surprise, and
the cost of revoking is small: a person removed by mistake creates new keys.

- **Removal.** When a subject loses its LAST membership in a tenant,
  `deleteMember` notifies (`notifyIssuerRemoved`) and the keys that subject
  issued there are revoked. Leaving one org of several is not leaving.
- **At authentication.** `authMiddleware` asks `delegationIssuerIsLive` before
  admitting a key, so the property holds on every lane, including the protocol
  lane with RFC 0049 enforcement off. It is cached per key for a minute:
  removal already revokes outright, so this is the backstop.
- **Erasure.** `eraseDeveloperKeysForSubject` (ADR 0464) DELETES the subject's
  key records and hash pointers; a revoked row would keep the subject's
  `createdBy` and the key's name. `devkey:record` leaves the actor-attribution
  debt list.

> **Correction during implementation — "live" had to be narrowed.** The first
> version read "the issuer has no member row in the key's tenant" as "gone". 30
> existing tests went red, and they were right: in a deployment-named tenant
> with enforcement off, NOBODY is a member, so that rule would have killed every
> key there. Membership now decides presence only where membership is how one
> is present at all — a shared `ws:` workspace (ADR 0015), or any tenant once
> enforcement is on. Elsewhere the removal hook and erasure are the mechanism.

## Rollout

D3 and D4 act at mint and are on from the first deploy: no existing key changes
behaviour except one with an unparseable expiry, which now fails closed.

D1, D2, D5 and D6's authentication check are each behind a switch that defaults
to `enforce` — a fresh install is secure — and accepts `report` (log what WOULD
change, change nothing) or `off`:

| Switch | Governs |
|---|---|
| `OPENWOP_KEY_AUTHORITY` | D1 (the resolvers) and D6's issuer check at authentication |
| `OPENWOP_KEY_VENDOR_GATE` | D2 |
| `OPENWOP_KEY_QUERY_PARAM` | D5 |

**Production is set to `report` on all three before this deploys**, because the
blast radius there is not measured: which CLI commands, pairing calls and
integrations reach a vendor route with a narrow key, and which keys' issuers
are spelled `oidc:<sub>` while their membership is keyed `user:<id>`. Each
would-be refusal logs one `key_policy_would_change` line per distinct
(kind, key, detail). Read those, fix or accept what they name, then flip each
switch to `enforce`. `KEY-11` (keys minted through the ADR 0800 hole) is read
from the same logs: such a key resolves to nothing under D1.

## Implementation record

| Decision | What | Witness |
|---|---|---|
| D1 | `host/delegatedSubject.ts` (the seam + the three switches); `viaDelegation` in `accessControlService.ts` under `resolveEffectiveAccess`, `resolveSubjectScopesUnion`, `resolveTenantLevelScopes`; the key store registers the lookup | `test/adr0795-key-authority.test.ts` (14) |
| D2 | `middleware/keyVendorGate.ts`, mounted after auth | `test/adr0795-key-policy.test.ts` § D2; `cdp-apikey-auth` no longer pins a `manifest:read` key reading CRM contacts |
| D3 + D4 | `features/developer-keys/keyPolicy.ts`; `isExpired`; `policy` on the list | § D3, § D4 of the same file |
| D4 notice, `KEY-13` | `sendExpiryNotice` + the throttled swap in `verifyApiKey` | § "expiry is not a surprise" |
| D5 | the query-param branch of `authMiddleware` | § D5 |
| D6 | `delegationIssuerIsLive`, `notifyIssuerRemoved`, `revokeKeysIssuedBy`, `eraseDeveloperKeysForSubject` (+ manifest) | § D6; `subject-erasure-feature-stores` |
| Tab | `cli` preset, lifetime choice, expiry in the list, four locales | `ApiKeysPage.test.tsx` (20), `api-keys-preset-parity.test.ts` (8), `e2e/api-keys.spec.ts` (3) |
| Review fixes | see § Correction | `adr0795-key-policy.test.ts` (35), `adr0795-key-authority.test.ts` (15), `path-case-routing.test.ts` (5) |

With all three switches forced off, 17 of the 41 tests the two ADR 0795 files held before the review fail. The
127 existing test files that touch keys or erasure pass with the switches at
their default.

What the implementation found that the proposal did not know:

- `resolveTenantLevelScopes` answered OWNER for a key id on a single-principal
  tenant in ANY mode, not only demo mode — a third resolver with the same hole.
- A test (`cdp-apikey-auth`) minted `manifest:read` and read CRM contacts with
  it. It pinned the gap as intended behaviour.
- The entities API has its own key-scope grammar, and four vendor routes gate on
  protocol scopes. A blanket vendor floor would have broken all of them; hence
  the registry seam and the exact own-gate list.

## Correction — the adversarial review of the implementation (2026-10-01)

A second reviewer attacked the first implementation with a booted app and found
three bypasses it reproduced and several more by reading. Each is fixed in the
same PR; the claims above that they falsified are corrected here rather than
edited away.

| Found | Was | Now |
|---|---|---|
| **Path case skips the vendor floor — and, on production, the ADR 0750 credential-less `401`.** Express routes case-insensitively; every path predicate here compares exactly. MEASURED on production: `POST /v1/runs` with no credential → 401, `POST /V1/runs` → the handler (201 locally) | D2 was void on exactly the routes it exists for | `app.set('case sensitive routing', true)`: one spelling routes, the rest are 404. `test/path-case-routing.test.ts`, cookie posture on (3 of 5 fail without the line) |
| **A read-only key decided approvals through `/reviews`.** The approval-source arm of `POST /reviews/:id/actions/:action` checked only `runs:read`; a viewer-issued `runs:read` key approved a `campaign-spend` | The own-gate list said every exempt entry "refuses a key itself". False for this POST | The arm requires `approvals:respond`, like the interrupt arm and the node route |
| **`x-openwop-act-as` skipped D1.** `resolveEffectiveAccess` delegates only when no `memberId` is passed, and six route files pass the header's member id. A viewer's key created an admin member | "A key cannot hold a scope its issuer does not" was false | A key presenting the header is refused (`key_cannot_act_as`) in the gate middleware, before any route reads it. The same header is open to a viewer SESSION — that is `CE-8`, not this ADR |
| **The entities key lane granted on declaration alone.** Any member could mint `entities:admin` (D3 made it mintable) and reach the admin tier | D3 + the `/entities` exemption widened a hole instead of closing one | `requireEntitiesScope` also requires the ISSUER to hold the tier's scope (`delegationIssuerScopes`); the scheme is matched case-insensitively, as the auth middleware matches it |
| **Superadmin is keyed on the tenant.** A narrowed key minted in a superadmin tenant was superadmin | — | A key with a narrowing declaration is never superadmin |
| **D6 missed ways an issuer stops**: a disabled account (SCIM deprovision); a rotated operator env key (`bearer:<8>` was always live and always owner); an org delete (members removed without `deleteMember`); the device websocket (verifies the key itself); a subject rekey (`oidc:<sub>` → `user:<id>` orphaned the keys) | — | `delegationIssuerIsLive` reads the session authority's `disabled`; an operator issuer is honoured only while its env key is configured; `deleteOrg` notifies; the websocket asks `apiKeyIssuerRefused`; `rekeyMemberSubject` moves the issued keys |
| **A transient store error permanently revoked keys.** `deleteMember` read "no membership left" from a resolver that answers `none` on error | — | A strict membership read that throws; on error the keys are left alone, and the liveness check refuses that one request and caches nothing |
| The `/mcp` exemption was a prefix; the D5 stream regex was unanchored; the expiry notice addressed non-user issuers | — | The MCP MOUNT only (`POST …/mcp`); anchored on the canonical run-events path; sent only to a `user:` issuer |

These rules ride `OPENWOP_KEY_AUTHORITY` (act-as, entities issuer, superadmin,
issuer liveness) except case-sensitive routing, the `/reviews` scope and the
strict membership read, which are unconditional.

Fixed but NOT yet covered by a test of their own: the entities issuer check,
the disabled-account reading in `delegationIssuerIsLive`, and the device
websocket's issuer check. They are exercised only by the suites that already
cover those surfaces staying green.

Recorded, not fixed here: `cdp/routes.ts` `requireAdmin` passes `{}` to
`resolveEffectiveAccess`, which answers owner for any caller (`KEY-19`).

## Risks

| Risk | Mitigation |
|---|---|
| D1 narrows a flow that works today only because of the demo-owner fallback (a key calling a vendor route in a personal workspace) | Phase 0 report mode names every such request before anything is refused |
| D1 puts a store read on every authority check for a key | The key record is already read by `verifyApiKey` on the same request; carry it on the principal rather than re-reading |
| D3 rejects a scope a feature mints today | The registry is built from the gates and the mint sites, test-pinned; Phase 0(a) lists every scope string actually stored |
| D4's default expiry surprises a script owner in 90 days | The tab shows the date at creation and in the list; an owner notice before expiry belongs with `KEY-7` |
| D5 breaks a client that passes `?apiKey=` | Report mode counts them first; the stream routes keep working |

## Open questions

- [x] D2 presets — decided: narrow presets stay narrow; a `cli` preset is added.
- [x] D4 lifetimes — decided: 90 default, 366 maximum, operator-configurable.
- [x] D6 removal — decided: revoke; erasure deletes.
- [ ] Read the production `report` logs and flip the three switches to `enforce`.
- [ ] An issuer recorded as `oidc:<sub>` whose membership is keyed `user:<id>`
      resolves as not-a-member (ADR 0774's two spellings). A rekey now moves the
      keys; a key minted BEFORE this shipped by an account that has already been
      bound is still under the old spelling. Report mode will show whether any
      production key is affected.
- [ ] Is `["*"]` offered in the tab? Today it is API-only.
- [ ] Phase 4 of the proposal stands: migrate the 78 id-as-subject sites to pass
      the principal, then delete the `apikey:` branch in the resolvers.
- [ ] Should demo mode's owner fallback exist for ANY non-human principal? Out
      of scope here (LEAK-9 owns it); D1 only stops keys reaching it.
