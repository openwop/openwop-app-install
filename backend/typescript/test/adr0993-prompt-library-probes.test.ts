/**
 * ADR 0993 — the prompt library's owner lanes, its reference integrity, and the
 * tenant boundary of the RFC 0028 template store it references.
 *
 * Every case here was born RED on main (`a52087693`):
 *  - D2: a member who cannot READ a co-member's private entry could still PATCH it
 *    (the 200 handed back its name, description and promptRef) and DELETE it.
 *  - D3: `updateEntry` was a blind read-modify-write; a stale editor overwrote.
 *  - D4: an entry could bind another tenant's template, and an entry whose
 *    template had gone still listed as if usable.
 *  - D5: `/prompts` (RFC 0028) user templates lived in ONE process-global map, so tenant B
 *    could read, render, version and delete tenant A's template. A tenant's own
 *    user template did not render at all (`:render` looked only at fixtures).
 *  - D6: no DSAR eraser covered `prompts:entry` (it sat in ACTOR_ATTRIBUTED_DEBT).
 *  - D7: the portability export handed every member every private entry (CPC-16).
 *
 * Cases added with the fix (from the `/architect` pass, so not born red on main
 * for the same reason): the tenant `GET` is not publicly cacheable (H3), the
 * tenant writer refuses `chainmint-` (H2), and the export's outsider/no-caller arms
 * (M4). Their sabotage witnesses are recorded in ADR 0993.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { createOrg } from '../src/host/accessControlService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { ERASED } from '../src/host/subjectErasureRedaction.js';
import {
  createEntry, deleteEntry, getEntry, getEntryUnfiltered, listEntries, updateEntry,
} from '../src/features/prompts/promptLibraryService.js';
import { buildExportBundle } from '../src/features/portability/portabilityService.js';
import { createMember } from '../src/host/accessControlService.js';
import { createLink, resolveShared } from '../src/features/sharing/sharingService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';

let server: http.Server;
let BASE = '';
const KEY: Record<string, string> = {};
const TA = 'adr0993-a';
const TB = 'adr0993-b';
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['OPENWOP_AUTH_DISABLE_COOKIES']) saved[k] = process.env[k];
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0993', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  for (const t of [TA, TB]) {
    KEY[t] = (await issueApiKey({ tenantId: t, name: 'k', createdBy: `user:${t}`, scopes: ['prompts:read', 'prompts:write'] })).token;
  }
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

function call(tenant: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY[tenant]}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

let n = 0;
async function template(tenant: string, text = 'Hello {{name}}'): Promise<string> {
  const id = `adr0993-t${n++}`;
  const res = await call(tenant, 'POST', '/prompts', { templateId: id, version: '1.0.0', kind: 'user', text, name: id });
  expect(res.status, await res.clone().text()).toBe(201);
  return id;
}

const OWNER = userIdFor(TA, 'oidc:owner');
const OTHER = userIdFor(TA, 'oidc:other');

describe('D5 — RFC 0028 user templates belong to one tenant', () => {
  it('tenant B cannot read, render, version or delete tenant A\'s template', async () => {
    const id = await template(TA, 'A secret {{x}}');
    expect((await call(TB, 'GET', `/prompts/${id}`)).status).toBe(404);
    expect((await call(TB, 'POST', '/prompts:render', { ref: `prompt:${id}`, variables: {} })).status).toBe(404);
    expect((await call(TB, 'PUT', `/prompts/${id}`, { templateId: id, version: '2.0.0', kind: 'user', text: 'pwned' })).status).toBe(404);
    expect((await call(TB, 'DELETE', `/prompts/${id}`)).status).toBe(404);
    const listB = (await (await call(TB, 'GET', '/prompts?source=user')).json()) as { items: { templateId: string }[] };
    expect(listB.items.map((t) => t.templateId)).not.toContain(id);
    const own = await call(TA, 'GET', `/prompts/${id}`);
    expect(own.status).toBe(200);
    expect(((await own.json()) as { text: string }).text, 'B\'s PUT wrote nothing').toBe('A secret {{x}}');
  });

  it('a tenant can render its own user template', async () => {
    const id = await template(TA, 'Hi {{name}}');
    const res = await call(TA, 'POST', '/prompts:render', { ref: `prompt:${id}`, variables: { name: 'Ada' } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { composed?: string }).composed).toContain('Ada');
  });

  it('a user template lives in storage, not a module map (it survives a restart or a second instance)', async () => {
    const id = await template(TA, 'durable');
    const { listTemplates } = await import('../src/host/promptStore.js');
    expect(listTemplates().map((t) => t.templateId), 'the global, in-memory layers do not hold it').not.toContain(id);
    const row = await hostExtStorage().kvGet(`hostext:proposal-installed-prompts:${TA}::${id}::1.0.0`);
    expect((JSON.parse(row ?? '{}') as { tenant?: string }).tenant, 'the storage row holds it').toBe(TA);
  });

  it('a tenant template is not publicly cacheable (the Firebase door caches public responses by URL)', async () => {
    const id = await template(TA);
    const res = await call(TA, 'GET', `/prompts/${id}?version=1.0.0`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('dispatch resolves through the tenant resolver: the run\'s own tenant, never another', async () => {
    const { resolveTenantTemplate } = await import('../src/host/tenantPromptTemplates.js');
    const id = await template(TA, 'mine');
    const own = await resolveTenantTemplate(TA, id);
    expect(own && own !== 'ambiguous' ? own.template.text : null).toBe('mine');
    expect(await resolveTenantTemplate(TB, id)).toBeNull();
    // The wiring: both dispatch sites call the tenant resolver with the run's tenant.
    const src = (await import('node:fs')).readFileSync(new URL('../src/bootstrap/nodes.ts', import.meta.url), 'utf8');
    expect(src.match(/resolveTenantTemplate\(ctx\.tenantId,/g)?.length, 'both dispatch call sites').toBe(2);
    expect(src).not.toMatch(/\bgetTemplate\(/);
  });

  it('the tenant writer refuses the reserved chain-mint namespace', async () => {
    const res = await call(TA, 'POST', '/prompts', { templateId: 'chainmint-abc-def', version: '1.0.0', kind: 'system', text: 'planted' });
    expect(res.status).toBe(403);
  });
});

describe('D4 — an entry binds only a template its own tenant can see', () => {
  it('refuses another tenant\'s template', async () => {
    const id = await template(TA);
    await expect(createEntry(TB, 'org-b', userIdFor(TB, 'oidc:b'), { name: 'steal', promptRef: id }))
      .rejects.toMatchObject({ code: 'validation_error' });
  });

  it('an entry whose template was deleted lists as unavailable', async () => {
    const id = await template(TA);
    const e = await createEntry(TA, 'org-av', OWNER, { name: 'av', promptRef: id, visibility: 'org' });
    expect((await call(TA, 'DELETE', `/prompts/${id}`)).status).toBe(204);
    const listed = (await listEntries(TA, 'org-av', OWNER)).find((x) => x.entryId === e.entryId);
    expect(listed?.available).toBe(false);
  });
});

describe('D2 — a private entry is its owner\'s on every lane', () => {
  it('a co-member can neither edit nor delete it, and learns nothing from trying', async () => {
    const id = await template(TA);
    const e = await createEntry(TA, 'org-own', OWNER, { name: 'mine', description: 'secret plan', promptRef: id });
    await expect(updateEntry(TA, 'org-own', e.entryId, OTHER, { name: 'renamed' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteEntry(TA, 'org-own', e.entryId, OTHER)).rejects.toMatchObject({ code: 'not_found' });
    const after = await getEntryUnfiltered(TA, 'org-own', e.entryId);
    expect(after?.name).toBe('mine');
  });

  it('negative control: the owner still edits and deletes, and org entries stay org-writable', async () => {
    const id = await template(TA);
    const mine = await createEntry(TA, 'org-own2', OWNER, { name: 'mine', promptRef: id });
    expect((await updateEntry(TA, 'org-own2', mine.entryId, OWNER, { name: 'mine2' })).name).toBe('mine2');
    const org = await createEntry(TA, 'org-own2', OWNER, { name: 'team', promptRef: id, visibility: 'org' });
    expect((await updateEntry(TA, 'org-own2', org.entryId, OTHER, { name: 'team2' })).name).toBe('team2');
    await deleteEntry(TA, 'org-own2', mine.entryId, OWNER);
    expect(await getEntry(TA, 'org-own2', mine.entryId, OWNER)).toBeNull();
  });
});

describe('D3 — a stale edit is refused, not applied', () => {
  it('expectedRevision that is behind the row answers conflict', async () => {
    const id = await template(TA);
    const e = await createEntry(TA, 'org-cas', OWNER, { name: 'v1', promptRef: id, visibility: 'org' });
    expect(e.revision).toBe(1);
    const second = await updateEntry(TA, 'org-cas', e.entryId, OTHER, { name: 'v2', expectedRevision: 1 });
    expect(second.revision).toBe(2);
    await expect(updateEntry(TA, 'org-cas', e.entryId, OWNER, { name: 'stale', expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect((await getEntryUnfiltered(TA, 'org-cas', e.entryId))?.name).toBe('v2');
  });
});

describe('D6 — DSAR reaches prompt-library entries', () => {
  it('deletes the subject\'s private entries and anonymizes their attribution on org entries (both spellings)', async () => {
    const id = await template(TA);
    const priv = await createEntry(TA, 'org-dsar', OWNER, { name: 'p', promptRef: id });
    const team = await createEntry(TA, 'org-dsar', OWNER, { name: 'o', promptRef: id, visibility: 'org' });
    const doubled = await createEntry(TA, 'org-dsar', `user:${OWNER}`, { name: 'd', promptRef: id, visibility: 'org' });
    const bystander = await createEntry(TA, 'org-dsar', OTHER, { name: 'b', promptRef: id });
    await eraseSubject(TA, OWNER);
    expect(await getEntryUnfiltered(TA, 'org-dsar', priv.entryId), 'the subject\'s own private prompt is deleted').toBeNull();
    const t = await getEntryUnfiltered(TA, 'org-dsar', team.entryId);
    expect(t?.createdBy).toBe(ERASED);
    expect(t?.updatedBy).toBe(ERASED);
    expect((await getEntryUnfiltered(TA, 'org-dsar', doubled.entryId))?.createdBy).toBe(ERASED);
    expect((await getEntryUnfiltered(TA, 'org-dsar', bystander.entryId))?.createdBy, 'no over-erasure').toBe(OTHER);
  });
});

describe('D7 — export carries only what the exporter may read', () => {
  it('a member\'s export omits a co-member\'s private entry', async () => {
    const id = await template(TA);
    const org = await createOrg({ tenantId: TA, createdBy: OWNER, name: 'Export org', ownerSubject: OWNER });
    await createMember({ tenantId: TA, orgId: org.orgId, subject: OTHER, displayName: 'other', roles: ['editor'] });
    await createEntry(TA, org.orgId, OWNER, { name: 'owner-private', promptRef: id });
    await createEntry(TA, org.orgId, OWNER, { name: 'owner-org', promptRef: id, visibility: 'org' });
    const bundle = await buildExportBundle(TA, ['prompt-template'], OTHER) as { items: { payload: { name?: string } }[] };
    const names = bundle.items.map((i) => i.payload.name);
    expect(names).toContain('owner-org');
    expect(names).not.toContain('owner-private');
    const outsider = await buildExportBundle(TA, ['prompt-template'], userIdFor(TA, 'oidc:outsider')) as { items: unknown[] };
    expect(outsider.items, 'a non-member of the org exports none of it').toEqual([]);
    expect((await buildExportBundle(TA, ['prompt-template'], null) as { items: unknown[] }).items, 'no caller, no rows').toEqual([]);
  });
});

describe('review fixes (grade-code / code-review, 2026-10-27)', () => {
  it('P61CD-1: a text edit that loses the race does not wedge later edits, and leaves no body behind', async () => {
    const e = await createEntry(TA, 'org-race', OWNER, { name: 'r', template: { kind: 'user', text: 'v1' }, visibility: 'org' });
    const [a, b] = await Promise.allSettled([
      updateEntry(TA, 'org-race', e.entryId, OWNER, { text: 'from A' }),
      updateEntry(TA, 'org-race', e.entryId, OTHER, { name: 'renamed by B' }),
    ]);
    const okText = a.status === 'fulfilled' ? 1 : 0;
    // Both read revision 1, so exactly one CAS lands (D3): the other is a 409, not
    // a silent overwrite.
    const settled = [a, b];
    expect(settled.filter((x) => x.status === 'fulfilled').length, 'exactly one write lands').toBe(1);
    expect(settled.find((x) => x.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    const cur = (await getEntryUnfiltered(TA, 'org-race', e.entryId))!;
    const after = await updateEntry(TA, 'org-race', e.entryId, OWNER, { text: 'later edit', expectedRevision: cur.revision });
    expect(after.body?.text, 'a later edit always lands').toBe('later edit');
    const raw = await hostExtStorage().kvList(`hostext:prompts:entry-version:${TA}:org-race:${e.entryId}:`);
    expect(raw.length, 'v1, the later edit, and A\'s only if it landed: a loser\'s version is removed').toBe(2 + okText);
  });

  it('P61CD-1: a version left behind (a crash between the version write and the entry CAS) does not block the next edit', async () => {
    const e = await createEntry(TA, 'org-orphan', OWNER, { name: 'o', template: { kind: 'user', text: 'v1' }, visibility: 'org' });
    // Plant what a writer that died after `writeBodyVersion` leaves: 1.1.0, unpinned.
    await hostExtStorage().kvSet(`hostext:prompts:entry-version:${TA}:org-orphan:${e.entryId}:1.1.0`, JSON.stringify({ tenantId: TA, orgId: 'org-orphan', entryId: e.entryId, version: '1.1.0', kind: 'user', text: 'orphan', createdAt: '2026-10-27T00:00:00.000Z' }));
    const next = await updateEntry(TA, 'org-orphan', e.entryId, OWNER, { text: 'v2', expectedRevision: 1 });
    expect(next.body?.text).toBe('v2');
    expect(next.bodyVersion, 'one above the highest stored version, not above the pin').toBe('1.2.0');
  });

  it('P61CD-1: editing a body moves the pin and keeps the old version', async () => {
    const e = await createEntry(TA, 'org-pin', OWNER, { name: 'p', template: { kind: 'system', text: 'one' }, visibility: 'org' });
    const v2 = await updateEntry(TA, 'org-pin', e.entryId, OWNER, { text: 'two', expectedRevision: 1 });
    expect(v2.bodyVersion).toBe('1.1.0');
    expect(v2.body?.text).toBe('two');
    expect(await hostExtStorage().kvGet(`hostext:prompts:entry-version:${TA}:org-pin:${e.entryId}:1.0.0`)).not.toBeNull();
  });

  it('P61CD-2: delete removes the row, its versions and its links; a missing body can be repaired with a kind', async () => {
    const e = await createEntry(TA, 'org-del', OWNER, { name: 'd', template: { kind: 'user', text: 'x' }, visibility: 'org' });
    await deleteEntry(TA, 'org-del', e.entryId, OWNER);
    expect(await getEntryUnfiltered(TA, 'org-del', e.entryId)).toBeNull();
    expect(await hostExtStorage().kvList(`hostext:prompts:entry-version:${TA}:org-del:${e.entryId}:`)).toEqual([]);
    const f = await createEntry(TA, 'org-del', OWNER, { name: 'f', template: { kind: 'user', text: 'x' }, visibility: 'org' });
    await hostExtStorage().kvDelete(`hostext:prompts:entry-version:${TA}:org-del:${f.entryId}:1.0.0`);
    const fixed = await updateEntry(TA, 'org-del', f.entryId, OWNER, { text: 'restored', kind: 'user' });
    expect(fixed.available).toBe(true);
  });

  it('P61CD-4: ids and versions are validated; a key-aliasing id or a non-semver version is refused', async () => {
    expect((await call(TA, 'POST', '/prompts', { templateId: 'a', version: 'b::1.0.0', kind: 'user', text: 'SQUAT' })).status).toBe(400);
    expect((await call(TA, 'POST', '/prompts', { templateId: 'a::b', version: '1.0.0', kind: 'user', text: 'x' })).status).toBe(400);
    const id = await template(TA);
    expect((await call(TA, 'PUT', `/prompts/${id}`, { templateId: id, version: 'zzz', kind: 'user', text: 'x' })).status).toBe(400);
  });

  it('P61CD-9: a non-integer expectedRevision is a 400, not an eternal 409', async () => {
    const e = await createEntry(TA, 'org-rev', OWNER, { name: 'v', template: { kind: 'user', text: 'x' }, visibility: 'org' });
    await expect(updateEntry(TA, 'org-rev', e.entryId, OWNER, { name: 'w', expectedRevision: '1' })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('P61CD-10: a shared link of an entry whose text is gone serves nothing', async () => {
    const id = await template(TA);
    const org = await createOrg({ tenantId: TA, createdBy: OWNER, name: 'Share org', ownerSubject: OWNER });
    const e = await createEntry(TA, org.orgId, OWNER, { name: 's', promptRef: id, visibility: 'shared' });
    const link = await createLink(TA, org.orgId, OWNER, { resourceType: 'prompt', resourceId: e.entryId });
    expect((await resolveShared(link.token)).resource.name, 'precondition: it serves').toBe('s');
    expect((await call(TA, 'DELETE', `/prompts/${id}`)).status).toBe(204);
    await expect(resolveShared(link.token), 'not a success with an empty body').rejects.toMatchObject({ httpStatus: 404 });
  });

  it('P61CD-5: a co-member\'s private import of a name does not block or reveal mine', async () => {
    const { applyImport } = await import('../src/features/portability/portabilityService.js');
    const id = await template(TA);
    const org = await createOrg({ tenantId: TA, createdBy: 'oidc:imp-a', name: 'Import org', ownerSubject: 'oidc:imp-a' });
    await createMember({ tenantId: TA, orgId: org.orgId, subject: 'oidc:imp-b', displayName: 'b', roles: ['editor'] });
    const bundle = { bundleVersion: '1', source: { origin: 'adapter:test' }, items: [{ kind: 'prompt-template', ref: 'x', payload: { name: 'Board memo', orgId: org.orgId, promptRef: id, visibility: 'private' } }] };
    const first = await applyImport(TA, 'oidc:imp-a', bundle);
    expect(first.items[0]?.status, JSON.stringify(first)).toBe('imported');
    const second = await applyImport(TA, 'oidc:imp-b', bundle);
    expect(second.items[0]?.status, JSON.stringify(second)).toBe('imported');
  });
});
