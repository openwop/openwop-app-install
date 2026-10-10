# ADR 0806 — The addresses third parties hold survive the v1 cut

Status: Accepted (implemented — the host half. The operator half is a runbook
step that can only run before the cut, see § Operator steps. The read forward
waits on a corpus errata, see § Review fold-in, Governance)

Related: ADR 0669 (the cut switch, and its asset-address exception), ADR 0656
(canonical emitted links), ADR 0671 (SPA on the canonical root),
`docs/steward/V2-COMPLETION-PLAN.md` W3.

## Context

ADR 0669 makes v1 retirement one flag, `OPENWOP_V1_RETIRED=true`, which answers
every inbound `/v1/...` request `410`. Its 2026-09-30 addendum listed what the
rehearsal could not see. For addresses held outside the host it named two
things: OAuth callback URIs, and stored asset URLs (closed 2026-10-01 with a
`308` forward for asset reads).

MEASURED 2026-10-03 on `ed7d2cc44`, the class is much wider than those two.
`/v1/host/openwop-app/...` addresses that parties outside this host hold, and
that would all answer `410` on the day:

| Who holds it | Examples | How it calls |
|---|---|---|
| Search indexes, feed readers, recipients | public pages, `llms.txt`, sitemaps, podcast `feed.xml`, shared cards, form / booking / signing pages, email open, click and unsubscribe links in mail already sent | browser or crawler `GET` |
| Customers' own sites | the service-desk widget `embed.js` snippet, pasted before ADR 0671 with a `/v1` `src` | `GET`, then the script's own calls |
| Providers, via a console the operator filled in | Stripe billing + commerce webhooks, email-provider bounce webhooks, connection inbound events, app-builder sync, SAML ACS, OAuth callbacks | `POST` (OAuth: browser `GET`) |

Worse, `embed.js` derives its API base from `document.currentScript.src`.
After a forward, `src` still holds the original `/v1` URL. So even a forwarded
script would post every message to a retired address.

The spec decides what is allowed. `versioning.md` §5: "A `/v1/host/<org>/…`
twin MAY ride the overlap; it retires atomically with `/v1`." Serving the twin
in place after the cut is not available.

## Decision

1. **A read of a held address forwards `308` to its unversioned twin.**
   ADR 0669's asset rule generalised: `GET`/`HEAD` on
   `/v<N>/host/openwop-app/<rest>`, where the address is one outsiders hold,
   answers `308 Location: /host/openwop-app/<rest>` (query kept). Nothing is
   served at the `/v1` address, which is the same argument ADR 0669 made for
   assets.
   - **"Outsiders hold it" is DERIVED, not listed.** It is the auth layer's
     unauthenticated set (`isPublicPath`, `PUBLIC_PATH_PREFIXES`): an address
     that needs no session is, by construction, one a third party can call. An
     authenticated vendor address is called by our SPA and SDK clients, which
     already use the canonical root (`spaHostExtensionCallSites` 0). It is
     injected into `protocolVersionMiddleware({ heldByThirdParties })` because
     `middleware/auth.ts` imports the negotiator.
   - **No open redirect.** The target is anchored on the vendor root and must
     not start `//` (`retiredVendorTwinPath`), so `/v1//evil.example` and
     `/v1/host/openwop-app//evil.example` stay `410`.
2. **A write to a held address still answers `410`.** Webhook senders do not
   reliably follow redirects (Stripe treats any 3xx as a failed delivery), and
   forwarding a `POST` would make the twin effectively live. These are
   re-pointed by the operator before the cut (§ Operator steps). The host makes
   that possible and measurable:
   - **Hand out the unversioned address now**, everywhere the operator copies
     one from: the email bounce-webhook `ingestPath`, the connection
     `inboundIngestUrl`, and the unsubscribe and preferences form actions. A
     provider still configured with the twin keeps working until the cut.
   - **The OAuth `redirect_uri` moves WITH the cut**, derived from `v1Retired()`.
     It must equal what the provider console holds on both the authorize
     request and the token exchange, so it cannot move ahead of the operator.
     Providers accept several URIs, so the operator registers the unversioned
     one first, and the flip changes nothing a provider sees.
   - **Readiness is the existing `deprecated_major_request` log** (ADR 0669
     addendum). Any non-`GET` line whose `family` is a held address is a
     provider still calling the twin. Zero such lines over a representative
     window is the go signal.
3. **`embed.js` always talks to the unversioned root.** It normalises
   `/v<N>/host/` → `/host/` in the base it derives. The unversioned root is
   served on both sides of the cut, and CORS (mounted after the negotiator's
   rewrite) treats both spellings alike.
4. **In-app addresses the SPA fetches are unversioned** (`ui-plugin` entry
   paths, the in-memory presigned blob URL), the same move as ADR 0671.

### RFC 8058 one-click unsubscribe — no exception needed

Mail sent before ADR 0656 (2026-09-11) carries `/v1` unsubscribe URLs, and a
mailbox provider's one-click `POST` to one will answer `410` after the cut. We
considered serving it in place, but it is not needed. The cut cannot happen
before 2026-12-04, which is 84 days after the last such send. CAN-SPAM's
obligation is 30 days. The `GET` unsubscribe page still forwards (decision 1),
and its form now posts to the unversioned address (decision 2).

## Review fold-in (2026-10-03, independent adversarial review before merge)

An independent review probed the branch with raw-socket requests against a
retired app. It found one blocker and seven should-fix items, and all of them
are folded in here:

- **BLOCKER — the email-approval confirm form posted to `/v1`**
  (`routes/interrupts.ts`). The `GET` forwarded and rendered the page, but
  pressing Approve or Reject answered `410`, so no emailed approval could
  complete after the cut. It was the same class as the unsubscribe form,
  missed by the inventory. Now unversioned. A source ratchet fails on any
  `action="/v<N>/…"` in a server-rendered form.
- **The forward dropped the `/api` prefix.** Behind a proxy that forwards only
  `/api/**`, the Location left the backend. It now restores the prefix from
  `req.originalUrl` (`apiPathPrefixOf`). ADR 0669's asset forward had the same
  bug and shares the fix.
- **The `308` carried no CORS headers**, so a cross-origin `fetch` failed on
  the redirect itself. A forward to a request with an `Origin` now sets
  non-credentialed `Access-Control-Allow-Origin: *`; the response has no body
  and a Location the caller could derive. *Not covered:* a PREFLIGHTED call,
  because `OPTIONS` is not a read and still answers `410`. `embed.js` itself is
  unaffected (a `<script src>` load is no-cors, and the script now talks to the
  unversioned root).
- **OAuth flows in flight at the flip.** The callback is not on the public
  list, so its `/v1` `GET` answered `410`. Even when forwarded, the exchange
  would have recomputed a post-cut `redirect_uri` that no longer matched the
  authorize request (`invalid_grant`). Now the callback is a held address
  (`isOAuthCallbackTwin`), and the pending-auth record stores the
  `redirect_uri` it sent; the exchange replays that value.
- **Dot segments.** `/v1/host/openwop-app/public/../orgs` forwarded to a
  Location the browser resolved onto an authenticated path. Harmless (the
  target runs its own auth), but it falsified "authenticated addresses stay
  `410`". `.`/`..` segments (raw or `%2e`) are now refused.
- **Docs and the cleanup job.** `README.md` and `DEPLOY.md` still told new
  installs to register `/v1` addresses for SAML, OAuth and Stripe, and the
  Cloud Scheduler cleanup job targets `/v1/.../admin/cleanup`. The docs are
  re-pointed (for OAuth: register **both** URIs), and the job is in the
  operator table.
- **"Held" is the unauthenticated set, not every anonymous surface.** The
  service-desk widget API (`public-service-desk/:intakeKey/…`) is reached by
  an anonymous session rather than the bypass list, so it is not forwarded.
  Nothing in the app hands out its address (no snippet, no docs), so no third
  party holds a `/v1` copy we issued. This is recorded as a known limit rather
  than widening the auth bypass to cover it.
- **Governance.** RFC 0181's §A.5 row reads a violation as "the twin ANSWERS
  after retirement", and a `308` is an answer. ADR 0669 already took this
  reading for assets. A ruling is requested from the corpus steward (is a
  permanent redirect to the canonical address a conformant retired answer, by
  the §3 `$id` precedent?), and this ADR follows it. If the ruling is no, the
  forward narrows back to assets before the cut, and only the emitter and
  operator halves stay.

  > **Steward answer (`openwop-7b`, 2026-10-03, read against corpus
  > `6d57014f`):** it needs an errata first. No core doc names what a retired
  > `/v1` path answers (`410` is this host's choice, not a corpus rule), and the
  > RFC 0181 §A.5 row as written would read a `308` as a violation. The
  > `$id` precedent supports the analogy but is not authority. The steward
  > recommends it to the maintainer as **conformant in substance**: the
  > operation is no longer served, protocol `/v1/*` stays `410`, and atomicity
  > holds. The fix is one clarifying sentence in §5 ("MAY answer a GET or HEAD
  > … with 308 to the same `/host/<org>/…` path and no body; MUST NOT serve any
  > operation there"), with the RFC 0181 row reworded from "answers" to
  > "serves an operation". **The implementation was brought inside that
  > scope:** safe methods only, a same-path target, and NO BODY.
  > `res.redirect()` writes a text body, so the forward now sends a bare
  > status and Location, and the test asserts an empty body. **This is a
  > precondition of the cut** (V2 completion plan W8): the errata lands, or the
  > forward narrows to assets before `OPENWOP_V1_RETIRED=true`.
- **Nit — caching.** The forward sends `Cache-Control: no-cache`, so the
  `retired_twin_forward` count measures real use.

## Alternatives weighed

- **Keep serving `/v1/host/openwop-app/*` after the cut.** Zero breakage for
  anyone, but §5 says the twin retires atomically with `/v1`. Rejected as
  non-conformant.
- **A hand-kept allowlist of forwarded prefixes.** Narrower, but it drifts. A
  new public feature added without a list entry breaks on the day, silently.
  The unauthenticated set already exists and is maintained for a stronger
  reason (it is the auth bypass), so it cannot lag a new public route.
- **Forward writes too (`308` preserves method and body).** It works for
  browsers but not for webhook senders, and it would turn the twin back into a
  live surface. Rejected.

## Operator steps (before `OPENWOP_V1_RETIRED=true`)

For each provider, register or re-point to the **unversioned** address
(`https://<host>/host/openwop-app/...`):

| Provider surface | New address |
|---|---|
| Stripe (platform + Connect registrations) | `/host/openwop-app/billing/webhook` |
| Commerce payment webhook | `/host/openwop-app/commerce/webhook` |
| Email bounce/complaint webhook (SendGrid, Postmark) | `/host/openwop-app/public-email/events/<webhookId>` |
| Connection inbound events | the URL shown for the connection (`inboundIngestUrl`) |
| App-builder sync webhook | `/host/openwop-app/app-builder-sync/webhook/<webhookId>` |
| OAuth apps (Google, Slack, …) | **add** `/host/openwop-app/connections/<provider>/callback` beside the existing URI; remove the `/v1` one only after the cut |
| SAML IdP | set `OPENWOP_SAML_ACS_URL` to `/host/openwop-app/auth/saml/sso/acs` and re-import the SP metadata |
| Cloud Scheduler `cleanup` job (`DEPLOY.md` §cleanup) | `--uri=…/api/host/openwop-app/admin/cleanup` (`gcloud scheduler jobs update http …`) |

Then confirm no provider still calls the twin:

```
gcloud logging read 'resource.type="cloud_run_revision"
  AND resource.labels.service_name="openwop-app-backend"
  AND jsonPayload.msg="deprecated_major_request"
  AND jsonPayload.method!="GET"
  AND jsonPayload.family=~"^host/openwop-app/"' \
  --freshness=7d --project openwop-dev --format='value(jsonPayload.family,jsonPayload.method)' | sort | uniq -c
```

An empty result is the readiness signal for this class, but only if the same
query without the `method` filter returns rows, which proves the query can
see the log at all.

## Consequences

- ADR 0669's "the only `/v1` address that survives" (assets) becomes "every
  READ of an unauthenticated vendor address". A correction note there points
  here, and the rehearsal's "nothing else rides the exception" leg is updated
  in place.
- The forward is reads-only, so the twin is never a live write surface after
  the cut.
- After the cut, the forward is the one remaining `/v1` code path for vendor
  addresses. It can be removed once the log shows no forwarded reads for a
  window the operator chooses (V2 completion plan W9).

## Implementation record

| What | Where |
|---|---|
| `retiredVendorTwinPath`, `ProtocolVersionOptions.heldByThirdParties`, the read forward | `middleware/protocolVersion.ts` |
| injection of `isPublicPath` | `index.ts` |
| unversioned `ingestPath` + form actions | `features/email/routes.ts` |
| `inboundIngestUrl` unversioned; `redirectUri` derived from the cut | `features/connections/oauthFlow.ts` |
| `embed.js` base normalised | `features/chat-widget/publicGateway.ts` |
| email-approval confirm form unversioned | `routes/interrupts.ts` |
| forward keeps `/api`, sends CORS + `no-cache`, refuses dot segments | `middleware/protocolVersion.ts` |
| OAuth callback held; `redirect_uri` replayed from the pending record | `features/connections/oauthFlow.ts`, `features/connections/routes.ts`, `index.ts` |
| docs re-pointed | `README.md`, `DEPLOY.md` |
| plugin entry + presigned blob URLs | `features/ui-plugins/frontendPluginPacks.ts`, `host/inMemorySurfaces.ts` |
| tests (pre-cut control, forward, forward logged, writes 410, auth'd 410, open-redirect, `/api` prefix, CORS, dot segments over raw sockets, OAuth callback forward + replayed `redirect_uri`, the form-action ratchet, embed.js run from the served script) — seven sabotages red | `test/adr0806-third-party-addresses-survive-cut.test.ts` |
| the ADR 0669 asset-only assertion corrected | `test/adr0669-v1-retirement-rehearsal.test.ts` |

## Open questions

- [x] Should a forwarded read log `retired_twin_forward` (family + caller
  class), so the forward's own retirement in W9 has a measurement rather than
  a guess? **Yes, done:** one line per forward carrying the vendor family and
  the same coarse caller class as `deprecated_major_request` (now one shared
  `callerClass`), and nothing identifying. The test asserts a capability token
  in the path never reaches the log.

## Correction (2026-10-04): the OAuth `redirect_uri` does NOT move with the cut

Decision 2 said the OAuth `redirect_uri` "moves WITH the cut", so that operators register the unversioned URI before the flip. When v1 end-of-support was moved to 2026-10-04 (maintainer directive, RFC 0234), the 7-day log turned up production's own **Gmail** OAuth client calling the `/v1` callback. Its console holds the `/v1` URI, and a provider console is not something the host can edit. Switching at the cut would have broken Gmail connect on cut day.

The switch was never necessary. The `/v1` callback GET is forwarded (a bodiless `308`, conformant under the suite 2.45.11 `versioning.md` §5 errata), and the token exchange replays the URI the authorize request sent (§ Review fold-in). So staying on the registered twin works on both sides of the cut. The unversioned URI is now an operator opt-in, `OPENWOP_OAUTH_REDIRECT_UNVERSIONED=true`, for once every console holds it. The forward is then the one thing that has to survive until that opt-in, and it is test-pinned.

