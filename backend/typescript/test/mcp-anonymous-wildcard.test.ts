/**
 * ADR 0553 P0 — the MCP mount must not invent authority for a caller it cannot
 * identify.
 *
 * `routes/mcp.ts` used to synthesize `{ principalId: 'mcp-anonymous',
 * tenants: ['*'] }` whenever auth middleware had not attached a principal. A
 * tenant WILDCARD — the widest authority the host has — handed out precisely
 * when it could not establish who was calling.
 *
 * ADR 0553: "A warning is not an authorization boundary. This must never be
 * production-reachable."
 *
 * HOW REACHABLE WAS IT, precisely? Narrower than I first wrote, and measuring
 * it corrected my own test design. `/v1/host/openwop-app/mcp` is NOT in
 * `middleware/auth.ts`'s exempt list, so a plain unauthenticated request is
 * 401'd by the global middleware before `routes/mcp.ts` runs. The fallback
 * therefore needed a configuration where the middleware RUNS but attaches no
 * principal — an auth-bypass posture, or a future exempt path. Still wrong: the
 * fallback's own comment said it existed for exactly such a configuration.
 *
 * My first version of these tests booted an unauthenticated host and asserted
 * 401 on the endpoint. They passed — and would have passed with the wildcard
 * fully restored, because they were measuring the global middleware. They now
 * test the boundary DIRECTLY, which is the only way to test a guard that sits
 * behind another guard.
 *
 * `isAnonymousPrincipal` (ADR 0087) also mitigated this — gated tools are denied
 * to `mcp-anonymous` and to wildcard principals. But that is per-tool, so a tool
 * which never opted into gating stayed reachable. A per-tool denial is not a
 * route-level boundary.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request } from 'express';
import { principalFromReq } from '../src/routes/mcp.js';

describe('ADR 0553 P0 — principalFromReq fails closed', () => {
  const prior = process.env.OPENWOP_TEST_SEAM_ENABLED;
  afterAll(() => {
    if (prior === undefined) delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    else process.env.OPENWOP_TEST_SEAM_ENABLED = prior;
  });

  it('returns null — never a wildcard — when nothing attached a principal', () => {
    delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    expect(principalFromReq({} as Request)).toBeNull();
  });

  it('passes through a principal the middleware DID attach', () => {
    delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    const real = { principalId: 'real-caller', tenants: ['acme'], token: 't' };
    expect(principalFromReq({ principal: real } as unknown as Request)).toEqual(real);
  });

  it('the test seam yields a NAMED, single-tenant principal', () => {
    process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
    const p = principalFromReq({} as Request);
    expect(p).not.toBeNull();
    expect(p?.principalId).toBe('mcp-test-seam');
    // The property that matters: not `['*']`.
    expect(p?.tenants).toEqual(['default']);
    expect(p?.tenants).not.toContain('*');
  });

  it('an attached principal still wins over the seam', () => {
    // The seam must be a fallback, never an override — otherwise enabling it
    // would downgrade a real caller's identity.
    process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
    const real = { principalId: 'real-caller', tenants: ['acme'], token: 't' };
    expect(principalFromReq({ principal: real } as unknown as Request)?.principalId).toBe('real-caller');
  });

  it('no wildcard-tenant literal survives in the module', () => {
    // Source-pinned so a future edit widening the seam back to `['*']` is red.
    // Scoped to the code, not the file: this file's own header discusses the
    // old value, and a naive grep would match the explanation.
    const src = readFileSync(join(__dirname, '..', 'src', 'routes', 'mcp.ts'), 'utf8');
    const code = src.split('\n').filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'));
    expect(code.join('\n')).not.toMatch(/tenants: \['\*'\]/);
  });
});
