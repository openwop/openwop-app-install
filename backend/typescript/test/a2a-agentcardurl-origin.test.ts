/**
 * RFC 0076/0152 — the A2A 1.0 AgentCard names a cross-host-reachable backend
 * origin, never a `localhost` stub (capabilities.md advertise-honestly).
 * Regression test for the P2-APP deploy defect where the live doc advertised
 * `http://localhost:8080/.well-known/agent-card.json`.
 *
 * What is asserted now (ADR 0812 P3c-0 deleted the v1-document
 * `a2a.agentCardUrl` facet and the `OPENWOP_A2A_PUBLIC_BASE_URL` override leg):
 * the served card's `supportedInterfaces[0].url` derives from the origin the
 * caller reached (`host/requestOrigin.ts`: X-Forwarded-Proto/Host), never reuses
 * `OPENWOP_PUBLIC_BASE_URL` (the SPA/OAuth origin), and the forwarded host is
 * sanitized to a host token (header-injection defeat).
 *
 * Tracker TST-BG1-2. Red when (probe-witnessed, wave 58): `requestOrigin`
 * ignores X-Forwarded-Host or X-Forwarded-Proto, lets `_` through the host
 * sanitizer, or prefers `OPENWOP_PUBLIC_BASE_URL`.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;
const PRIOR_ENV: Record<string, string | undefined> = {};
const TOUCHED = ['OPENWOP_STORAGE_DSN', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_A2A_SERVER_ENABLED', 'OPENWOP_A2A_DURABLE_TASKS', 'OPENWOP_A2A_PUBLIC_BASE_URL', 'OPENWOP_PUBLIC_BASE_URL'];

beforeAll(async () => {
  for (const k of TOUCHED) PRIOR_ENV[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_A2A_SERVER_ENABLED = 'true';
  process.env.OPENWOP_A2A_DURABLE_TASKS = 'true';
  delete process.env.OPENWOP_A2A_PUBLIC_BASE_URL;
  delete process.env.OPENWOP_PUBLIC_BASE_URL;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const k of TOUCHED) {
    if (PRIOR_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = PRIOR_ENV[k];
  }
});

/**
 * ADR 0812 P3c-0 — the `capabilities.a2a.agentCardUrl` facet rode the v1
 * discovery document only; the v2 document carries no `a2a.agentCardUrl`. The
 * same ONE origin derivation (`host/requestOrigin.ts`) builds the served
 * AgentCard's own endpoint url, so the honesty legs are asserted there: the
 * card a peer fetches must name the origin the caller reached, never localhost.
 */
const cardUrl = async (headers: Record<string, string> = {}): Promise<string> => {
  const res = await fetch(`${BASE}/.well-known/agent-card.json`, { headers: { ...headers, 'A2A-Version': '1.0' } });
  expect(res.status).toBe(200);
  const card = (await res.json()) as { supportedInterfaces?: Array<{ url?: string }> };
  return card.supportedInterfaces?.[0]?.url ?? '';
};
const A2A = '/host/openwop-app/a2a';

describe('a2a AgentCard url — honest cross-host origin', () => {
  it('derives from X-Forwarded-Proto/Host (the origin the caller reached) — https, not localhost', async () => {
    const url = await cardUrl({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'openwop-app-backend-xyz.a.run.app' });
    expect(url).toBe(`https://openwop-app-backend-xyz.a.run.app${A2A}`);
    expect(url).not.toContain('localhost');
  });

  // ADR 0812 P3c-0: the `OPENWOP_A2A_PUBLIC_BASE_URL` override leg was deleted —
  // that override only ever fed the v1-document `a2a.agentCardUrl` facet, which
  // the v2 document does not carry.

  it('does NOT reuse OPENWOP_PUBLIC_BASE_URL (the SPA/OAuth origin)', async () => {
    process.env.OPENWOP_PUBLIC_BASE_URL = 'https://app.openwop.dev';
    try {
      const url = await cardUrl({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'backend.run.app' });
      // The a2a card tracks the backend the caller reached, not the SPA origin —
      // app.openwop.dev only routes /api/** to the backend.
      expect(url).toBe(`https://backend.run.app${A2A}`);
      expect(url).not.toContain('app.openwop.dev');
    } finally {
      delete process.env.OPENWOP_PUBLIC_BASE_URL;
    }
  });

  it('sanitizes out-of-charset characters in X-Forwarded-Host (header-injection defeat)', async () => {
    // `_` is a valid HTTP header-value byte (so fetch sends it) but not a valid
    // host token — the sanitizer strips it (and CR/LF, quotes, etc.).
    const url = await cardUrl({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil_host.run.app' });
    expect(url).toBe(`https://evilhost.run.app${A2A}`);
    expect(url).not.toContain('_');
  });
});
