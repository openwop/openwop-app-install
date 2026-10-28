/**
 * ADR 0993 D5 (hotfix ahead of the rest of ADR 0993) — RFC 0028 user templates
 * belong to ONE tenant and live in storage.
 *
 * Born red on main (`a52087693`): the `/prompts` (RFC 0028) user layer was one
 * process-global in-memory map. Tenant B could GET, `:render`, `PUT` a new version
 * of and `DELETE` tenant A's template, and a prompt-library entry in tenant B could
 * bind it. A tenant's own user template did not `:render` at all (compose looked
 * only at the host fixtures). Every template vanished on a restart or on a second
 * Cloud Run instance.
 *
 * Sabotage witnesses (run 2026-10-27, each red, then restored):
 * - the resolver reading another tenant's row → "tenant B cannot…" and the dispatch case;
 * - `Cache-Control: public` on a tenant GET → "not publicly cacheable";
 * - `chainmint-` not reserved → "refuses the reserved chain-mint namespace";
 * - `:render` composing fixtures only → "a tenant can render its own";
 * - dispatch back on the global `getTemplate` → the dispatch case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/index.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { listTemplates } from '../src/host/promptStore.js';
import { resolveTenantTemplate } from '../src/host/tenantPromptTemplates.js';
import { createEntry } from '../src/features/prompts/promptLibraryService.js';

let server: http.Server;
let BASE = '';
const KEY: Record<string, string> = {};
const TA = 'adr0993h-a';
const TB = 'adr0993h-b';
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['OPENWOP_AUTH_DISABLE_COOKIES']) saved[k] = process.env[k];
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0993h', serviceVersion: '0.0.1', enableConsoleTracer: false });
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
  const id = `adr0993h-t${n++}`;
  const res = await call(tenant, 'POST', '/prompts', { templateId: id, version: '1.0.0', kind: 'user', text, name: id });
  expect(res.status, await res.clone().text()).toBe(201);
  return id;
}

describe('ADR 0993 D5 — RFC 0028 user templates belong to one tenant', () => {
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

  it('a user template lives in storage, not a module map', async () => {
    const id = await template(TA, 'durable');
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

  it('the tenant writer refuses the reserved chain-mint namespace', async () => {
    const res = await call(TA, 'POST', '/prompts', { templateId: 'chainmint-abc-def', version: '1.0.0', kind: 'system', text: 'planted' });
    expect(res.status).toBe(403);
  });

  it('dispatch resolves through the tenant resolver: the run\'s own tenant, never another', async () => {
    const id = await template(TA, 'mine');
    const own = await resolveTenantTemplate(TA, id);
    expect(own && own !== 'ambiguous' ? own.template.text : null).toBe('mine');
    expect(await resolveTenantTemplate(TB, id)).toBeNull();
    // The wiring: both dispatch sites call the tenant resolver with the run's tenant.
    const src = readFileSync(new URL('../src/bootstrap/nodes.ts', import.meta.url), 'utf8');
    expect(src.match(/resolveTenantTemplate\(ctx\.tenantId,/g)?.length, 'both dispatch call sites').toBe(2);
    expect(src).not.toMatch(/\bgetTemplate\(/);
  });

  it('a prompt-library entry cannot bind another tenant\'s template', async () => {
    const id = await template(TA);
    await expect(createEntry(TB, 'org-b', userIdFor(TB, 'oidc:b'), { name: 'steal', promptRef: id }))
      .rejects.toMatchObject({ code: 'validation_error' });
    expect((await createEntry(TA, 'org-a', userIdFor(TA, 'oidc:a'), { name: 'mine', promptRef: id })).promptRef).toBe(id);
  });
});
