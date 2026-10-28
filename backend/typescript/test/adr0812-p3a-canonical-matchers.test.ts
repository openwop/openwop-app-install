/**
 * ADR 0812 P3a — every guard, body parser and path predicate holds on BOTH path
 * spellings, BEFORE the routing flip (P3b) removes the negotiator's `/v1` rewrite.
 *
 * Today the negotiator rewrites a vendor or shared-name protocol request to
 * `/v1…`, and every matcher downstream of it was keyed on that spelling. P3b
 * removes the rewrite. A matcher keyed only on `/v1` then matches nothing, and
 * nothing goes red: a test-seam guard stops guarding (GC-1), a raw-body parser
 * stops capturing (signed webhooks fail closed, money events drop), and the
 * bound-id tenant check stops checking.
 *
 * Each case drives a BARE express app with no negotiator and no auth, so an
 * unversioned URL reaches the mount directly, as it will after P3b. Each one goes
 * red against the old `/v1`-only code. Tracker: TST-BVC-2.
 *
 * Red when (wave 60 probes w60g4-p3a-*): the seam guard, a raw-body parser or
 * a large-upload parser is mounted on `/v1` only; the bound-id tenant check is
 * skipped; a browser `/v1` navigation or a protocol client falls through to
 * the page; a `/v1` spelling counts as public; the credential-optional read
 * admits a write; a source mount or middleware regex is keyed on `/v1`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { V1_PATH_PREFIX as V1 } from '../src/middleware/protocolVersion.js';
import { mountScopedBodyParsers } from '../src/middleware/scopedBodyParsers.js';
import { v2IdentityMiddleware } from '../src/middleware/v2Identity.js';
import { isCredentialOptionalRead, isPublicPath, PUBLIC_PATH_PREFIXES } from '../src/middleware/auth.js';
import { __isSseExemptPathForTests } from '../src/middleware/rateLimit.js';
import { registerTestSeamRoutes } from '../src/routes/testSeam.js';
import { registerPackTestRoutes } from '../src/routes/packs-test.js';
import { openStorage } from '../src/storage/index.js';
import { SIGNED_INGEST_ROOT } from '../src/host/signedIngestRoot.js';

let server: http.Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((res) => server!.close(() => res()));
  server = undefined;
});
async function listen(app: Express): Promise<string> {
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

// ADR 0812 P3c — the guards and parsers are mounted on the unversioned path only:
// a `/v1` request is answered 410 by the negotiator before it reaches either.
describe('ADR 0812 P3a — test-seam and packs-test guards (GC-1)', () => {
  const prevSeam = process.env.OPENWOP_TEST_SEAM_ENABLED;
  const prevPacks = process.env.OPENWOP_PACKS_TEST_NAMESPACE_ENABLED;
  afterEach(() => {
    process.env.OPENWOP_TEST_SEAM_ENABLED = prevSeam;
    process.env.OPENWOP_PACKS_TEST_NAMESPACE_ENABLED = prevPacks;
    if (prevSeam === undefined) delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    if (prevPacks === undefined) delete process.env.OPENWOP_PACKS_TEST_NAMESPACE_ENABLED;
  });

  it('an anonymous write to a seam or packs-test path is 401', async () => {
    process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
    process.env.OPENWOP_PACKS_TEST_NAMESPACE_ENABLED = 'true';
    const app = express();
    app.use(express.json());
    registerTestSeamRoutes(app, { storage: await openStorage('memory://') });
    registerPackTestRoutes(app);
    // No route below this answers 404, so a missed guard reads as 404, not 401.
    const base = await listen(app);
    for (const path of ['/host/sample/anything', '/host/openwop-app/test/mock-ai/program', '/packs-test/reset']) {
      const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(r.status, `${path} must be guarded`).toBe(401);
      expect(((await r.json()) as { details?: { reason?: string } }).details?.reason, path).toBe('anonymous_principal_refused');
    }
  });
});

describe('ADR 0812 P3a — scoped body parsers', () => {
  async function parserApp(): Promise<string> {
    const app = express();
    mountScopedBodyParsers(app);
    // Deliberately NO global parser: a path the scoped parsers miss arrives unparsed.
    app.use((req: Request, res: Response) => {
      const raw = (req as Request & { rawBody?: Buffer }).rawBody;
      res.json({ parsed: req.body !== undefined && Object.keys(req.body ?? {}).length > 0, rawLen: raw?.length ?? null });
    });
    return listen(app);
  }

  it('every signed-webhook mount captures the raw body', async () => {
    const base = await parserApp();
    const webhooks = [
      '/host/openwop-app/connections-inbound/x',
      '/host/openwop-app/app-builder-sync/webhook',
      `${SIGNED_INGEST_ROOT}/x`,
      '/host/openwop-app/billing/webhook',
      '/host/openwop-app/commerce/webhook',
      '/host/openwop-app/public-email/events',
    ];
    const body = JSON.stringify({ id: 'evt_1' });
    for (const path of webhooks) {
      const r = (await (await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).json()) as { rawLen: number | null };
      expect(r.rawLen, `${path} raw body`).toBe(Buffer.byteLength(body));
    }
    // Twilio posts urlencoded to the inbound prefix: same capture.
    for (const path of ['/host/openwop-app/connections-inbound/x']) {
      const r = (await (await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' })).json()) as { rawLen: number | null };
      expect(r.rawLen, `${path} urlencoded raw body`).toBe(3);
    }
  });

  it('every large-upload mount accepts a body over the 1mb global limit', async () => {
    const base = await parserApp();
    const large = [
      '/packs/x',
      '/host/openwop-app/media/x',
      '/host/openwop-app/document-editor/x',
      '/host/openwop-app/notebooks/n1/sources/audio',
      '/host/openwop-app/kb/c1/documents',
      '/host/openwop-app/cdp/collect/import',
      '/host/openwop-app/drawings/d1',
      '/host/openwop-app/cad/d1',
      '/host/openwop-app/slides/d1',
      '/host/openwop-app/campaign-studio/d1',
      '/host/openwop-app/app-builder/d1',
      '/host/openwop-app/canvas-packs/d1',
    ];
    const body = JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) });
    for (const path of large) {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      expect(res.status, path).toBe(200);
      expect(((await res.json()) as { parsed: boolean }).parsed, `${path} parsed by its scoped parser`).toBe(true);
    }
  });
});

describe('ADR 0812 P3a — v2Identity bound-id guard (tenant isolation)', () => {
  it('checks and strips a bound id on both spellings', async () => {
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      Object.defineProperty(req, Symbol.for('openwop.protocol.major'), { value: 2, writable: true, configurable: true });
      (req as Request & { tenantId?: string }).tenantId = 'tenant-a';
      next();
    });
    app.use(v2IdentityMiddleware());
    app.use((req: Request, res: Response) => { res.json({ url: req.url }); });
    app.use((err: { code?: string; httpStatus?: number }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.httpStatus ?? 500).json({ error: err.code });
    });
    const base = await listen(app);
    const opaque = '8d365026-981a-4730-b416-8bfde6fc37ff';
    for (const kind of ['runs', 'webhooks', 'trigger-subscriptions']) {
      for (const prefix of ['', V1]) {
        const other = await fetch(`${base}${prefix}/${kind}/tenant-b%2F${opaque}`);
        expect(other.status, `${prefix}/${kind}: another tenant's id`).toBe(403);
        expect(((await other.json()) as { error?: string }).error).toBe('id_tenant_mismatch');
        const own = (await (await fetch(`${base}${prefix}/${kind}/tenant-a%2F${opaque}/events`)).json()) as { url: string };
        expect(own.url, `${prefix}/${kind}: stripped, prefix and tail kept`).toBe(`${prefix}/${kind}/${opaque}/events`);
      }
    }
  });
});

describe('ADR 0812 P3a hotfix — a browser navigation to a bare /runs/<id> is the SPA page, not the wire', () => {
  it('a text/html navigation falls through; a protocol client and the /v1 spelling are still guarded', async () => {
    // Major 1 is retired, which is what makes a BARE id a 400 (the shape that broke the SPA).
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      Object.defineProperty(req, Symbol.for('openwop.protocol.major'), { value: 2, writable: true, configurable: true });
      (req as Request & { tenantId?: string }).tenantId = 'tenant-a';
      next();
    });
    app.use(v2IdentityMiddleware());
    app.use((req: Request, res: Response) => { res.json({ fellThrough: true, url: req.url }); });
    app.use((err: { code?: string; httpStatus?: number }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.httpStatus ?? 500).json({ error: err.code });
    });
    const base = await listen(app);
    const browser = { 'user-agent': 'Mozilla/5.0', accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
    // The exact shape verify-deploy.sh probes (ADR 0631): a bare, non-bound id.
    const page = await fetch(`${base}/runs/verify-deploy-does-not-exist`, { headers: browser });
    expect(page.status, 'browser navigation must reach the SPA, not a 400').toBe(200);
    expect(((await page.json()) as { fellThrough?: boolean }).fellThrough).toBe(true);
    // A real run page address with an opaque id, too.
    const opaque = '8d365026-981a-4730-b416-8bfde6fc37ff';
    expect((await fetch(`${base}/runs/${opaque}`, { headers: browser })).status).toBe(200);
    // Tenant isolation is unchanged for protocol clients on the bare spelling…
    const wire = await fetch(`${base}/runs/tenant-b%2F${opaque}`, { headers: { accept: 'application/json' } });
    expect(wire.status).toBe(403);
    const named = await fetch(`${base}/runs/tenant-b%2F${opaque}`, { headers: { ...browser, 'openwop-version': '2' } });
    expect(named.status, 'OpenWOP-Version makes it a protocol request even with an html Accept').toBe(403);
    // …and on the /v1 spelling, which is never a page.
    expect((await fetch(`${base}${V1}/runs/tenant-b%2F${opaque}`, { headers: browser })).status).toBe(403);
    // …and a protocol client presenting a BARE id on a retired-v1 host is still refused.
    expect((await fetch(`${base}/runs/${opaque}`, { headers: { accept: 'application/json' } })).status).toBe(400);
  });
});

describe('ADR 0812 P3a — path predicates', () => {
  // ADR 0812 P3c — the predicates see unversioned paths only: a `/v1` request is
  // answered 410/308 by the negotiator before any of them runs, and the ADR 0806
  // forwarder strips the twin before it asks `isPublicPath` (`index.ts`).
  it('every public-path entry is public, the allowlist widens nothing, and a /v1 spelling is not public', () => {
    for (const p of PUBLIC_PATH_PREFIXES) {
      if (p === '/') continue;
      expect(isPublicPath(p), p).toBe(true);
      expect(isPublicPath(`${V1}${p}`), `${V1}${p}`).toBe(false);
    }
    for (const bare of ['/host/openwop-app/users', '/runs/x', '/host/openwop-app/test/surface', '/host/sample/x']) {
      expect(isPublicPath(bare), bare).toBe(false);
    }
    expect(isPublicPath(V1)).toBe(false);
  });

  it('the SSE exemption and the credential-optional content read hold', () => {
    for (const path of ['/runs/r1/events', '/host/openwop-app/notifications/stream', '/host/openwop-app/channels/c1/presence']) {
      expect(__isSseExemptPathForTests(path), path).toBe(true);
    }
    expect(__isSseExemptPathForTests('/host/openwop-app/public-forms/f1/submit')).toBe(false);
    expect(isCredentialOptionalRead('GET', '/content/pages/home')).toBe(true);
    // The same path, so only the METHOD can refuse the write.
    expect(isCredentialOptionalRead('POST', '/content/pages/home')).toBe(false);
  });
});

describe('ADR 0812 P3a — ratchet: no matcher keyed on /v1 alone', () => {
  const SRC = join(__dirname, '..', 'src');
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
  }

  it('no app.use mount is spelled on the /v1 prefix alone', () => {
    // A mount registered on `/v1` only stops matching when P3b removes the rewrite.
    // The one exception waits for P3b deliberately: the `content` guard on a
    // SHARED name, which needs the explicit `isProtocolClient` gate first.
    // ADR 0812 P3b complete: v1() is the identity, so it is no longer a /v1 mount;
    // the content guard's exception is gone with it.
    const ALLOWED = new Set<string>();
    const MOUNT = /(?:app|router)\.use\(\s*(?:['`]\/v1|vendorTwin\(|`\$\{V1_PATH_PREFIX\})/;
    const offenders = walk(SRC)
      .filter((f) => MOUNT.test(readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')))
      .map((f) => relative(SRC, f))
      .filter((f) => !ALLOWED.has(f));
    expect(offenders).toEqual([]);
  });

  it('no middleware regex is anchored on /v1', () => {
    // protocolVersion.ts owns the prefix; every other middleware matcher compares
    // `unversionedPath(...)` against an unversioned pattern.
    const offenders = walk(join(SRC, 'middleware'))
      .filter((f) => !f.endsWith('protocolVersion.ts'))
      .filter((f) => /\/\^\\\/v1\\\//.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
