/**
 * ADR 1101 D2 (`KS2WF-2`) — the knowledge-sync lane PINS its bound connection on every
 * brokered call, so a pass can only ever read a folder as the account the user chose.
 *
 * Unpinned, the broker ran its user → org → workspace fall-through: a bound token that
 * stopped being `active` silently read the folder as the org's or the workspace's
 * account, and a "complete" listing under that view pruned every document the bound
 * user could see and it cannot.
 *
 *  - BEHAVIOUR: each provider's listing and each fetch path passes `deps.connectionId`
 *    to `brokeredFetch` as the call's `connectionId`. Red if `pinOf(deps)` is removed
 *    from any one of them, or if `pinOf` stops reading the field.
 *  - RATCHET: EVERY `brokeredFetch(` call in `host/knowledgeSourceFetch.ts` spreads the
 *    pin. A new call site that forgets it falls through silently, and the behaviour
 *    legs only cover the paths they drive. Sabotage: delete `...pinOf(deps), ` from any
 *    one call ⇒ the count leg is red.
 *  - The unpinned lane is unchanged: no `connectionId` in deps ⇒ no pin in the call.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Response } from 'undici';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';

vi.mock('../src/host/brokeredEgress.js', () => ({ brokeredFetch: vi.fn() }));
import { brokeredFetch } from '../src/host/brokeredEgress.js';
import { listFolder, fetchKnowledgeSource, browseFolders, type KnowledgeFetchDeps } from '../src/host/knowledgeSourceFetch.js';
import { stripComments } from './helpers/stripComments.js';

const mFetch = vi.mocked(brokeredFetch);
type Brokered = Awaited<ReturnType<typeof brokeredFetch>>;
const sent = (body: unknown): Brokered => ({
  outcome: 'sent',
  get res() { return new Response(JSON.stringify(body), { status: 200 }); },
  provenance: { connectionId: 'c-bound', provider: 'test' },
});

let base: KnowledgeFetchDeps;
beforeAll(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  base = { storage, tenantId: 't1', actingUserId: 'user:a', orgId: 'org1' };
});
afterEach(() => vi.clearAllMocks());

const pins = (): Array<string | undefined> => mFetch.mock.calls.map((c) => (c[1] as { connectionId?: string }).connectionId);

describe('every listing pins the bound connection', () => {
  for (const [provider, folder, body] of [
    ['google', 'FOLDER1', { files: [] }],
    ['microsoft-graph', 'root', { value: [] }],
    ['microsoft-sharepoint', 'drive1', { value: [] }],
    ['dropbox', '/Reports', { entries: [], has_more: false }],
    ['box', 'root', { entries: [], total_count: 0 }],
  ] as const) {
    it(`${provider}`, async () => {
      mFetch.mockResolvedValue(sent(body));
      await listFolder({ ...base, connectionId: 'c-bound' }, provider, folder).catch(() => undefined);
      expect(mFetch).toHaveBeenCalled();
      expect(new Set(pins()), 'a listing call fell through to the broker\'s user → org → workspace pick').toEqual(new Set(['c-bound']));
    });
  }
});

it('a fetch pins it too, and browse does', async () => {
  mFetch.mockResolvedValue(sent({ name: 'Doc', mimeType: 'text/plain' }));
  await fetchKnowledgeSource({ ...base, connectionId: 'c-bound' }, { provider: 'google', ref: '1AbcDEF_ghiJKL-mnoPQRstuVWxyz0123456789' }).catch(() => undefined);
  mFetch.mockResolvedValue(sent({ files: [] }));
  await browseFolders({ ...base, connectionId: 'c-bound' }, 'google', 'root').catch(() => undefined);
  expect(mFetch.mock.calls.length).toBeGreaterThan(1);
  expect(new Set(pins())).toEqual(new Set(['c-bound']));
});

it('without a connectionId the call is unpinned (the agent-knowledge import lane, unchanged)', async () => {
  mFetch.mockResolvedValue(sent({ files: [] }));
  await listFolder(base, 'google', 'FOLDER1');
  expect(pins().every((p) => p === undefined)).toBe(true);
});

it('RATCHET: every brokeredFetch( call in knowledgeSourceFetch.ts spreads the pin', () => {
  const src = stripComments(readFileSync(fileURLToPath(new URL('../src/host/knowledgeSourceFetch.ts', import.meta.url)), 'utf8'));
  const calls = [...src.matchAll(/brokeredFetch\(/g)].length;
  const pinned = [...src.matchAll(/brokeredFetch\(egressDeps, \{ \.\.\.pinOf\(deps\), /g)].length;
  expect(calls, 'non-vacuity: the file still makes brokered calls').toBeGreaterThan(10);
  expect(pinned, 'a brokeredFetch call does not pass the connection pin').toBe(calls);
});
