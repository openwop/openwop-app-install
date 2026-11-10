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
 *   1. it REFLECTS the env (flip the env → the reported state flips), and each
 *      lever's reported `envVar` is the variable that actually moves it;
 *   2. it is superadmin-gated and has no write twin.
 * Plus the regression that motivated the change: `context-economy` must no
 * longer appear as a flippable toggle.
 *
 * Sabotage (witnessed 2026-11-03, w81): dropping a lever or the voice note reds
 * the inventory case; reporting a stored/constant master or wiring a lever to the
 * master reds the REFLECTS case; swapping two levers' `envVar`s reds the binding
 * case; removing the superadmin check, or adding a write route, reds the gate
 * case; re-registering a `context-economy` toggle default reds the last case.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const PATH = '/host/openwop-app/feature-toggles/admin/env-governed';
const ADMIN = { authorization: 'Bearer dev-token' };

interface Lever { id: string; envVar: string; enabled: boolean; note?: string }
interface Capability { id: string; label: string; envVar: string; enabled: boolean; levers: Lever[] }
interface ErrorBody { error?: string; message?: string }

/** Every env var the projection reads. Saved and cleared around each case so a
 *  value in the host env (or a previous case) cannot decide an assertion. */
const CE_KEYS = [
  'OPENWOP_CONTEXT_ECONOMY',
  'OPENWOP_CONTEXT_ECONOMY_PROVIDER_CACHE',
  'OPENWOP_CONTEXT_ECONOMY_TOOL_DIET',
  'OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT',
  'OPENWOP_CONTEXT_ECONOMY_MEMORY',
  'OPENWOP_CONTEXT_ECONOMY_TRANSPORT',
  'OPENWOP_CONTEXT_ECONOMY_CONVERSATION_CACHE',
];
const BOOT_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_SUPERADMIN_TENANTS', 'OPENWOP_FEATURE_TOGGLES_DEV_OPEN'];

describe('env-governed capabilities (ADR 0434)', () => {
  let server: http.Server;
  let BASE: string;
  const savedBoot: Record<string, string | undefined> = {};
  const savedCe: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of BOOT_KEYS) savedBoot[k] = process.env[k];
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
  }, 120_000);
  afterAll(async () => {
    for (const k of BOOT_KEYS) { if (savedBoot[k] === undefined) delete process.env[k]; else process.env[k] = savedBoot[k]; }
    await new Promise<void>((res) => server.close(() => res()));
  });
  beforeEach(() => {
    for (const k of CE_KEYS) { savedCe[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of CE_KEYS) { if (savedCe[k] === undefined) delete process.env[k]; else process.env[k] = savedCe[k]; }
  });

  const contextEconomy = async (): Promise<Capability> => {
    const res = await fetch(`${BASE}${PATH}`, { headers: ADMIN });
    expect(res.status).toBe(200);
    const body = await res.json() as { capabilities: Capability[] };
    const ce = body.capabilities.find((c) => c.id === 'context-economy');
    expect(ce, 'context-economy must remain visible to an operator').toBeTruthy();
    return ce!;
  };

  it('reports context-economy with its owning env var and all six levers', async () => {
    const ce = await contextEconomy();
    expect(ce.envVar).toBe('OPENWOP_CONTEXT_ECONOMY');
    expect(ce.levers.map((l) => l.id).sort()).toEqual(
      ['conversationCache', 'memoryBudget', 'providerCache', 'toolDiet', 'transcriptBudget', 'transport'],
    );
    // Every lever names a DISTINCT env var in the family; the binding case below
    // proves each one is the variable that actually moves that lever.
    for (const l of ce.levers) expect(l.envVar).toMatch(/^OPENWOP_CONTEXT_ECONOMY_/);
    expect(new Set(ce.levers.map((l) => l.envVar)).size).toBe(6);
    // ADR 1003 D7 — the voice seed is windowed whatever the transcript lever
    // says, so the projection must not let "off" read as "never bounded".
    expect(ce.levers.find((l) => l.id === 'transcriptBudget')?.note).toMatch(/voice/i);
  });

  it('REFLECTS the env rather than a stored row (the anti-lying-switch property)', async () => {
    const off = await contextEconomy();
    expect(off.enabled).toBe(false);
    expect(off.levers.find((l) => l.id === 'toolDiet')!.enabled).toBe(false);

    // Master on ⇒ every lever defaults on.
    process.env.OPENWOP_CONTEXT_ECONOMY = 'true';
    const on = await contextEconomy();
    expect(on.enabled).toBe(true);
    expect(on.levers.every((l) => l.enabled)).toBe(true);

    // An explicit per-lever env overrides the master — reported faithfully.
    process.env.OPENWOP_CONTEXT_ECONOMY_TOOL_DIET = 'false';
    const mixed = await contextEconomy();
    expect(mixed.enabled).toBe(true);
    expect(mixed.levers.find((l) => l.id === 'toolDiet')!.enabled).toBe(false);

    // ...and each reported envVar is the one that moves ITS lever: with the
    // master on, turning that one variable off turns exactly that lever off.
    delete process.env.OPENWOP_CONTEXT_ECONOMY_TOOL_DIET;
    for (const lever of on.levers) {
      process.env[lever.envVar] = 'false';
      const now = await contextEconomy();
      expect(now.levers.filter((l) => !l.enabled).map((l) => l.id), lever.envVar).toEqual([lever.id]);
      delete process.env[lever.envVar];
    }
  });

  it('is superadmin-gated and read-only (no write twin)', async () => {
    const anon = await fetch(`${BASE}${PATH}`); // anon cookie session, non-superadmin
    expect(anon.status).toBe(403);
    const refusal = await anon.json() as ErrorBody;
    expect(refusal.error).toBe('forbidden');
    expect(refusal.message).toMatch(/^Feature-toggle administration/);
    for (const method of ['PUT', 'POST', 'DELETE']) {
      const res = await fetch(`${BASE}${PATH}`, { method, headers: ADMIN });
      expect(res.status, `${method} must not be routable`).toBe(404);
    }
  });

  it('context-economy is no longer a flippable feature toggle', () => {
    expect(getToggleDefault('context-economy')).toBeFalsy();
  });
});
