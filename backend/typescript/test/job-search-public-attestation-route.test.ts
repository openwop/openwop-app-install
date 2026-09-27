/**
 * ADR 0544 P3 — the PUBLIC verification route.
 *
 * Public-route tests: no PII beyond claims, payload cap, uniform 404. The
 * verifier is an unauthenticated stranger, so every assertion here is about what
 * a stranger can learn — including from the SHAPE of a refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { issueAttestation, revokeAttestation } from '../src/features/job-search/attestation/token.js';
import { createApplyGrant, consumeSubmit } from '../src/host/applyGrant.js';
import { enableTenantOverride } from '../src/host/featureToggles/service.js';
import { __isSseExemptPathForTests } from '../src/middleware/rateLimit.js';

const PUB = '/v1/host/openwop-app/public-attestations';
const TENANT = 'user:t-pubatt';

let server: Server;
let BASE: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
  await enableTenantOverride('job-search', TENANT, 'test');
}, 180_000);

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

let seq = 0;

async function issue() {
  // A distinct deal per issuance: the campaign↔deal link is now derived from the
  // audit row, so reusing one deal id would resolve every token to the first.
  const dealId = `deal:PRIVATE-${(seq += 1)}`;
  const g = await createApplyGrant({
    tenantId: TENANT, orgId: 'org-1', subjectId: 'subj-PRIVATE', grantedBy: 'user-PRIVATE',
    campaignId: 'camp-1', maxSubmits: 9, maxPrepared: 3, ratePerHour: 4,
    origins: ['boards.example.com'], resumePolicy: 'default',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await consumeSubmit(TENANT, g.grantId, Date.now(), dealId);
  // The SUBJECT issues: an attestation states that person's own conduct.
  const r = await issueAttestation({ tenantId: TENANT, dealId, issuedBy: 'subj-PRIVATE', now: Date.now() });
  if ('refused' in r) throw new Error(`seed failed: ${r.refused}`);
  return r;
}

describe('ADR 0544 P3 — the public verification route', () => {
  it('resolves a valid token with NO authentication at all', async () => {
    // The whole point: an employer with a link and no account. A route that
    // quietly required a session would look fine in a signed-in browser and fail
    // for every real verifier.
    const { token } = await issue();
    const res = await fetch(`${BASE}${PUB}/${token}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { claims: unknown[] };
    expect(body.claims.length).toBeGreaterThan(0);
  });

  it('exposes NO PII beyond the claims', async () => {
    const { token } = await issue();
    const text = await (await fetch(`${BASE}${PUB}/${token}`)).text();
    for (const secret of [TENANT, 'subj-PRIVATE', 'user-PRIVATE', 'deal:PRIVATE', 'grant:', 'entryHash', 'tokenHash', 'camp-1']) {
      expect(text, `the public route leaked ${secret}`).not.toContain(secret);
    }
  });

  it('unknown and REVOKED are byte-identical — status AND body', async () => {
    const { token, attestationId } = await issue();
    await revokeAttestation(TENANT, attestationId, Date.now());

    const revoked = await fetch(`${BASE}${PUB}/${token}`);
    const unknown = await fetch(`${BASE}${PUB}/owatt_no-such-token-at-all-here`);

    expect(revoked.status).toBe(unknown.status);
    // Body too: a differing message is an existence oracle just as much as a
    // differing status code.
    expect(await revoked.text()).toBe(await unknown.text());
  });

  it('a MALFORMED token is the same refusal as an unknown one', async () => {
    const bad = await fetch(`${BASE}${PUB}/!!!not-a-token!!!`);
    const unknown = await fetch(`${BASE}${PUB}/owatt_no-such-token-at-all-here`);
    expect(bad.status).toBe(unknown.status);
    expect(await bad.text()).toBe(await unknown.text());
  });

  it('caps the payload BEFORE doing any lookup', async () => {
    // An unbounded path segment on an anonymous route is free work for anyone.
    const res = await fetch(`${BASE}${PUB}/${'x'.repeat(5000)}`);
    expect(res.status).toBe(404);
    const unknown = await fetch(`${BASE}${PUB}/owatt_no-such-token-at-all-here`);
    expect(await res.text(), 'even the oversized refusal must be uniform').toBe(await unknown.text());
  });

  it('is a SIBLING prefix, not nested under the authed namespace', async () => {
    // The `public-forms` ≠ `forms` rule. Nesting an anonymous route inside an
    // otherwise-authenticated namespace is how a public hole opens by accident.
    const { token } = await issue();
    const nested = await fetch(`${BASE}/v1/host/openwop-app/job-search/public/attestations/${token}`);
    expect(nested.status, 'no anonymous route may live under /job-search').toBeGreaterThanOrEqual(400);
  });

  it('stays under the per-IP rate budget — it is not on the SSE exemption list', () => {
    // The ADR names a rate limit as P3 verification. The route does not
    // implement one; it INHERITS the app-wide `ipRateLimitMiddleware`. That is
    // the right design and the wrong thing to leave unasserted — the exemption
    // list is one edit away from covering an anonymous path, and nothing else
    // would go red. This is the seam that list ships for.
    expect(__isSseExemptPathForTests(`${PUB}/owatt_anything`)).toBe(false);
  });

  it('does not accept a tenant parameter — tenant comes from the RESOURCE', async () => {
    // There is no path segment through which a caller could name a workspace, so
    // cross-tenant probing has nothing to probe with.
    const { token } = await issue();
    const res = await fetch(`${BASE}${PUB}/${token}?tenantId=user:someone-else`);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('someone-else');
  });
});
