/**
 * ADR 1040 D6 row 1 — an env API key resolving an interrupt is recorded as who
 * resolved it.
 *
 * `deriveReviewer` already computed the workload Subject for this lane (the
 * run-owner stamp's mapping) and then dropped it, so `interrupt.resolved`
 * carried no `resolvedBy` for an operator credential. Now the token lane keeps
 * its `capabilityToken` flag unchanged AND carries that Subject, which is
 * subject.schema.json-valid. Nothing is recorded for callers with no identity
 * (an anonymous cookie), and nothing is invented: a `{ kind: 'capability' }`
 * Subject is not a valid v2 Subject (D6).
 *
 * Red when: the env-key branch of `deriveReviewer` (routes/interrupts.ts) stops
 * carrying `resolvedBy`, carries it for a non-env-key caller, or flips the
 * `capabilityToken` flag.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import type { Request } from 'express';
import { reviewerOf } from '../src/routes/interrupts.js';

const envKeyReq = (): Request => ({
  tenantId: 't-1040',
  principal: { principalId: 'bearer:abcd1234', tenants: ['t-1040'], auth: { kind: 'env-key' } },
}) as unknown as Request;

describe('ADR 1040 D6 row 1 — the env-key lane records its workload Subject', () => {
  it('carries a schema-valid workload resolvedBy and keeps the token-lane flag', async () => {
    const root = join(process.cwd(), '..', '..', 'schemas', 'v2');
    const ajv = new Ajv2020({ strict: false });
    ajv.addSchema(JSON.parse(readFileSync(join(root, 'ids.schema.json'), 'utf8')), 'ids.schema.json');
    const validate = ajv.compile(JSON.parse(readFileSync(join(root, 'subject.schema.json'), 'utf8')));
    const r = await reviewerOf(envKeyReq());
    expect(r).toMatchObject({ capabilityToken: true });
    expect('subjectRef' in r).toBe(false);
    const subject = (r as { resolvedBy?: unknown }).resolvedBy;
    expect(subject).toMatchObject({ tenant: 't-1040', kind: 'workload', lane: 'api-key' });
    expect(validate(subject), JSON.stringify(validate.errors)).toBe(true);
  });

  it('a bearer that is not an env key, or a `*` env key with no tenant, records nothing', async () => {
    const otherBearer = { tenantId: 't-1040', principal: { principalId: 'bearer:abcd1234', tenants: ['t-1040'], auth: { kind: 'api-key' } } } as unknown as Request;
    const r1 = await reviewerOf(otherBearer);
    expect(r1).toMatchObject({ capabilityToken: true });
    expect((r1 as { resolvedBy?: unknown }).resolvedBy).toBeUndefined();
    // A `*` key has no req.tenantId; the fallback tenant would make a FALSE Subject.
    const starKey = { principal: { principalId: 'bearer:abcd1234', tenants: ['*'], auth: { kind: 'env-key' } } } as unknown as Request;
    const r2 = await reviewerOf(starKey);
    expect(r2).toMatchObject({ capabilityToken: true });
    expect((r2 as { resolvedBy?: unknown }).resolvedBy).toBeUndefined();
  });

  it('an anonymous caller on that branch records nothing', async () => {
    const anon = { tenantId: 't-1040', principal: { principalId: 'anon:s1', tenants: ['t-1040'], auth: { kind: 'anon' } } } as unknown as Request;
    const r = await reviewerOf(anon);
    expect(r).toMatchObject({ capabilityToken: false });
    expect((r as { resolvedBy?: unknown }).resolvedBy).toBeUndefined();
  });
});
