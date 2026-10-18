/**
 * Regression ratchet for the promote/rollback outcome union (ADR 0387 H2).
 *
 * The bug this pins: the route answers **202** `{status:'pending_approval'}` when
 * the approval gate intercepts — the pointer does NOT move
 * (`features/environments/routes.ts` sendPromotionOutcome; the service comment
 * reads "Route returns a typed 202, NOT a success mutation"). Because 202 passes
 * `res.ok`, the client used to cast that body to the 201 shape and hand the page
 * `{ environment: undefined, noop: undefined }`, which rendered as
 * "Promotion recorded." — a completed promotion that never happened.
 *
 * These assert all THREE arms, including the plain-success one: pinning only the
 * gated arm would stay green if the client regressed to "always pending".
 *
 * DOUBLE GUARD (named, wave 52): `asPromotionOutcome` reads pending from
 * `res.status === 202 || body.status === 'pending_approval'`. The real route
 * always sends both together, so the 202 arm is pinned on its own by "a bare
 * 202 …" below; the body arm is a BELT for a server that drops the status code
 * and has no real wire shape of its own to test — removing only it stays green
 * by design. Sabotage-witnessed: dropping the 202 arm, the `?? null`, the
 * server-message detail, or rollback's union each turn a case red.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promote, rollback, type Environment } from '../environmentsClient.js';

function mockStatus(status: number, body: unknown): void {
  // A real Response — `ok` and `json()` come from the platform, not a hand copy.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));
}

afterEach(() => { vi.unstubAllGlobals(); });

const ENV: Environment = { environmentId: 'e1', name: 'staging', order: 1, protection: 'open', currentSnapshot: 'h1', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };

describe('promote — the three server outcomes stay distinguishable', () => {
  it('201 with a moved pointer → applied, noop false', async () => {
    mockStatus(201, { environment: ENV, noop: false });
    const out = await promote('dev');
    expect(out.status).toBe('applied');
    if (out.status !== 'applied') throw new Error('unreachable');
    expect(out.noop).toBe(false);
    expect(out.environment.name).toBe('staging');
  });

  it('201 with noop → applied, noop true (target already at this hash)', async () => {
    mockStatus(201, { environment: ENV, noop: true });
    const out = await promote('dev');
    expect(out).toEqual({ status: 'applied', environment: ENV, noop: true });
  });

  it('202 pending_approval → NOT applied; nothing moved', async () => {
    mockStatus(202, { status: 'pending_approval', approval: { approvalId: 'appr:abc' } });
    const out = await promote('dev', 'prod');
    expect(out).toEqual({ status: 'pending_approval', approvalId: 'appr:abc' });
    // The regression: this must never surface an `environment`, which is what the
    // page keys "Promotion recorded." off.
    expect('environment' in out).toBe(false);
  });

  it('a bare 202 (no status field in the body) is still pending — the status code alone decides', async () => {
    mockStatus(202, { approval: { approvalId: 'appr:only-status-code' } });
    expect(await promote('dev')).toEqual({ status: 'pending_approval', approvalId: 'appr:only-status-code' });
  });

  it('202 without an approval id still reports pending, not success', async () => {
    mockStatus(202, { status: 'pending_approval', approval: {} });
    expect(await promote('dev')).toEqual({ status: 'pending_approval', approvalId: null });
  });

  it('a non-ok status still throws with the server message', async () => {
    mockStatus(409, { message: 'Environment is locked (change-freeze).' });
    await expect(promote('dev', 'prod')).rejects.toThrow('Environment is locked (change-freeze).');
  });
});

describe('rollback — same union (it shares sendPromotionOutcome)', () => {
  it('202 pending_approval → NOT applied', async () => {
    mockStatus(202, { status: 'pending_approval', approval: { approvalId: 'appr:xyz' } });
    expect(await rollback('prod', 'h9')).toEqual({ status: 'pending_approval', approvalId: 'appr:xyz' });
  });

  it('201 → applied', async () => {
    mockStatus(201, { environment: ENV, noop: false });
    const out = await rollback('prod', 'h9');
    expect(out).toEqual({ status: 'applied', environment: ENV, noop: false });
  });
});
