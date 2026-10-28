/**
 * ADR 0932 (Book AI P6) — clarification answers are validated, attributed and
 * scoped.
 *   1. A declared resumeSchema binds every external resume lane (interrupt.md MUST).
 *   2. The resolving Subject is a spec-valid `resolvedBy` (subject.schema.json).
 *   3. A non-approval interrupt that declares an approver ACL hands its resume
 *      token only to a caller on that ACL (was: anyone with the base scope).
 * Red under: dropping the schema check, validating host-internal resumes,
 * a permissive fallback for a broken schema, a non-Subject resolvedBy, or the
 * projector returning `true` for every non-approval kind again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import type { Request } from 'express';
import { createApp } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { assertResumeMatchesSchema } from '../src/host/resumeSchemaValidation.js';
import { requestSubjectV2 } from '../src/host/runOwner.js';
import { resolveAndResume, decideTokenProjector } from '../src/routes/interrupts.js';
import type { InterruptRecord } from '../src/types.js';
import { getSuspendManager, setSuspendBackend } from '../src/executor/suspendManager.js';

const ANSWERS = { type: 'object', required: ['answers'], additionalProperties: false, properties: { answers: { type: 'array', items: { type: 'string' } } } };

let server: http.Server;
let storage: Storage;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  storage = await openStorage('memory://');
  setSuspendBackend(storage);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const req = (userId: string, tenantId = 't-0932'): Request => ({ userId, tenantId, principal: { principalId: userId, auth: { kind: 'session' } } }) as unknown as Request;

describe('ADR 0932 (1) — resumeSchema is enforced', () => {
  it('accepts a matching value and refuses a mismatched one with validation_error', () => {
    expect(() => assertResumeMatchesSchema(ANSWERS, { answers: ['yes'] })).not.toThrow();
    expect(() => assertResumeMatchesSchema(ANSWERS, { answers: 'yes' })).toThrow(expect.objectContaining({ code: 'validation_error' }));
    expect(() => assertResumeMatchesSchema(ANSWERS, { answers: [], extra: 1 })).toThrow(/resumeSchema/);
  });

  it('a schema that cannot compile refuses (never "anything goes")', () => {
    expect(() => assertResumeMatchesSchema({ type: 'not-a-type' }, { x: 1 })).toThrow(/does not compile/);
  });

  it('no declared schema → no constraint (the kind-specific checks still apply elsewhere)', () => {
    expect(() => assertResumeMatchesSchema(undefined, 'anything')).not.toThrow();
  });

  it.each([null, false, true, 42, 'not-a-schema', []])('refuses malformed runtime declaration %j before it can be stored', async (resumeSchema) => {
    expect(() => assertResumeMatchesSchema(resumeSchema, 'anything'))
      .toThrow(expect.objectContaining({ code: 'validation_error' }));
    // Reflect invokes the runtime JavaScript boundary without pretending the
    // malformed pack value satisfies the TypeScript declaration.
    const interruptId = `invalid-schema-${JSON.stringify(resumeSchema)}`;
    await expect(Reflect.apply(getSuspendManager().createInterrupt, undefined, [{
      runId: 'r-malformed', nodeId: 'n', kind: 'clarification', data: {}, interruptId, resumeSchema,
    }])).rejects.toMatchObject({ code: 'validation_error', details: { field: 'resumeSchema' } });
    expect(await storage.getInterrupt(interruptId)).toBeNull();
  });

  it('a malformed legacy object declaration cannot consume a resume token', async () => {
    const now = new Date().toISOString();
    await storage.insertRun({ runId: 'r-legacy-schema', workflowId: 'wf', tenantId: 't-0932', status: 'waiting-approval', inputs: null, metadata: {}, configurable: {}, createdAt: now, updatedAt: now } as never);
    await Reflect.apply(storage.insertInterrupt, storage, [{ interruptId: 'i-legacy-schema', runId: 'r-legacy-schema', nodeId: 'n', kind: 'clarification', token: 'legacy-tok', data: {}, resumeSchema: [], createdAt: now }]);
    await expect(resolveAndResume(storage, {} as never, 'i-legacy-schema', 'anything', { subjectRef: 'u-author' }))
      .rejects.toMatchObject({ code: 'validation_error', details: { field: 'resumeSchema' } });
    expect((await storage.getInterrupt('i-legacy-schema'))?.resolvedAt).toBeUndefined();
  });

  it('resolveAndResume refuses a mismatched answer on an external lane BEFORE claiming the interrupt', async () => {
    const now = new Date().toISOString();
    await storage.insertRun({ runId: 'r-0932', workflowId: 'wf', tenantId: 't-0932', status: 'waiting-approval', inputs: null, metadata: {}, configurable: {}, createdAt: now, updatedAt: now } as never);
    const rec: InterruptRecord = { interruptId: 'i-0932', runId: 'r-0932', nodeId: 'n', kind: 'clarification', token: 'tok', data: {}, resumeSchema: ANSWERS, createdAt: now };
    await storage.insertInterrupt(rec);
    await expect(resolveAndResume(storage, {} as never, 'i-0932', { answers: 42 }, { subjectRef: 'u-author' })).rejects.toMatchObject({ code: 'validation_error' });
    expect((await storage.getInterrupt('i-0932'))?.resolvedAt).toBeUndefined();
  });
});

describe('ADR 0932 (2) — resolvedBy is a spec Subject', () => {
  it('a session caller maps to a subject.schema.json-valid Subject in the active tenant', () => {
    const root = join(process.cwd(), '..', '..', 'schemas', 'v2');
    const ajv = new Ajv2020({ strict: false });
    ajv.addSchema(JSON.parse(readFileSync(join(root, 'ids.schema.json'), 'utf8')), 'ids.schema.json');
    const validate = ajv.compile(JSON.parse(readFileSync(join(root, 'subject.schema.json'), 'utf8')));
    const s = requestSubjectV2(req('user:u-author'), 't-0932');
    expect(s).toBeDefined();
    expect(validate(s), JSON.stringify(validate.errors)).toBe(true);
    expect(s).toMatchObject({ tenant: 't-0932', lane: 'session', kind: 'user' });
  });

  it('no principal → no Subject (never invented)', () => {
    expect(requestSubjectV2({} as Request, 't')).toBeUndefined();
  });
});

describe('ADR 0932 (3) — a declared ACL scopes the resume token for every kind', () => {
  const clar = (data: unknown): InterruptRecord => ({ interruptId: 'i', runId: 'r', nodeId: 'n', kind: 'clarification', token: 't', data, createdAt: '' });

  it('a clarification with approverRefs gives its token only to a listed caller', async () => {
    const it2 = clar({ approverRefs: ['u-author'] });
    expect(await decideTokenProjector(req('u-viewer'), 't-0932', true)(it2)).toBe(false);
    expect(await decideTokenProjector(req('u-author'), 't-0932', true)(it2)).toBe(true);
  });

  it('a clarification with no ACL keeps today\'s behaviour (base scope suffices)', async () => {
    expect(await decideTokenProjector(req('u-viewer'), 't-0932', true)(clar({}))).toBe(true);
  });

  it('without the base scope, nobody gets it', async () => {
    expect(await decideTokenProjector(req('u-author'), 't-0932', false)(clar({ approverRefs: ['u-author'] }))).toBe(false);
  });
});
