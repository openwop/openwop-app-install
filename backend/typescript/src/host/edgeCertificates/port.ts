/**
 * ADR 0906 D1 — the edge-certificate provider PORT.
 *
 * A custom hostname needs a TLS certificate at the edge that fronts this
 * service. Who issues it is deployment topology, so it sits behind a port:
 *
 *   - `manual` (default) — the operator issues certificates by hand
 *     (`scripts/custom-domain-edge.sh host <hostname>`). The app makes no
 *     edge calls and writes no edge state: today's behaviour, byte for byte.
 *   - `gcp-certificate-manager` — the app creates a DNS authorization, a
 *     Google-managed certificate and a certificate-map entry per verified
 *     hostname, over the Certificate Manager REST API.
 *
 * A Cloudflare-for-SaaS or Caddy adapter can be added later behind the same
 * port. The app never holds private keys (ADR 0295: managed certificates only).
 */

export type EdgeProviderId = 'manual' | 'gcp-certificate-manager';

/**
 * TLS state for one hostname. A separate axis from ownership (`status`):
 * `live` means the TXT proved ownership, not that HTTPS is serving (D3).
 */
export type EdgeTlsState = 'not_requested' | 'awaiting_dns' | 'provisioning' | 'active' | 'failed' | 'releasing';

export interface DnsRecord {
  type: 'CNAME' | 'A' | 'TXT';
  /** Fully-qualified record name, without a trailing dot. */
  name: string;
  value: string;
  purpose: 'ownership' | 'routing' | 'certificate';
}

export interface EdgeIssue {
  /** A stable machine reason (e.g. `dns_not_configured`, `CAA`, `RATE_LIMITED`). */
  reason: string;
  /** Provider detail, length-capped; never carries credentials. */
  detail: string;
}

/** The provider resources that exist for one hostname, by full resource name. */
export interface EdgeHandle {
  dnsAuthName?: string;
  certName?: string;
  mapEntryName?: string;
}

/** One step's outcome. `pending` means the provider accepted the work and has not finished it. */
export type StepResult<T> = { done: true; value: T } | { done: false };

export interface EdgeStatus {
  tls: Exclude<EdgeTlsState, 'not_requested' | 'releasing'>;
  issue?: EdgeIssue;
}

export interface EdgeCertificateProvider {
  readonly id: EdgeProviderId;
  /** Create (or find) the DNS authorization. Idempotent. */
  prepare(hostname: string): Promise<StepResult<{ handle: EdgeHandle; dnsRecords: DnsRecord[] }>>;
  /** Create (or find) the certificate, then the map entry. Idempotent; resumes from `handle`. */
  issue(hostname: string, handle: EdgeHandle): Promise<StepResult<EdgeHandle>>;
  /** Read the certificate's state. */
  status(handle: EdgeHandle): Promise<EdgeStatus>;
  /** Delete map entry → certificate → DNS authorization, each NOT_FOUND-tolerant. Idempotent. */
  release(hostname: string): Promise<'released' | 'partial'>;
}

/** The row's edge sub-object (D3). Only the server writes it. */
export interface CustomDomainEdge {
  provider: EdgeProviderId;
  tls: EdgeTlsState;
  dnsAuthName?: string;
  /** The CNAME the customer adds so the certificate can be authorized. */
  dnsAuthRecord?: DnsRecord;
  certName?: string;
  mapEntryName?: string;
  issue?: EdgeIssue;
  checkedAt: string;
  /** When the TLS state last changed (drives the 24 h `dns_not_configured` rule). */
  tlsSince?: string;
  /**
   * Why the row is `releasing` (P3): `delete` (the owner removed it), `expire`
   * (an unverified claim timed out) or `reissue` (retry after a failure). A
   * `delete`/`expire` row stops serving at once; `reissue` keeps its binding.
   */
  releaseIntent?: 'delete' | 'expire' | 'reissue';
  /** Failed release sweeps; an org admin may force-delete after 3 (D4). */
  releaseAttempts?: number;
}
