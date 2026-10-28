/**
 * Operator recipes in the shipped docs reach a live route (gap-closure plan
 * section 01, S01-R1 / witness S01-T1; audit OPS-01).
 *
 * The defect this closes: major 1 was retired (ADR 0812), so every `/v1/…`
 * address answers `410` — except a held READ, which ADR 0806 forwards `308`.
 * The README's Stripe setup still told an operator to `POST
 * /v1/host/openwop-app/byok/secrets` and `PUT …/v1/…/commerce-connect/fee-config`,
 * and `.env.example` told them to register a `/v1` SAML ACS URL, which the IdP
 * POSTs to. Each of those is a write, so each was refused: an adopter following
 * the docs could not configure billing or sign in with SAML.
 *
 * Two halves, both against the real app (no handwritten route catalog):
 *   1. Every `/v1/…` address of THIS host named in a shipped operator doc is
 *      requested with the method the doc gives it, and must not answer 410.
 *      What survives is an address the host still forwards (the OAuth callback,
 *      held by provider consoles, and public reads).
 *   2. The Stripe recipe itself, run as the README describes it with a wildcard
 *      operator key and fake test credentials: the secret write lands where
 *      billing resolves it (host-global), a webhook signed with it is
 *      acknowledged and one signed with another secret is refused, and the fee
 *      config round-trips. Each write's retired `/v1` spelling answers 410.
 *
 * Sabotage: putting `/v1` back in front of any documented write in README.md,
 * DEPLOY.md, DEPLOY-SMOKE.md, WHITE-LABEL.md, a deploy README or `.env.example`
 * reds half 1 with the file and line. The docs read here all ship in the
 * white-label bundle (`scripts/build-whitelabel-zip.sh`), so this is not a
 * steward-lane test.
 */
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { resolveSecret } from '../src/byok/secretResolver.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OPERATOR_KEY = 'k-s01-operator';
const auth = { authorization: `Bearer ${OPERATOR_KEY}`, 'content-type': 'application/json' };

let server: Server;
let BASE = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_API_KEYS = `${OPERATOR_KEY}:*`;
  // README § "⚠ OPENWOP_BYOK_EPHEMERAL gotcha": platform billing requires it.
  process.env.OPENWOP_BYOK_EPHEMERAL = 'false';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('billing');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => {
  for (const k of ['OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET', 'OPENWOP_API_KEYS', 'OPENWOP_BYOK_EPHEMERAL']) delete process.env[k];
  await new Promise<void>((res) => server.close(() => res()));
});

/** The adopter-facing operator docs that name this host's routes. */
function operatorDocs(): string[] {
  const deployDir = join(REPO, 'deploy');
  const deployReadmes = readdirSync(deployDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join('deploy', e.name, 'README.md'))
    .filter((p) => existsSync(join(REPO, p)));
  return ['README.md', 'DEPLOY.md', 'DEPLOY-SMOKE.md', 'deploy/README.md', 'frontend/react/WHITE-LABEL.md', 'backend/typescript/.env.example', ...deployReadmes];
}

interface DocRef { where: string; method: string; path: string }

/** Hosts that are this app. A `/v1/` under any other host (Google's JWKS, the
 *  pack registry) is somebody else's API and is left alone. */
const OWN_HOST = /^(?:https?:\/\/(?:localhost|127\.0\.0\.1|<your-host>|app\.openwop\.dev)(?::\d+)?)?(?:\$\{?BASE\}?|\$\{?[A-Z_]+_URL\}?)?(?:\/api)?$/;

function docRefs(): DocRef[] {
  const out: DocRef[] = [];
  for (const file of operatorDocs()) {
    const lines = readFileSync(join(REPO, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/(\S*?)(\/v1\/[A-Za-z0-9_\-/:.{}<>$]+)/g)) {
        const prefix = (m[1] ?? '').replace(/^[`'"(]+/, '').replace(/^.*?(https?:\/\/)/, '$1');
        if (!OWN_HOST.test(prefix)) continue;
        const before = line.slice(0, m.index);
        // A provider POSTs to an ACS or webhook URL; a doc lists it bare. Probing
        // it as a GET would hit the held-read forward and pass a dead address.
        const verb = /\b(GET|POST|PUT|PATCH|DELETE)\b[`\s]*$/.exec(before)?.[1]
          ?? /-X\s+(GET|POST|PUT|PATCH|DELETE)\b/.exec(line)?.[1]
          ?? (/\/(?:acs|webhook)\b/.test(m[2]!) ? 'POST' : 'GET');
        const path = m[2]!
          .replace(/[.,:;)`'"]+$/, '')
          .replace(/\.\.\.$/, '')
          // `:orgId`, `{id}`, `<provider>`, `$RUNID` → a placeholder id; a
          // trailing custom verb (`{id}:fork`) survives.
          .split('/')
          .map((seg) => seg.replace(/^(?::[A-Za-z_]+|\{[^}]*\}|<[^>]*>|\$\{?[A-Za-z_]+\}?)/, 'x'))
          .join('/');
        out.push({ where: `${file}:${i + 1}`, method: verb, path });
      }
    });
  }
  return out;
}

describe('S01-T1 — every documented /v1 address of this host still answers', () => {
  const refs = docRefs();

  it('finds the documented addresses it is checking (the scan is not empty)', () => {
    // The OAuth callback is documented on purpose (ADR 0806: the provider console
    // holds it); if the scan stops seeing even that, the scan broke, not the docs.
    expect(refs.some((r) => r.path.endsWith('/callback'))).toBe(true);
  });

  it('no documented /v1 address answers 410', async () => {
    const gone: string[] = [];
    for (const r of refs) {
      const res = await fetch(`${BASE}${r.path}`, { method: r.method, redirect: 'manual', headers: auth, ...(r.method === 'GET' ? {} : { body: '{}' }) });
      if (res.status === 410) gone.push(`${r.where}: ${r.method} ${r.path}`);
    }
    expect(gone, 'documented as the address to use, but the host has withdrawn it (410)').toEqual([]);
  });
});

describe('S01-T1 — the README Stripe recipe, run as written', () => {
  const sign = (body: string, secret: string): string => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  };

  it('the BYOK write lands host-global, where billing resolves it, and echoes no value', async () => {
    const res = await fetch(`${BASE}/host/openwop-app/byok/secrets`, {
      method: 'POST', headers: auth, body: JSON.stringify({ credentialRef: 'billing:webhook-secret', value: 'whsec_s01_fixture' }),
    });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('whsec_s01_fixture');
    expect(await resolveSecret('billing:webhook-secret')).toBe('whsec_s01_fixture');
  });

  it('a webhook signed with that secret is acknowledged; one signed with another is refused', async () => {
    const raw = JSON.stringify({ id: 'evt_s01_fixture', type: 'customer.created', data: { object: { id: 'cus_s01' } } });
    const good = await fetch(`${BASE}/host/openwop-app/billing/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sign(raw, 'whsec_s01_fixture') }, body: raw,
    });
    // 202 {received:true} is the route's acknowledgement (Stripe stops retrying on
    // any 2xx). This fixture event names no tenant, so it is acked unapplied.
    expect(good.status).toBe(202);
    expect(await good.json()).toEqual({ received: true, applied: false });
    const bad = await fetch(`${BASE}/host/openwop-app/billing/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sign(raw, 'whsec_someone_else') }, body: raw,
    });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { message?: string }).message).toBe('Stripe signature verification failed.');
  });

  it('the fee config round-trips through the documented route', async () => {
    const put = await fetch(`${BASE}/host/openwop-app/commerce-connect/fee-config`, {
      method: 'PUT', headers: auth, body: JSON.stringify({ applicationFeePct: 13 }),
    });
    expect(put.status).toBe(200);
    const get = await fetch(`${BASE}/host/openwop-app/commerce-connect/fee-config`, { headers: auth });
    expect(((await get.json()) as { applicationFeePct?: number }).applicationFeePct).toBe(13);
  });

  it('the retired /v1 spelling of each recipe write answers 410, not a silent success', async () => {
    for (const [method, path, body] of [
      ['POST', '/v1/host/openwop-app/byok/secrets', { credentialRef: 'billing:stripe-key', value: 'sk_test_s01' }],
      ['PUT', '/v1/host/openwop-app/commerce-connect/fee-config', { applicationFeePct: 14 }],
      ['POST', '/v1/host/openwop-app/auth/saml/sso/acs', {}],
    ] as const) {
      const res = await fetch(`${BASE}${path}`, { method, headers: auth, body: JSON.stringify(body) });
      expect(res.status, `${method} ${path}`).toBe(410);
      expect(((await res.json()) as { error?: string }).error, `${method} ${path}`).toBe('protocol_version_unsupported');
    }
    expect(await resolveSecret('billing:stripe-key')).toBeNull();
  });
});
