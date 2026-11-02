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
 *
 * §w68 (TST-CQB-1) — the preflight now runs through `corsMiddleware()` mounted on
 * a bare `express()` app over a real socket (no `createApp`, no hand-built
 * req/res casts), and every header check splits the allow-list into TOKENS
 * (a substring of the joined string can be satisfied by a neighbour).
 * Sabotage-witnessed: red when `X-OpenWOP-Field-Contract` or `ACT_AS_HEADER`
 * leaves HOST_REQUEST_HEADERS, when the de-dupe filter drops if-match /
 * openwop-version / openwop-client-version / idempotency-key, and when `ETag`
 * leaves Expose-Headers.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { corsMiddleware } from '../src/middleware/cors.js';
import { VERSION_RESPONSE_HEADER } from '../src/middleware/protocolVersion.js';
import { FIELD_CONTRACT_HEADER } from '../src/host/preserveDroppedFields.js';

const ORIGIN = 'http://localhost:5173';

let server: http.Server;
let BASE = '';
let prevOrigins: string | undefined;
beforeAll(async () => {
  prevOrigins = process.env.OPENWOP_CORS_ORIGINS;
  process.env.OPENWOP_CORS_ORIGINS = ORIGIN;
  const app = express();
  app.use(corsMiddleware());
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  if (prevOrigins === undefined) delete process.env.OPENWOP_CORS_ORIGINS;
  else process.env.OPENWOP_CORS_ORIGINS = prevOrigins;
});

/** Run one real OPTIONS preflight through the middleware and return its response headers. */
async function preflight(origin = ORIGIN): Promise<Headers> {
  const res = await fetch(`${BASE}/host/openwop-app/workflows`, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST' },
  });
  expect(res.status).toBe(204);
  return res.headers;
}

/** A comma-separated header as lower-cased TOKENS. */
const tokens = (v: string | null): string[] => (v ?? '').toLowerCase().split(',').map((h) => h.trim()).filter(Boolean);
const allowed = async (): Promise<string[]> => tokens((await preflight()).get('access-control-allow-headers'));

describe('CORS preflight admits the custom headers the SPA sends', () => {
  it('fixture guard: a preflight from an allowed origin actually sets the header', async () => {
    // Without this, every assertion below would pass against a middleware that
    // set NOTHING — an empty token list contains no header name either.
    const h = await preflight();
    expect(tokens(h.get('access-control-allow-headers')).length, 'the preflight set no allow-headers at all').toBeGreaterThan(0);
    expect(h.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('admits the ADR 0524 field-contract header', async () => {
    expect(
      await allowed(),
      `${FIELD_CONTRACT_HEADER} is not admitted by the preflight — cross-origin builder saves will be blocked`,
    ).toContain(FIELD_CONTRACT_HEADER.toLowerCase());
  });

  it('admits If-Match, the builder save precondition (ADR 0770 D5)', async () => {
    // Not CORS-safelisted and not `x-openwop-*`, so the generator below cannot
    // see it: pinned by name, like the negotiation header.
    expect(await allowed()).toContain('if-match');
    expect(tokens((await preflight()).get('access-control-expose-headers'))).toContain('etag');
  });

  it('still admits the pre-existing headers', async () => {
    // Guards the other direction: a fix that ADDED the new header by replacing
    // the list would break authorization and content-type.
    const list = await allowed();
    for (const h of ['authorization', 'content-type', 'idempotency-key']) {
      expect(list, `${h} was dropped from the allow-list`).toContain(h);
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
  it('admits the protocol negotiation header the SDK sends on every major-2 request', async () => {
    expect(
      await allowed(),
      'the SPA speaks major 2; without this every cross-origin v2 request is blocked by the browser',
    ).toContain(VERSION_RESPONSE_HEADER.toLowerCase());
  });

  /**
   * THE THIRD GENERATOR, for headers the SDK sends and the SPA never spells.
   *
   * `OpenWOP-Version` was a named leg above because the SPA-source walk below
   * cannot see an SDK-sent header. Pinning it by name left the next SDK header
   * just as invisible: `OpenWOP-Client-Version` (RFC 0219, SDK 2.5.0) was about
   * to repeat the outage, and `OpenWOP-Dedup` already could. So this reads the
   * request headers straight out of the SDK the browser runs (`client.js`, the
   * frontend's install first, else the backend's copy of the same package) and
   * requires the preflight to admit each one. Webhook signing helpers are
   * server-to-server, never browser requests, and live in other files.
   */
  it('GENERATOR: every OpenWOP-* request header the installed SDK client sends is admitted', async () => {
    const candidates = [
      resolve(__dirname, '../../../frontend/react/node_modules/@openwop/openwop/dist/client.js'),
      resolve(__dirname, '../node_modules/@openwop/openwop/dist/client.js'),
    ];
    const file = candidates.find((f) => { try { return statSync(f).isFile(); } catch { return false; } });
    expect(file, `no installed SDK client found at ${candidates.join(' or ')}`).toBeTruthy();
    const src = readFileSync(file!, 'utf8');
    const sent = new Set([...src.matchAll(/['"`](OpenWOP-[A-Za-z-]+)['"`]/g)].map((m) => m[1]!.toLowerCase()));
    expect(sent.size, 'no OpenWOP-* header literal found — the SDK moved, and this leg would be vacuous').toBeGreaterThan(0);
    const list = await allowed();
    for (const h of sent) expect(list, `the SDK sends ${h}; a cross-origin request carrying it fails preflight`).toContain(h);
  });

  it('admits OpenWOP-Client-Version before the SPA takes SDK 2.5.0 (RFC 0219)', async () => {
    expect(await allowed()).toContain('openwop-client-version');
  });

  it('GENERATOR: every custom x-openwop-* request header the SPA sends is admitted', async () => {
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
    // Two-sided: the walk must SEE the two real sends this file exists for, so a
    // regex that silently stops matching cannot turn the check below vacuous.
    expect([...found]).toEqual(expect.arrayContaining(['x-openwop-field-contract', 'x-openwop-act-as']));

    // (A `NOT_HTTP_HEADERS` exclusion for the `x-openwop-cv-*` drag-and-drop MIME
    // types used to sit here. It was dead: those strings are spelled
    // `'application/x-openwop-cv-…'`, so the quote-anchored regex above can never
    // capture them — measured 2026-10-29, w68. Removed; nothing is excused.)
    // Checked against the SERVED preflight, not the constant, so both sides are behaviour.
    const admitted = new Set(await allowed());
    const missing = [...found].filter((h) => !admitted.has(h));
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
