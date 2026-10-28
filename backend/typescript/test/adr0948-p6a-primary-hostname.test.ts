/**
 * ADR 0948 P6a (D7) — a funnel's primary hostname.
 *
 *  - It must be a SERVING custom domain of the same org: an unverified domain, another
 *    org's, or another tenant's is refused; '' or null clears it.
 *  - It is part of what a publish approval pins (the digest), and publish refuses a
 *    domain that has stopped serving (`domain_not_serving`).
 *  - `funnelPublicUrl` is the platform viewer URL. Custom-domain funnel serving does not
 *    exist yet (P6b), so the helper never returns a URL that would not work.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { addDomain, listDomains, verifyDomain, removeDomain, isServingDomain, __resetCustomDomains } from '../src/host/customDomains.js';
import { createPage, transitionPage } from '../src/features/cms/cmsService.js';
import { createFunnel, updateFunnel, getFunnel, publishFunnel, funnelPublishDigest, funnelPublicUrl } from '../src/features/funnels/funnelsService.js';

const T = 't-p6a';
let n = 0;

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => { await __resetCustomDomains(); });

async function liveDomain(tenantId: string, orgId: string, hostname: string): Promise<void> {
  await addDomain({ tenantId, orgId, createdBy: 'u', hostname });
  const row = (await listDomains(tenantId, orgId)).find((d) => d.hostname === hostname)!;
  const out = await verifyDomain(tenantId, orgId, hostname, async () => [[row.verificationToken]]);
  expect(out?.status).toBe('live');
}
async function funnel(orgId: string) {
  const p = await createPage({ tenantId: T, orgId, title: `Page ${n}`, createdBy: 'u' });
  await transitionPage(T, orgId, p.pageId, 'publish', 'u');
  return createFunnel({ tenantId: T, orgId, createdBy: 'u', name: `Funnel ${n++}`, steps: [{ kind: 'landing', pageId: p.pageId }] });
}

describe('ADR 0948 P6a — primary hostname', () => {
  it('accepts only a serving domain of the same org; clears with null', async () => {
    const f = await funnel('o1');
    await liveDomain(T, 'o1', 'go.acme.test');
    await addDomain({ tenantId: T, orgId: 'o1', createdBy: 'u', hostname: 'pending.acme.test' }); // never verified
    await liveDomain(T, 'o2', 'other-org.acme.test');
    await liveDomain('t-other', 'o1', 'other-tenant.acme.test');

    for (const bad of ['pending.acme.test', 'other-org.acme.test', 'other-tenant.acme.test', 'nowhere.acme.test']) {
      await expect(updateFunnel(T, 'o1', f.funnelId, { primaryHostname: bad }), bad).rejects.toMatchObject({ httpStatus: 400 });
    }
    await updateFunnel(T, 'o1', f.funnelId, { primaryHostname: 'GO.acme.test.' });
    expect((await getFunnel(T, 'o1', f.funnelId))?.primaryHostname).toBe('go.acme.test');
    await updateFunnel(T, 'o1', f.funnelId, { primaryHostname: null });
    expect((await getFunnel(T, 'o1', f.funnelId))?.primaryHostname).toBeUndefined();
  });

  it('is pinned by the digest; publish refuses a domain that stopped serving; the URL stays the platform one', async () => {
    const f = await funnel('o1');
    await liveDomain(T, 'o1', 'shop.acme.test');
    const before = funnelPublishDigest((await getFunnel(T, 'o1', f.funnelId))!);
    await updateFunnel(T, 'o1', f.funnelId, { primaryHostname: 'shop.acme.test' });
    const withHost = (await getFunnel(T, 'o1', f.funnelId))!;
    expect(funnelPublishDigest(withHost)).not.toBe(before);

    // P6b does not exist yet: the public URL is the platform viewer, never the domain.
    expect(await funnelPublicUrl(withHost, 'https://app.example/')).toBe(`https://app.example/fn/o1/${encodeURIComponent(withHost.slug)}`);

    // ADR 0906 D4 on main: a row with no edge resources is deleted at once; force
    // removal exists only after failed provider releases.
    expect(await removeDomain(T, 'o1', 'shop.acme.test', null)).toBe('deleted');
    await expect(publishFunnel(T, 'o1', f.funnelId)).rejects.toMatchObject({ details: { code: 'domain_not_serving' } });
    await updateFunnel(T, 'o1', f.funnelId, { primaryHostname: null });
    expect((await publishFunnel(T, 'o1', f.funnelId))?.status).toBe('published');
  });

  it('isServingDomain is the host lookup\'s own rule (live, and not being released)', () => {
    expect(isServingDomain({ status: 'live' } as never)).toBe(true);
    expect(isServingDomain({ status: 'pending' } as never)).toBe(false);
    expect(isServingDomain({ status: 'live', edge: { tls: 'releasing', releaseIntent: 'remove' } } as never)).toBe(false);
    expect(isServingDomain({ status: 'live', edge: { tls: 'releasing', releaseIntent: 'reissue' } } as never)).toBe(true);
  });
});
