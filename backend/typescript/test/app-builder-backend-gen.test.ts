/**
 * ADR 0423 — the backend generator (6e slice, DECIDE-2 ratified).
 * Invariants: deterministic emit (double-emit hash equality), the closed field
 * map on both the Drizzle schema and the inert SQL migration, route↔OpenAPI
 * path/method parity from the shared kind map, SBOM↔package.json parity,
 * fixture shapes from the declared field lists, honest 501 for action kinds,
 * and no backend emit when the design declares no operations.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateBackend } from '../src/features/app-builder/export/backendGen.js';
import { generateOpenApi } from '../src/features/app-builder/export/openapiGen.js';

const STATE = {
  models: [
    {
      id: 'job', name: 'Job',
      fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'price', type: 'number' },
        { name: 'done', type: 'boolean' },
        { name: 'due', type: 'date' },
        { name: 'customer', type: 'reference' },
        { name: 'meta', type: 'object' },
        { name: 'tags', type: 'list' },
      ],
    },
  ],
  operations: [
    { id: 'listJobs', name: 'List jobs', kind: 'list', modelId: 'job', output: { type: 'modelList' } },
    { id: 'getJob', name: 'Get job', kind: 'get', modelId: 'job', input: [{ name: 'id', type: 'string', required: true }], output: { type: 'model' } },
    { id: 'createJob', name: 'Create job', kind: 'create', modelId: 'job', input: [{ name: 'title', type: 'string', required: true }] },
    { id: 'updateJob', name: 'Update job', kind: 'update', modelId: 'job' },
    { id: 'removeJob', name: 'Remove job', kind: 'delete', modelId: 'job' },
    { id: 'notifyCrew', name: 'Notify crew', kind: 'action', input: [{ name: 'message', type: 'string' }], output: { type: 'object', fields: [{ name: 'sent', type: 'boolean' }] } },
  ],
};

const fileMap = (files: Array<{ path: string; content: string }>): Map<string, string> =>
  new Map(files.map((f) => [f.path, f.content]));

describe('ADR 0423 — backend generator', () => {
  it('no operations ⇒ no backend emit (the openapi rule)', () => {
    expect(generateBackend({ models: STATE.models })).toEqual([]);
    expect(generateBackend({})).toEqual([]);
  });

  it('is deterministic — double emit is byte-identical', () => {
    const digest = (files: Array<{ path: string; content: string }>): string =>
      createHash('sha256').update(files.map((f) => `${f.path}\n${f.content}`).join('\x00')).digest('hex');
    expect(digest(generateBackend(STATE))).toBe(digest(generateBackend(STATE)));
  });

  it('emits the Drizzle schema + inert SQL migration through the closed field map', () => {
    const files = fileMap(generateBackend(STATE));
    const schema = files.get('backend/src/db/schema.ts')!;
    expect(schema).toContain("export const job = pgTable('job', {");
    expect(schema).toContain("title: text('title').notNull(),");
    expect(schema).toContain("price: doublePrecision('price'),");
    expect(schema).toContain("due: timestamp('due', { withTimezone: true, mode: 'string' }),");
    expect(schema).toContain("meta: jsonb('meta'),");
    const migration = files.get('backend/drizzle/0000_init.sql')!;
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "job"');
    expect(migration).toContain('"title" text NOT NULL');
    expect(migration).toContain('"price" double precision');
    expect(migration).toContain('"due" timestamptz');
    expect(migration).toContain('"tags" jsonb');
  });

  it('routes match the OpenAPI projection path-for-path and method-for-method', () => {
    const routes = fileMap(generateBackend(STATE)).get('backend/src/routes.ts')!;
    const openapi = generateOpenApi(STATE)!;
    const paths = openapi.paths as Record<string, Record<string, unknown>>;
    for (const [path, methods] of Object.entries(paths)) {
      for (const method of Object.keys(methods)) {
        expect(routes, `${method.toUpperCase()} ${path} must exist in routes.ts`).toContain(`app.${method}('${path}'`);
      }
    }
  });

  it('CRUD kinds implement Drizzle handlers; action kinds are honest 501 stubs', () => {
    const routes = fileMap(generateBackend(STATE)).get('backend/src/routes.ts')!;
    expect(routes).toContain('db.select().from(schema.job)');
    expect(routes).toContain('db.insert(schema.job)');
    expect(routes).toContain('db.update(schema.job)');
    expect(routes).toContain('db.delete(schema.job)');
    expect(routes).toContain("c.json({ error: 'not_implemented', operation: 'notifyCrew' }, 501)");
  });

  it('SBOM components exactly mirror the emitted package.json dependencies', () => {
    const files = fileMap(generateBackend(STATE));
    const pkg = JSON.parse(files.get('backend/package.json')!) as { dependencies: Record<string, string> };
    const sbom = JSON.parse(files.get('backend/sbom.cdx.json')!) as { bomFormat: string; components: Array<{ name: string; version: string }> };
    expect(sbom.bomFormat).toBe('CycloneDX');
    expect(Object.fromEntries(sbom.components.map((c) => [c.name, c.version]))).toEqual(pkg.dependencies);
  });

  it('fixtures derive from the declared field shapes', () => {
    const files = fileMap(generateBackend(STATE));
    const fx = JSON.parse(files.get('backend/test/fixtures/notifyCrew.json')!) as { operationId: string; request: Record<string, unknown>; response: Record<string, unknown> };
    expect(fx.operationId).toBe('notifyCrew');
    expect(fx.request).toEqual({ message: 'sample' });
    expect(fx.response).toEqual({ sent: true });
    expect(files.has('backend/test/fixtures/listJobs.json')).toBe(true);
  });

  it('rejects unsafe identifiers (closed-world ids only)', () => {
    const files = generateBackend({
      models: [{ id: 'ok_model', fields: [{ name: 'good', type: 'string' }, { name: 'bad-name;drop', type: 'string' }] }],
      operations: [{ id: 'ok_op', kind: 'list', modelId: 'ok_model' }, { id: 'nope;injection', kind: 'list' }],
    });
    const all = files.map((f) => f.content).join('\n');
    expect(all).not.toContain('drop');
    expect(all).not.toContain('injection');
    expect(all).toContain('ok_model');
  });
});
