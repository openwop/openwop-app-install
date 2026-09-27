# ADR 0753 — RFC 0199 adoption: the host as an OAuth client, and the `credential` interrupt

Status: Accepted — P1–P5 implemented (PR #4130); the `oauth` advert is operator-gated OFF by default and stays off in production until the open items below close

Implements OpenWOP **RFC 0199** (`../openwop/RFCS/0199-outbound-oauth-client-and-credential-interrupt.md`,
`Active`, wire shape landed in the vendored schemas at corpus `v2.38.0`) plus the owner's two
2026-09-26 clarifications (built-in MCP-reach providers are bound by §B; a reference-bound host
reads §C through the bound reference). This is host work on an already-shaped wire — no new RFC.
Its security half (§A.2 atomic single-use `state`, §A.3 same-user binding, §A.5 fail-closed
redirect base) already shipped in #4125 (`f270cfb61`, rev 00744).

**Why adopt at all.** RFC 0199's acceptance box needs a *production* OAuth-client witness
(`.pkce-s256`, `.state-single-use`, `.same-user-callback`, `.iss-validated`,
`.credential-interrupt`). MyndHyve does not mount seams; openwop-app is the only tier-1 candidate.
And the Connections OAuth flow is live on app.openwop.dev, so every §A rule is a real hardening
of a real grant, not a conformance exercise.

## Context — measured at `origin/main` `f270cfb61`

| RFC rule | Today | File |
|---|---|---|
| §A.1 PKCE S256, never `plain` | **have** | `features/connections/oauthFlow.ts:222–232` |
| §A.2 fresh 256-bit `state`, 10-min TTL, provider-bound, single-use atomic | **have** (#4125) | `oauthFlow.ts:195,247` |
| §A.3 same-Subject callback | **have** (#4125) | `routes.ts:295–298` |
| §A.4 `iss` (RFC 9207) / distinct redirect URIs | redirect URIs are per-provider (`…/connections/<provider>/callback`) — so the issuer-less half holds; **`iss` is never read** | `oauthFlow.ts:146`, `routes.ts:266` |
| §A.5 fixed redirect URI | **have** (prod fails closed without a base, #4125) | `oauthFlow.ts:123` |
| §A.6 code/redirect/state/verifier off run-visible surfaces | **have** | — |
| Refusal is observable | **every refused callback 302s to the SPA** — the suite requires `≥ 400` | `routes.ts:266ff` |
| §B `resource`, PRM verify-not-select, pinning | **missing**; pack loader drops `auth.issuer` / `auth.pkce` | `connectionPackLoader.ts:68–171` |
| §C `credential` interrupt | **missing**; `credential` is absent from 6 host-side kind enums and `mapSuspendKind` silently rewrites unknown kinds to `external-event`; refresh failure flips `needs-reconsent` and emits no `connector.auth-expired` | `executor/suspendSignal.ts:19–24`, `connectionsService.ts:518–566` |
| §D.1 A2A `auth-required` | projection is status-only, never emits it | `host/a2aTaskStore.ts:157` |
| §D.2 MCP form-mode guard | **missing** — `requestedSchema` is passed through verbatim, nested or `format: password` included. **This binds every host with an MCP mount (RFC §C6), advertiser or not — it is a live obligation today.** | `host/mcpCurrentCodec.ts:353–389` |
| Errors | `connector_auth_declined`, `connection_auth_metadata_mismatch`, `connector_auth_expired` absent from `OpenwopErrorCode` (the v2 mapper already registers them from the vendored envelope schema) | `types.ts:654` |
| Advert | neither v1 `capabilities.oauth` nor v2 `oauth` is advertised | `routes/discovery.ts:790,1532` |
| Seams | `authorize-start`, `expire-refresh` declared `served:false`; no `auth/credential/mint` | `routes/conformanceSeams.ts:105–106` |

**A live-provider finding (2026-09-26, public reads).** Google is the only built-in provider with
an MCP reach (`calendarmcp.googleapis.com/mcp/v1`). Its PRM names
`authorization_servers: ["https://accounts.google.com/"]` (trailing slash); its AS metadata
names `issuer: "https://accounts.google.com"` (none), `code_challenge_methods_supported:
["plain","S256"]`, `authorization_response_iss_parameter_supported: true`. §B.3(c) and §B.3(d)
both compare by identity, so **no configured issuer passes both, and a literal implementation
refuses every Google grant**. **Owner ruling (openwop-77, 2026-09-26):** §B.3(c) compares after
exactly ONE normalization — an `https` issuer with an empty path equals the same issuer with path
`/` (RFC 3986 §6.2.3); nothing else (host case, port, other paths, query, fragment) is normalized.
§B.3(d) and the RFC 9207 `iss` check stay exact against the CONFIGURED issuer. So Google is
configured as `https://accounts.google.com` (no slash) and pinned in that form. §B.1 `resource`
gets **no** exemption: if Google rejects it (`invalid_target`), Google is recorded here as a
provider non-conformance, not carved out. Still *unverified*: whether Google accepts `resource`.

## Decision

| # | Decision | RFC |
|---|---|---|
| D1 | **Refusals are 4xx, the UX is unchanged.** A refused callback answers `400` (`403` for `subject_mismatch`) with a `no-store` HTML page that meta-refreshes to the same `returnTo?connectError=…&reason=…` the 302 used to target. Success stays `302`, and so does a *provider-reported* `?error=` (the user refusing at the provider is not a host refusal). The page reuses the 302 path's same-origin `returnTo` validator, HTML-escapes it as an attribute, never renders `reason`, and sends `Content-Security-Policy: default-src 'none'`. One response shape for browsers and the suite — no content negotiation, so the suite measures the path users take. | §A.2–§A.4 observability |
| D2 | **`iss` validation before any token request.** `ProviderManifest` gains `issuer?` and `issResponseParameter?`. On the callback, for the provider bound to `state`: an `iss` that differs from `issuer` (simple string comparison) is refused; a missing `iss` is refused when `issResponseParameter` is true. Google-family providers (`google`, `gmail`, `bigquery`, `bigquery-write`) get `issuer: https://accounts.google.com`, `issResponseParameter: true` (measured above). Providers without a stable issuer (Microsoft `common`, Slack, Zoom, Dropbox, Box, Workday) stay issuer-less; their per-provider redirect URI is the RFC 9700 §4.4.2.2 defense. | §A.4 |
| D3 | **Pack providers carry `issuer` / `pkce`.** `connectionPackLoader` reads `provider.auth.issuer` and `provider.auth.pkce`. `pkce: "unsupported"` is honoured (no PKCE sent) and advertised on that provider's `providers[]` member. | §A.1, §E.2 |
| D4 | **§B verify-not-select, one module.** New `features/connections/mcpReachVerifier.ts`: canonical resource URI; PRM fetched only from the RFC 9728 §3 well-known URIs (or a same-origin `resource_metadata` challenge) through `guardedEgressFetch`; checks (b)–(e), with (c)'s single empty-path≡`/` equivalence (owner ruling) and (d) exact; refusal = `422 connection_auth_metadata_mismatch` **before** an authorization URL exists. `resource` is sent on the authorize and token requests. Endpoints used are always the manifest's — discovery can only refuse. | §B.1–§B.3 |
| D5 | **Pinning.** The verified `(resource, issuer, authorize, token)` tuple is recorded in a `DurableCollection` keyed by provider id + canonical resource, first-writer-wins (CAS on create). §B.3 runs at registration (pack load / host boot for built-ins); if it could not complete there (network), the grant runs it and pins — a grant never proceeds without a pinned tuple, and a later disagreement is refused, never adopted. | §B.4 |
| D6 | **Scope of §B.** Applies to pack providers with `reach.mcp` + `oauth2`, and to the seam's synthetic MCP-reach provider. **Built-in Google is held on today's path until `resource` acceptance is verified on a live grant** (the trailing-slash conflict is ruled; configure `https://accounts.google.com`) — and `oauth` is not advertised (D11) while any built-in MCP-reach provider is outside §B. An issuer-less or `pkce:"unsupported"` MCP-reach provider is refused its grant. | §B, §E.2, ruling (2) |
| D7 | **MCP form-mode guard (every host).** `mcpCurrentCodec` emits `mode:"form"` only for a flat object of primitive properties with no `writeOnly: true` / `format: "password"`. The `credential` branch runs BEFORE the existing no-`elicitation`-capability `-32021` refusal (`mcpCurrentCodec.ts:308`). A `credential` interrupt is answered in URL mode (`url` = `connectUrl`) iff the request's `_meta["io.modelcontextprotocol/clientCapabilities"].elicitation.url` is declared, else `CallToolResult { isError: true }` naming the provider — never a form fallback. A non-flat/sensitive non-credential interrupt is answered with `isError` (§D.2(b)'s branch — the SPA run page does not enforce same-Subject resolution, so it cannot be §D.2(d)'s URL target). An `accept` retry for URL mode re-checks and re-answers `input_required` with the same URL if nothing resolved. Client-side (§D.3): a remote URL-mode elicitation resolves with no `content`. | §D.2, §D.3, §C.6 |
| D8 | **The `credential` kind end to end.** Added to every host-side kind enum (`SuspendKind`, `mapSuspendKind`, `packIsolationDispatch.SUSPEND_KINDS`, `bootstrap/nodes.ts` `VALID_KINDS`, `A2aInterruptKind`, discovery `kinds`). A node whose config declares `auth: { type: "oauth2", provider, scopes }` is checked on EVERY invocation, **recorded resolution first** (the interrupt key is the node id): a seeded `declined` fails the node `connector_auth_declined`; a seeded `authorized` re-resolves and, if still missing, fails `connector_auth_expired` — never a second suspend on the same key; only with no seeded resolution does the live check run. The check calls the SAME credential resolver the node's token fetch uses (one helper in `connectionsService.ts`), never a parallel lookup. With no seeded resolution: no credential for the **run owner's** Subject/provider/scopes ⇒ suspend `credential` with `reason: missing` / `insufficient_scope`; a terminal refresh failure ⇒ emit `connector.auth-expired` first, then suspend with `reason: expired`. `resumeSchema` is the fixed closed `{outcome}` schema. | §C.2, §C.3 |
| D9 | **`connectUrl` and resolution.** `connectUrl` = `<public origin>/v1/host/openwop-app/connections/connect/<runId>/<nodeId>` — deterministic, no store; neither id is a secret and nothing in it resolves the interrupt. GET requires an authenticated user equal to the run's recorded owner Subject (read verbatim, never re-resolved — fork-safe) and an OPEN `credential` interrupt at that key (else 401/403/404, no authorization URL), then 302s to the **production** authorization-URL builder. The pending-auth record carries `{runId, interruptKey}`, so the target rides the single-use `state`. When that grant's callback completes, the host resolves the interrupt itself through the ordinary resolve path; losing the concurrent-resolve race (`409`) still stores the credential and succeeds the redirect with `{outcome:"authorized"}`. A caller's `authorized` is re-checked (400 `validation_error`, `details.field:"resumeValue"` while nothing resolves); `declined` fails the node `connector_auth_declined`. | §C.3, §C.4 |
| D10 | **A2A.** A `waiting-input` run whose open interrupt is `credential` projects to `auth-required`, `interruptKind: "credential"`, status message naming the provider and carrying `connectUrl`. | §D.1 |
| D11 | **Advertisement last, and only when honest.** v2 `oauth` `{ grants:["authorization_code"], providers[], credentialInterrupt: true }` + v1 `capabilities.oauth`. `providers[]` lists only providers the host can actually run a grant for (client id configured). The synthetic suite providers (`synthetic`, `synthetic-noiss`, `synthetic-noiss-b`) appear only while seams are mounted. Not advertised until D1–D10 land **and** D6's Google hold is resolved. | §E.1 |
| D12 | **Seams (conformance only, `OPENWOP_TEST_SEAM_ENABLED`).** Synthetic providers live in a seam-only overlay of the PRODUCTION `getProvider` (so the real callback, `iss` check and token exchange resolve them — R9 extended to the callback). `oauth/authorize-start` calls the production `beginAuthorization` (RFC R9 — the seam must not build its own URL) for a request-scoped synthetic provider, or registers the body's `connection` pack through the production pack path first; `oauth/expire-refresh` marks the caller's credential expired; `auth/credential/mint` mints a second-Subject `owk_` key. Fixture `conformance-credential` (node `conformance.oauth.use`) is registered only with seams. | seams-v2 |
| D13 | **Errors.** `connector_auth_declined` (401), `connection_auth_metadata_mismatch` (422), `connector_auth_expired` join `OpenwopErrorCode` and the exhaustive mappers. | §E.5 |

**Out of scope, recorded.** The product's interactive `openwop-connection` prompt
(`host/connectionInterrupt.ts`, a `clarification`) is not migrated to `credential`: §C.2 binds
nodes that *declare* `auth`, product nodes bind by `connectorId`/capability, and ruling (4)
explicitly adds no obligation. Migrating it (plus a frontend `credential` card) is a follow-up
worth doing once D8 exists. Device-code and incremental scopes stay RFC-unresolved.

## Alternatives weighed

- **Content-negotiate the callback** (JSON 4xx for non-HTML, 302 for browsers) — rejected: the
  suite would measure a branch real users never take.
- **Let discovery fill in endpoints for built-ins** — rejected by the RFC (verify, never select).
- **Exempt Google from §B and advertise anyway** — rejected: advertising `oauth` binds §B; an
  exemption is a dishonest wire claim. Holding the advert is the honest cost.
- **Build a second "credential" UI** — rejected (CLAUDE.md "one chat"); follow-up rides the existing
  HITL interrupt cards.

**Frontend.** `useOAuthCallback.ts` `OAUTH_ERROR_KEY` gains `subject_mismatch` (live since #4125) and `iss_mismatch`, 4-locale parity.

**/architect review (2026-09-26)** — proceed; four blockers folded in above (seeded-resolution-first ordering; one credential resolver; `credential` before the `-32021` gate; escaped/CSP'd refusal page), plus deterministic `connectUrl`, pin key incl. resource, 409-tolerant auto-resolve, `isError` for non-flat, seam overlay on the production registry. No duplicate of an existing outbound discovery fetcher exists (all PRM code is inbound).

## Phases

| Phase | Content | Gate |
|---|---|---|
| P1 | D1, D2, D3, D13 | route tests (createApp) incl. wrong/missing `iss` → zero token requests |
| P2 | D7 (binds today — may land first or in parallel) | codec tests + sabotage |
| P3 | D4, D5, D6 (packs + synthetic) | fake PRM/AS tests; pin CAS race test |
| P4 | D8, D9, D10 | executor + route tests; replay/fork of a resolved `credential` interrupt |
| P5 | D11, D12, then the witness cut (seams-on companion from the production image) | installed-suite `v2-oauth-*` + `v2-credential-interrupt` green locally; Google `resource` verified |

## Open questions

- [x] Owner ruling: §B.3(c) vs Google's trailing-slash `authorization_servers` — ruled 2026-09-26 (single empty-path equivalence; see Context).
- [ ] Does Google accept `resource` on authorize + token? Verify with a real grant before D6 lifts.
- [ ] Witness: a seams-on colocated companion trips the RFC 0170 revocation-seam gap (recorded
      under the colocated-companion recipe); resolve before P5's cut.

## Implementation record

| Phase | Commit | Tests (sabotage that turns them red) |
|---|---|---|
| ADR | `6a6ef3974` | — |
| P1 §A.4 `iss`, 4xx refusals, pack issuer/pkce | `448e3716f` | `oauth-callback-security`, `connections-feature` (iss check off → 4 red; refusals as 302 → 8 red) |
| P2 §D.2 form-mode guard | `b8f725de7` | `mcp-current-codec` (guard off → 3 red) |
| P3 §B verify-not-select, `resource`, pinning | `68867b49b` | `oauth-mcp-reach` (any issuer listed → 4 red; no `resource` → 1 red) |
| P4 §C credential interrupt, §D.1 A2A | `f13ecd0ec` | `credential-interrupt` (decline-first off → 2; re-check off → 4; owner check off → 1) |
| P5 advertisement + seams | `e377b6bce`, `eb2575a9d` | `oauth-advertisement-seams` (held-provider condition off → 1 red) |

**Corrections found while building** (the reasoning trail, per this repo's ADR rule):

- **This host never emitted `interrupt.requested`.** It records `node.suspended` +
  `interrupt.resolved`. D8 therefore writes `interrupt.requested` for the
  `credential` kind ONLY, as the closed `{kind, key, data, resumeSchema}` the v2
  schema requires (engine `__resume*` keys and the gate-preview artifact kept off
  it). Emitting it for every kind is a separate, wider gap — not taken here, because
  existing kinds' stored `data` is not schema-closed.
- **`interrupt.resolved` carries `resumeValue` for `credential` only** (`{outcome}`,
  closed, no secret); other kinds keep today's payload.
- **Seam routes must be registered AFTER the `/v1/host/sample` rewrite** — a route
  registered earlier is matched against the un-rewritten url and never fires
  (caught by the P5 test, 404).
- **The mint seam (`auth/credential/mint`) is not built.** The suite falls back to
  `OPENWOP_TEST_TENANT_B_API_KEY` for its second Subject, which the colocated
  companion recipe already sets.
- **New paths ride the vendor root** (`vendorTwin`, ADR 0652); `connectUrl` names the
  canonical `/host/openwop-app/…` address (v1-reliance ratchet, ADR 0642).
- **The §B.4 pin store is host-global** (`connections:mcp-reach-pin`), classified
  EXEMPT in the erasure ratchet: public endpoint URLs, identical for every tenant.

**Open before `oauth` is advertised in production** (each is a real gate, not scope):

- [ ] Google `resource` acceptance on a live grant (D6). Until then Google stays held
      and, because it is grantable in production, `oauthAdvertised()` is false there.
- [ ] Google `iss` presence confirmed on a live grant — P1 refuses a missing `iss`
      for Google because its metadata promises one; a post-deploy Google connect is
      the smoke test (a refusal logs `oauth callback issuer mismatch`).
- [ ] Witness cut: the three `v2-oauth-*`/`v2-credential-interrupt` scenarios against
      a seams-on colocated companion of the production image (RFC 0216 route), each
      a separate go from the maintainer.
- [ ] Frontend: `OAUTH_ERROR_KEY` gains `subject_mismatch` / `iss_mismatch` (4 locales).

