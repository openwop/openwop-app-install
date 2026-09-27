/**
 * ADR 0551 P2 — the RFC 0059 workspace advertisement now follows the guarantee.
 *
 * The claim `workspace.supported: true` was unconditional. `spec/v1/agent-
 * workspace.md` §9 makes the workspace snapshot a cross-host replay guarantee
 * ("a run replayed on another host MUST observe the same workspace snapshot"),
 * and on a `memory://` boot the store dies with the process, so no other process
 * can ever read it. The capability is absent on that profile and the advert now
 * says so.
 *
 * ── WHY BOTH A UNIT AND A ROUTE LEG ────────────────────────────────────────
 *
 * The predicate is a pure function and the unit leg pins its DSN semantics. But
 * a predicate nobody calls is exactly the shape of gate this program keeps
 * finding — green, and connected to nothing. So the load-bearing assertions
 * here boot two REAL apps, one per profile, and read `/.well-known/openwop`.
 * Deleting the gate in `routes/discovery.ts` turns the memory leg red; deleting
 * the whole capability turns the sqlite leg red. Neither can pass vacuously,
 * because each asserts the OPPOSITE of the other on the same key.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import {
  workspaceAdvertisable,
  workspaceDurabilityRequired,
  workspaceReadinessStartupError,
  workspaceReadinessWarning,
} from '../src/host/workspaceReadiness.js';

const DURABLE_ENV = 'OPENWOP_WORKSPACE_REQUIRE_DURABLE';

describe('ADR 0551 P2 — the readiness predicate', () => {
  it('follows the SELECTED ADAPTER, not the adapter TYPE', () => {
    // `memory://` resolves to the sqlite backend at `:memory:`, so "it is the
    // sqlite adapter" and "it survives a restart" are different questions —
    // which is why the predicate reads the DSN and never an adapter instance.
    expect(workspaceAdvertisable('memory://')).toBe(false);
    expect(workspaceAdvertisable(':memory:')).toBe(false);
    expect(workspaceAdvertisable('sqlite://:memory:')).toBe(false);
    expect(workspaceAdvertisable('sqlite:///var/data/app.db')).toBe(true);
    expect(workspaceAdvertisable('postgres://user@host/db')).toBe(true);
  });

  it('warns exactly once per non-durable profile, and never on a durable one', () => {
    const warning = workspaceReadinessWarning('memory://');
    expect(warning).toContain('NOT advertised');
    // Names the remedy AND the escape hatch — a warn that only states the
    // problem is a warn people learn to scroll past.
    expect(warning).toContain('OPENWOP_STORAGE_DSN');
    expect(warning).toContain(DURABLE_ENV);
    expect(workspaceReadinessWarning('sqlite:///var/data/app.db')).toBeNull();
  });
});

describe('ADR 0551 P2 — fail closed on request', () => {
  afterAll(() => { delete process.env[DURABLE_ENV]; });

  it('withholds the capability by DEFAULT rather than refusing to boot', () => {
    delete process.env[DURABLE_ENV];
    expect(workspaceDurabilityRequired()).toBe(false);
    // The whole point of the default: a `memory://` dev box and the test suite
    // still boot. A gate that refuses those is a gate people route around.
    expect(workspaceReadinessStartupError('memory://')).toBeNull();
  });

  it('REFUSES to start when the deployment asked for durability it cannot have', () => {
    process.env[DURABLE_ENV] = 'true';
    expect(workspaceDurabilityRequired()).toBe(true);
    const err = workspaceReadinessStartupError('memory://');
    expect(err).toContain(DURABLE_ENV);
    expect(err).toContain('agent-workspace.md §9');
    // …and does NOT refuse when the storage can back the claim, which is the
    // half that proves the guard is about durability and not about the flag.
    expect(workspaceReadinessStartupError('sqlite:///var/data/app.db')).toBeNull();
    expect(workspaceReadinessStartupError('postgres://user@host/db')).toBeNull();
  });

  it("the flag is exactly 'true' — a truthy string does not arm a fail-closed guard", () => {
    process.env[DURABLE_ENV] = '1';
    expect(workspaceDurabilityRequired()).toBe(false);
    process.env[DURABLE_ENV] = 'true';
    expect(workspaceDurabilityRequired()).toBe(true);
  });
});

/* ── the route leg: two real boots, opposite answers ───────────────────────── */

let memServer: http.Server;
let memBase: string;
let fileServer: http.Server;
let fileBase: string;
let tmp: string;

beforeAll(async () => {
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  delete process.env[DURABLE_ENV];

  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const memApp = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { memServer = memApp.listen(0, '127.0.0.1', () => { memBase = `http://127.0.0.1:${(memServer.address() as AddressInfo).port}`; res(); }); });

  tmp = mkdtempSync(join(tmpdir(), 'owp-workspace-advert-'));
  const fileDsn = `sqlite://${join(tmp, 'workspace.db')}`;
  process.env.OPENWOP_STORAGE_DSN = fileDsn;
  const fileApp = await createApp({ port: 0, storageDsn: fileDsn, serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { fileServer = fileApp.listen(0, '127.0.0.1', () => { fileBase = `http://127.0.0.1:${(fileServer.address() as AddressInfo).port}`; res(); }); });
}, 60_000);

afterAll(async () => {
  await new Promise<void>((res) => memServer.close(() => res()));
  await new Promise<void>((res) => fileServer.close(() => res()));
  rmSync(tmp, { recursive: true, force: true });
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
});

/** The advertisement document. `workspace` sits at its ROOT, beside `kanban`
 *  and `dispatch` — NOT inside the nested `capabilities` object. Asserting the
 *  wrong path would make "absent" true everywhere and both legs below vacuous,
 *  which is why the shape is checked before the key is. */
async function advertisement(base: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/.well-known/openwop`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.protocolVersion).toBeTruthy();
  expect(body.capabilities).toBeTypeOf('object');
  return body;
}

describe('ADR 0551 P2 — /.well-known/openwop follows the readiness check', () => {
  it('a memory:// boot does NOT advertise the workspace', async () => {
    const ad = await advertisement(memBase);
    expect(ad.workspace).toBeUndefined();
    // Sibling root keys are still there — the absence is the gate, not a
    // truncated document.
    expect(ad.kanban).toBeTruthy();
  });

  it('a sqlite FILE boot DOES advertise it, with the same shape as before', async () => {
    const ad = await advertisement(fileBase);
    // The shape is unchanged — P2 gates the claim, it does not renegotiate it.
    expect(ad.workspace).toEqual({ supported: true, maxFileBytes: 65_536 });
  });

  it('the ENDPOINTS keep working on the profile that withholds the claim', async () => {
    // The advert is what was untrue; the routes are the thing under test in
    // eight conformance scenarios and every workspace unit test. Gating those
    // would have traded a real coverage loss for an honesty gain the flag does
    // not require — so this pins that they were NOT gated.
    const res = await fetch(`${memBase}/v1/host/workspace/files`, {
      headers: { authorization: 'Bearer dev-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('files');
  });
});
