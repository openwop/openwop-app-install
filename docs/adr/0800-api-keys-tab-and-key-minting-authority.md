# ADR 0800 — API keys: a key cannot mint keys, and a key-management tab the CLI can use

Status: Accepted (2026-10-01; D1 + D2 implemented in the PR that adds this file — see § Implementation record)

- **Composes:** ADR 0270 (developer API keys — the routes and the `owk_` format),
  ADR 0434 (the surface is always on), ADR 0745 / 0755 (a key is narrowed to the
  scopes it declares), ADR 0601 (a key's authority is its issuer's), ADR 0788 D6
  (the "AI clients (MCP)" tab, which left "the full key-management page" to a
  later row), ADR 0144 (Access Hub), ADR 0750 (a credential-less protocol call
  is `401` on both majors).
- **Toggle:** none. Developer keys graduated off their toggle in ADR 0434; this
  adds a tab to an always-on surface.
- **Wire:** untouched. Everything here is under `/v1/host/openwop-app/*`
  (non-normative) or the SPA. No RFC is needed.

## Context

Once ADR 0750 was extended to major 1, a protocol call with no credential
answers `401` on production. That is correct, and it exposed a gap: a member of
the public had no way to obtain a credential the CLI can use.

**The only screen that mints a key is built for MCP clients.** `/access/mcp`
offers two presets, `workspace:read` and `workspace:read + workspace:write +
runs:create`. An `owk_` key is narrowed to exactly the scopes it declares
(`keyDeclarationPermits` is plain inclusion), and neither preset declares
`runs:read`. MEASURED on `8c5dbd16f`, real app over HTTP, keys minted with the
tab's own scopes:

| Key | `POST /v1/runs` | get · poll · list · cancel |
|---|---|---|
| "Read only" | 403 | 403 |
| "Read & act" | **201** | **403** `insufficient_scope`, `scope="runs:read"` |
| declares nothing | 201 | 200 |
| the five run scopes | 201 | 200 |

So the one key a person could get from the app starts a run and is then refused
reading it. `openwop developer-keys create` cannot bootstrap either: it needs a
non-anonymous credential to begin with.

**A key could mint a wider key.** `POST /developer-keys` refused only an
anonymous principal and took the new key's `scopes` from the request body.
MEASURED: a `workspace:read` key called it with no `scopes` and received an
un-narrowed key, which then created and read a run. The new key was stamped
`createdBy: apikey:<keyId>`, so it was absent from the delegating person's own
key list, and the MCP tab (which lists only `MCP: `-named keys) would not show
it either. Production runs with RFC 0049 membership enforcement off, the same
posture as the measurement. Whoever holds a read-only key a person gave an AI
client could therefore act with run authority in that workspace.

## Decision

### D1 — an API key cannot manage API keys

`GET`, `POST` and `DELETE /developer-keys` refuse a caller whose principal is an
`owk_` key (`auth.kind === 'api-key'`) with `403 forbidden`
(`details.code: key_cannot_manage_keys`). Keys are managed by a signed-in person
(cookie session or OIDC bearer) or by the operator's own env credential.

> **Correction, same PR (adversarial review).** The first draft refused only
> `POST` and said "a key sees and revokes only what it issued, which after D1 is
> nothing". That was false on production. `keyScopeOf` resolves the key's own
> subject (`apikey:<id>`) through `resolveEffectiveAccess`, and in demo mode an
> unknown subject on a single-principal tenant is OWNER
> (`accessControlService.ts`, the LEAK-9 fallback). Production runs
> `OPENWOP_DEMO_MODE=true`. MEASURED with the refusal removed: a `workspace:read`
> key in a `user:` workspace listed every key and revoked the owner's. The
> control test had passed only because its tenant was not single-principal and
> demo mode was off — the test now runs in the production posture.

Alternatives weighed:

- *Allow minting, but require the new key's scopes to be a subset of the
  caller's and stamp `createdBy` as the original issuer.* Keeps `openwop
  developer-keys create` working with a key. Rejected for now: "subset" needs a
  defined answer for a caller that declares nothing and for the scopes only the
  MCP lane reads (`workspace:*`), and a wrong answer there is another
  escalation. Nothing in the product needs key-minted keys today. This can be
  added later as a narrowing of a refusal, which is the safe direction.
- *Leave it and rely on enforcement being switched on.* Rejected: the
  deployment that matters runs with enforcement off and demo mode on, and "safe
  once another flag flips" is not a property of this route.
- *Force `isAdmin: false` for a key instead of refusing list/revoke.* Rejected:
  it leaves a key able to see and revoke "its own" keys, a set that is empty
  once it cannot mint. A 403 says what is true.

Consequence, accepted: `openwop developer-keys list|create|revoke` answer `403`
when the CLI is authenticated with an `owk_` key. They still work with an
operator env key.

Not covered, by design: `routes/credentialLaneSeams.ts` (registered only under
`OPENWOP_TEST_SEAM_ENABLED=true`, off in production) mints an un-narrowed key
for whoever calls it, including a key. It is a conformance seam, not a product
route.

### D2 — an "API keys" tab in the Access Hub

`/access/api-keys` (tab id `api-keys`, group Credentials, tier `workspace` for
the same reason as the MCP tab: a member mints their own key). It lists every
key the caller may see, creates one, and revokes one.

- **Presets declare what the server enforces.** `run` = `runs:create`,
  `runs:read`, `runs:cancel`, `artifacts:read`, `approvals:respond`; `read` =
  `runs:read`, `artifacts:read`; `full` = every scope in `SCOPES_SUPPORTED`. The
  scope ids are shown under each option. There is deliberately no "unrestricted"
  option: a key that declares nothing carries its issuer's whole authority.
- **The key is shown once, as itself**, with a copy button, followed by the two
  lines the CLI reads (`OPENWOP_BASE_URL`, `OPENWOP_API_KEY`). The base URL is
  made absolute, because the SPA's own base is the same-origin path `/api`.
- **The list is honest about what each key is.** A key that declares nothing is
  chipped "Unrestricted" with a note; a key the MCP tab minted is chipped "AI
  client"; an admin sees colleagues' keys marked as someone else's. Keys the D1
  hole may already have produced are visible to a workspace admin here.
- **One client.** `features/apikeys/apiKeysClient.ts` owns the developer-key calls; the
  MCP client now delegates to it and keeps only its naming convention and
  presets.

Alternatives weighed:

- *Show the bare token on the MCP tab beside the config snippet.* Rejected: the
  scopes are the defect, not the presentation, and that tab disappears when the
  MCP mount is off.
- *Add `runs:read` to the MCP "Read & act" preset.* Rejected as the fix: it
  would widen every AI client's key to serve a different audience. The MCP
  presets are unchanged.
- *A CLI login (device flow).* The right long-term answer for a CLI, and not
  attempted here: it needs a token-exchange endpoint and a decision about token
  lifetime. A key copied from the app is the conventional interim.

## Risks

| Risk | Mitigation |
|---|---|
| A preset names a scope no route gates, or `full` drifts from `SCOPES_SUPPORTED` | `api-keys-preset-parity.test.ts` parses the SPA constant and pins it to the backend list, and proves each preset over HTTP |
| Keys minted, or revoked, through the D1 hole on production | Not enumerated here (no production data access from this change). They are listed on the new tab to a workspace admin, marked "Unrestricted" and "Someone else's"; revoke from there |
| Two tabs both called "keys" (`Keys` is provider/BYOK) | The new tab is labelled "API keys"; the help text says what it is for |

## Implementation record

| Phase | What | Witness |
|---|---|---|
| D1 | `refuseKeyPrincipal` on all three routes in `features/developer-keys/routes.ts` | `test/developer-keys-key-cannot-mint.test.ts` (6, in the production posture: enforcement off, demo mode on; with the calls removed 5 fail, the operator-key control stays green) |
| D2 | `features/apikeys/` (page, client, four locales), route + hub labels, MCP client delegates | `apikeys/__tests__/ApiKeysPage.test.tsx` (15), `test/api-keys-preset-parity.test.ts` (7), `e2e/api-keys.spec.ts` (a key made in the page starts and reads a run with no cookie; control: the MCP scopes cannot) |
| — | Preset option text left the mono-uppercase caption register (both tabs) | visual check, light and dark |

## Open questions

- [ ] CLI device login, so no key is copied by hand.
- [ ] Key-minted keys under a subset rule, if a real use appears (D1 alternative).
- [ ] **Vendor (`/host/openwop-app/*`) routes do not honour a key's declared
      scopes, and in demo mode a key's subject is OWNER of a personal
      workspace.** The protocol, extension-scope and MCP routes narrow; a few
      vendor routes check explicitly; the rest act on `apikey:<id>` with whatever
      that route grants. D1 closes the developer-key instance. The general case
      is unsurveyed and needs its own decision (resolve a key through its issuer
      and its declaration at one choke, as ADR 0601 did for MCP). Until then the
      tab's copy claims only what is enforced: it says a preset limits what the
      key may do with runs, artifacts and approvals.
- [ ] An expiry choice on the tab (the route already accepts `expiresAt`).
