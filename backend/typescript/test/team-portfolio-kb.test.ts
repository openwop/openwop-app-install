/**
 * ADR 0172 P4 fold-in — team profiles auto-index into the tenant-level
 * `Team Portfolio KB` collection (gated on `production`). §Correction: profiles are
 * tenant-scoped, so the collection is `mgd-team-<tenant>` under the reserved
 * sentinel org `_team`, NOT the per-org vendor collection. Plus GRADE DATA-4 /
 * TPK-1 (ADR 0100 D2): the shareable-KB provider ensures + BACKFILLS + resolves it.
 *
 * Reads past the G8 managed-plan gate. With `production` OFF, `kbService` hides the
 * managed collection from an ordinary read (and refuses the write), so an ordinary
 * `getDocument` answers null whatever the indexer did. The toggle case therefore
 * reads with `KB_MAINTENANCE_CALLER` and asserts the collection was never MINTED.
 *
 * The `ctx.features.profiles` surface case that used to live here was cut: it is
 * covered by `profiles-node-through-surface.test.ts` (list strips internal columns,
 * get on a seeded member, unknown id → null), and both went red under the same
 * sabotage (w3g2-tpk-surface-strip / -cover).
 *
 * Sabotage that turns it red:
 *   - PATCH /me not calling `indexProfile` → case 1 (w3g2-tpk-route-index)
 *   - `profileToText` dropping interests / emitting `contact.location` → case 1
 *     (w3g2-tpk-interests / -pii)
 *   - an empty profile not removed → case 1 (w3g2-tpk-remove-empty)
 *   - `gateOpen` → `true` → case 2 (w3g2-tpk-gate)
 *   - `ensureCollectionIds` not backfilling → case 3 (w3g2-tpk-backfill)
 *   - `resolveCollectionIds` unconditional → case 3 (w3g2-tpk-resolve)
 *   - `upsertDocument`'s content-hash skip disabled → case 3 (w3g2-tpk-idempotent)
 *
 * @see docs/adr/0172-production-intelligence-vendor-directory.md
 * @see docs/adr/0100-planning-knowledge-base.md
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getCollection, getDocument, KB_MAINTENANCE_CALLER } from '../src/features/kb/kbService.js';
import { teamPortfolioShareableKbProvider, backfillTeamPortfolioKb } from '../src/features/profiles/profilesKnowledgeService.js';

let BASE = '';
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'production']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: unknown }
interface MeBody { userId: string }

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}

/** A signed-in member of a fresh tenant, and their userId. */
async function member(prefix: string): Promise<{ c: ReturnType<typeof client>; tenantId: string; userId: string }> {
  const tenantId = `org:${prefix}-${n++}`;
  const c = client();
  const login = await c.post('/host/openwop-app/test/login', { email: `${prefix}-${n++}@t.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const me = await c.get('/host/openwop-app/profiles/me');
  expect(me.status, JSON.stringify(me.body)).toBe(200);
  return { c, tenantId, userId: (me.body as MeBody).userId };
}

async function setProduction(status: 'on' | 'off'): Promise<void> {
  const prod = getToggleDefault('production');
  expect(prod, 'the production toggle must exist').toBeTruthy();
  await saveConfig({ ...prod!, status }, 'test');
}

const teamCol = (tenantId: string): [string, string, string] => [tenantId, '_team', `mgd-team-${tenantId}`];

describe('Team Portfolio KB indexing (ADR 0172 P4 fold-in)', () => {
  it('indexes a member on profile edit; empties → removes; excludes PII', async () => {
    const { c, tenantId, userId } = await member('tpk');

    // Edit descriptive capability fields (+ a contact location = declared PII) → indexed.
    const patched = await c.patch('/host/openwop-app/profiles/me', { jobTitle: 'Video Editor', interests: ['motion graphics'], equipment: ['DaVinci Resolve'], contact: { location: 'SECRET-CITY-42', links: [] } });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const doc = await getDocument(...teamCol(tenantId), `profile:${userId}`);
    expect(doc, 'profile should be indexed after edit').not.toBeNull();
    expect(doc!.text).toContain('Video Editor');
    expect(doc!.text).toContain('motion graphics');
    expect(doc!.text).not.toContain('SECRET-CITY-42'); // contact/location PII is NOT indexed

    // Empty the capability signal → the doc is removed (no noise).
    const emptied = await c.patch('/host/openwop-app/profiles/me', { jobTitle: '', bio: '', interests: [], equipment: [] });
    expect(emptied.status, JSON.stringify(emptied.body)).toBe(200);
    expect(await getDocument(...teamCol(tenantId), `profile:${userId}`), 'empty profile should be unindexed').toBeNull();
  });

  it('is gated on the production toggle (off ⇒ no indexing)', async () => {
    await setProduction('off');
    try {
      const { c, tenantId, userId } = await member('tpk-off');
      const patched = await c.patch('/host/openwop-app/profiles/me', { jobTitle: 'Designer' });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200); // a real edit with signal — not a failed write
      // MAINTENANCE reads see past the G8 plan gate, so they observe the INDEXER:
      // no managed collection was minted, and no document written.
      expect(await getCollection(...teamCol(tenantId), KB_MAINTENANCE_CALLER), 'no Team Portfolio collection while production is off').toBeNull();
      expect(await getDocument(...teamCol(tenantId), `profile:${userId}`, KB_MAINTENANCE_CALLER)).toBeNull();
    } finally {
      await setProduction('on');
    }
  });
});

describe('Team Portfolio KB is retrievable (GRADE DATA-4 / TPK-1)', () => {
  it('the shareableKb provider ensures+backfills the collection and resolves it', async () => {
    // A profile that PRE-DATES indexing: edited while production was off, so only a
    // backfill can put it in the KB.
    await setProduction('off');
    const { tenantId, userId } = await (async () => {
      try {
        const m = await member('tpk-share');
        expect((await m.c.patch('/host/openwop-app/profiles/me', { jobTitle: 'Gaffer' })).status).toBe(200);
        return m;
      } finally {
        await setProduction('on');
      }
    })();

    // Nothing to resolve yet — the collection does not exist.
    expect(await teamPortfolioShareableKbProvider.resolveCollectionIds(tenantId, 'someOrg')).toEqual([]);

    // ensure creates + backfills…
    const ensured = await teamPortfolioShareableKbProvider.ensureCollectionIds!(tenantId, 'someOrg', userId);
    expect(ensured).toEqual([`mgd-team-${tenantId}`]);
    const doc = await getDocument(...teamCol(tenantId), `profile:${userId}`);
    expect(doc, 'the pre-existing profile must have been backfilled').not.toBeNull();
    expect(doc!.text).toContain('Gaffer');
    // …then resolve returns it.
    expect(await teamPortfolioShareableKbProvider.resolveCollectionIds(tenantId, 'someOrg')).toEqual([`mgd-team-${tenantId}`]);

    // Backfill is idempotent: a re-run over unchanged profiles rewrites nothing.
    await backfillTeamPortfolioKb(tenantId);
    const again = await getDocument(...teamCol(tenantId), `profile:${userId}`);
    expect(again?.text).toBe(doc!.text);
    expect(again?.revision, 'an unchanged profile must not be re-ingested').toBe(doc!.revision);
  });
});
