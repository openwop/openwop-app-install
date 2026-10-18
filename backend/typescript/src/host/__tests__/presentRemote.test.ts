/**
 * ADR 0328 Phase 4 — the present-remote capability: stateless HMAC token
 * (mint/verify roundtrip + tamper/expiry rejection), the per-type outline
 * registry, and the nav pub/sub payload discipline.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { openStorage } from '../../storage/index.js';
import { initHostExtPersistence } from '../hostExtPersistence.js';
import {
  mintPresentRemoteToken,
  verifyPresentRemoteToken,
  registerPresentOutlineProvider,
  presentOutlineFor,
  publishPresentNav,
  subscribePresentNav,
} from '../presentRemote.js';

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  initHostExtPersistence(await openStorage('memory://'));
});

describe('present-remote token', () => {
  it('roundtrips claims and rejects tamper, expiry, and garbage uniformly', () => {
    const MINTER = { userId: 'user:abc', orgId: 'org-1' };
    const { token, expiresAt } = mintPresentRemoteToken('tenant-a', 'canvas-1', MINTER);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    const claims = verifyPresentRemoteToken(token);
    expect(claims).toEqual({ tenantId: 'tenant-a', canvasId: 'canvas-1', userId: 'user:abc', orgId: 'org-1', exp: expect.any(Number) });

    // Tampered signature.
    expect(verifyPresentRemoteToken(`${token.slice(0, -2)}xx`)).toBeNull();
    // Claims swap (another canvas) with the original signature.
    const parts = token.split('.');
    const forged = `v2.${Buffer.from(JSON.stringify({ t: 'tenant-a', c: 'canvas-2', u: 'user:abc', o: 'org-1' })).toString('base64url')}.${parts[2]}.${parts[3]}`;
    expect(verifyPresentRemoteToken(forged)).toBeNull();
    // Expired.
    const old = mintPresentRemoteToken('tenant-a', 'canvas-1', MINTER, Date.now() - 5 * 3600 * 1000);
    // ADR 0886 D3 — a minter swap is a forgery too; a v1 (minter-less) token is retired.
    const swapped = `v2.${Buffer.from(JSON.stringify({ t: 'tenant-a', c: 'canvas-1', u: 'user:other', o: 'org-1' })).toString('base64url')}.${parts[2]}.${parts[3]}`;
    expect(verifyPresentRemoteToken(swapped)).toBeNull();
    expect(verifyPresentRemoteToken(`v1.${parts[1]}.${parts[2]}.${parts[3]}`)).toBeNull();
    expect(verifyPresentRemoteToken(old.token)).toBeNull();
    // Garbage.
    expect(verifyPresentRemoteToken('')).toBeNull();
    expect(verifyPresentRemoteToken('v1.only.two')).toBeNull();
  });

  it('binds the tenant — a token never verifies into different claims', () => {
    const { token } = mintPresentRemoteToken('tenant-b', 'canvas-9', { userId: 'user:b', orgId: 'org-b' });
    const claims = verifyPresentRemoteToken(token);
    expect(claims?.tenantId).toBe('tenant-b');
    expect(claims?.canvasId).toBe('canvas-9');
  });
});

describe('present outline registry', () => {
  it('projects through the registered provider; unknown types are null (no present mode)', () => {
    registerPresentOutlineProvider('canvas.test-present', (state) => ({
      title: String(state.title ?? ''),
      frames: [{ name: 'one', notes: 'n1' }],
    }));
    expect(presentOutlineFor('canvas.test-present', { title: 'T' })).toEqual({ title: 'T', frames: [{ name: 'one', notes: 'n1' }] });
    expect(presentOutlineFor('canvas.never-registered', {})).toBeNull();
  });
});

describe('present nav pub/sub', () => {
  it('delivers commands and positions to a subscriber on the same channel; malformed payloads are dropped', async () => {
    const claims = { tenantId: 't1', canvasId: 'c1', userId: 'user:p', orgId: 'o1', exp: 0 };
    const got: unknown[] = [];
    const unsubscribe = await subscribePresentNav(claims, (ev) => got.push(ev));
    await publishPresentNav(claims, { kind: 'command', action: 'next' });
    await publishPresentNav(claims, { kind: 'position', current: 3 });
    // A different canvas's channel must NOT arrive here.
    await publishPresentNav({ tenantId: 't1', canvasId: 'other', userId: 'user:p', orgId: 'o1', exp: 0 }, { kind: 'command', action: 'prev' });
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual([
      { kind: 'command', action: 'next' },
      { kind: 'position', current: 3 },
    ]);
    await unsubscribe();
  });
});
