/**
 * CHAN-F19 #6 (ADR 0464 §9) — `portability:import-claims` keeps one permanent
 * dedup claim per imported item. A PRIVATE prompt's claim key is
 * `${tenantId}:prompt:${orgId}:${owner}:${name}`, so it holds the importer's
 * `User.userId` and the name of a prompt they imported, and no eraser reached it.
 *
 * This boots the REAL app (so the registered eraser set is the production one),
 * imports through `applyImport`, and erases one person through the host fan-out
 * (`eraseSubject`). It pins:
 *  - the person's private-prompt claims are deleted, including one written before
 *    claims carried `ownerUserId` (matched on the key segment);
 *  - another person's private claim and the org-visible claim (no person) are kept;
 *  - the same person's claim in ANOTHER workspace is kept (tenant-scoped);
 *  - new private claims record `ownerUserId` (the census signal), public ones do not.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { createTenantTemplate } from '../src/host/tenantPromptTemplates.js';
import { createOrg } from '../src/host/accessControlService.js';
import { applyImport } from '../src/features/portability/portabilityService.js';

let server: http.Server;
const T = 'ws-portability-f19-a';
const OTHER_T = 'ws-portability-f19-b';
const ALICE = 'user:portability-f19-alice';
const BOB = 'user:portability-f19-bob';

interface ClaimRow { key: string; tenantId: string; createdAt: string; ownerUserId?: string }
const claimsView = () => new DurableCollection<ClaimRow>('portability:import-claims', (c) => c.key);
const keysFor = async (tenantId: string): Promise<string[]> =>
  (await claimsView().listByPrefix(`${tenantId}:`)).map((c) => c.key).sort();

async function setUpTenant(tenantId: string): Promise<string> {
  expect((await createTenantTemplate(tenantId, { templateId: 'tpl-f19', version: '1.0.0', kind: 'user', text: 'Hi {{name}}', name: 'tpl-f19' })).ok).toBe(true);
  const org = await createOrg({ tenantId, createdBy: ALICE, name: 'F19 org', ownerSubject: ALICE });
  return org.orgId;
}

async function importPrompt(tenantId: string, actor: string, orgId: string, name: string, visibility: 'private' | 'org'): Promise<void> {
  const res = await applyImport(tenantId, actor, {
    bundleVersion: '1',
    source: { origin: 'adapter:test' },
    items: [{ kind: 'prompt-template', ref: name, payload: { name, orgId, promptRef: 'tpl-f19', visibility } }],
  });
  expect(res.items.find((i) => i.ref === name)?.status, JSON.stringify(res)).toBe('imported');
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo).port; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('CHAN-F19 #6 — portability import claims on a DSAR', () => {
  it('deletes the subject\'s private-prompt claims, in their workspace only', async () => {
    const org = await setUpTenant(T);
    const otherOrg = await setUpTenant(OTHER_T);
    // Bob imports into an org he owns (an import needs workspace:write on its org).
    const bobOrg = (await createOrg({ tenantId: T, createdBy: BOB, name: 'Bob org', ownerSubject: BOB })).orgId;

    await importPrompt(T, ALICE, org, 'alice-private', 'private');
    await importPrompt(T, BOB, bobOrg, 'bob-private', 'private');
    await importPrompt(T, ALICE, org, 'team-shared', 'org');
    await importPrompt(OTHER_T, ALICE, otherOrg, 'alice-elsewhere', 'private');
    // A claim written before claims recorded `ownerUserId`.
    const legacyKey = `${T}:prompt:${org}:${ALICE}:alice-legacy`;
    await claimsView().put({ key: legacyKey, tenantId: T, createdAt: new Date().toISOString() });

    const aliceKey = `${T}:prompt:${org}:${ALICE}:alice-private`;
    const bobKey = `${T}:prompt:${bobOrg}:${BOB}:bob-private`;
    const sharedKey = `${T}:prompt:${org}:team-shared`;
    expect(await keysFor(T)).toEqual([aliceKey, legacyKey, bobKey, sharedKey].sort());
    expect((await claimsView().get(aliceKey))?.ownerUserId, 'a private claim names its importer').toBe(ALICE);
    expect((await claimsView().get(sharedKey))?.ownerUserId, 'an org-visible claim names nobody').toBeUndefined();

    await eraseSubject(T, ALICE);

    expect(await keysFor(T), 'Alice\'s claims (new and legacy) are gone; Bob\'s and the shared one stay').toEqual([bobKey, sharedKey].sort());
    expect(await keysFor(OTHER_T), 'the other workspace is a different erasure').toEqual([`${OTHER_T}:prompt:${otherOrg}:${ALICE}:alice-elsewhere`]);
  });
});
