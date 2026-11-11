/**
 * ADR 1045 CHAN-F14 — the one-time rewrite of stored legacy env-key ids
 * (`bearer:<first 8 raw key chars>`) to the id the same key presents today.
 *
 * Two configured keys share the `sk-live-` prefix (AMBIGUOUS: nothing says which
 * minted a `bearer:sk-live-` record, so those are left), and one key holds the
 * `uniq-key` prefix alone (MAPPED). Legs, on real stores:
 *  (a) report mode counts what apply would change and writes nothing;
 *  (b) apply rewrites the mapped id in a developer-key delegation's `createdBy`
 *      (real `issueApiKey` row), in a tenant-indexed row AND its index marker
 *      projection, re-keys an org member (and the membership check follows it),
 *      and rewrites `actingUserId` on a STAMPED run;
 *  (c) apply leaves: the ambiguous prefix's rows, an audit collection's row, an
 *      UNSTAMPED run (its owner echo derives from `actingUserId`), and counts each;
 *  (d) a second apply changes nothing (idempotent);
 *  (e) the job is off without the env, stays pending in report mode, and
 *      completes in apply mode.
 *
 * The new id is a LITERAL, derived outside the product:
 * `printf %s uniq-key-0004 | shasum -a 256 | cut -c1-16` → 5444aa090cdc1f1d.
 *
 * Red when: report mode writes; apply misses a store above or rewrites a left
 * one; an ambiguous prefix is mapped; a re-run changes anything; the job marks
 * itself done outside apply.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { DurableCollection, initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { runLegacyBearerIdRewrite, LEGACY_BEARER_REWRITE_ENV } from '../src/host/legacyBearerIdRewrite.js';
import { BACKGROUND_APP_JOBS } from '../src/host/appMigrations.js';
import { createMember, isWorkspaceMember } from '../src/host/accessControlService.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
// Registers the real `brand:audit` collection (the walk sees only registered ones, as at boot).
import '../src/features/brand/brandService.js';

const KEY_A = 'sk-live-alpha-0001';
const KEY_B = 'sk-live-bravo-0002';
const KEY_U = 'uniq-key-0004';
const LEGACY_U = 'bearer:uniq-key';
const LEGACY_AMBIG = 'bearer:sk-live-';
const NEW_U = 'bearer:5444aa090cdc1f1d';
const T = 'adr1045-f14';

interface Row { id: string; tenantId: string; ownerUserId: string; note: string; history: Array<{ by: string }> }
const rows = new DurableCollection<Row>('adr1045-f14:row', (r) => r.id, undefined, (r) => r.tenantId, (r) => ({ owner: r.ownerUserId }));

const saved: Record<string, string | undefined> = {};
let storage: Storage;

async function kvJson(key: string): Promise<Record<string, unknown>> {
  const v = await storage.kvGet(key);
  expect(v, key).not.toBeNull();
  return JSON.parse(v!) as Record<string, unknown>;
}
async function run(runId: string): Promise<Record<string, unknown>> {
  return (await storage.getRun(runId))!.metadata;
}
const job = BACKGROUND_APP_JOBS.find((j) => j.id === 'legacy-bearer-id-rewrite')!;

let delegationKey = '';
beforeAll(async () => {
  for (const k of ['OPENWOP_API_KEYS', LEGACY_BEARER_REWRITE_ENV]) saved[k] = process.env[k];
  process.env.OPENWOP_API_KEYS = `${KEY_A}:${T},${KEY_B}:${T},${KEY_U}:${T}`;
  delete process.env[LEGACY_BEARER_REWRITE_ENV];
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);

  const { key } = await issueApiKey({ tenantId: T, name: 'legacy delegation', createdBy: LEGACY_U });
  delegationKey = `hostext:devkey:record:${key.keyId}`;
  await rows.put({ id: 'u', tenantId: T, ownerUserId: LEGACY_U, note: 'mentions bearer:uniq-key inline', history: [{ by: LEGACY_U }, { by: 'user:someone' }] });
  await rows.put({ id: 'a', tenantId: T, ownerUserId: LEGACY_AMBIG, note: '', history: [] });
  await storage.kvSet('hostext:brand:audit:f14', JSON.stringify({ id: 'f14', actor: LEGACY_U }));
  await createMember({ orgId: T, tenantId: T, displayName: 'Env key', subject: LEGACY_U, roles: ['owner'] });
  const now = new Date().toISOString();
  const base = { workflowId: 'wf', tenantId: T, status: 'completed' as const, inputs: null, configurable: {}, createdAt: now, updatedAt: now };
  await storage.insertRun({ ...base, runId: 'f14-stamped', metadata: { actingUserId: LEGACY_U, owner: { principal: 'p', subject: { issuer: 'x', subjectId: 'p', lane: 'api-key', kind: 'workload' } } } });
  await storage.insertRun({ ...base, runId: 'f14-unstamped', metadata: { actingUserId: LEGACY_U } });
  await storage.insertRun({ ...base, runId: 'f14-ambig', metadata: { actingUserId: LEGACY_AMBIG, owner: { principal: 'q' } } });
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetHostExtPersistence();
  await storage.close();
});

describe('(a) report mode', () => {
  it('counts what apply would change and writes nothing', async () => {
    const before = JSON.stringify(await storage.kvList('hostext'));
    const r = await runLegacyBearerIdRewrite(storage, 'report');
    expect(r).toMatchObject({ mode: 'report', configuredKeys: 3, mappedPrefixes: 1, ambiguousPrefixes: 1, members: 1, runs: 1, unstampedRunsLeft: 1, auditRowsLeft: 1, conflicts: 0, failures: 0 });
    expect(r.rowsByCollection).toEqual({ 'devkey:record': 1, 'adr1045-f14:row': 1 });
    expect(r.markers).toBe(1);
    expect(r.unmappedValues).toBeGreaterThanOrEqual(2); // the ambiguous row's owner + its marker
    expect(JSON.stringify(await storage.kvList('hostext'))).toBe(before);
    expect((await run('f14-stamped')).actingUserId).toBe(LEGACY_U);
  });
});

describe('(b)–(c) apply mode', () => {
  it('rewrites the mapped id where it is an identity reference, and leaves the rest', async () => {
    const r = await runLegacyBearerIdRewrite(storage, 'apply');
    expect(r).toMatchObject({ mode: 'apply', members: 1, runs: 1, unstampedRunsLeft: 1, auditRowsLeft: 1, conflicts: 0, failures: 0 });

    // (b) rewritten
    expect((await kvJson(delegationKey)).createdBy).toBe(NEW_U);
    const u = await rows.get('u');
    expect(u?.ownerUserId).toBe(NEW_U);
    expect(u?.history).toEqual([{ by: NEW_U }, { by: 'user:someone' }]);
    expect(u?.note).toBe('mentions bearer:uniq-key inline'); // a substring is not an id
    const marker = await kvJson(`hostextidx:adr1045-f14:row:${T}:u`);
    expect(JSON.stringify(marker)).toContain(NEW_U);
    expect(JSON.stringify(marker)).not.toContain(LEGACY_U);
    expect(await isWorkspaceMember(NEW_U, T)).toBe(true);
    expect(await isWorkspaceMember(LEGACY_U, T)).toBe(false);
    expect((await run('f14-stamped')).actingUserId).toBe(NEW_U);

    // (c) left
    expect((await rows.get('a'))?.ownerUserId).toBe(LEGACY_AMBIG);
    expect((await run('f14-ambig')).actingUserId).toBe(LEGACY_AMBIG);
    expect((await kvJson('hostext:brand:audit:f14')).actor).toBe(LEGACY_U);
    expect((await run('f14-unstamped')).actingUserId).toBe(LEGACY_U);
  });

  it('(d) a second apply changes nothing', async () => {
    const before = JSON.stringify(await storage.kvList('hostext'));
    const r = await runLegacyBearerIdRewrite(storage, 'apply');
    expect(r).toMatchObject({ values: 0, members: 0, runs: 0, rowsByCollection: {}, markers: 0 });
    expect(JSON.stringify(await storage.kvList('hostext'))).toBe(before);
  });
});

describe('(e) the background job', () => {
  it('is off without the env, stays pending in report mode, and completes in apply mode', async () => {
    delete process.env[LEGACY_BEARER_REWRITE_ENV];
    expect(await job.run(storage)).toEqual({ complete: false });
    process.env[LEGACY_BEARER_REWRITE_ENV] = 'report';
    expect(await job.run(storage)).toEqual({ complete: false });
    process.env[LEGACY_BEARER_REWRITE_ENV] = 'apply';
    expect(await job.run(storage)).toEqual({ complete: true });
    delete process.env[LEGACY_BEARER_REWRITE_ENV];
  });
});
