/**
 * ADR 0416 — trust center + tenant audit export.
 *  P1: the `trust` system-site page seeds DRAFT via the marketing/legal seeder
 *  (one owner, deterministic id), makes only capability-true claims (no
 *  fabricated certifications), carries the operator placeholders, and links the
 *  existing policy pages instead of duplicating them.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { ensureMarketingLegalPages, __resetMarketingLegalEnsure } from '../src/host/marketingLegalPages.js';
import { getPage, type Section } from '../src/features/cms/cmsService.js';
import { appendAudit } from '../src/host/auditChainService.js';

let BASE: string; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** Cookie-jar client (the adr0391 harness pattern). `raw` keeps body as text +
 *  exposes headers for the CSV/proof-header assertions. */
function client() {
  let cookie = '';
  const raw = async (method: string, path: string, body?: unknown): Promise<{ status: number; text: string; headers: Headers }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, text: await res.text(), headers: res.headers };
  };
  return {
    raw,
    get: (path: string) => raw('GET', path),
    login: async () => {
      const r = await raw('POST', '/v1/host/openwop-app/test/login', { email: `trust-${Date.now()}-${n++}@acme.test` });
      expect([200, 201]).toContain(r.status);
      const { user } = JSON.parse(r.text) as { user: { tenantId: string } };
      return { tenantId: user.tenantId };
    },
  };
}

const sectionText = (s: Section): string => {
  const d = s.data as Record<string, unknown>;
  return [d.heading, d.subheading, d.text].filter((v): v is string => typeof v === 'string').join('\n');
};

describe('ADR 0416 P1 — trust-center page seed', () => {
  it('seeds the trust page DRAFT with honest claims, placeholders, and policy links', async () => {
    __resetMarketingLegalEnsure();
    await ensureMarketingLegalPages();

    const trust = await getPage('host:site', 'host-site', 'page:host-site-trust');
    expect(trust).toBeTruthy();
    // DRAFT — the operator reviews + publishes through the editorial gate.
    expect(trust?.status).toBe('draft');
    expect(trust?.slug).toBe('trust');

    const all = (trust?.sections ?? []).map(sectionText).join('\n');
    // Capability-true claims present…
    expect(all).toContain('Multi-factor authentication');
    expect(all).toContain('tamper-evident audit trail');
    expect(all).toContain('Bring-your-own-key');
    // …deployment-specific facts are explicit operator placeholders…
    expect(all).toContain('[PLACEHOLDER');
    // …no fabricated certification claims anywhere in the seed.
    expect(all).not.toMatch(/SOC ?2|ISO ?27001|HIPAA|certified/i);
    // Links the existing pages rather than duplicating their content.
    for (const slug of ['/p/security', '/p/subprocessors', '/p/privacy', '/p/dpa', '/p/vulnerability-disclosure']) {
      expect(all).toContain(slug);
    }
  });
});

describe('ADR 0416 P2 — tenant audit-chain export', () => {
  const EXPORT = '/v1/host/openwop-app/governance/audit/export';

  it('an anonymous visitor sees ONLY their own (empty) anon-workspace chain — never another tenant', async () => {
    // The tenant-level gate's documented authority (featureRoute.ts): the caller
    // is the implicit owner of their OWN personal workspace — in the demo
    // cookie-per-visitor posture that includes a fresh anon tenant. The export
    // is keyed by the CALLER's tenant with no override, so the worst an anon
    // caller gets is their own empty chain (nothing to leak). Seed a real
    // tenant's chain first and prove none of it appears.
    await appendAudit('tenant-someone-else', 'test.event', { tenantId: 'tenant-someone-else' });
    const r = await client().get(EXPORT);
    expect(r.status).toBe(200);
    const lines = r.text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const proof = lines[0];
    expect(proof.proof).toBe(true);
    expect(proof.tenantId).not.toBe('tenant-someone-else');
    expect(proof.entries).toBe(0);
    expect(lines.length).toBe(1); // proof line only — zero entries
  });

  it('exports the caller tenant chain as JSONL with a verified proof line — and ONLY that tenant', async () => {
    const c = client();
    const { tenantId } = await c.login();
    await appendAudit(tenantId, 'test.event', { tenantId, note: 'first' });
    await appendAudit(tenantId, 'test.event', { tenantId, note: 'second' });
    // A FOREIGN tenant's chain rows must never appear in this export.
    await appendAudit('tenant-foreign', 'test.event', { tenantId: 'tenant-foreign', note: 'other' });

    const r = await c.get(EXPORT);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/x-ndjson');
    expect(r.headers.get('content-disposition')).toContain('audit-chain.jsonl');
    const lines = r.text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const proof = lines[0];
    expect(proof.proof).toBe(true);
    expect(proof.tenantId).toBe(tenantId);
    expect(proof.verified).toBe(true);
    expect((proof.head as { seq: number }).seq).toBeGreaterThanOrEqual(2);
    const entries = lines.slice(1);
    expect(entries.length).toBe(proof.entries);
    for (const e of entries) {
      expect(e.tenantId).toBe(tenantId); // isolation — no foreign rows
      expect(typeof e.entryHash).toBe('string');
      expect(typeof e.prevHash).toBe('string');
    }
    expect(entries.some((e) => (e.payload as { note?: string }).note === 'other')).toBe(false);
  });

  it('CSV format carries the proof in response headers and RFC-4180 rows', async () => {
    const c = client();
    const { tenantId } = await c.login();
    await appendAudit(tenantId, 'test.csv', { tenantId, tricky: 'a,"quoted"\nline' });
    const r = await c.get(`${EXPORT}?format=csv`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.headers.get('x-audit-verified')).toBe('true');
    expect(Number(r.headers.get('x-audit-head-seq'))).toBeGreaterThanOrEqual(1);
    expect(r.headers.get('x-audit-head-hash')).toMatch(/^[0-9a-f]{64}$/);
    const [header] = r.text.split('\r\n');
    expect(header).toBe('seq,at,kind,prevHash,entryHash,payload');
    // RFC-4180: the JSON payload cell (embedded commas + quotes) is wrapped and
    // every interior quote doubled — `"{""tenantId""…}"`.
    expect(r.text).toContain('"{""tenantId""');
    expect(r.text).toContain('\\""quoted\\""');
  });
});
