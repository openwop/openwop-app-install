/**
 * Custom-domains feature client (ADR 0295 / FNL-UX-3). Wraps
 * /host/openwop-app/custom-domains/*. 404s when the toggle is off.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const base = `${config.baseUrl}/host/openwop-app/custom-domains`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/** ADR 0906 D3 — HTTPS at the edge, a separate axis from ownership. */
export type EdgeTlsState = 'not_requested' | 'awaiting_dns' | 'provisioning' | 'active' | 'failed' | 'releasing';

export interface DnsRecord {
  type: 'CNAME' | 'A' | 'TXT';
  name: string;
  value: string;
  purpose: 'ownership' | 'routing' | 'certificate';
}

export interface CustomDomainEdge {
  provider: 'manual' | 'gcp-certificate-manager';
  tls: EdgeTlsState;
  dnsAuthRecord?: DnsRecord;
  issue?: { reason: string; detail: string };
  checkedAt: string;
  tlsSince?: string;
  releaseIntent?: 'delete' | 'expire' | 'reissue';
  releaseAttempts?: number;
}

export interface CustomDomain {
  hostname: string; orgId: string;
  status: 'pending' | 'live' | 'failed';
  verificationToken: string;
  createdAt: string; verifiedAt?: string; lastCheckedAt?: string; lastError?: string;
  /** Absent under the `manual` provider. */
  edge?: CustomDomainEdge;
}

/** What the server says about the edge (ADR 0906 D10). */
export type EdgeSummary =
  | { provider: 'manual'; ready: true }
  | { provider: string; ready: true; lbIp?: string; edgeHostname?: string }
  | { provider: string; ready: false; reason: string };

/** Records a domain needs, plus the alternative routing record when the apex guess may be wrong. */
export interface DomainDnsRecords { records: DnsRecord[]; alternative?: DnsRecord }

/**
 * The DNS records to show for one domain (ADR 0906 D2). The ONE place they are
 * derived:
 *   - ownership: TXT `_openwop-verify.<host>` (always);
 *   - certificate: the CNAME the server returned (only once it exists);
 *   - routing: a CNAME to the edge hostname for a subdomain, an A record to the
 *     LB IP for a root domain — never a CNAME at the apex.
 * Whether a name is a root domain cannot be known from its label count
 * (`example.co.uk`), so when both targets exist the other form is returned as
 * the alternative instead of asserting one answer.
 */
export function dnsRecordsFor(domain: Pick<CustomDomain, 'hostname' | 'verificationToken' | 'edge'>, edge: EdgeSummary | null): DomainDnsRecords {
  const records: DnsRecord[] = [
    { type: 'TXT', name: `_openwop-verify.${domain.hostname}`, value: domain.verificationToken, purpose: 'ownership' },
  ];
  if (domain.edge?.dnsAuthRecord) records.push(domain.edge.dnsAuthRecord);
  const lbIp = edge && edge.ready && 'lbIp' in edge ? edge.lbIp : undefined;
  const edgeHostname = edge && edge.ready && 'edgeHostname' in edge ? edge.edgeHostname : undefined;
  const looksApex = domain.hostname.split('.').length === 2;
  const cname: DnsRecord | undefined = edgeHostname ? { type: 'CNAME', name: domain.hostname, value: edgeHostname, purpose: 'routing' } : undefined;
  const a: DnsRecord | undefined = lbIp ? { type: 'A', name: domain.hostname, value: lbIp, purpose: 'routing' } : undefined;
  const primary = looksApex ? (a ?? undefined) : (cname ?? a);
  const alternative = looksApex ? undefined : (primary === cname ? a : undefined);
  if (primary) records.push(primary);
  return alternative ? { records, alternative } : { records };
}
export interface Org { orgId: string; name: string }

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, { headers: authedHeaders(), ...fetchOpts });
  return (await parse<{ orgs?: Org[] }>(res)).orgs ?? [];
}

const orgBase = (orgId: string): string => `${base}/orgs/${encodeURIComponent(orgId)}/domains`;

export async function listDomainPage(orgId: string): Promise<{ domains: CustomDomain[]; edge: EdgeSummary | null }> {
  const res = await fetch(orgBase(orgId), { headers: authedHeaders(), ...fetchOpts });
  const body = await parse<{ domains: CustomDomain[]; edge?: EdgeSummary }>(res);
  return { domains: body.domains, edge: body.edge ?? null };
}

export async function listDomains(orgId: string): Promise<CustomDomain[]> {
  return (await listDomainPage(orgId)).domains;
}

export async function addDomain(orgId: string, hostname: string): Promise<CustomDomain> {
  const res = await fetch(orgBase(orgId), { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ hostname }), ...fetchOpts });
  return (await parse<{ domain: CustomDomain }>(res)).domain;
}

export async function verifyDomain(orgId: string, hostname: string): Promise<CustomDomain> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(hostname)}/verify`, { method: 'POST', headers: authedHeaders(), ...fetchOpts });
  return (await parse<{ domain: CustomDomain }>(res)).domain;
}

/** `releasing` (202) means the certificate is still being removed; the row goes when it finishes. */
export async function removeDomain(orgId: string, hostname: string): Promise<'deleted' | 'releasing'> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(hostname)}`, { method: 'DELETE', headers: authedHeaders(), ...fetchOpts });
  return (await parse<{ outcome?: 'deleted' | 'releasing' }>(res)).outcome ?? 'deleted';
}

/** Org-admin escape after repeated failed certificate removals (ADR 0906 D4). */
export async function forceRemoveDomain(orgId: string, hostname: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(hostname)}?force=1`, { method: 'DELETE', headers: authedHeaders(), ...fetchOpts });
  await parse<{ ok: boolean }>(res);
}

/** "Check again" — re-issues a failed certificate, else refreshes. 429 within a minute. */
export async function retryDomain(orgId: string, hostname: string): Promise<CustomDomain> {
  const res = await fetch(`${orgBase(orgId)}/${encodeURIComponent(hostname)}/retry`, { method: 'POST', headers: authedHeaders(), ...fetchOpts });
  return (await parse<{ domain: CustomDomain }>(res)).domain;
}
