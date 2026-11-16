/**
 * ADR 0666 D1, re-keyed by ADR 0982 D2 — the grant the consent ROUTE files is the grant the lane
 * reads, and the notes land where the Personal Memory route lists them.
 *
 * History. ADR 0666 found the lane read `user:user:<hash>` while the route filed `user:<hash>`, so
 * nothing had ever been written. ADR 0982 then found the route keyed on `callerSubject` in the
 * ACTIVE tenant while Personal Memory lists `(home tenant, canonical User.userId)`: an unbound
 * `oidc:` session or a shared-workspace chat wrote notes no list shows. Both doors now resolve the
 * person through `resolveCallerUser` and key on the canonical id in the home tenant. Prod had 0
 * grant rows on 2026-10-26, so the re-key strands nothing.
 *
 * These legs go through the REAL route (an OIDC caller as the auth middleware stamps one) and the
 * REAL lane, never a hand-filed key, so a key-form drift on either side reds them.
 *
 * Sabotage witnesses (grade-tests wave 111 g1, `w111g1-gk-*`): filing the PUT in the ACTIVE
 * workspace (route-active) or on the principal (route-principal), keying the lane's grant read on
 * `actingUserId` (lane-key), or moving the note scope (note-scope) each red BORN RED; the GET
 * reading another key (get-read) or the DELETE filing `true` (delete) red GET/DELETE; honouring a
 * revoked grant (revoked) reds FAIL-CLOSED; a subject-tolerant grant read (tolerant) reds ANOTHER
 * person; `available` true for a non-`user:` home (available), the PUT not refusing it (put-409)
 * or the DELETE refusing it (delete-allowed) red the no-personal-workspace case.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerMemoryExtractRoutes } from '../src/features/memory-auto-extract/routes.js';
import { setExtractionGrant, getExtractionGrant } from '../src/features/memory-auto-extract/grantService.js';
import { extractConversationMemory } from '../src/features/memory-auto-extract/extractionBinding.js';
import { countSubjectNotes, listSubjectNotes } from '../src/host/subjectMemory.js';
import { personSubject } from '../src/host/subject.js';
import type { ExtractorResult } from '../src/features/memory-auto-extract/memoryExtractor.js';
import { personalChat } from './helpers/personalChatRun.js';

const facts = (...f: string[]) => async (): Promise<ExtractorResult> => ({ status: 'ok', facts: f.map((fact) => ({ fact, category: 'other' as const })), rejected: 0 });

let server: Server; let base = '';
beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr0982-key-')) });
  initHostExtPersistence(await openStorage('memory://'));
  const app = express();
  // An OIDC caller as the auth middleware stamps one: principal + personal tenant, optionally an
  // ACTIVE shared workspace (`x-active`), and no `userId` (an unbound session).
  app.use((req, _res, next) => {
    const sub = req.header('x-sub') ?? 'none';
    (req as { principal?: unknown }).principal = { principalId: `oidc:${sub}`, tenants: ['*'], token: 't' };
    const home = req.header('x-home') ?? `user:${sub}-home`;
    (req as { personalTenant?: string }).personalTenant = home;
    (req as { tenantId?: string }).tenantId = req.header('x-active') ?? home;
    next();
  });
  registerMemoryExtractRoutes({ app } as never);
  // Echo the refusal's code and reason, so a case can tell WHICH guard answered.
  app.use((err: { httpStatus?: number; code?: string; details?: { reason?: unknown } }, _req: unknown, res: express.Response, _next: unknown) => {
    res.status(err.httpStatus ?? 500).json({ error: err.code ?? null, reason: err.details?.reason ?? null });
  });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/host/openwop-app/profiles/me/memory-extraction`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('ADR 0982 D2 — the route files the grant where the lane reads it', () => {
  it('BORN RED — opted in from a SHARED workspace, an unbound session\'s chat lands in the listable scope', async () => {
    const p = await personalChat('gk-born');
    const put = await fetch(base, { method: 'PUT', headers: { 'x-sub': 'gk-born', 'x-active': 'ws:team-1' } });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ granted: true, available: true });
    // Filed on the HOME tenant + canonical id, not on the active workspace or the principal.
    expect(await getExtractionGrant(p.home, p.userId)).toMatchObject({ granted: true });
    expect(await getExtractionGrant('ws:team-1', p.principal)).toBeNull();

    // The chat is stamped with the unbound principal, as `POST /runs` stamps it before a bind.
    const r = await extractConversationMemory(await p.run({ acting: p.principal }), ['I keep bees'], facts('Keeps bees'));
    expect(r).toEqual({ status: 'written', written: 1, duplicates: 0, rejected: 0, suppressed: 0, failedWrites: 0, budgetFull: false });
    const listed = await listSubjectNotes(p.home, personSubject(p.userId));
    expect(listed.map((n) => n.content)).toEqual(['Keeps bees']);
    expect(await countSubjectNotes(p.home, personSubject(p.principal))).toBe(0);
  });

  it('GET reports the grant the lane reads; DELETE revokes it', async () => {
    const p = await personalChat('gk-get');
    expect((await fetch(base, { method: 'PUT', headers: { 'x-sub': 'gk-get' } })).status).toBe(200);
    expect(await (await fetch(base, { headers: { 'x-sub': 'gk-get' } })).json()).toMatchObject({ granted: true, available: true });
    expect((await fetch(base, { method: 'DELETE', headers: { 'x-sub': 'gk-get' } })).status).toBe(204);
    expect(await getExtractionGrant(p.home, p.userId)).toMatchObject({ granted: false });
    expect(await (await fetch(base, { headers: { 'x-sub': 'gk-get' } })).json()).toMatchObject({ granted: false, available: true });
    // The lane reads the same row: revoked through the route, it no longer extracts.
    expect(await extractConversationMemory(await p.run(), ['x'], facts('should not land'))).toEqual({ status: 'skipped', reason: 'no-consent' });
    expect(await countSubjectNotes(p.home, personSubject(p.userId))).toBe(0);
  });

  it('an account with no personal workspace is told so: GET available:false, PUT refused 409, DELETE allowed', async () => {
    // A SAML-style deployment tenant as the home tenant: it can never extract (ADR 0982 D1/D2).
    const headers = { 'x-sub': 'gk-saml', 'x-home': 'host-saml' };
    expect(await (await fetch(base, { headers })).json()).toEqual({ granted: false, updatedAt: null, available: false });
    const put = await fetch(base, { method: 'PUT', headers });
    expect(put.status).toBe(409);
    expect(await put.json()).toEqual({ error: 'conflict', reason: 'memory_extraction_unavailable' });
    expect((await fetch(base, { method: 'DELETE', headers })).status).toBe(204);
  });

  it('still FAIL-CLOSED with no grant, and with a revoked one', async () => {
    const p = await personalChat('gk-closed');
    expect(await extractConversationMemory(await p.run(), ['x'], facts('should not land'))).toEqual({ status: 'skipped', reason: 'no-consent' });
    await setExtractionGrant(p.home, p.userId, false, p.userId);
    expect(await extractConversationMemory(await p.run(), ['x'], facts('should not land'))).toEqual({ status: 'skipped', reason: 'no-consent' });
    expect(await countSubjectNotes(p.home, personSubject(p.userId))).toBe(0);
  });

  it('a grant for ANOTHER person does not authorize this one', async () => {
    const p = await personalChat('gk-target');
    const other = await personalChat('gk-other');
    await setExtractionGrant(p.home, other.userId, true, other.userId);
    expect(await extractConversationMemory(await p.run(), ['x'], facts('should not land'))).toEqual({ status: 'skipped', reason: 'no-consent' });
    expect(await countSubjectNotes(p.home, personSubject(p.userId))).toBe(0);
  });
});
