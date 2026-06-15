/**
 * RFC 0076/0100 — `capabilities.a2a.agentCardUrl` MUST advertise a
 * cross-host-reachable backend origin, never a `localhost` stub (capabilities.md
 * advertise-honestly). Regression test for the P2-APP deploy defect where the
 * live doc advertised `http://localhost:8080/v1/host/openwop-app/a2a`.
 *
 * The base derives, in precedence order:
 *   1. OPENWOP_A2A_PUBLIC_BASE_URL (dedicated override — custom-domain backends),
 *   2. the forwarded request origin (X-Forwarded-Proto/Host the caller reached us
 *      on — honest behind Cloud Run without flipping global `trust proxy`),
 *   3. http://localhost:8080 (local-dev fallback only).
 *
 * It must NOT reuse OPENWOP_PUBLIC_BASE_URL (the SPA/OAuth origin).
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';

const PORT = 18293;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_A2A_SERVER_ENABLED = 'true';
  process.env.OPENWOP_A2A_DURABLE_TASKS = 'true';
  delete process.env.OPENWOP_A2A_PUBLIC_BASE_URL;
  delete process.env.OPENWOP_PUBLIC_BASE_URL;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_A2A_SERVER_ENABLED;
  delete process.env.OPENWOP_A2A_DURABLE_TASKS;
  delete process.env.OPENWOP_A2A_PUBLIC_BASE_URL;
});

const cardUrl = async (headers: Record<string, string> = {}): Promise<string> => {
  const res = await fetch(`${BASE}/.well-known/openwop`, { headers });
  const doc = (await res.json()) as { capabilities?: { a2a?: { agentCardUrl?: string } }; a2a?: { agentCardUrl?: string } };
  return (doc.capabilities?.a2a ?? doc.a2a)?.agentCardUrl ?? '';
};

describe('a2a.agentCardUrl — honest cross-host origin', () => {
  it('derives from X-Forwarded-Proto/Host (the origin the caller reached) — https, not localhost', async () => {
    const url = await cardUrl({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'openwop-app-backend-xyz.a.run.app' });
    expect(url).toBe('https://openwop-app-backend-xyz.a.run.app/v1/host/openwop-app/a2a');
    expect(url).not.toContain('localhost');
  });

  it('OPENWOP_A2A_PUBLIC_BASE_URL overrides the request origin', async () => {
    process.env.OPENWOP_A2A_PUBLIC_BASE_URL = 'https://a2a.example.com';
    try {
      const url = await cardUrl({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'ignored.run.app' });
      expect(url).toBe('https://a2a.example.com/v1/host/openwop-app/a2a');
    } finally {
      delete process.env.OPENWOP_A2A_PUBLIC_BASE_URL;
    }
  });

  it('does NOT reuse OPENWOP_PUBLIC_BASE_URL (the SPA/OAuth origin)', async () => {
    process.env.OPENWOP_PUBLIC_BASE_URL = 'https://app.openwop.dev';
    try {
      const url = await cardUrl({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'backend.run.app' });
      // The a2a card tracks the backend the caller reached, not the SPA origin —
      // app.openwop.dev only routes /api/** to the backend, not /v1/...
      expect(url).toBe('https://backend.run.app/v1/host/openwop-app/a2a');
      expect(url).not.toContain('app.openwop.dev');
    } finally {
      delete process.env.OPENWOP_PUBLIC_BASE_URL;
    }
  });

  it('sanitizes out-of-charset characters in X-Forwarded-Host (header-injection defeat)', async () => {
    // `_` is a valid HTTP header-value byte (so fetch sends it) but not a valid
    // host token — the sanitizer strips it (and CR/LF, quotes, etc.).
    const url = await cardUrl({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil_host.run.app' });
    expect(url).toBe('https://evilhost.run.app/v1/host/openwop-app/a2a');
    expect(url).not.toContain('_');
  });
});
