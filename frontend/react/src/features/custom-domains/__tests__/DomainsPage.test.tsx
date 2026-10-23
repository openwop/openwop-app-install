/**
 * ADR 0906 P4 — the HTTPS axis on the domains page.
 *
 *  - `dnsRecordsFor` is the ONE derivation of the records a domain needs:
 *    ownership TXT always; the certificate CNAME once the server has it; a
 *    routing CNAME for a subdomain, an A record for a root domain (never a
 *    CNAME at the apex), and the other form as the alternative when the apex
 *    guess may be wrong;
 *  - the page shows the HTTPS chip and a plain-language issue, "Check again"
 *    only where it can change something, force-remove only after 3 failed
 *    releases, a manual deployment as operator-managed, and an unready edge as
 *    a warning (never hidden).
 *
 * Sabotage-witnessed (wave 55/56 probes, each red here): the apex rule moved
 * (3 labels); an apex with no LB IP falling back to a CNAME; the alternative
 * dropped; the certificate record dropped; a manual provider treated as gcp;
 * `active` added to, or `awaiting_dns` / `provisioning` removed from, the
 * retryable set; retry called without the hostname; the force-remove threshold
 * moved either way; Delete enabled while releasing; the unready-edge warning
 * hidden; a raw issue code shown.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';

const { listOrgs, listDomainPage, retryDomain, forceRemoveDomain, useFeatureAccess } = vi.hoisted(() => ({
  listOrgs: vi.fn<typeof import('../domainsClient.js').listOrgs>(),
  listDomainPage: vi.fn<typeof import('../domainsClient.js').listDomainPage>(),
  retryDomain: vi.fn<typeof import('../domainsClient.js').retryDomain>(),
  forceRemoveDomain: vi.fn<typeof import('../domainsClient.js').forceRemoveDomain>(),
  useFeatureAccess: vi.fn(() => makeFeatureAccess({ enabled: true, loading: false })),
}));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../domainsClient.js', async (orig) => ({
  ...(await orig<typeof import('../domainsClient.js')>()),
  listOrgs, listDomainPage, retryDomain, forceRemoveDomain,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess,
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));

import { DomainsPage } from '../DomainsPage.js';
import { dnsRecordsFor, type CustomDomain, type EdgeSummary } from '../domainsClient.js';

const GCP: EdgeSummary = { provider: 'gcp-certificate-manager', ready: true, lbIp: '203.0.113.7', edgeHostname: 'edge.example.net' };
const base = (hostname: string, extra: Partial<CustomDomain> = {}): CustomDomain => ({
  hostname, orgId: 'o1', status: 'live', verificationToken: 'owp-verify=abc', createdAt: '2026-10-01T00:00:00.000Z', ...extra,
});
const CERT = { type: 'CNAME' as const, name: '_acme-challenge_owp-cd-1.shop.example.com', value: 'owp-cd-1.authorize.certificatemanager.goog', purpose: 'certificate' as const };

describe('dnsRecordsFor', () => {
  it('a subdomain gets TXT + certificate CNAME + routing CNAME, with the A record as the alternative', () => {
    const out = dnsRecordsFor(base('shop.example.com', { edge: { provider: 'gcp-certificate-manager', tls: 'awaiting_dns', checkedAt: '', dnsAuthRecord: CERT } }), GCP);
    expect(out.records.map((r) => `${r.purpose}:${r.type}`)).toEqual(['ownership:TXT', 'certificate:CNAME', 'routing:CNAME']);
    expect(out.records[0]).toMatchObject({ name: '_openwop-verify.shop.example.com', value: 'owp-verify=abc' });
    expect(out.records[2]!.value).toBe('edge.example.net');
    expect(out.alternative).toMatchObject({ type: 'A', value: '203.0.113.7' });
  });

  it('a root domain gets an A record and never a CNAME', () => {
    const out = dnsRecordsFor(base('example.com'), GCP);
    expect(out.records.map((r) => r.type)).toEqual(['TXT', 'A']);
    expect(out.alternative).toBeUndefined();
  });

  it('a root domain with no LB IP gets no routing record rather than a CNAME', () => {
    const out = dnsRecordsFor(base('example.com'), { provider: 'gcp-certificate-manager', ready: true, edgeHostname: 'edge.example.net' });
    expect(out.records.map((r) => r.type)).toEqual(['TXT']);
  });

  it('manual, or nothing configured: ownership only', () => {
    expect(dnsRecordsFor(base('shop.example.com'), { provider: 'manual', ready: true }).records.map((r) => r.purpose)).toEqual(['ownership']);
    expect(dnsRecordsFor(base('shop.example.com'), null).records.map((r) => r.purpose)).toEqual(['ownership']);
  });
});

const mount = async (domains: CustomDomain[], edge: EdgeSummary | null): Promise<void> => {
  listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  listDomainPage.mockResolvedValue({ domains, edge });
  render(<DomainsPage />);
  await act(async () => {});
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  // Reset the client mocks' RETURNS too (clearAllMocks keeps a resolved value
  // from one case into the next); useFeatureAccess / confirm keep their impls.
  for (const m of [listOrgs, listDomainPage, retryDomain, forceRemoveDomain]) m.mockReset();
});

describe('DomainsPage — HTTPS axis', () => {
  it('manual: an operator-managed chip, no Check again, and the operator copy', async () => {
    await mount([base('shop.example.com')], { provider: 'manual', ready: true });
    expect(screen.getByText('Operator-managed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Check HTTPS again/ })).toBeNull();
    expect(screen.getByText(/configured by your operator/)).toBeTruthy();
  });

  it('gcp: the TLS chip, a plain-language issue, and Check again calls retry', async () => {
    retryDomain.mockResolvedValue(base('shop.example.com', { edge: { provider: 'gcp-certificate-manager', tls: 'awaiting_dns', checkedAt: '' } }));
    await mount([base('shop.example.com', { edge: { provider: 'gcp-certificate-manager', tls: 'failed', checkedAt: '', issue: { reason: 'dns_not_configured', detail: 'x' } } })], GCP);
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText(/CNAME was not found after 24 hours/)).toBeTruthy();
    expect(screen.queryByText(/configured by your operator/)).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check HTTPS again for shop.example.com' })); });
    expect(retryDomain).toHaveBeenCalledWith('o1', 'shop.example.com');
  });

  it('an unknown issue reason reads as plain language, never as the raw code', async () => {
    await mount([base('shop.example.com', { edge: { provider: 'gcp-certificate-manager', tls: 'awaiting_dns', checkedAt: '', issue: { reason: 'WEIRD_CODE', detail: 'd' } } })], GCP);
    expect(screen.getByText(/reported a problem/)).toBeTruthy();
    expect(screen.queryByText('WEIRD_CODE')).toBeNull();
  });

  it('an active certificate offers no Check again; a provisioning one does', async () => {
    await mount([
      base('shop.example.com', { edge: { provider: 'gcp-certificate-manager', tls: 'active', checkedAt: '' } }),
      base('new.example.com', { edge: { provider: 'gcp-certificate-manager', tls: 'provisioning', checkedAt: '' } }),
    ], GCP);
    expect(screen.getByText('Active')).toBeTruthy();
    // Positive signal first: the provisioning row offers it, so the absence
    // below is about `active`, not about the button never rendering.
    expect(screen.getByRole('button', { name: 'Check HTTPS again for new.example.com' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check HTTPS again for shop.example.com' })).toBeNull();
  });

  it('force remove appears only after 3 failed releases', async () => {
    await mount([
      base('a.example.com', { edge: { provider: 'gcp-certificate-manager', tls: 'releasing', releaseIntent: 'delete', releaseAttempts: 2, checkedAt: '' } }),
      base('b.example.com', { edge: { provider: 'gcp-certificate-manager', tls: 'releasing', releaseIntent: 'delete', releaseAttempts: 3, checkedAt: '' } }),
    ], GCP);
    expect(screen.queryByRole('button', { name: 'Force remove a.example.com' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Delete domain a.example.com' }) as HTMLButtonElement).disabled).toBe(true);
    forceRemoveDomain.mockResolvedValue(undefined);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Force remove b.example.com' })); });
    expect(forceRemoveDomain).toHaveBeenCalledWith('o1', 'b.example.com');
  });

  it('an unready edge is a visible warning with its reason', async () => {
    await mount([base('shop.example.com')], { provider: 'gcp-certificate-manager', ready: false, reason: 'OPENWOP_CUSTOM_DOMAIN_CERT_MAP is not set' });
    expect(screen.getByText(/HTTPS certificates are not being issued/)).toBeTruthy();
    expect(screen.getByText(/CERT_MAP is not set/)).toBeTruthy();
  });

  it('the DNS records disclosure lists each record with its own copy button', async () => {
    await mount([base('shop.example.com', { edge: { provider: 'gcp-certificate-manager', tls: 'awaiting_dns', checkedAt: '', dnsAuthRecord: CERT } })], GCP);
    const details = screen.getByText('Show DNS records (3)').closest('details')!;
    const d = within(details);
    expect(d.getByText('owp-verify=abc')).toBeTruthy();
    expect(d.getByText(CERT.value)).toBeTruthy();
    expect(d.getByText('edge.example.net')).toBeTruthy();
    expect(d.getAllByRole('button', { name: /^Copy the / })).toHaveLength(4); // 3 records + the A alternative
    // awaiting_dns is retryable: the records were just shown, so Check again is offered.
    expect(screen.getByRole('button', { name: 'Check HTTPS again for shop.example.com' })).toBeTruthy();
  });
});
