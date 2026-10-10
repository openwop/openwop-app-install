/**
 * ADR 0800 D2 — the API keys tab offers presets, and the server narrows a key
 * to EXACTLY the scopes it declares (`keyDeclarationPermits`). A preset naming a
 * scope no route gates on would mint a key that looks capable and is refused;
 * a "full" preset missing a gated scope would be a quiet lie. Both are pinned
 * here against the backend's own list, and the run-and-read claim is proved
 * over HTTP with the preset's real scopes (the MCP "Read & act" preset, the only
 * one a person could pick before, creates a run and then cannot read it).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { SCOPES_SUPPORTED } from '../src/host/protocolAuthorization.js';
import { MINTABLE_KEY_SCOPES } from '../src/features/developer-keys/keyPolicy.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { toWireRunId } from '../src/host/v2Ids.js';

const CLIENT = resolve(import.meta.dirname, '..', '..', '..', 'frontend', 'react', 'src', 'features', 'developer-keys', 'apiKeysClient.ts');

function presets(): Record<string, string[]> {
  const src = readFileSync(CLIENT, 'utf8');
  const block = /export const API_KEY_PRESETS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src)?.[1];
  if (!block) throw new Error('API_KEY_PRESETS not found in apiKeysClient.ts');
  const out: Record<string, string[]> = {};
  for (const m of block.matchAll(/(\w+):\s*\[([\s\S]*?)\]/g)) out[m[1]!] = [...m[2]!.matchAll(/'([^']+)'/g)].map((s) => s[1]!);
  return out;
}

describe('ADR 0800 D2 — the SPA key presets are pinned to the scopes this host gates on', () => {
  const P = presets();

  it('the parse found the three presets (an empty parse agrees with anything)', () => {
    expect(Object.keys(P).sort()).toEqual(['cli', 'read', 'run']);
    for (const scopes of Object.values(P)) expect(scopes.length).toBeGreaterThan(0);
  });

  it('every preset scope is one the server will mint (ADR 0795 D3) — a typo here is a 400 for every user', () => {
    for (const [name, scopes] of Object.entries(P)) {
      for (const s of scopes) expect(MINTABLE_KEY_SCOPES, `${name}: ${s}`).toContain(s);
    }
  });

  it('"run" and "read" are protocol-only: they reach no part of the workspace', () => {
    for (const name of ['run', 'read']) {
      for (const s of P[name]!) expect(SCOPES_SUPPORTED, `${name}: ${s}`).toContain(s);
      expect(P[name]!.some((s) => s.startsWith('workspace:'))).toBe(false);
    }
  });

  it('"cli" is every protocol scope plus the workspace pair the vendor floor asks of a key (ADR 0795 D2)', () => {
    expect([...P.cli!].sort()).toEqual([...SCOPES_SUPPORTED, 'workspace:read', 'workspace:write'].sort());
  });
});

describe('ADR 0800 D2 — what each preset can do on the protocol, over HTTP', () => {
  let server: http.Server; let BASE = '';
  const saved: Record<string, string | undefined> = {};
  const TENANT = 'adr0800-presets';

  beforeAll(async () => {
    for (const k of ['OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_AUTHORIZATION_ENFORCEMENT']) saved[k] = process.env[k];
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    delete process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0800-presets', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  }, 120_000);
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  // A LIVE run (`conformance-cancellable`), so cancel answers 200: major 2 refuses to cancel a
  // run that has already finished (409), which would hide the scope check this probes.
  async function probe(scopes: string[]): Promise<{ create: number; get: number; poll: number; list: number; cancel: number }> {
    const { token } = await issueApiKey({ tenantId: TENANT, name: 'p', createdBy: 'user:adr0800', scopes });
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json', connection: 'close', 'OpenWOP-Version': '2' };
    const create = await fetch(`${BASE}/runs`, { method: 'POST', headers: h, body: JSON.stringify({ workflowId: 'conformance-cancellable', inputs: { delayMs: 20000 } }) });
    // A refused create has no id; probe with a well-formed tenant-BOUND one, since a
    // bare id on a v2 path is refused 400 before the scope check this file measures.
    const id = encodeURIComponent(((await create.json().catch(() => ({}))) as { runId?: string }).runId ?? toWireRunId('no-such-run-adr0800', TENANT));
    const get = await fetch(`${BASE}/runs/${id}`, { headers: h });
    const poll = await fetch(`${BASE}/runs/${id}/events/poll`, { headers: h });
    const list = await fetch(`${BASE}/runs`, { headers: h });
    const cancel = await fetch(`${BASE}/runs/${id}/cancel`, { method: 'POST', headers: h, body: '{}' });
    return { create: create.status, get: get.status, poll: poll.status, list: list.status, cancel: cancel.status };
  }

  it('"run" creates a run and can read, follow, list and cancel it', async () => {
    expect(await probe(presets().run!)).toEqual({ create: 201, get: 200, poll: 200, list: 200, cancel: 200 });
  });

  it('"cli" does everything "run" does', async () => {
    expect(await probe(presets().cli!)).toEqual({ create: 201, get: 200, poll: 200, list: 200, cancel: 200 });
  });

  it('"read" lists runs and is refused creating or cancelling one', async () => {
    const r = await probe(presets().read!);
    expect(r.create).toBe(403);
    expect(r.list).toBe(200);
    expect(r.cancel).toBe(403);
  });

  it('CONTROL — the MCP "Read & act" scopes create a run and cannot read it (why this tab exists)', async () => {
    const r = await probe(['workspace:read', 'workspace:write', 'runs:create']);
    expect(r).toEqual({ create: 201, get: 403, poll: 403, list: 403, cancel: 403 });
  });
});
