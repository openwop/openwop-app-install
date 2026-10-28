/**
 * ADR 0982 D6 — deleting a LEARNED fact on the Personal Memory route tells the extraction lane
 * never to learn it again, and nothing else.
 *
 * Before this, a person who deleted a learned fact saw it come back the next time they restated
 * it, with no way to say "stop learning this". The tombstone is written by the route (which reads
 * the row's source first), never by `removeSubjectNote`, which deletes by id and is shared with the
 * org, project and agent lanes (architect A5).
 *
 * Driven through the real route with an OIDC caller as the auth middleware stamps one, and the
 * real lane with only the provider faked.
 *
 * Witnessed (row 57 sabotage, see the PR): dropping the route's tombstone write reds case 1;
 * tombstoning regardless of source reds case 2; letting the tombstone gate a typed add reds case 3.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerProfileMemoryRoutes } from '../src/features/profile-memory/routes.js';
import { setExtractionGrant } from '../src/features/memory-auto-extract/grantService.js';
import { extractConversationMemory } from '../src/features/memory-auto-extract/extractionBinding.js';
import { addSubjectNote, listSubjectNotes, forgottenFactMatcher } from '../src/host/subjectMemory.js';
import { personSubject } from '../src/host/subject.js';
import type { ExtractorResult } from '../src/features/memory-auto-extract/memoryExtractor.js';
import { personalChat } from './helpers/personalChatRun.js';

const facts = (...f: string[]) => async (): Promise<ExtractorResult> => ({ status: 'ok', facts: f.map((fact) => ({ fact, category: 'other' as const })), rejected: 0 });

let server: Server; let base = '';
beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr0982-forget-')) });
  initHostExtPersistence(await openStorage('memory://'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.header('x-sub') ?? 'none';
    (req as { principal?: unknown }).principal = { principalId: `oidc:${sub}`, tenants: ['*'], token: 't' };
    (req as { personalTenant?: string }).personalTenant = `user:${sub}-home`;
    (req as { tenantId?: string }).tenantId = `user:${sub}-home`;
    next();
  });
  registerProfileMemoryRoutes({ app } as never);
  app.use((err: { httpStatus?: number }, _req: unknown, res: express.Response, _next: unknown) => { res.status(err.httpStatus ?? 500).json({}); });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/host/openwop-app/profiles/me/memory`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('ADR 0982 D6 — "forget" sticks', () => {
  it('a learned fact the person deleted is not learned again', async () => {
    const p = await personalChat('fg-1');
    await setExtractionGrant(p.home, p.userId, true, p.userId);
    expect(await extractConversationMemory(await p.run(), ['I keep bees'], facts('Keeps bees'))).toMatchObject({ status: 'written', written: 1 });
    const [learned] = await listSubjectNotes(p.home, personSubject(p.userId));
    expect(learned?.source, 'precondition: a learned note').toBe('auto-extract');

    expect((await fetch(`${base}/${learned!.id}`, { method: 'DELETE', headers: { 'x-sub': 'fg-1' } })).status).toBe(204);

    const again = await extractConversationMemory(await p.run(), ['I keep bees'], facts('keeps bees.'));
    expect(again).toEqual({ status: 'nothing-new', duplicates: 0, suppressed: 1, budgetFull: false });
    expect(await listSubjectNotes(p.home, personSubject(p.userId))).toHaveLength(0);
  });

  it('a learned fact the secret scrubber altered still stays forgotten (code-review #3)', async () => {
    const p = await personalChat('fg-scrub');
    await setExtractionGrant(p.home, p.userId, true, p.userId);
    const raw = 'Uses deploy key sk-abcdefghijklmnop for staging';
    expect(await extractConversationMemory(await p.run(), ['I use deploy key sk-abcdefghijklmnop for staging'], facts(raw))).toMatchObject({ status: 'written', written: 1 });
    const [learned] = await listSubjectNotes(p.home, personSubject(p.userId));
    expect(learned?.content, 'precondition: the stored note was scrubbed').not.toContain('sk-abcdefghijklmnop');
    await fetch(`${base}/${learned!.id}`, { method: 'DELETE', headers: { 'x-sub': 'fg-scrub' } });
    expect(await extractConversationMemory(await p.run(), ['I use deploy key sk-abcdefghijklmnop for staging'], facts(raw))).toMatchObject({ status: 'nothing-new', suppressed: 1 });
  });

  it('deleting a TYPED note records nothing', async () => {
    const p = await personalChat('fg-2');
    const { id } = await addSubjectNote(p.home, personSubject(p.userId), 'Lives in Lisbon');
    expect((await fetch(`${base}/${id}`, { method: 'DELETE', headers: { 'x-sub': 'fg-2' } })).status).toBe(204);
    expect((await forgottenFactMatcher(p.home, personSubject(p.userId)))('Lives in Lisbon')).toBe(false);
  });

  it('a tombstone never blocks the person typing the fact themselves', async () => {
    const p = await personalChat('fg-3');
    await setExtractionGrant(p.home, p.userId, true, p.userId);
    await extractConversationMemory(await p.run(), ['I keep bees'], facts('Keeps bees'));
    const [learned] = await listSubjectNotes(p.home, personSubject(p.userId));
    await fetch(`${base}/${learned!.id}`, { method: 'DELETE', headers: { 'x-sub': 'fg-3' } });
    const add = await fetch(base, { method: 'POST', headers: { 'x-sub': 'fg-3', 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Keeps bees' }) });
    expect(add.status).toBe(201);
    const notes = await listSubjectNotes(p.home, personSubject(p.userId));
    expect(notes.map((n) => [n.content, n.source])).toEqual([['Keeps bees', 'user']]);
  });
});
