/**
 * PMXWF-1 (ADR 0590) — tenant teardown must not orphan the Priority Matrix
 * overlay collections.
 *
 * Five collections carry rows keyed `listId::cardId[::voterId]` (or `ev:…`)
 * with NEITHER a `tenantOf` NOR a JSON `tenantId`: `priority-matrix:score`,
 * `priority-matrix:vote`, `priority-matrix:schedule`, `priority:intake`,
 * `priority:evidence`. The generic `purgeTenantHostExt` walk cannot match them,
 * and the SAME walk deletes the `priority-matrix:list` rows that are their only
 * tenant resolution — so account deletion permanently orphaned rows carrying
 * PII (`IdeaIntake.requester` operator-typed names/emails, `addedBy`,
 * `voterId`). The KT-D1 `purgeTenantKanban` pre-step is the in-tree precedent;
 * this feature now registers a tenant-purge hook that `purgeTenantHostExt` runs
 * FIRST, while the list rows still resolve the tenant — covering BOTH lanes
 * (account delete AND the anon-teardown sweep) at the one composition owner.
 *
 * The discriminator (a prescribed fix can be an attack): a SECOND tenant's PM
 * rows must survive the first tenant's purge byte-identical.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { purgeTenantHostExt, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { __pmStoresForErasure } from '../src/features/priority-matrix/priorityMatrixService.js';
import { __intakeStoresForErasure } from '../src/features/priority-matrix/intake.js';

let BASE = '';
let closeApp: () => Promise<void>;
beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  await enableToggle('priority-matrix', 'on');
});
afterAll(async () => { await closeApp(); });

const L = '/v1/host/openwop-app/priority-matrix/lists';

interface Seeded { c: Client; tenantId: string; orgId: string; listIds: string[]; cardIds: string[] }

/** Seed a tenant with a single-scorer list (score + schedule + intake +
 *  evidence) AND a multi-voter list (vote row) — every orphanable collection
 *  gets at least one row. */
async function seedTenant(prefix: string): Promise<Seeded> {
  const c = makeClient(() => BASE);
  const tenantId = `org:${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const login = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail(prefix), tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const orgId = (await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;

  const single = (await c.post(L, { orgId, name: 'Single bets', presetId: 'weighted' })).body;
  const multi = (await c.post(L, { orgId, name: 'Multi bets', presetId: 'weighted', votingMode: 'multi-voter' })).body;
  const cardIds: string[] = [];
  for (const listId of [single.id, multi.id]) {
    const idea = await c.post(`${L}/${listId}/ideas`, { title: `Idea in ${listId}` });
    expect(idea.status, JSON.stringify(idea.body)).toBe(201);
    cardIds.push(idea.body.id);
    expect((await c.put(`${L}/${listId}/ideas/${idea.body.id}/scores`, { scores: { roi: 8 } })).status).toBe(200);
  }
  // Schedule + intake (with PII-shaped requester) + evidence on the single list.
  expect((await c.put(`${L}/${single.id}/ideas/${cardIds[0]}/schedule`, { targetDate: '2027-01-31' })).status).toBe(200);
  expect((await c.patch(`${L}/${single.id}/ideas/${cardIds[0]}/intake`, { requester: 'Ada Lovelace <ada@acme.test>' })).status).toBe(200);
  expect((await c.post(`${L}/${single.id}/ideas/${cardIds[0]}/evidence`, { kind: 'url', ref: 'https://example.test/evidence' })).status).toBe(201);
  return { c, tenantId, orgId, listIds: [single.id, multi.id], cardIds };
}

/** Count PM overlay rows belonging to the given list ids, per collection. */
async function overlayRowCounts(listIds: string[]): Promise<Record<string, number>> {
  const mine = new Set(listIds);
  const { scores, votes, schedules } = __pmStoresForErasure();
  const { intakes, evidence } = __intakeStoresForErasure();
  return {
    scores: (await scores.list()).filter((r) => mine.has(r.listId)).length,
    votes: (await votes.list()).filter((r) => mine.has(r.listId)).length,
    schedules: (await schedules.list()).filter((r) => mine.has(r.listId)).length,
    intakes: (await intakes.list()).filter((r) => mine.has(r.listId)).length,
    evidence: (await evidence.list()).filter((r) => mine.has(r.listId)).length,
  };
}

describe('PMXWF-1 — teardown purges the five tenant-unresolvable PM overlay collections', () => {
  it('purgeTenantHostExt leaves ZERO residual PM rows for the torn-down tenant — and the second tenant survives untouched', async () => {
    const a = await seedTenant('pmxa');
    const b = await seedTenant('pmxb');

    // Pre-flight: the seed really wrote every orphanable collection (a witness
    // over nothing proves nothing).
    const beforeA = await overlayRowCounts(a.listIds);
    expect(beforeA).toEqual({ scores: 1, votes: 1, schedules: 1, intakes: 1, evidence: 1 });
    const beforeB = await overlayRowCounts(b.listIds);
    expect(beforeB.scores).toBe(1);

    await purgeTenantHostExt(a.tenantId);

    // The five orphanable collections hold NOTHING for tenant A's lists.
    expect(await overlayRowCounts(a.listIds)).toEqual({ scores: 0, votes: 0, schedules: 0, intakes: 0, evidence: 0 });

    // Class-enumeration belt: no `hostext:priority*` key anywhere still names
    // one of tenant A's list ids (catches a sixth store this test forgot).
    const rows = await hostExtStorage().kvList('hostext:priority');
    const leaked = rows.filter(({ key, value }) => a.listIds.some((id) => key.includes(id) || value.includes(id)));
    expect(leaked.map((r) => r.key)).toEqual([]);

    // Discriminator — tenant B's rows survive tenant A's purge (a purge that
    // fans out beyond its tenant would be a cross-tenant destructive write).
    expect(await overlayRowCounts(b.listIds)).toEqual(beforeB);
    // B's PII field is intact, not scrubbed.
    const bIntake = (await b.c.get(`${L}/${b.listIds[0]}/ideas/${b.cardIds[0]}/intake`)).body.intake;
    expect(bIntake.requester).toBe('Ada Lovelace <ada@acme.test>');
  });

  it('is idempotent: a second purge finds nothing and does not throw', async () => {
    const a = await seedTenant('pmxc');
    await purgeTenantHostExt(a.tenantId);
    await purgeTenantHostExt(a.tenantId);
    expect(await overlayRowCounts(a.listIds)).toEqual({ scores: 0, votes: 0, schedules: 0, intakes: 0, evidence: 0 });
  });
});
