# 0185 — Group the connector catalog by commercial vendor

Status: implemented

## Context

A company adopting OpenWOP thinks in terms of the **vendors it does business with** —
"we're a Microsoft 365 shop", "we run on Google Workspace", "HR is Workday". But the
Connections catalog (`/connections`) presented providers as one flat alphabetical list
of Connect buttons + a flat secret-credential `<select>`. Nothing told a Google shop
that Google Workspace, Gmail, and BigQuery are all *their* vendor, or grouped Outlook/
Graph under "Microsoft 365". Picking the right connectors meant scanning per-provider
labels and knowing which brand owns which surface.

This matters more now, not less: after the params→run-inputs + **capability-typed
connector** redesign (ADR 0163 line of work; the `capability:<category>` binding), a
workflow no longer hard-codes a provider — it binds "the user's email-calendar
connection". So the **vendor choice moved entirely to the connection layer**: connect
your vendor's surfaces once, and provider-agnostic workflows bind to whatever's
connected. The catalog is exactly where a vendor-first mental model pays off.

The request ("group packs on `packs.openwop.dev` by Microsoft 365 / Google / Workday …
so companies pick by the vendors they use") names the public registry, but the same
model has to exist in the host that *consumes* those packs — otherwise the app's own
catalog stays flat while the registry groups.

## Decision

Add **`vendor`** as a presentational, host-only grouping dimension on the connector
catalog — a direct parallel to the existing capability **`category`** field, and
governed by the same rule: it is **not** the wire key. RFC 0095 `provider.id` still
resolves auth; `vendor` only decides how the catalog is *displayed*. No RFC.

- **`ProviderManifest.vendor?: string`** (`providerRegistry.ts`) — the commercial
  vendor/ecosystem ("Microsoft 365", "Google", "Workday", …).
- **`BUILTIN_VENDOR`** map applied to the built-ins, mirroring `BUILTIN_CATEGORY`:
  `google`/`gmail`/`bigquery` → "Google", `microsoft-graph` → "Microsoft 365",
  `workday` → "Workday", and one-connector vendors (Slack, Zoom, ServiceNow, SendGrid,
  Twilio, Expo, Dropbox, Box) under their own name.
- **Pack-delivered connectors** group under their own label for now. The normative
  RFC 0095 provider schema is `additionalProperties:false`, so a pack **cannot** carry
  a `vendor` field without an openwop RFC amendment — that is the follow-on (below),
  not host work. `connectionPackLoader` documents the deliberate omission.
- The `GET /providers` extension route already spreads `...manifest`, so `vendor`
  flows to the client with no route change.
- **Frontend** (`ConnectionsManager.tsx`): a pure `groupByVendor()` groups both the
  OAuth Connect cards (one `role="group"` section per vendor, alphabetical) and the
  secret-credential `<select>` (`<optgroup label={vendor}>`). A provider with no
  declared vendor falls back to its own label, so nothing is ever hidden.

### Why host-only, no RFC
`vendor` never crosses the run/event/auth wire — it is catalog chrome, exactly like
`category`. Other hosts ignore an unknown optional manifest field. Advertising it
would be a dishonest wire claim (CLAUDE.md RFC-gate), so it stays off the protocol
surface. The normative `auth.provider.id` remains the single resolution key
(RFC 0045/0047/0095).

## Alternatives weighed

- **Derive vendor from `provider.id` substrings** — rejected: unreliable
  (`bigquery` → Google isn't lexically obvious; `microsoft-graph` vs a future
  `microsoft365`). An explicit map is honest and auditable, like `BUILTIN_CATEGORY`.
- **A new normative `vendor` field on the RFC 0095 manifest** — rejected: it's
  presentational, not behavioral; putting it on the wire would trip the RFC-gate for
  no interop gain.
- **Reuse `category`** — rejected: orthogonal axes. `category` is *capability*
  (email-calendar, hr) for capability-typed binding; `vendor` is *who sells it*
  (Google, Microsoft). Google is one vendor spanning three categories.

## Consequences

- The catalog reads as a vendor picker: a Microsoft-365 or Google shop sees its
  surfaces grouped under one heading. Directly serves "pick connectors by the vendors
  you use."
- Additive + reversible: drop the map + `groupByVendor` and the catalog returns to a
  flat list. No stored data, no migration.
- **Follow-on (needs an openwop RFC):** to let *pack-delivered* connectors declare
  their vendor (and for the public registry `packs.openwop.dev` / `openwop-registry` to
  group connection-pack listings by it), RFC 0095's provider manifest needs an additive
  optional `vendor` field. That is a wire-schema change → a new/amended RFC in openwop,
  reaching Accepted before the host reads it. Until then vendor grouping is built-in-only
  (host map); pack providers group under their label. Workflow-chain packs stay
  vendor-neutral by design (capability-typed) — they are *not* grouped by vendor.

## Implementation

| Piece | File |
|---|---|
| `ProviderManifest.vendor` + `BUILTIN_VENDOR` | `backend/typescript/src/features/connections/providerRegistry.ts` |
| Documented pack-manifest omission (RFC-gate) | `backend/typescript/src/features/connections/connectionPackLoader.ts` |
| `Provider.vendor` client type | `frontend/react/src/features/connections/connectionsClient.ts` |
| `groupByVendor()` + grouped catalog UI | `frontend/react/src/features/connections/ConnectionsManager.tsx` |
