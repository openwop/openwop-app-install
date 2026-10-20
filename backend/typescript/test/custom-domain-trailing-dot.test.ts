/**
 * ADR 0906 P0 / C6 — one canonical host form. Add strips a trailing dot; the
 * lookup used to strip only the port, so `pages.example.com.` missed its own
 * row. Both now go through `canonicalHost`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  __resetCustomDomains, addDomain, canonicalHost, listDomains, resolveCustomHost, verifyDomain,
} from '../src/host/customDomains.js';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetCustomDomains();
});

describe('ADR 0906 C6 — one canonical host form', () => {
  it('canonicalHost strips case, port and trailing dot', () => {
    expect(canonicalHost('Pages.Example.COM.:443')).toBe('pages.example.com');
    expect(canonicalHost('[::1]:8080')).toBe('[::1]');
  });

  it('a trailing-dot Host resolves the live row', async () => {
    await addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u1', hostname: 'pages.example.com' });
    const [row] = await listDomains('t1', 'o1');
    await verifyDomain('t1', 'o1', 'pages.example.com', async () => [[row!.verificationToken]]);
    expect(await resolveCustomHost('pages.example.com.')).toEqual({ tenantId: 't1', orgId: 'o1' });
    expect(await resolveCustomHost('PAGES.example.com.:443')).toEqual({ tenantId: 't1', orgId: 'o1' });
  });
});

