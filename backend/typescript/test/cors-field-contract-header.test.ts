/**
 * Every custom request header the SPA sends MUST survive a CORS preflight.
 *
 * THE BUG THIS PINS (2026-08-06). ADR 0524 Phase E0 added
 * `x-openwop-field-contract` to the builder's save. A custom header makes the
 * request PREFLIGHTED, and the header was missing from the allow-list — so
 * cross-origin the browser blocked the POST with `net::ERR_FAILED` and **every
 * builder save was lost**, with no server-side trace, because the request never
 * arrived.
 *
 * Nothing could see it: jsdom does not enforce CORS, the backend never received
 * the request, and same-origin deployments (the Firebase `/api` rewrite) are
 * unaffected. It took driving a real browser against a cross-origin backend.
 *
 * §Correction (grade-code, 2026-08-08) — WHY THIS NO LONGER PARSES SOURCE.
 * The first version regex-matched the `Access-Control-Allow-Headers` literal out
 * of `cors.ts`. Measured: a one-line reflow of that `res.set(...)` call (exactly
 * what a formatter does) breaks the match. It threw rather than passing
 * vacuously — the right direction — but it was still a test of how the source is
 * FORMATTED, not of what the middleware DOES. It would also have missed the real
 * contract entirely if the list were ever built from a variable.
 *
 * This drives the actual middleware through a real OPTIONS preflight and reads
 * the response header. Reformat `cors.ts` however you like; this only goes red
 * when the BEHAVIOUR regresses.
 */
import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { corsMiddleware, ALLOWED_REQUEST_HEADERS } from '../src/middleware/cors.js';
import { VERSION_RESPONSE_HEADER } from '../src/middleware/protocolVersion.js';
import { FIELD_CONTRACT_HEADER } from '../src/host/preserveDroppedFields.js';

const ORIGIN = 'http://localhost:5173';

/** Run one OPTIONS preflight through the middleware and collect its headers. */
function preflight(origin = ORIGIN): Record<string, string> {
  const prev = process.env.OPENWOP_CORS_ORIGINS;
  process.env.OPENWOP_CORS_ORIGINS = ORIGIN;
  try {
    const headers: Record<string, string> = {};
    // Mirrors what the middleware actually reads: `req.header('origin')` and
    // `req.path` (NOT `req.get`). The fixture guard below is what caught the
    // first version of this mock — it used `get` and every assertion failed,
    // which is the correct outcome for a stub that does not match its subject.
    const req = {
      method: 'OPTIONS',
      path: '/v1/host/openwop-app/workflows',
      headers: { origin },
      header: (n: string) => (n.toLowerCase() === 'origin' ? origin : undefined),
    } as unknown as Request;
    const res = {
      set: (k: string, v: string) => { headers[k.toLowerCase()] = v; return res; },
      status: () => res,
      send: () => res,
      end: () => res,
    } as unknown as Response;
    corsMiddleware()(req, res, () => {});
    return headers;
  } finally {
    if (prev === undefined) delete process.env.OPENWOP_CORS_ORIGINS;
    else process.env.OPENWOP_CORS_ORIGINS = prev;
  }
}

describe('CORS preflight admits the custom headers the SPA sends', () => {
  it('fixture guard: a preflight from an allowed origin actually sets the header', () => {
    // Without this, every assertion below would pass against a middleware that
    // set NOTHING — `undefined` contains no header name either.
    const h = preflight();
    expect(h['access-control-allow-headers'], 'the preflight set no allow-headers at all').toBeTruthy();
    expect(h['access-control-allow-origin']).toBe(ORIGIN);
  });

  it('admits the ADR 0524 field-contract header', () => {
    const allowed = (preflight()['access-control-allow-headers'] ?? '').toLowerCase();
    expect(
      allowed,
      `${FIELD_CONTRACT_HEADER} is not admitted by the preflight — cross-origin builder saves will be blocked`,
    ).toContain(FIELD_CONTRACT_HEADER.toLowerCase());
  });

  it('still admits the pre-existing headers', () => {
    // Guards the other direction: a fix that ADDED the new header by replacing
    // the list would break authorization and content-type.
    const allowed = (preflight()['access-control-allow-headers'] ?? '').toLowerCase();
    for (const h of ['authorization', 'content-type', 'idempotency-key']) {
      expect(allowed, `${h} was dropped from the allow-list`).toContain(h);
    }
  });

  /**
   * THE GENERATOR, closed. Pinning ONE header by name does not stop the next
   * one repeating this bug — and auditing for a repeat found `X-OpenWOP-Act-As`
   * (`client/accessClient.ts`, org "view as", read by five backend routes) had
   * ALREADY shipped un-admitted.
   *
   * So this walks the SPA source for every `x-openwop-*` string used as a
   * REQUEST HEADER KEY and requires the preflight to admit it. A new custom
   * header is now a red test on the day it lands, not a silent cross-origin
   * outage discovered by driving a browser.
   */
  /**
   * THE PROTOCOL NEGOTIATION HEADER — and the reason the generator above cannot
   * cover it.
   *
   * THE BUG THIS PINS (2026-09-18, ADR 0730 C.3). Moving the SPA's discovery
   * read to major 2 means the SDK sends `OpenWOP-Version` on every protocol
   * request. It was not admitted, so cross-origin the browser blocked the
   * request, `getCapabilities()` threw, and `InMemoryHostBanner`'s `catch` —
   * there to keep network noise off the screen — swallowed it. The banner
   * silently stopped rendering: nine e2e failures across three specs, no
   * server-side trace, every cross-origin v2 request affected.
   *
   * This is the SECOND instance of this exact class in this file. The first
   * (`x-openwop-field-contract`, 2026-08-06) lost every builder save. The
   * generator written to stop a recurrence could not see this one, because the
   * SPA source never contains the string: the SDK sends it. A source walk
   * cannot find a header the SPA does not spell.
   *
   * So this leg is stated directly, derived from the constant the negotiator
   * itself publishes — if that is renamed, this follows.
   */
  it('admits the protocol negotiation header the SDK sends on every major-2 request', () => {
    const allowed = (preflight()['access-control-allow-headers'] ?? '').toLowerCase();
    expect(
      allowed.split(',').map((h) => h.trim()),
      'the SPA speaks major 2; without this every cross-origin v2 request is blocked by the browser',
    ).toContain(VERSION_RESPONSE_HEADER.toLowerCase());
  });

  it('GENERATOR: every custom x-openwop-* request header the SPA sends is admitted', () => {
    const SRC = resolve(__dirname, '../../../frontend/react/src');
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) {
          if (e !== '__tests__' && e !== 'node_modules') walk(p);
          continue;
        }
        if (!/\.tsx?$/.test(e) || /\.test\./.test(e)) continue;
        const text = readFileSync(p, 'utf8');
        // Any QUOTED `x-openwop-*` in non-test source. The first cut required a
        // trailing `:` or `,` (an object-literal key) and found NOTHING — the
        // two real sends are `const H = 'x-openwop-field-contract'` and
        // `h['x-openwop-act-as'] = …`. The fixture guard below is what caught
        // that; without it this test would have "passed" over an empty set.
        // KEPT AT `x-openwop-`, and the attempt to widen it is worth recording.
        // The 2026-09-18 outage was `OpenWOP-Version`, which has no `x-` prefix,
        // so the obvious fix was to match `(?:x-)?openwop-`. MEASURED: that
        // returns 18 non-headers — CSS animation names (`openwop-spinner-rotate`,
        // `openwop-pulse`), pack and org ids (`openwop-app`, `openwop-sample`),
        // auth profile ids (`openwop-auth-saml`) — because `openwop-` is a common
        // token in this codebase in a way `x-openwop-` is not. A generator that
        // cries wolf 18 times gets excused, and then it stops catching the real
        // one. The negotiation header is covered by its own direct leg above
        // instead, which is the honest instrument: the SPA source never contains
        // that string at all, so NO source walk can find it.
        for (const m of text.matchAll(/['"`](x-openwop-[a-z0-9-]+)['"`]/gi)) {
          found.add(m[1]!.toLowerCase());
        }
      }
    };
    walk(SRC);

    // Fixture guard: if the walk finds nothing, the assertion below is vacuous.
    expect(found.size, 'the SPA scan found no custom headers at all — the walk is broken').toBeGreaterThan(0);

    // `x-openwop-cv-*` are drag-and-drop DataTransfer MIME types, not HTTP
    // headers — they never reach a preflight. Excluded by name, with the reason,
    // rather than by a loose pattern that would quietly excuse a real header.
    const NOT_HTTP_HEADERS = new Set(['x-openwop-cv-component', 'x-openwop-cv-frame', 'x-openwop-cv-move']);
    const admitted = new Set(ALLOWED_REQUEST_HEADERS.map((h) => h.toLowerCase()));
    const missing = [...found].filter((h) => !admitted.has(h) && !NOT_HTTP_HEADERS.has(h));
    expect(
      missing,
      `the SPA sends custom header(s) the CORS preflight does not admit: ${missing.join(', ')} — `
      + 'cross-origin these requests are blocked by the browser with no server-side trace',
    ).toEqual([]);
  });

  it('the header constant is the one the SPA actually sends', () => {
    // Both sides of the wire are literals in different builds; each is pinned to
    // this same string so neither can drift alone. The SPA copy is pinned in
    // `frontend/react/src/builder/persistence/__tests__/fieldContract.test.ts`.
    expect(FIELD_CONTRACT_HEADER).toBe('x-openwop-field-contract');
  });
});
