/**
 * RFC 0073 document-root layout — the root/wrapper mirror, pinned (ADR 0537 residue).
 *
 * THE CLASS THIS CLOSES. ADR 0537 fixed one advert that was being resolved on a
 * fallback arm, and named the general hazard: a permissive multi-arm resolver
 * (plain-root → dotted-root → plain-wrapper → dotted-wrapper) means a consumer
 * can be satisfied by ANY arm, so nothing observes which one answered. The audit
 * it deferred found the hazard is not hypothetical — **14 in-repo test files
 * assert discovery capabilities through `doc.capabilities.<family>`, the
 * DEPRECATED wrapper.** Every one of them would stay green if root emission broke
 * outright, because the wrapper alone would satisfy them.
 *
 * WHY THIS FILE INSTEAD OF EDITING THOSE 14. Rewriting each to read the root
 * would fix 14 call sites and leave the 15th to be written wrong. The reason a
 * wrapper assertion is dangerous is that root and wrapper can DIVERGE — so pin
 * them together and the danger is gone at the source: with this invariant held,
 * a wrapper read is provably equivalent to a root read, and `discovery.ts`'s
 * single `return { ...advertisement, ...advertisement.capabilities }` can no
 * longer regress silently.
 *
 * `capabilities.md` §"Document-root layout" makes the ROOT canonical; the nested
 * `capabilities` object was a deprecated v1.x compatibility mirror.
 *
 * ADR 0812 P4 — the mirror is GONE: it was a v1 construct, and the v1 builder
 * is deleted. The v2 root has no `capabilities` wrapper at all, so the old
 * leg 1 (root == wrapper) has nothing to compare and is replaced by a leg that
 * the served root carries no wrapper. Leg 2 (no dotted family key) is a
 * property of the served root and is kept, read from the v2 document.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { AddressInfo } from 'node:net';

let server: http.Server;
let BASE = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

/** The SERVED root (header-less is the v2 document). */
const discovery = async (): Promise<Record<string, unknown>> => {
  const res = await fetch(`${BASE}/.well-known/openwop`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
};

describe('RFC 0073 — every capability family is at the document ROOT', () => {
  it('leg 1: the served root has no `capabilities` wrapper — one arm, so no arm can diverge', async () => {
    const doc = await discovery();
    expect(doc['capabilities'], 'a wrapper is a second arm a consumer could be satisfied by').toBeUndefined();
    // Non-vacuity: the root does carry families.
    const families = Object.entries(doc).filter(([, v]) => v !== null && typeof v === 'object' && typeof (v as Record<string, unknown>)['status'] === 'string');
    expect(families.length).toBeGreaterThan(20);
  });

  it('leg 2: no dotted family key — plain is canonical (ADR 0537)', async () => {
    const doc = await discovery();
    const dotted = Object.keys(doc).filter((k) => k.includes('.'));
    expect(
      dotted,
      'RFC 0137 G16: the PLAIN family name is the discovery key; `host.` is the capability IDENTIFIER notation (§headings, pack peerDependencies, error.capability). Add the plain key.',
    ).toEqual([]);
    // The v1 `host.forms` mirror was the one sanctioned exception; its plain
    // form is what the v2 root carries.
    expect(doc['forms']).toBeDefined();
  });
});
