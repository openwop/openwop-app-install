# ADR 0864 — Access hub summary: section counts, summary cards, reconnect banner

Status: implemented

Builds on ADR 0144 (the `/access` console) and its 2026-10-07 addendum (#4497, the
grouped side menu), which explicitly left three pieces of the Access redesign canvas
out: per-section counts in the side menu, the summary cards, and the "needs
attention" banner. #4497's stated reason: "they need data the hub doesn't fetch
today and would add reads to every page load."

## Context

The hub renders one section at a time. A section's data is fetched only by that
section's panel, so the page shell cannot say "Connections — 1 issue" without
loading every panel. Fetching each section's list from the shell would be N
requests per page load, each re-running its route's full authorization and read.

MEASURED on `44dac5b29` (route → read cost):

| Section | List route | Authority | Read |
|---|---|---|---|
| Keys | `GET /byok/secrets` | session tenant | indexed SQL |
| Connections | `GET /connections` | session tenant + `callerOwnerIds` | **full cross-tenant scan** (`store.list()`, no tenant index) |
| Voice | `GET /voice/realtime/capability` | `voice` toggle | point read |
| Endpoints | `GET /compat-endpoints?orgId=` | env gate + per-org `workspace:read` | prefix scan, per org |
| AI clients / API keys | `GET /developer-keys` | person, not an `owk_` key, `keyScopeOf` | tenant index |
| Organizations | `GET /orgs` | session tenant | tenant index |
| Capability firewall | `GET /capability-firewall/...` | `workspace:read` | point read |

No existing route returns counts for any of these.

## Decision

**D1 — one aggregated read: `GET /host/openwop-app/access/summary`.** A
host-extension route (non-normative, no RFC) owned by a new backend feature
package `features/access-hub/`. One request per hub load instead of N.

**D2 — each section is authorized by the SAME helper its list route uses.** The
route file that owns a section exports a request-level reader (for example
`listCallerConnections(req)`, `listVisibleApiKeys(req)`), and BOTH the list route
and the summary call it. The summary never re-derives authority. A section whose
reader refuses (401/403/404) or throws is **omitted** from the response; it is
never reported as zero. The SPA shows no count for an omitted section, so absence
is never presented as "none".

**D3 — counts, not rows.** The response carries counts plus the minimum needed
for the banner (the display name and provider of connections that need
reconnecting). No secret refs, key names, member identities or rule bodies.

**D4 — "needs reconnecting" uses the existing predicate.** `kind === 'oauth2' &&
(status === 'needs-reconsent' || status === 'expired')`, the predicate
`ConnectionsManager.tsx` and `connectionsService.ts` already use. Connections are
split by the panel's own axis (a `userId` row is Personal, everything else is
Workspace) so the banner and the counts match what the Connections panel shows in
each scope.

**D5 — endpoints are not summarized.** Their authority is per-org and the read is
env-gated; a tenant-wide count would either over-report (orgs the caller cannot
read) or need N org checks. The side menu shows no count for Endpoints.

> **Superseded by ADR 0866 D3 (2026-10-09).** The N org checks are the right cost,
> not a reason to skip: an org's endpoint list is already one tenant prefix scan,
> orgs per tenant are few, and the panel's own picker offers exactly those orgs. The
> count is now the sum over the orgs the caller can read, through GET's own check.

**D6 — the SPA.**
- `TabItem` gains an optional `meta` (and `metaTone: 'attention'`), rendered
  inside the tab after the label, so the tab's accessible name carries it
  ("Connections, 1 issue").
- The Workspace scope shows a `KeyFigureBand` of up to four cards (Model keys,
  Connections, AI clients, Members); each card selects its section. A card is
  shown only when both the section's tab is visible and its count is present.
- A warning `Notice` names the connection that needs reconnecting (or the count,
  when several), with a button that opens the Connections section. It is shown in
  whichever scope holds the broken connection.
- The summary is fetched once per hub load and again when the section changes, so
  counts catch up after an edit in a panel. A failed summary read hides counts,
  cards and banner; it never blocks the console.

## Alternatives weighed

- **N client fetches from the shell.** Rejected for #4497's reason: N requests
  and N authorizations per load, and each panel then fetches its list again.
- **Add a tenant index to the connections store now.** `DurableCollection`
  supports it with a one-shot backfill, but the backfill is sentinel-guarded:
  during a deploy the superseded revision keeps serving for up to an hour
  (WHD-28) without the index, and a connection it creates after the new
  revision's backfill gets no marker, so it would never appear in an indexed
  list. The summary keeps the existing full scan (the same read the Connections
  panel already does). The index is follow-up work: it needs a backfill that
  re-runs until no un-indexed writer can still be serving.
- **A per-section `?count=1` on each list route.** Seven route changes and still
  seven requests.

## Implementation plan

| Phase | What |
|---|---|
| P1 | Export the shared readers from the connections, developer-keys, BYOK, voice, orgs and firewall route modules; switch each list route to its reader (no behaviour change). |
| P2 | `features/access-hub/` backend feature: the summary route with per-section isolation (D2), route tests through `createApp` covering omission on refusal, the anonymous caller, and no secret material in the body. |
| P3 | SPA: `TabItem.meta`, the summary client, the cards and the banner, i18n in en/es/fr/pt-BR, unit tests, `DESIGN.md` note. |

## Implementation record

| Phase | Where | Witness |
|---|---|---|
| P1 | `listCallerConnections`, `listVisibleApiKeys`, `listCallerSecretRefs`, `readRealtimeProvider`, `listCallerOrgs`/`readOrgCounts`, `readFirewallPosture`; each list route now calls its reader | existing route suites for those modules (53 files green) |
| P2 | `backend/typescript/src/features/access-hub/` | `test/access-hub-summary-route.test.ts` (5 tests). Sabotage: dropping the `oauth2` clause from `needsReconnect` turns the connections leg red (2 ≠ 1). |
| P3 | `ui/Tabs.tsx` `meta`/`metaTone`, `features/access-hub/accessSummary.ts`, `AccessHubPage.tsx`, `KeyFigureItem.subTone:'attention'`, `DESIGN.md` §4.5 r18 + the `<Tabs>`/`<KeyFigureBand>` rows | `accessSummaryView.test.ts` (8), `tabsMeta.test.tsx`; rendered in Chromium against a local backend, light/dark/390px |

**Correction during P3:** the canvas tints the Connections card's NOTE amber,
not its total. `<KeyFigureBand>`'s `tone:'attention'` tints the numeral, which
would have marked "3 connections" as the at-risk figure when only one is. Added
`subTone:'attention'` for the line instead.

## Open questions

- [x] Connections tenant index with a deploy-safe backfill (see Alternatives) — ADR 0866 D1–D2.
- [x] Endpoint counts (D5) — ADR 0866 D3.
