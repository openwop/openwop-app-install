/**
 * ADR 0745 D2 — the scope surface RFC 0200 publishes is the one this host enforces.
 *
 * Three claims, one per describe block:
 *   1. `ENFORCED_PROTOCOL_SCOPES` (= PRM `scopes_supported`) is exactly the set of
 *      scopes some protocol route gates on — scanned from the call sites, because a
 *      hand-kept list is the drift RFC 0200 §A.3 forbids ("MUST list the scopes the
 *      host enforces").
 *   2. A self-service `owk_` key that declares scopes is refused `403` for any other,
 *      with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` — in the
 *      DEFAULT posture, not only under RFC 0049 enforcement. Before this ADR a key
 *      minted with `['runs:read']` could create runs.
 *   3. The challenge attaches to scope refusals only: a 404 carries none
 *      (`auth-challenge-no-oracle`), and an undeclared-scope key is not narrowed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { SCOPES_SUPPORTED } from '../src/host/protocolAuthorization.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';

const SRC = resolve(import.meta.dirname, '..', 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' ? [] : tsFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('scopes_supported is derived from the gates, both directions', () => {
  it('every scope a protocol route gates on is listed, and every listed scope is gated on', () => {
    const gated = new Set<string>();
    // `loadReadableRun(…, { scope })` is a gate too (ADR 0746: `getArtifact`
    // authorizes on `artifacts:read` through it); its default `runs:read` is
    // already listed by the literal inside the helper. ADR 0755 adds the key-lane
    // gate (`requireKeyLaneScope`) and prompts.ts's `sendError` wrapper of it.
    const call = /\b(?:requireProtocolScope|requireKeyLaneScope|refusedKeyScope|loadOwnedRun|loadReadableRun)\([^)]*?'([a-z]+:[a-z-]+)'/g;
    for (const f of tsFiles(SRC)) {
      // ADR 0755 (WIT-AUTH-5) — comments are not gates. Unstripped, the doc
      // comment ``requireProtocolScope(req, 'runs:read')`` in runAccess.ts kept
      // `runs:read` "gated" with every real call site deleted. `//` after a `:`
      // is a URL, not a comment.
      const code = stripComments(readFileSync(f, 'utf8'));
      for (const m of code.matchAll(call)) gated.add(m[1]!);
    }
    // Floor: the scan found the gates at all (an empty scan agrees with nothing).
    expect(gated.size).toBeGreaterThanOrEqual(3);
    expect([...gated].sort()).toEqual([...SCOPES_SUPPORTED].sort());
  });

  it('SABOTAGE: the comment stripper removes a gate that exists only in a comment', () => {
    const only = "/** see `requireProtocolScope(req, 'runs:read')` */\n// requireKeyLaneScope(req, 'prompts:read')\nconst u = 'https://x';";
    expect(stripComments(only)).not.toMatch(/runs:read|prompts:read/);
    expect(stripComments(only)).toContain("'https://x'");
  });
});

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

let server: http.Server;
let BASE = '';
const TENANT = 'adr0745-scopes';
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_AUTHORIZATION_ENFORCEMENT']) saved[k] = process.env[k];
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // The DEFAULT posture: RFC 0049 membership enforcement OFF. Key narrowing must hold anyway.
  delete process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0745-scopes', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

async function key(scopes: string[] | undefined): Promise<string> {
  const { token } = await issueApiKey({ tenantId: TENANT, name: 'adr0745', createdBy: 'user:adr0745', ...(scopes ? { scopes } : {}) });
  return token;
}

const createRun = (token: string): Promise<Response> =>
  fetch(`${BASE}/v1/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workflowId: 'openwop-app.uppercase', inputs: {} }),
  });

function params(res: Response): Record<string, string> {
  const h = res.headers.get('www-authenticate') ?? '';
  return Object.fromEntries([...h.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
}

describe('a key that declares scopes is narrowed to them (default posture)', () => {
  it('a runs:read-only key is refused runs:create with the insufficient_scope challenge', async () => {
    const res = await createRun(await key(['runs:read']));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('forbidden');
    const p = params(res);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer /);
    expect(p['error']).toBe('insufficient_scope');
    expect(p['scope']?.split(' ')).toContain('runs:create');
    expect(p['resource_metadata']).toBe(`${BASE}/.well-known/oauth-protected-resource`);
  });

  it('CONTROL: the same key holding runs:create is not refused for scope', async () => {
    const res = await createRun(await key(['runs:read', 'runs:create']));
    expect(res.status, 'without this leg a host refusing every key passes the one above').not.toBe(403);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('a key declaring `*` is not narrowed (scopes are free-form at mint)', async () => {
    const res = await createRun(await key(['*']));
    expect(res.status).not.toBe(403);
  });

  it('a key with NO declared scopes carries its issuer\'s authority (undeclared ≠ none)', async () => {
    const res = await createRun(await key(undefined));
    expect(res.status).not.toBe(403);
  });
});

describe('resolving a run interrupt needs approvals:respond (ADR 0745 follow-up)', () => {
  const resolve = (token: string): Promise<Response> =>
    fetch(`${BASE}/v1/runs/no-such-run/interrupts/gate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ resumeValue: { action: 'accept' } }),
    });

  it('a runs:read key is refused 403 with scope="approvals:respond" — before any existence check', async () => {
    const res = await resolve(await key(['runs:read']));
    expect(res.status).toBe(403);
    const p = params(res);
    expect(p['error']).toBe('insufficient_scope');
    expect(p['scope']?.split(' ')).toEqual(['approvals:respond']);
  });

  it('CONTROL: a key holding approvals:respond passes the scope gate (then 404s on the unknown run, with no challenge)', async () => {
    const res = await resolve(await key(['approvals:respond']));
    expect(res.status).toBe(404);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });
});

describe('the scope challenge never rides a non-scope refusal', () => {
  it('an unknown run is 404 with no challenge (auth-challenge-no-oracle)', async () => {
    const res = await fetch(`${BASE}/v1/runs/no-such-run`, { headers: { authorization: `Bearer ${await key(['runs:read'])}` } });
    expect(res.status).toBe(404);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });
});
