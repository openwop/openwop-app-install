/**
 * Secrets-vault admin surface (ADR 0389 Phase 2) — over HTTP against the real
 * app: the superadmin gate fails closed; the LIST boundary never carries a
 * value; reveal demands step-up (wildcard admin bearer exempt — the operator
 * key IS the step-up) and audits BEFORE returning; `connection:*` refs are
 * refused for reveal/rotate/delete (the connections lifecycle owns them);
 * delete fail-closes on live references and honors ?force=true; every
 * mutation lands a `security.*` row on the EXISTING tamper-evident chain.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { listChain, __resetAuditChain } from '../src/host/auditChainService.js';
import { setHeadlessAiDefault } from '../src/host/headlessAi.js';
import { setSecret } from '../src/byok/secretResolver.js';

let server: http.Server;
let BASE: string;
const ADMIN = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
const VAULT = '/v1/host/openwop-app/vault';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await __resetAuditChain();
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 0389 P2 — secrets vault', () => {
  it('fails closed: an authenticated non-superadmin (anon session) gets 403', async () => {
    const res = await fetch(`${BASE}${VAULT}`); // no bearer ⇒ anon cookie session
    expect(res.status).toBe(403);
  });

  it('inventory is masked — refs/metadata only, never a value field', async () => {
    await setSecret('vault-test-key', 's3cret-value'); // host-global bucket
    const res = await fetch(`${BASE}${VAULT}`, { headers: ADMIN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hostSecrets: Array<{ credentialRef: string }> };
    expect(body.hostSecrets.some((s: { credentialRef: string }) => s.credentialRef === 'vault-test-key')).toBe(true);
    // The WHOLE response must not carry the stored value anywhere.
    expect(JSON.stringify(body)).not.toContain('s3cret-value');
  });

  it('add stores to the host bucket via scope:"host"; a connection:* ref is refused', async () => {
    const ok = await fetch(`${BASE}${VAULT}/secrets`, {
      method: 'POST', headers: ADMIN,
      body: JSON.stringify({ credentialRef: 'vault-added', value: 'v1-value', scope: 'host' }),
    });
    expect(ok.status).toBe(201);
    const refused = await fetch(`${BASE}${VAULT}/secrets`, {
      method: 'POST', headers: ADMIN,
      body: JSON.stringify({ credentialRef: 'connection:abc', value: 'x', scope: 'host' }),
    });
    expect(refused.status).toBe(400);
  });

  it('reveal: wildcard admin bearer is step-up-exempt, audits BEFORE returning; connection:* refused', async () => {
    const res = await fetch(`${BASE}${VAULT}/secrets/vault-added/reveal`, {
      method: 'POST', headers: ADMIN, body: JSON.stringify({ scope: 'host' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { value: string }).value).toBe('v1-value');
    // The reveal chained a tamper-evident security.* row (host-admin chain for
    // the wildcard bearer).
    const chain = await listChain('host-admin');
    const reveal = chain.find((e) => e.kind === 'security.secret-reveal');
    expect(reveal).toBeTruthy();
    expect((reveal!.payload as { credentialRef?: string }).credentialRef).toBe('vault-added');

    const conn = await fetch(`${BASE}${VAULT}/secrets/connection:abc/reveal`, {
      method: 'POST', headers: ADMIN, body: JSON.stringify({ scope: 'host' }),
    });
    expect(conn.status).toBe(403); // delegated tokens never reveal
  });

  it('reveal demands step-up for a non-wildcard session (cookie caller ⇒ 403 stepup_required)', async () => {
    // Become a superadmin TENANT via env; the anon cookie session has no fresh
    // auth_time ⇒ fail closed.
    const mint = await fetch(`${BASE}${VAULT}`); // mints an anon cookie (403 — not superadmin yet)
    const setCookie = mint.headers.get('set-cookie') ?? '';
    const m = /(__session=[^;]+)/.exec(setCookie);
    expect(m).toBeTruthy();
    // Extract the anon tenant from a whoami-ish route: use /v1/host/openwop-app/me/workspaces
    const who = await fetch(`${BASE}/v1/host/openwop-app/me/workspaces`, { headers: { cookie: m![1]! } });
    expect(who.status).toBe(200);
    const personal = ((await who.json()) as { personal: string }).personal;
    process.env.OPENWOP_SUPERADMIN_TENANTS = personal;
    try {
      const res = await fetch(`${BASE}${VAULT}/secrets/vault-added/reveal`, {
        method: 'POST', headers: { cookie: m![1]!, 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'host' }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(JSON.stringify(body)).toContain('stepup_required');
    } finally {
      delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    }
  });

  it('rotate overwrites an existing ref (404 for a missing one) and audits', async () => {
    const missing = await fetch(`${BASE}${VAULT}/secrets/never-stored/rotate`, {
      method: 'POST', headers: ADMIN, body: JSON.stringify({ value: 'x', scope: 'host' }),
    });
    expect(missing.status).toBe(404);
    const res = await fetch(`${BASE}${VAULT}/secrets/vault-added/rotate`, {
      method: 'POST', headers: ADMIN, body: JSON.stringify({ value: 'v2-value', scope: 'host' }),
    });
    expect(res.status).toBe(200);
    const reveal = await fetch(`${BASE}${VAULT}/secrets/vault-added/reveal`, {
      method: 'POST', headers: ADMIN, body: JSON.stringify({ scope: 'host' }),
    });
    expect(((await reveal.json()) as { value: string }).value).toBe('v2-value');
    const chain = await listChain('host-admin');
    expect(chain.some((e) => e.kind === 'security.secret-rotate')).toBe(true);
  });

  it('delete fail-closes on a live reference, honors ?force=true, audits', async () => {
    // Bind the secret as a tenant's headless-AI default → a live consumer.
    // (Tenant-scoped: the consumer check keys off the CALLER's tenant, so use a
    // tenant superadmin session.)
    const mint = await fetch(`${BASE}/v1/host/openwop-app/me/workspaces`);
    const cookie = /(__session=[^;]+)/.exec(mint.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const who = await fetch(`${BASE}/v1/host/openwop-app/me/workspaces`, { headers: { cookie } });
    const personal = ((await who.json()) as { personal: string }).personal;
    process.env.OPENWOP_SUPERADMIN_TENANTS = personal;
    try {
      await setSecret('dep-checked', 'val', { tenantId: personal });
      await setHeadlessAiDefault(
        { tenantId: personal, actorId: 'test' },
        { provider: 'openai', model: 'gpt-4o-mini', credentialRef: 'dep-checked' },
        new Date().toISOString(),
      );
      const refused = await fetch(`${BASE}${VAULT}/secrets/dep-checked`, {
        method: 'DELETE', headers: { cookie },
      });
      expect(refused.status).toBe(409);
      expect(JSON.stringify(await refused.json())).toContain('headless-ai default binding');
      const forced = await fetch(`${BASE}${VAULT}/secrets/dep-checked?force=true`, {
        method: 'DELETE', headers: { cookie },
      });
      expect(forced.status).toBe(200);
      const chain = await listChain(personal);
      expect(chain.some((e) => e.kind === 'security.secret-delete')).toBe(true);
    } finally {
      delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    }
  });

  /**
   * ENG-2 / SEC-G4 — the two paths where the "fail-closed" delete guard was
   * fail-OPEN. Both previously produced `[]` from the consumer lookup, and `[]`
   * flows into `consumers.length > 0` as PERMISSION. The distinction the fix
   * introduces is between "I looked, nothing uses this" and "I could not look";
   * only the first may delete unforced.
   *
   * These are route-level on purpose: the no-tenant branch is a property of the
   * REQUEST (which credential was presented), so a service-level test cannot
   * reach it — it is only observable through the HTTP boundary.
   */
  describe('delete refuses when consumers are UNKNOWN (ENG-2)', () => {
    it('host-scoped secret: cross-tenant consumers are not enumerable → 409, not a silent delete', async () => {
      const mint = await fetch(`${BASE}/v1/host/openwop-app/me/workspaces`);
      const cookie = /(__session=[^;]+)/.exec(mint.headers.get('set-cookie') ?? '')?.[1] ?? '';
      const who = await fetch(`${BASE}/v1/host/openwop-app/me/workspaces`, { headers: { cookie } });
      const personal = ((await who.json()) as { personal: string }).personal;
      process.env.OPENWOP_SUPERADMIN_TENANTS = personal;
      try {
        // A host-global (scopeless) secret — the `billing:stripe-key` class.
        await setSecret('host-global-probe', 'val');
        const refused = await fetch(`${BASE}${VAULT}/secrets/host-global-probe?scope=host`, {
          method: 'DELETE', headers: { cookie },
        });
        expect(refused.status).toBe(409);
        const body = await refused.json() as { details?: { referencesKnown?: boolean } };
        // The load-bearing assertion: the refusal is because the answer is
        // UNKNOWN, not because a consumer was named.
        expect(body.details?.referencesKnown).toBe(false);

        // …and force still works, so this is a speed bump for an operator who
        // knows what they are doing, not a dead end.
        const forced = await fetch(`${BASE}${VAULT}/secrets/host-global-probe?scope=host&force=true`, {
          method: 'DELETE', headers: { cookie },
        });
        expect(forced.status).toBe(200);
      } finally {
        delete process.env.OPENWOP_SUPERADMIN_TENANTS;
      }
    });

    it('wildcard admin bearer (no tenant context): 409 rather than the permissive empty answer', async () => {
      await setSecret('no-tenant-probe', 'val');
      const refused = await fetch(`${BASE}${VAULT}/secrets/no-tenant-probe?scope=host`, {
        method: 'DELETE', headers: ADMIN,
      });
      expect(refused.status).toBe(409);
      const body = await refused.json() as { details?: { referencesKnown?: boolean } };
      expect(body.details?.referencesKnown).toBe(false);

      const forced = await fetch(`${BASE}${VAULT}/secrets/no-tenant-probe?scope=host&force=true`, {
        method: 'DELETE', headers: ADMIN,
      });
      expect(forced.status).toBe(200);
    });

    it('audits WHICH answer it had — a forced delete over an unknown index is not the same act as one over a named binding', async () => {
      await __resetAuditChain();
      await setSecret('audit-unknown-probe', 'val');
      await fetch(`${BASE}${VAULT}/secrets/audit-unknown-probe?scope=host&force=true`, {
        method: 'DELETE', headers: ADMIN,
      });
      const chain = await listChain('host-admin');
      const row = chain.find((e) => e.kind === 'security.secret-delete');
      expect(row).toBeTruthy();
      const detail = JSON.stringify(row);
      expect(detail).toContain('"referencesKnown":false');
      expect(detail).toContain('referencesUnknownReason');
      // And never the secret VALUE.
      expect(detail).not.toContain('val"');
    });
  });
});

describe('a FAILED write must not leave the chain asserting a success', () => {
  /**
   * The pre-write append (DATAG-2, `adminVault.ts`) is deliberate and stays: an
   * audit failure must abort rather than yield an UNAUDITED write. But it has a
   * cost the original comment did not name — when `setSecret` then throws, the
   * chain is left asserting a `security.secret-set` that never happened.
   *
   * Auditing after instead would trade this over-report for an under-report (a
   * crash between write and append hides a real secret change), which is strictly
   * worse. So the fix is a COMPENSATING record, not a reordering: the attempt is
   * still recorded, and the outcome is recorded too.
   *
   * The failure is real, not mocked: `ephemeralEnabled()` reads the env at call
   * time, and under ephemeral mode a SCOPELESS (host) write throws by design —
   * exactly the configuration in which this is reachable in production.
   */
  it('appends security.secret-set-failed when the write throws, keeping the attempt row', async () => {
    process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
    try {
      const res = await fetch(`${BASE}${VAULT}/secrets`, {
        method: 'POST', headers: ADMIN,
        body: JSON.stringify({ credentialRef: 'phantom-probe', value: 'never-stored-value', scope: 'host' }),
      });
      expect(res.status, 'the write failed, so the route must not report 201').not.toBe(201);

      const chain = await listChain('host-admin');
      const rows = chain.filter((e) => String(e.kind).startsWith('security.secret-set'));
      const attempt = rows.filter((e) => e.kind === 'security.secret-set'
        && (e.payload as { credentialRef?: string }).credentialRef === 'phantom-probe');
      const failure = rows.filter((e) => e.kind === 'security.secret-set-failed'
        && (e.payload as { credentialRef?: string }).credentialRef === 'phantom-probe');

      // Fixture guard — if the attempt row is missing the route never got far
      // enough to be interesting, and the assertion below would pass vacuously.
      expect(attempt.length, 'fixture guard: the pre-write attempt row must exist').toBe(1);
      // The load-bearing assertion.
      expect(failure.length, 'an attempt with no outcome row reads as a successful set').toBe(1);

      // The compensating row is attacker-visible in an audit export — it carries
      // the ref and the error, never the value.
      expect(JSON.stringify(failure[0])).not.toContain('never-stored-value');
      expect(JSON.stringify(failure[0])).toContain('phantom-probe');
    } finally {
      delete process.env.OPENWOP_BYOK_EPHEMERAL;
    }
  });

  it('a SUCCESSFUL write records the attempt and NO failure row', async () => {
    // The other arm — the compensation must not fire on the happy path.
    const res = await fetch(`${BASE}${VAULT}/secrets`, {
      method: 'POST', headers: ADMIN,
      body: JSON.stringify({ credentialRef: 'happy-probe', value: 'stored-fine', scope: 'host' }),
    });
    expect(res.status).toBe(201);
    const chain = await listChain('host-admin');
    const failure = chain.filter((e) => e.kind === 'security.secret-set-failed'
      && (e.payload as { credentialRef?: string }).credentialRef === 'happy-probe');
    expect(failure.length, 'a spurious failure row is its own dishonesty').toBe(0);
  });
});
