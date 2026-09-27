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
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promote, rollback } from '../environmentsClient.js';

function mockStatus(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response)));
}

afterEach(() => { vi.unstubAllGlobals(); });

const ENV = { environmentId: 'e1', name: 'staging', order: 1, protection: 'open', currentSnapshot: 'h1', createdAt: '', updatedAt: '' };

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
    expect(out.status).toBe('applied');
  });
});
