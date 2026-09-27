# ADR 0244 — Broker-resolved image-generation credentials

|            |                                                                    |
| ---------- | ------------------------------------------------------------------ |
| **Status** | implemented (2026-07-04) — the ADR 0229 §Deferred "broker-resolved image credentials" follow-on |
| **Deciders** | openwop-app maintainers |
| **Relates** | ADR 0229 (creative assets — recorded this follow-on), ADR 0115 (image-generation seam), RFC 0095 (connection packs), ADR 0024 (Connections broker / egress firewall) |

## Context

ADR 0115's image seam resolves BOTH the endpoint and the api_key from ENV
(`OPENWOP_IMAGE_PROVIDER_ENDPOINT[_PROVIDER]` + `OPENWOP_IMAGE_PROVIDER_KEY[_PROVIDER]`).
ADR 0229 shipped the `openai-images` / `google-imagen` connection packs that
declare the `api_key` *shape* but noted, honestly, that "the host image seam is
env-configured … it does NOT resolve credentials through the Connections broker.
Broker resolution … is a recorded follow-on." That means the sensitive, rotatable,
per-operator **secret** lives in a host-wide env var instead of a per-tenant
KMS-enveloped Connection.

## Decision

**Resolve the api_key (the credential) through the Connections broker; keep the
endpoint env-configured.** The credential IS the key (the packs declare
`auth.kind: api_key`); the endpoint is non-secret host infra config. This fully
satisfies "broker-resolved credentials" and sidesteps the pack's missing endpoint
path (it declares only `apiHosts` host).

- **In `host/imageProviderAdapter.ts` `dispatchImageGeneration`** (a `host/`
  module that, like `host/smtpSend.ts`, may import `features/connections`): when a
  `tenantId` is supplied, resolve `resolveConnectionCredential({tenantId, provider:
  connectionProviderIdFor(provider)})` (`openai`→`openai-images`, `google`→
  `google-imagen`, explicit map — an unknown provider skips the broker). The
  resolved `secret` (KMS-enveloped at rest) is used as the `Authorization: Bearer`
  key; a resolved Connection **beats** the env `imageApiKey(provider)`. No key is
  logged (the §D endpoint-non-disclosure already scrubs errors; the key only rides
  the auth header). `callImageGenerator` threads `scope.tenantId` in.
- **Precedence:** broker Connection > env key. An installed per-tenant Connection
  is explicit, granular, rotatable operator intent; the host-wide env key is the
  bootstrap fallback. Env-wins would make the Connection inert — self-defeating.
- **Scope:** the resolution is TENANT-scoped (the image scope carries no acting
  user), so only a **workspace-scoped** Connection self-authorizes; a user-scoped
  Connection is not selected without an acting user, and an org-scoped one is
  withheld by the D2 confused-deputy guard (`actingUserHasOrgUse(…, undefined)`
  returns `false` — verified). Image gen therefore uses a workspace Connection,
  matching the per-tenant image budget.
- **Honest-off unchanged:** the endpoint still gates the whole path
  (`imageProviderConfigured` = enabled + endpoint). A tenant with a Connection but
  no host endpoint stays honest-off — the endpoint is required host infra. The two
  connection-pack descriptions are CORRECTED to state this (the key comes from the
  broker; the operator still configures the endpoint).

## Alternatives weighed

- **Broker-derive the endpoint too** — REJECTED: the pack declares only an
  `apiHosts` host (no path), and the app has no per-provider known endpoint path;
  making the pack's host load-bearing is out of scope. Endpoint stays env.
- **Route the image dispatch through `brokeredPost` (like ads)** — DEFERRED: a
  bigger rewrite of `dispatchImageGeneration`'s careful §D non-disclosure +
  allow-private + https-pin + timeout egress, for the marginal "key never returns
  to the adapter function" gain (the adapter is host-trusted; the env key already
  flows the same way).
- **Env-wins-over-broker** — REJECTED: makes a deliberately-installed Connection
  inert.

## Open items (deferred)

- **RFC 0079 connection-use provenance stamp** on a broker-resolved image call
  (`stampConnectionUse` needs `storage`, not readily threaded into the image seam)
  — the ads-adapter pattern; a follow-on. The broker's own resolution logging
  records the use meanwhile. **DONE — ADR 0253** (stamped on success via the public
  `hostExtStorage()` accessor — no AdapterScope surgery — dedup-by-connectionId).
- **`brokeredPost` egress unification** for the image dispatch. **DECLINED — ADR 0253**
  (a non-fit: brokeredPost is broker-only with no env fallback and applies the
  per-tenant ADR 0187 firewall to a HOST-configured endpoint; the seam's
  purpose-built SSRF guard is already appropriate. The provenance parity — the real
  value — is delivered by the stamp alone).
