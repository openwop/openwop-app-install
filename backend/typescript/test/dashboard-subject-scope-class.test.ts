/**
 * EDBC-6a (remainder) — the dashboard's per-(tenant, subject) isolation.
 *
 * The filed row said "no backend self-scope/IDOR test". That half is STALE: all
 * three resources already have a same-tenant caller-B leg
 * (`dashboard-layout-route.test.ts:56,89,98`, `dashboard-briefing-route.test.ts:63`).
 * What was genuinely missing is the other two halves the row named:
 *
 *  1. CROSS-TENANT. Every store key is `(tenantId, subject)`, and nothing pinned
 *     that the tenant half carries. The same subject id in a second tenant must
 *     see nothing — a subject id is not tenant-unique (SSO/SCIM can mint the same
 *     external id in two workspaces), so this is reachable, not theoretical.
 *
 *  2. The CLASS. IDOR-safety here is by CONSTRUCTION: every handler derives its
 *     key from `requireSubject(req)` — the session — and no handler accepts a
 *     subject, user or tenant identifier from request input. Six handlers satisfy
 *     that today and every existing test would still pass if a SEVENTH took
 *     `req.params.userId`. A protection provided by never doing something needs a
 *     guard over the whole surface, not a case per resource.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  getLayout, putLayout, getNote, putNote, getBriefingConfig, putBriefingConfig,
} from '../src/features/dashboard/dashboardService.js';

const ROUTES = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'features', 'dashboard', 'routes.ts');
const A = 'tenant-alpha';
const B = 'tenant-beta';
const WHO = 'user:same-external-id'; // the SAME subject id in both tenants

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('EDBC-6a — the (tenant, subject) key isolates on the TENANT half too', () => {
  it('layout: the same subject id in a second tenant sees nothing, and writing there cannot clobber', async () => {
    await putLayout(A, WHO, [{ id: 'active-runs', order: 0, size: 'half', enabled: true }]);
    expect(await getLayout(B, WHO), 'tenant B must not read tenant A rows').toBeNull();
    await putLayout(B, WHO, [{ id: 'notes', order: 0, size: 'full', enabled: true }]);
    const a = await getLayout(A, WHO);
    expect(a?.tiles.map((t) => t.id), "tenant B's write must not reach tenant A").toEqual(['active-runs']);
  });

  it('note: same isolation (the private-text resource, where a leak is worst)', async () => {
    await putNote(A, WHO, 'alpha private note');
    expect(await getNote(B, WHO)).toBeNull();
    await putNote(B, WHO, 'beta note');
    expect((await getNote(A, WHO))?.text).toBe('alpha private note');
  });

  it('briefing: same isolation (a pointer at a conversation the other tenant must not learn)', async () => {
    await putBriefingConfig(A, WHO, 'conv-alpha');
    expect(await getBriefingConfig(B, WHO)).toBeNull();
    await putBriefingConfig(B, WHO, 'conv-beta');
    expect((await getBriefingConfig(A, WHO))?.conversationId).toBe('conv-alpha');
  });

  it('control: within ONE tenant the same calls DO round-trip (so the nulls above are isolation, not a dead store)', async () => {
    await putLayout(A, WHO, [{ id: 'notes', order: 0, size: 'half', enabled: true }]);
    expect((await getLayout(A, WHO))?.tiles.map((t) => t.id)).toEqual(['notes']);
    await putNote(A, WHO, 'x');
    expect((await getNote(A, WHO))?.text).toBe('x');
  });
});

describe('EDBC-6a — EVERY dashboard handler keys off the SESSION, never request input (class guard)', () => {
  const src = readFileSync(ROUTES, 'utf8');
  // Strip comments: prose in this file legitimately discusses `req.body` and
  // "request input", and a detector that counts comments measures the wrong thing
  // (the trap that bit the GATE-EPIPE ratchet and a slice marker the same night).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  it('every registered handler calls requireSubject, and the counts MATCH', () => {
    const handlers = code.match(/app\.(get|put|post|patch|delete)\(/g) ?? [];
    const derives = code.match(/requireSubject\(req\)/g) ?? [];
    expect(handlers.length, 'there must be handlers to check').toBeGreaterThan(0);
    expect(derives.length, 'one session-derivation per handler — a new route must not skip it').toBe(handlers.length);
  });

  it('no handler reads a subject/user/tenant identifier out of params, body or query', () => {
    // `parseTiles(req.body)` is fine — that is CONTENT. What must never appear is
    // an IDENTITY taken from the request, which is exactly what IDOR needs.
    expect(code).not.toMatch(/req\.(params|query)\s*\.\s*(userId|subject|tenantId|tenant|user)\b/);
    expect(code).not.toMatch(/req\.body\s*[.[]\s*['"]?(userId|subject|tenantId)\b/);
    expect(code).not.toMatch(/\breq\.params\b/); // the routes declare no :param at all
  });

  it('the derivation reads ONLY session-side identity and fails closed', () => {
    expect(code).toMatch(/const subject = req\.userId \?\? req\.principal\?\.principalId/);
    expect(code).toMatch(/throw new OpenwopError\('unauthenticated'/);
  });

  it('control: the detectors FIRE on a planted violation (so the negatives above are measurements)', () => {
    const planted = `${code}\napp.get('/x', (req) => getLayout(req.params.tenantId, req.params.userId));`;
    const handlers = (planted.match(/app\.(get|put|post|patch|delete)\(/g) ?? []).length;
    const derives = (planted.match(/requireSubject\(req\)/g) ?? []).length;
    expect(derives, 'the count guard must notice the extra handler').not.toBe(handlers);
    expect(planted, 'the identity-from-request guard must notice it too').toMatch(/req\.params\s*\.\s*userId\b/);
  });
});
