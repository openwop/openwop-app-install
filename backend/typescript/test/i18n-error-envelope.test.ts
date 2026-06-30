/**
 * Localized error envelopes (ADR 0143 / i18n.md annex) — ROUTE-level harness.
 * Boots the real app with i18n enabled (OPENWOP_I18N_LOCALES=en,pt-BR) and drives
 * the error formatter end-to-end via GET /v1/workflows/:id on an unknown id
 * (→ workflow_not_found, 404, no auth needed). Asserts the full negotiation
 * matrix: exact / family / default / unsupported / malformed Accept-Language, and
 * the honesty rule (Content-Language + details.locale ONLY when actually localized).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_I18N_DEFAULT_LOCALE = 'en';
  process.env.OPENWOP_I18N_LOCALES = 'en,pt-BR';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res();
    });
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface ErrBody { error?: string; message?: string; details?: Record<string, unknown> }
interface Res { status: number; headers: Headers; body: ErrBody }
async function getMissing(acceptLanguage?: string): Promise<Res> {
  const res = await fetch(`${BASE}/v1/workflows/does-not-exist-xyz`, {
    headers: acceptLanguage ? { 'accept-language': acceptLanguage } : {},
  });
  const body = (await res.json().catch(() => ({}))) as ErrBody;
  return { status: res.status, headers: res.headers, body };
}

describe('localized error envelopes (ADR 0143)', () => {
  it('exact match: Accept-Language pt-BR → localized message + Content-Language + details.locale', async () => {
    const r = await getMissing('pt-BR');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('workflow_not_found'); // code NEVER localized
    expect(r.body.message).toBe('Fluxo de trabalho não encontrado.');
    expect(r.headers.get('content-language')).toBe('pt-BR');
    expect(r.body.details?.locale).toBe('pt-BR');
    expect(r.body.details?.workflowId).toBe('does-not-exist-xyz'); // pre-existing details preserved
  });

  it('family fallback: Accept-Language pt-PT → pt-BR (family) localized', async () => {
    const r = await getMissing('pt-PT');
    expect(r.status).toBe(404);
    expect(r.body.message).toBe('Fluxo de trabalho não encontrado.');
    expect(r.headers.get('content-language')).toBe('pt-BR');
    expect(r.body.details?.locale).toBe('pt-BR');
  });

  it('default locale: no Accept-Language → English, NO Content-Language / details.locale', async () => {
    const r = await getMissing();
    expect(r.status).toBe(404);
    expect(r.body.message).toBe('workflow not found');
    expect(r.headers.get('content-language')).toBeNull();
    expect(r.body.details?.locale).toBeUndefined();
  });

  it('unsupported locale: Accept-Language de-DE → falls back to default, no markers', async () => {
    const r = await getMissing('de-DE');
    expect(r.status).toBe(404);
    expect(r.body.message).toBe('workflow not found');
    expect(r.headers.get('content-language')).toBeNull();
    expect(r.body.details?.locale).toBeUndefined();
  });

  it('malformed Accept-Language never 400s → falls back to default', async () => {
    const r = await getMissing(';;;garbage,,,q=notanumber');
    expect(r.status).toBe(404); // never 400 (annex MUST)
    expect(r.body.message).toBe('workflow not found');
    expect(r.headers.get('content-language')).toBeNull();
  });

  it('q-weighted: pt-BR outranks a higher-listed unsupported tag', async () => {
    const r = await getMissing('de;q=0.9, pt-BR;q=0.8');
    expect(r.headers.get('content-language')).toBe('pt-BR'); // de unsupported → pt-BR wins
    expect(r.body.message).toBe('Fluxo de trabalho não encontrado.');
  });
});
