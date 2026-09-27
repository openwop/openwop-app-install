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
 * `capabilities` object is a deprecated v1.x compatibility mirror. Both legs
 * below therefore describe a deliberate, temporary state — when the mirror is
 * finally dropped, leg 2 is the test to delete, and leg 1 stays.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

/** The ONE dotted key this host still emits, and the only sanctioned exception.
 *  ADR 0537: `forms` is canonical; `host.forms` is a deprecated mirror kept only
 *  while `host-capabilities.md` §host.forms still SHOWS the dotted spelling in
 *  prose. Delete this entry together with the mirror in `routes/discovery.ts`. */
const DOTTED_MIRROR_ALLOWLIST = new Set(['host.forms']);

let BASE = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const discovery = async (): Promise<Record<string, unknown>> => {
  const res = await fetch(`${BASE}/.well-known/openwop`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
};

describe('RFC 0073 — every capability family is readable at the document ROOT', () => {
  it('leg 1: every family in the deprecated wrapper is mirrored at the root, identically', async () => {
    const doc = await discovery();
    const wrapper = doc['capabilities'] as Record<string, unknown> | undefined;
    expect(wrapper && typeof wrapper === 'object', 'the v1.x compat wrapper is still emitted').toBe(true);

    const families = Object.keys(wrapper ?? {});
    // Non-vacuity: this host advertises dozens of families. A doc that lost its
    // wrapper would otherwise pass leg 1 by iterating nothing.
    expect(families.length, 'the wrapper must actually carry families').toBeGreaterThan(20);

    const missingAtRoot = families.filter((k) => doc[k] === undefined);
    expect(missingAtRoot, 'RFC 0073 makes the ROOT canonical — these families are wrapper-only').toEqual([]);

    const divergent = families.filter((k) => JSON.stringify(doc[k]) !== JSON.stringify((wrapper ?? {})[k]));
    expect(divergent, 'root and wrapper must be the same value, or a consumer gets a different answer per arm').toEqual([]);
  });

  it('leg 2: no NEW dotted family key — plain is canonical (ADR 0537)', async () => {
    const doc = await discovery();
    const wrapper = (doc['capabilities'] ?? {}) as Record<string, unknown>;
    const dotted = Object.keys(wrapper).filter((k) => k.includes('.') && !DOTTED_MIRROR_ALLOWLIST.has(k));
    expect(
      dotted,
      'RFC 0137 G16: the PLAIN family name is the discovery key; `host.` is the capability IDENTIFIER notation (§headings, pack peerDependencies, error.capability). Add the plain key; do not extend the allowlist.',
    ).toEqual([]);

    // The allowlisted mirror must still be paired with its plain form, so the
    // exception can never become the only spelling a consumer can find.
    for (const dottedKey of DOTTED_MIRROR_ALLOWLIST) {
      if (wrapper[dottedKey] === undefined) continue; // already retired — fine
      const plain = dottedKey.replace(/^host\./, '');
      expect(doc[plain], `${dottedKey} is a MIRROR; the canonical ${plain} must be emitted at the root too`).toBeDefined();
    }
  });
});
