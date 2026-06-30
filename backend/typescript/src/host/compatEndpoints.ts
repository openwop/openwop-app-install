/**
 * Compat (self-hosted / OpenAI-compatible) endpoint configuration —
 * RFC 0108 + ADR 0121 (reference-host side, tasks 7 + 9 + the dark advertise helper).
 *
 * A compat endpoint is a tenant-configured OpenAI-compatible server (Ollama /
 * vLLM / LM Studio / any `/v1/chat/completions` host): a base URL + an OPTIONAL
 * BYOK key (a `credentialRef`, resolved at dispatch via `resolveSecret`) +
 * DECLARED capabilities (the host cannot reliably probe a black-box endpoint —
 * RFC 0108 §B / Unresolved-Q2).
 *
 * Two host invariants live here:
 *   - **§D non-disclosure** — the `baseUrl` is host-only; it NEVER appears in the
 *     wire advertisement (this module derives an OPAQUE, non-URL provider-class
 *     id via {@link compatProviderId}) and never in events/errors (the dispatch
 *     scrub in `providers/dispatch.ts` handles the runtime half).
 *   - **§A.2 dark-by-default** — {@link advertisedSelfHostedProviders} returns
 *     `[]` when no endpoint is configured, mirroring the seam-gated
 *     `advertisedAuthProfiles()` in `routes/discovery.ts`. The discovery field is
 *     NOT wired here — it lands in a one-line follow-up once RFC 0108 is Accepted
 *     (ADR 0121 Phase 0 / the advertise/honor parity gate).
 *
 * NOTE: this module is intentionally not yet consumed by the live dispatch path
 * or the discovery advertisement — it is the host-internal contract the
 * (gated) advertisement + the conversation-exchange wiring will build on.
 */
import { DurableCollection } from './hostExtPersistence.js';
import { resolveSecret } from '../byok/secretResolver.js';

/** A tenant-configured compat endpoint. The `baseUrl` is host-only (§D). */
export interface CompatEndpoint {
  /** Opaque host-assigned id — the source of the §A.3 non-URL provider label.
   *  MUST NOT be URL-shaped (the store/route layer assigns an opaque slug/uuid). */
  id: string;
  tenantId: string;
  orgId: string;
  /** Human label for the picker only — NEVER used in the advertised wire id (§A.3). */
  label: string;
  /** Operator/tenant endpoint, e.g. `https://vllm.internal/v1`. Host-only (§D). */
  baseUrl: string;
  /** BYOK key reference (resolved via `resolveSecret`). Absent ⇒ no key
   *  (e.g. a default Ollama needs none). The raw key is never stored here. */
  credentialRef?: string;
  /** DECLARED capabilities (RFC 0108 §B) — default-conservative (all false ⇒
   *  text-only). A client MUST NOT infer these from the provider id. */
  capabilities: CompatDeclaredCapabilities;
  /** Optional model ids this endpoint serves (for the in-chat picker). */
  models?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CompatDeclaredCapabilities {
  /** Image input — an RFC 0091 INPUT modality, advertised via `aiProviders.input`. */
  vision: boolean;
  /** Function-calling / tool-use loop — RFC 0031 `function-calling`. */
  tools: boolean;
  /** Context window ≥ 200k tokens — RFC 0031 `long-context`. */
  longContext: boolean;
}

export const COMPAT_PROVIDER_ID = 'compat' as const;

const endpoints = new DurableCollection<CompatEndpoint>('compat:endpoint', (e) => `${e.tenantId}:${e.id}`);

// ── store (tenant-scoped, mirrors the knowledge-sync SyncSource pattern) ──────

export async function getCompatEndpoint(tenantId: string, id: string): Promise<CompatEndpoint | null> {
  return endpoints.get(`${tenantId}:${id}`);
}

/** All compat endpoints in `orgId` for `tenantId` (tenant-bounded scan + org filter). */
export async function listCompatEndpoints(tenantId: string, orgId: string): Promise<CompatEndpoint[]> {
  return (await endpoints.listForTenant(tenantId)).filter((e) => e.orgId === orgId);
}

export async function putCompatEndpoint(endpoint: CompatEndpoint): Promise<void> {
  await endpoints.put(endpoint);
}

export async function deleteCompatEndpoint(tenantId: string, id: string): Promise<boolean> {
  return endpoints.delete(`${tenantId}:${id}`);
}

// ── §A.3 opaque, non-URL provider-class id ───────────────────────────────────

/** The §A.3 opaque provider-class id for a compat endpoint. A single configured
 *  endpoint advertises as `compat`; multiple disambiguate by the OPAQUE endpoint
 *  id (never the URL or human label). Guaranteed URL-free. */
export function compatProviderId(endpoint: Pick<CompatEndpoint, 'id'>, multiple: boolean): string {
  return multiple ? `${COMPAT_PROVIDER_ID}:${endpoint.id}` : COMPAT_PROVIDER_ID;
}

// ── §A.2 dark-by-default advertise helper (mirrors advertisedAuthProfiles) ────

/** RFC 0108 §A.2 — the opaque provider-class ids to advertise in
 *  `aiProviders.selfHosted[]` for the configured compat endpoints in a scope.
 *  EMPTY when none configured ⇒ the advertisement is naturally DARK and honest
 *  under `OPENWOP_REQUIRE_BEHAVIOR`. (A live reachability probe is the caller's
 *  job at advertise time; this gates on "configured".) Each returned id is
 *  guaranteed non-URL (§A.3). */
export function advertisedSelfHostedProviders(configured: readonly Pick<CompatEndpoint, 'id'>[]): string[] {
  if (configured.length === 0) return [];
  const multiple = configured.length > 1;
  return configured.map((e) => compatProviderId(e, multiple));
}

// ── §B capability non-inference: DECLARED caps → RFC 0031 identifiers ─────────

/** RFC 0108 §B — a self-hosted endpoint's model capabilities come ONLY from what
 *  the host advertises (declared here), never inferred from the id. Maps the
 *  DECLARED flags to the RFC 0031 `modelCapabilities.advertised[]` vocabulary.
 *  (`vision` is an RFC 0091 INPUT modality, advertised via `aiProviders.input`,
 *  not an RFC 0031 model-capability — see {@link compatInputModalities}.) */
export function compatDeclaredModelCapabilities(caps: CompatDeclaredCapabilities): string[] {
  const out: string[] = [];
  if (caps.tools) out.push('function-calling');
  if (caps.longContext) out.push('long-context');
  return out;
}

/** The RFC 0091 input modalities a compat endpoint declares (image ⇐ vision).
 *  `text` is always implied. Returned for `aiProviders.input.modalities` union. */
export function compatInputModalities(caps: CompatDeclaredCapabilities): string[] {
  return caps.vision ? ['image'] : [];
}

// ── dispatch resolution (consumed by conversationExchange when provider==='compat') ──

/** Resolve a configured compat endpoint to the `{ baseUrl, apiKey }` the
 *  `compat` dispatcher needs. The key is resolved from BYOK at dispatch time
 *  (never persisted in this store); an endpoint with no `credentialRef` (e.g. a
 *  default Ollama) dispatches with an empty key. Returns `null` when the
 *  endpoint isn't found for the tenant (fail-closed). NOTE: callers MUST keep
 *  the returned `baseUrl` off the wire (§D) — it is passed only to the
 *  `compat` dispatcher, which scrubs it from any error. */
export async function resolveCompatDispatch(
  tenantId: string,
  endpointId: string,
): Promise<{ baseUrl: string; apiKey: string } | null> {
  const endpoint = await getCompatEndpoint(tenantId, endpointId);
  if (!endpoint) return null;
  const apiKey = endpoint.credentialRef
    ? (await resolveSecret(endpoint.credentialRef, { tenantId })) ?? ''
    : '';
  return { baseUrl: endpoint.baseUrl, apiKey };
}

// ── host-scoped advertisement (RFC 0108 §A.2) ────────────────────────────────

/** The host's test-seam compat endpoint URL, if configured. The conformance run
 *  sets `OPENWOP_TEST_COMPAT_ENDPOINT` to a reachable mock compat server; the
 *  honesty scenario dispatches against the advertised `compat` id and asserts it
 *  reaches a real endpoint (succeed OR transport error — §A.2). Host-only (§D). */
export function getHostTestCompatEndpoint(): string | undefined {
  return process.env.OPENWOP_TEST_COMPAT_ENDPOINT?.trim() || undefined;
}

/** RFC 0108 §A.2 host-scoped advertisement — the `aiProviders.selfHosted[]` value
 *  for the capabilities document. DARK (`[]`) unless the operator opted in
 *  (`OPENWOP_COMPAT_PROVIDER_ENABLED`) AND a reachable endpoint backs it. v1 keys
 *  the "reachable endpoint exists" signal on the conformance test seam
 *  (`OPENWOP_TEST_COMPAT_ENDPOINT`); advertising from real per-tenant config (a
 *  host-scoped async store check, since the capabilities doc is host-level) is a
 *  documented follow-up. The id is the opaque class id `compat` (§A.3, non-URL).
 *  This is the host-witness step of the RFC 0108 accept cycle — advertised only
 *  against the merged schema (openwop-conformance ≥1.36.0) + RFC 0108 `Active`. */
export function hostAdvertisedSelfHosted(): string[] {
  if (process.env.OPENWOP_COMPAT_PROVIDER_ENABLED !== 'true') return [];
  return getHostTestCompatEndpoint() ? [COMPAT_PROVIDER_ID] : [];
}
