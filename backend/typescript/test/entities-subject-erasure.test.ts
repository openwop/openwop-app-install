/**
 * UX_UPGRADE-entities R2 — ENT2-M1.
 *
 * `entities` is subject-signalled and registered no eraser, so `eraseSubject`
 * fanned out to every registered feature and silently skipped this one. What it
 * skipped is narrow but real: the ATTRIBUTION fields (`createdBy` on types,
 * `createdBy`/`updatedBy` on records) — fields this codebase already classifies
 * itself: the anonymous-wire projection strips them because they are "member
 * subjects (PII-adjacent — MUST NOT reach the public wire)" (ADR 0407 D2). A
 * field the public wire must not carry is a field a DSAR must reach.
 *
 * The boundary case below PINS what the eraser deliberately does NOT touch:
 * `values`. Only the tenant's data model knows which value fields are personal;
 * a generic eraser guessing at keys would either miss (false completeness) or
 * destroy business data. Erasing a person who exists AS an entity is the
 * tenant's kernel-level record deletion.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import {
  createEntityType, createEntity, updateEntity, getEntity, getEntityType,
} from '../src/features/entities/entitiesService.js';
import { eraseEntitiesSubject } from '../src/features/entities/erasure.js';
import { ERASED } from '../src/host/subjectErasureRedaction.js';

const TENANT = 'org:ent-erase';
const SUBJECT = 'user:erase-me-ent';
const OTHER = 'user:keep-me-ent';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  await createEntityType({
    tenantId: TENANT, name: 'customers', displayName: 'Customers',
    fields: [{ key: 'full_name', label: 'Full name', type: 'string', required: true }],
    createdBy: SUBJECT,
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

let n = 0;
const aRow = (createdBy: string, values: Record<string, unknown> = { full_name: 'Ada Lovelace' }) =>
  createEntity({ tenantId: TENANT, typeName: 'customers', entityId: `e-${++n}`, values, createdBy });

describe('ENT2-M1 — erasure reaches entity attribution, and STOPS at values', () => {
  it('anonymizes createdBy/updatedBy on records and createdBy on the type', async () => {
    const row = await aRow(SUBJECT);
    await updateEntity({ tenantId: TENANT, typeName: 'customers', entityId: row.entityId, values: { full_name: 'Ada L.' }, actor: SUBJECT } as never);

    await eraseEntitiesSubject(TENANT, SUBJECT);

    const after = await getEntity({ tenantId: TENANT, typeName: 'customers', entityId: row.entityId });
    expect(after, 'the record survives — it is the tenant\'s data').toBeTruthy();
    expect(after?.createdBy).toBe(ERASED);
    expect(after?.updatedBy).toBe(ERASED);

    const type = await getEntityType(TENANT, undefined, 'customers');
    expect(type?.createdBy, 'type attribution too').toBe(ERASED);
  });

  it('NEVER touches values — the pinned boundary', async () => {
    // This pins a DECISION: a "Customers" row's values may BE a person's data,
    // but only the tenant's schema knows which fields. A later sweep that makes
    // this eraser guess at value keys must consciously invert this assertion —
    // and pair it with schema-aware tooling, not a regex.
    const row = await aRow(SUBJECT, { full_name: 'Erase Me Himself' });
    await eraseEntitiesSubject(TENANT, SUBJECT);
    const after = await getEntity({ tenantId: TENANT, typeName: 'customers', entityId: row.entityId });
    expect(after?.values.full_name, 'business values are the tenant\'s data model, untouched').toBe('Erase Me Himself');
    expect(after?.createdBy, 'while the attribution IS erased').toBe(ERASED);
  });

  it('leaves another subject\'s attribution untouched (the negative control)', async () => {
    const row = await aRow(OTHER);
    await eraseEntitiesSubject(TENANT, SUBJECT);
    const after = await getEntity({ tenantId: TENANT, typeName: 'customers', entityId: row.entityId });
    expect(after?.createdBy).toBe(OTHER);
  });

  it('is idempotent and tenant-scoped', async () => {
    const row = await aRow(SUBJECT);
    await eraseEntitiesSubject(TENANT, SUBJECT);
    const once = await getEntity({ tenantId: TENANT, typeName: 'customers', entityId: row.entityId });
    await eraseEntitiesSubject(TENANT, SUBJECT);
    expect(await getEntity({ tenantId: TENANT, typeName: 'customers', entityId: row.entityId })).toEqual(once);
  });

  it('is WIRED — the host fan-out reaches this feature', async () => {
    const { eraseSubject } = await import('../src/host/subjectErasure.js');
    const row = await aRow(SUBJECT);
    await eraseSubject(TENANT, SUBJECT);
    expect((await getEntity({ tenantId: TENANT, typeName: 'customers', entityId: row.entityId }))?.createdBy).toBe(ERASED);
  });
});
