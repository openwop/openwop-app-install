# ADR 1035 — connector instance pin and org-bound connector writes

Status: Accepted (2026-11-03, lead decision: A+B, B first); P1 implemented (#5517), P2 implemented (PR 2)

Follows ADR 1022 (campaign-performance org truth) and its follow-ups (#5467, #5491),
which closed the same class of gap for ad campaigns. Composes ADR 0024 (the connection
broker), ADR 0076 (`ctx.connectors`), ADR 0186 (provider-agnostic capability nodes) and
ADR 0783 (connection data sources).

## Context

Three core connector nodes write records that live only in a vendor system:
`core.openwop.connectors.ticket-transition` (and `ticket-create`), `hris-action`
(`submit-time-off`) and `erp-action` (`post-bill`, `create-expense-report`, plus two
SuiteQL reads). Each builds its request URL from a **caller-chosen `baseUrl`** (node
config or inputs) and sends it through `ctx.connectors.invoke` → `brokeredFetch`.

`brokeredFetch` pins the destination to the provider's `apiHosts`, but those pins are
**eTLD+1 suffixes of multi-tenant SaaS domains**: `service-now.com`, `workday.com` /
`myworkday.com`, and in connection packs `netsuite.com`, `zendesk.com` and
`my.salesforce.com`. Every customer of those vendors has an instance under the same
suffix. So a run can send **this tenant's credential to any other customer's instance**
(`https://evil.service-now.com/...`), and the pin passes. That is a credential-exfil
path, not only a cross-org write. The `ctx.http.safeFetch` injection lane
(`connectionInjection.ts`) has the same shape: it attaches a bearer token to any URL
whose host matches an allow-listed provider's suffix.

The host has no record of who owns ticket X, worker Y or ERP document Z: those ids live
only in the vendor system. What the host *does* have is the connection's **data source**
(ADR 0783: `connection.dataSource.baseUrl`, validated against `apiHosts` at write time),
which names the one instance a connection belongs to.

**Measured in prod (2026-11-03, read-only, by the lead):** 0 connections for any
ticket/HRIS/ERP provider; 0 registered workflow definitions use the three nodes; 0 rows
in the ticket/HRIS/ERP receipt stores. Failing closed costs no real user.

## Decision

Two PRs, B first (security, all runs), then A.

### D1 (PR 1, B) — the instance pin, inside the credential broker

**Threat model (the inclusion rule).** A provider is *instance-scoped* when a third party
can run server code under the provider's API host suffix that reads inbound request
headers: ServiceNow Scripted REST, Salesforce Apex REST, NetSuite RESTlets, a Zendesk app,
a Workday tenant. Under such a suffix, "the host is the vendor's" does not mean "the
receiver is our customer's instance". Vendor-run single hosts (Google, Slack, Graph, Zoom,
Box, HubSpot) are out of scope: the receiver is the vendor itself.

**Classification.** Host-curated, never pack-declared (no RFC 0095 manifest field, so no
wire change, and no trust in a pack author to opt in):
- an `INSTANCE_SCOPED_SUFFIXES` set (`service-now.com`, `servicenowservices.com`,
  `workday.com`, `myworkday.com`, `netsuite.com`, `zendesk.com`, `my.salesforce.com`,
  `force.com`), matched in BOTH directions against each `apiHost` (an `apiHost` equal to
  or under a suffix, so a pack declaring `now.service-now.com` is caught);
- plus a sticky id set for the builtins (`servicenow`, `workday`), because a connection
  pack can override a builtin's manifest (`registerProvider`) with different `apiHosts`.
- A vendored-pack test asserts every shipped connection pack whose `apiHosts` touch the
  set is classified.

**Where.** ONE predicate (`host/connectorInstancePin.ts`), run INSIDE
`resolveConnectionCredential`, between connection selection and `liveSecretFor`. Every
caller passes a REQUIRED `egress` argument: `{ url }` for a caller-influenced URL, or
`{ fixedEndpoint: '<reason>' }` for a host-fixed one. So the pin runs before any secret is
read or OAuth-refreshed (a run spamming mismatched URLs cannot drive refreshes that flip a
healthy connection to `needs-reconsent`), and the classification of every call site is a
**type obligation**, not a hand-kept list. The `ctx.connectors.invoke` lane
(`brokeredFetch`), the fixed adapters (`brokeredPost`) and the `ctx.http.safeFetch`
injection lane (`connectionInjection`) all go through it.

**URL-aware selection.** Among the connections the caller may use (the existing user → org
→ workspace candidates, each still passing `connections:use`), an instance-scoped request
selects the one whose data-source origin matches the request origin; precedence only breaks
ties. Refusals:
- no authorized candidate has a data source → `connector_instance_unbound` (reads and writes
  alike; the message tells the operator to set the connection's data source);
- candidates have data sources, none matches → `connector_instance_mismatch`.
D2 narrows the candidate set (stamp org only) before this runs.

**Comparison rules.** `new URL(request).origin === new URL(base).origin` after the stored
base is re-validated against the CURRENT `apiHosts` (`validateDataSourceBaseUrl`, as
`dataIntegrationAdapter` does). The WHATWG parser lowercases, punycodes and drops `:443`;
userinfo is never part of an origin; a trailing dot, another port or `http:` mismatches and
fails closed. The broker dispatches the parsed `href`, so the check and the request cannot
parse the URL differently. Origin, not path: Workday shares hosts across tenants and puts
the tenant in the path, but its receiver is Workday itself with tenant-scoped tokens, so
the credential boundary that matters is the origin.

**Residual found by the /architect pass: the `credentialRefs` lane.** `prepareRunSecrets`
(`executor.ts`) resolved every `node.config.credentialRefs` / `configurable.credentialRefs`
entry with `resolveSecret`, and nothing refused the system-owned `connection:` namespace
(ADR 0779 D2 refused it only on the Keys and vault routes). A workflow could name
`connection:<id>` and receive a connection's raw secret in `ctx.secrets`, past
`connections:use` and past this pin. Witnessed and fixed SEPARATELY and first (#5515,
ADR 0779 correction note), because it is independent of this pin and more severe.

### D2 (PR 2, A) — org-bound connection selection for the connector write nodes

For the ticket/HRIS/ERP nodes' requests only: in a run whose host-written client stamp
names an org (ADR 0944 D2), connection selection uses **that org**, with no fall-through
to a user or workspace connection. Unstamped runs are unchanged. `ctx.connectors` is not
changed globally (BigQuery and other consumers are untouched); the global question is
filed. Detailed in PR 2.

> **CORRECTED 2026-11-03 (lead decision, before PR 2 opened) — host-side, keyed on the
> provider, not an opt-in flag.** The first build had the four nodes pass a
> `clientBound` flag. Any pack that left the flag off still wrote through the user's or
> the workspace's connection in a client-stamped run, so the guard protected only our
> own nodes: the "guard is a property of the caller" shape ADR 1022's adapter-seam
> follow-up (#5491) removed. As built: `connectorsAdapter` decides it. In a
> client-stamped run, for every **instance-scoped** provider (D1's classification: the
> curated suffixes plus the sticky builtin ids), selection is the stamp org's connection
> ONLY, still behind `connections:use`, with no fall-through, whatever the caller
> passes; an unreadable or two-client stamp → `connector_client_org_unreadable`.
> Capability resolution follows the same rule (the client's own instance-scoped
> providers first, then the non-instance-scoped ones as before). Non-instance-scoped
> providers (BigQuery, Google, Slack…) and unstamped runs are unchanged, so this is
> still not the global question (Q2). The nodes pass nothing.

## Alternatives weighed

- **Pin at each egress seam after selection (the first draft)** — rejected by the
  /architect pass: it resolves (and may refresh) the secret first, it refuses a request a
  different authorized connection could serve, and its call-site ratchet is a hand list.

- **Node-side baseUrl check** — leaves `ctx.connectors.invoke` and `safeFetch` open to
  packs (rejected; see D1).
- **A manifest flag (`instanceScoped: true`)** — a field on the RFC 0095 pack manifest is
  a wire change and needs an RFC; it also trusts the pack author to set it. The host-curated
  suffix set needs neither.
- **Require `dataSource` for every provider** — breaks every single-host API (Google,
  Slack, Graph), where the instance question does not exist.
- **Path containment (`isWithinBase`) instead of origin equality** — the node builders
  append fixed vendor paths (`/api/now/table/…`) that need not sit under the stored base
  path; the credential boundary is the origin. Origin equality is what the lead specified.

## Consequences

- An instance-scoped connection with no data source can no longer be used through the
  broker or safeFetch until an operator sets one (`/access?tab=connections`). 0 such
  connections exist in prod.
- `core.workday.query` (its `baseUrl` from config) and the shipped `insights-suite` chain
  that binds it answer `connector_instance_unbound` until the Workday connection has a data
  source. Capturing the data source when an instance-scoped connection is CREATED (the
  ServiceNow `api_key` setup is manual) keeps "unbound" from being every new user's first
  experience: in scope for PR 1 if small, else filed.
- Jira's connection pack declares no `apiHosts`, so the broker already refuses it
  (`connector_host_not_allowed`): ticket nodes on Jira are unreachable today. Filed.

## Open questions

- **Q0** A data source can be rewritten after the credential was minted, and survives a
  re-consent: a manager could point a credential minted for instance A at instance B. Should
  changing an instance-scoped connection's data source clear or re-require the secret?

- **Q1** Should the curated suffix set be extended to every built-in whose host is a
  shared SaaS suffix (e.g. `atlassian.net` once a Jira pack declares it)? Proposed: yes,
  as part of the pack's addition.
- **Q2** The global `ctx.connectors` org-selection question (D2's scope boundary).

## Phases

| Phase | Scope | PR |
|---|---|---|
| P1 | D1 instance pin at the three seams + ratchet + witnesses | PR 1 |
| P2 | D2 stamp-org connection selection for the connector write nodes | PR 2 |
| P3 | ad-metrics read ownership (ADR 1022 follow-up, after #5491) | PR 2 or 3 |

## Implementation record

| Phase | What | Witness |
|---|---|---|
| P1 | `host/connectorInstancePin.ts` (curated suffixes, sticky builtin ids, `pickInstanceBound`); `resolveConnectionCredential` takes a REQUIRED `egress` (overloads: `{fixedEndpoint}` → as before; `{url}` → URL-aware candidates, pin before `liveSecretFor`); `authorizedCandidates` (the single pick is `limit: 1`, same checks and denials); `brokeredFetch` and the safeFetch injection lane pass `{url}`; `brokeredPost` refuses an instance-scoped provider; `instance_refused` mapped in `connectorInvoker` and `knowledgeSourceFetch` | `adr1035-connector-instance-pin` (9 cases; five guards sabotage-witnessed) |
| P2 | D2, host-side: `connectorsAdapter` reads the run's client stamp (`runClientOrgOf`) for an instance-scoped provider and selects that org's connection ONLY (`orgOnly` through the invoker, the broker and `authorizedCandidates`, still behind `connections:use`); a two-client or unreadable stamp → `connector_client_org_unreadable`; capability resolution puts the client's own instance-scoped providers first; no caller flag | `adr1035-instance-connector-client-org` (5 cases, a pack-like node with no flag; three guards sabotage-witnessed) |

Filed, not in P1:
- **Data-source capture at connection creation** (`CIP-DS-FORM-1` in `docs/steward/TODO.md`) —
  needs the connect form (frontend, four locales) as well as the route, so it is over the
  ~150-line bar the lead set. Until it lands, an operator sets the data source on the connection after creating it.
- **Jira** — its connection pack declares no `apiHosts`, so the broker refuses it today
  (`connector_host_not_allowed`); when a pack declares `atlassian.net`, add the suffix (Q1).
- **Q0** (data source rewritten after the credential was minted) and **Q2** (global
  `ctx.connectors` org selection) stay open.
