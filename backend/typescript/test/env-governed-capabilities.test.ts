/**
 * ADR 0434 — the env-governed capability projection.
 *
 * `context-economy` used to register a feature toggle purely "for visibility"
 * while explicitly NOT gating dispatch (the dispatch layer is tenant-agnostic
 * and reads `OPENWOP_CONTEXT_ECONOMY*` directly). That made it a LYING SWITCH:
 * flipping it changed nothing, in either direction.
 *
 * The toggle is retired; the visibility need moved to this read-only projection.
 * These cases pin the two properties that make it honest:
 *   1. it REFLECTS the env (flip the env → the reported state flips), and
 *   2. it is superadmin-gated and has no write twin.
 * Plus the regression that motivated the change: `context-economy` must no
 * longer appear as a flippable toggle.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const PATH = '/v1/host/openwop-app/feature-toggles/admin/env-governed';
const ADMIN = { authorization: 'Bearer dev-token' };

interface Lever { id: string; envVar: string; enabled: boolean }
interface Capability { id: string; label: string; envVar: string; enabled: boolean; levers: Lever[] }

describe('env-governed capabilities (ADR 0434)', () => {
  let server: http.Server;
  let BASE: string;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
  });
  afterAll(async () => {
    delete process.env.OPENWOP_CONTEXT_ECONOMY;
    delete process.env.OPENWOP_CONTEXT_ECONOMY_TOOL_DIET;
    await new Promise<void>((res) => server.close(() => res()));
  });

  const get = async (): Promise<{ status: number; capabilities: Capability[] }> => {
    const res = await fetch(`${BASE}${PATH}`, { headers: ADMIN });
    const body = res.status === 200 ? await res.json() as { capabilities: Capability[] } : { capabilities: [] };
    return { status: res.status, capabilities: body.capabilities };
  };

  it('reports context-economy with its owning env var and all five levers', async () => {
    const { status, capabilities } = await get();
    expect(status).toBe(200);
    const ce = capabilities.find((c) => c.id === 'context-economy');
    expect(ce, 'context-economy must remain visible to an operator').toBeTruthy();
    expect(ce!.envVar).toBe('OPENWOP_CONTEXT_ECONOMY');
    expect(ce!.levers.map((l) => l.id).sort()).toEqual(
      ['memoryBudget', 'providerCache', 'toolDiet', 'transcriptBudget', 'transport'],
    );
    // Every lever names the env var that actually owns it — the whole point of
    // the projection is telling the operator WHERE the real switch lives.
    for (const l of ce!.levers) expect(l.envVar).toMatch(/^OPENWOP_CONTEXT_ECONOMY/);
  });

  it('REFLECTS the env rather than a stored row (the anti-lying-switch property)', async () => {
    delete process.env.OPENWOP_CONTEXT_ECONOMY;
    delete process.env.OPENWOP_CONTEXT_ECONOMY_TOOL_DIET;
    const off = (await get()).capabilities.find((c) => c.id === 'context-economy')!;
    expect(off.enabled).toBe(false);
    expect(off.levers.find((l) => l.id === 'toolDiet')!.enabled).toBe(false);

    // Master on ⇒ every lever defaults on.
    process.env.OPENWOP_CONTEXT_ECONOMY = 'true';
    const on = (await get()).capabilities.find((c) => c.id === 'context-economy')!;
    expect(on.enabled).toBe(true);
    expect(on.levers.every((l) => l.enabled)).toBe(true);

    // An explicit per-lever env overrides the master — reported faithfully.
    process.env.OPENWOP_CONTEXT_ECONOMY_TOOL_DIET = 'false';
    const mixed = (await get()).capabilities.find((c) => c.id === 'context-economy')!;
    expect(mixed.enabled).toBe(true);
    expect(mixed.levers.find((l) => l.id === 'toolDiet')!.enabled).toBe(false);
  });

  it('is superadmin-gated and read-only (no write twin)', async () => {
    const anon = await fetch(`${BASE}${PATH}`); // anon cookie session, non-superadmin
    expect(anon.status).toBe(403);
    for (const method of ['PUT', 'POST', 'DELETE']) {
      const res = await fetch(`${BASE}${PATH}`, { method, headers: ADMIN });
      expect(res.status, `${method} must not be routable`).not.toBe(200);
    }
  });

  it('context-economy is no longer a flippable feature toggle', () => {
    expect(getToggleDefault('context-economy')).toBeFalsy();
  });
});
