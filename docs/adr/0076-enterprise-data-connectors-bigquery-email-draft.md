# ADR 0076 - Enterprise data connectors: BigQuery (read-only) + email-draft-to-mailbox

**Status:** Accepted (implemented 2026-06-19 — Phases 1–3; see Implementation corrections)
**Date:** 2026-06-19
**PRD:** the supplied product brief behind ADR 0078 — §System Context (BigQuery upstream), §User Flows ("Saves to Drafts folder"), §Functional Requirements ("output drafts in the principal's native mail client format"), §AuthZ (read-only service identity). Factored out of ADR 0078 because both connectors are **reusable platform work**, not specific to that suite.
**Depends on / composes:** ADR 0024 (Connections credential broker), ADR 0037 (connector framework — `host.connectors.invoke`, eTLD+1 pinning, provenance), ADR 0030 (MCP, the fallback reach), the connection-pack loader (`features/connections/connectionPackLoader.ts`), the integration node pack (`packs/core.openwop.integration`, `host/emailAdapter.ts`).
**Surface:** a new **BigQuery connection pack** + a new **`email.draft` node** in the core integration node pack. Both host-extension; no feature toggle of their own (they extend existing always-on surfaces, gated at the consuming feature/route).
**RFC gate:** **no new RFC.** Connection packs and node packs are non-normative host-extension (the same class as the six shipped packs: github/jira/microsoft365/notion/salesforce/workday). Provider credentials never touch the wire (opaque `credentialRef`, ADR 0024 §5).

## Why this exists

The Insights & Drafting Agent Suite (ADR 0078) needs to (a) read financials from **BigQuery** and (b) leave recognition emails as **drafts** in the principal's mailbox — never auto-send. The audit found:

- **BigQuery: MISSING.** Six connection packs ship (github, jira, microsoft365, notion, salesforce, **workday**); there is no BigQuery (or generic SQL/warehouse) pack. The loader + manifest pattern is ready (Workday is the template); only the manifest + a query reach are absent.
- **Email-draft: MISSING.** `core.openwop.integration.email-send` (`host/emailAdapter.ts`, SendGrid v3) **only sends**. There is no node that *creates a draft* in Outlook/Gmail. The microsoft365 pack exposes `mail.read`/`mail.send` Graph scopes but no draft-creation node.

Both are horizontal: a BigQuery connector serves any analytics feature; an email-draft node serves any "draft for human approval" flow. Building them here, reusably, avoids a suite-specific fork.

## Feature-refinement audit

| Concept | Existing owner (`file:line`) | Decision |
|---|---|---|
| Connection-pack loader + manifest schema | `features/connections/connectionPackLoader.ts` (RFC 0095 §B.6); `examples/connection-packs/workday/pack.json` | **Extend** — add a `bigquery` pack manifest; reuse the loader verbatim. |
| Read/write scope groups per provider | `features/connections/providerRegistry.ts` (`ScopeGroup`, read/write split) | **Reuse** — declare a BigQuery `read` scope group only (no write group). |
| Credentialed external HTTP call | `host/connectorInvoker.ts` (`host.connectors.invoke`, eTLD+1 pin, fail-closed, RFC 0079 provenance) (ADR 0037) | **Reuse** — BigQuery query + Graph/Gmail draft calls go through `connectorInvoker`. |
| MCP reach (alternative) | `host/mcpClient.ts` (`ctx.mcp.invokeTool`) (ADR 0030) | **Fallback** — if a deployer's warehouse is only reachable via an MCP server, `reach: "mcp"` is supported without new code. |
| Email send node | `core.openwop.integration.email-send`; `host/emailAdapter.ts` | **Sibling** — add `email.draft` alongside; do not modify send. |
| BYOK secret storage | `byok/secretResolver.ts` (AES-256-GCM, `connection:<id>`) | **Reuse** — both connectors store creds as `credentialRef`. |

**No collision.** BigQuery and email-draft do not exist anywhere; the integration pack and connection registry are the single owners we extend.

## Decision

1. **BigQuery (read-only) connection pack** (`core.openwop.connections.bigquery` or a deployer-supplied pack):
   - Provider manifest: OAuth2 (or service-account key via BYOK), `apiHosts: ['bigquery.googleapis.com']` (eTLD+1 pinned), a **read scope group only** (`bigquery.readonly`), no write group.
   - A `bigquery.query` node (in a `core.openwop.connections.bigquery.nodes` pack or the integration pack): takes a parameterized SQL string, calls the BigQuery REST `jobs.query` via `host.connectors.invoke`, returns rows + **records the exact SQL and result `asOf` in node-output provenance** (feeds ADR 0078 "Verify Source").
   - **Host-side read-only intent:** the manifest declares only read scopes; v1 enforcement is provider-side (Google enforces the OAuth scope). See Open Questions for an optional host-side write-deny gate.

2. **`email.draft` node** (in `core.openwop.integration`):
   - `ctx.email.draft({ to, subject, body, format })` creates a draft in the user's mailbox via the existing **microsoft365** Connection (Graph `POST /me/mailFolders/drafts/messages`) or a Gmail Connection (`POST /upload/gmail/v1/users/me/drafts`), selected by the bound provider. Returns a draft id + a deep link.
   - **Never sends.** Output is a draft handle for human review (the PRD's "always draft for approval"). The `emailAdapter` gains a `draft()` branch parallel to `send()`; send stays untouched.

**Data model:** none new — connectors are stateless; credentials live in the existing Connections store; drafts live in the provider's mailbox.

## Feature Evaluation Matrix (connector-scoped)

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Not a feature-package — **packs** (connection + node) extending always-on surfaces. No new `feature.ts`/toggle. |
| 4 | Node pack | `bigquery.query` + `email.draft`; signed via the registry pipeline; consumed by ADR 0078's `requiredPacks`. |
| 7 | Public surface | None. |
| 8 | RBAC + isolation | Calls act as `run.metadata.actingUserId` (confused-deputy guard, ADR 0024 §D2); org-shared connections require `connections:use`; fail-closed on missing connection (`connector_no_connection`). |
| 9 | Replay/fork | Query SQL + `asOf` stamped in node output → deterministic on `:fork`; credentials resolved at execute time, never persisted in the run doc. |

## Phased plan

1. **BigQuery connection pack + `bigquery.query` node** — manifest, read-scope group, query reach via `connectorInvoker`, provenance stamping. *Gate:* a connector test (allowlist pin + fail-closed + provenance), vitest.
2. **`email.draft` node** — `emailAdapter.draft()` for Graph + Gmail, returns draft handle. *Gate:* an adapter test asserting draft-create (not send) + no auto-send path.
3. **(Optional) host-side read-only gate** — a per-connection "deny write verbs" guard in `connectorInvoker` for connections flagged read-only (see Open Questions).

## Alternatives weighed

- **MCP-only data access** (PRD's MCP framing). Rejected as the default — a connection pack gives credential brokering, eTLD+1 pinning, scope declaration, and provenance for free; MCP remains the fallback `reach` for warehouses only reachable that way.
- **Extend `email-send` with a `draft: true` flag.** Rejected — overloads a send node with a non-send semantic; a distinct `email.draft` keeps "never auto-send" auditable and the allowlist clean.
- **Generic SQL connector instead of BigQuery-specific.** Considered; ship BigQuery first (the PRD's source), structure the node so a Snowflake/Postgres sibling is a manifest swap.

## Open questions

1. **Host-side write-deny enforcement** — should `connectorInvoker` reject write verbs for connections marked read-only, or trust provider-side OAuth scopes? Lean: add an optional host-side guard (defense-in-depth) for connections flagged `readOnly: true`.
2. **BigQuery auth** — OAuth2 (per-user consent) vs service-account key (BYOK) for an unattended scheduled run. A scheduled run has no interactive user; lean service-account-key via BYOK, acting under the feature's configured identity.
3. **Gmail vs Graph draft parity** — confirm both providers' draft APIs accept the same `{to,subject,body}` shape; normalize in the adapter.

## Implementation corrections (Phase 1 — architect review 2026-06-19)

The pre-implementation `/architect` pass found the connector framework more skeletal
than this ADR assumed; three corrections were applied (the design above stands; these
refine the "how"):

1. **Dedicated `bigquery` BUILTIN provider, not a pack.** A connection-pack manifest
   cannot carry `apiHosts` (`toProviderManifest` never sets it) and `registerProvider`
   **replaces** — so a pack-loaded provider fails closed at `brokeredFetch` (empty
   `apiHosts`), and a pack that overrides a builtin silently strips `apiHosts`. BigQuery
   therefore ships as a **dedicated builtin provider** (`providerRegistry.ts`, id
   `bigquery`, `apiHosts: ['bigquery.googleapis.com']`, read scope only) — override-immune,
   and a narrower read-only identity than the broad `google` provider. A pack-based path
   would need an `apiHosts` field on the (vendored, RFC 0095) manifest schema → an RFC.
2. **`ctx.connectors` had to be wired.** ADR 0037's `connectorInvoker` slot existed but
   was never on the node `ctx` (zero callers). Phase 1 adds `host/connectorsAdapter.ts`
   (`makeConnectorsAdapter`) + a `connectors?` field on `NodeContext`, built per-run in
   the executor like the email/slack adapters — making the framework usable for any
   future connector.
3. **`core.bigquery.query` is a host-native node** (`bootstrap/nodes.ts`), not a signed
   pack node, for Phase 1 (loads with no pack-install/sign step; can graduate later).
   Provenance = deterministic `{sql, projectId, jobId}` output fields (replay-safe via the
   invocation log); `dataAsOf` is stamped by the variance workflow from run-start (ADR
   0078), never a wall clock here.
4. **Auth scope (Phase 1):** OAuth2 user-consented (works with the existing bearer
   injection). Service-account-JWT for unattended runs (Open Q2) needs a JWT-sign→token
   mint that does not yet exist — deferred to the ADR 0078 scheduled-run work, flagged there.

### Phase 2 corrections (architect review 2026-06-19)

Decision §2's original framing (a `draft()` branch on `emailAdapter`) is **overturned** —
Phase 2 instead ships a host-native `core.email.draft` node over the already-wired
`ctx.connectors` (Phase 1), exactly mirroring `core.bigquery.query`. The `emailAdapter`
(`ctx.email.send`, SendGrid) is left untouched (send-only, orthogonal).

1. **Dedicated `microsoft-graph` builtin provider** (not the `microsoft365` pack — a pack
   carries no `apiHosts` and fails closed at `brokeredFetch`, same finding as Phase 1 §1).
   `apiHosts: ['graph.microsoft.com']`. The two coexist intentionally: `microsoft365`
   (broad pack identity) vs `microsoft-graph` (narrow, pinned connector identity) — same
   `bigquery`-vs-`google` rationale.
2. **Scope honesty:** the provider declares `Mail.ReadWrite` under `scopes.write` (creating
   a draft mutates the mailbox) — deliberately **never** `Mail.Send`.
3. **Never-send is structural, two ways:** the node constructs exactly one fixed URL literal
   (`POST /v1.0/me/messages`, which files to Drafts) — no code path to `/sendMail` or
   `…/send`; and the scope lacks `Mail.Send`. A test asserts the emitted URL never contains
   `send`.
4. **Gmail parity deferred (Open Q3):** Phase 2 is Graph-only. Gmail drafts
   (`POST /upload/gmail/v1/users/me/drafts`, base64url RFC822) are a sibling node/provider
   follow-up — not shipped here.

### Phase 3 corrections (architect review 2026-06-19) — Open Q1 resolved

Shipped a **defense-in-depth** host-side read-only gate (honestly scoped, not marketed as
the primary control):

1. **`ProviderManifest.readOnly?: boolean`** + `readOnly: true` on `bigquery` (not on
   `microsoft-graph`, which legitimately drafts). `connectorInvoker` fails closed
   (`connector_read_only`) on PUT/PATCH/DELETE for a readOnly provider, **before** the
   credential is touched. Method default mirrors `brokeredFetch` (absent ⇒ GET).
2. **Intentionally permissive to GET/POST** — BigQuery `jobs.query` is a read-via-POST, so
   the gate cannot catch a mutating POST. The **primary** control remains the manifest's
   missing write scope + provider-side enforcement; this gate catches obvious
   wiring/credential mistakes only. The code comments say so.
3. **Config invariant** `assertReadOnlyConsistent` — a readOnly provider MUST NOT declare a
   write scope group; asserted over `BUILTIN` at load + in a unit test. NOT thrown from
   `registerProvider` (the marketplace override hook stays permissive). Open Q1's "lean: add
   an optional host-side guard" is thus implemented.

## RFC verdict

**Host-extension — no new RFC.** Connection packs + node packs are non-normative; credentials stay off the wire (opaque `credentialRef`). No capability is advertised beyond what is wired and honored.
