/**
 * ADR 0873 P2 — the offline engine, with nothing declaring yet.
 *
 * Three layers:
 *   1. the build-time checks (D1 shape, D4 derivation and refusals, D9 start_url);
 *   2. the D6 precache derivation from a fixture Rollup bundle (graphs, budget,
 *      version);
 *   3. the generated worker RUN against a simulated service-worker global (fake
 *      CacheStorage, fetch and events), for D3/D11 (empty table) and D4–D7.
 *
 * DOUBLE GUARDS, named so a green probe is not misread: the engine refuses a
 * never-cache navigation/subresource EVEN THOUGH `checkOfflineTable` already refuses
 * such a table at build time. `buildOfflineTable` does not validate, so the engine
 * cases below feed it build-refused tables directly to reach the engine's own copy.
 * Sabotage (wave 51 probes): any of the D4 guards in sw/offline-engine.js, the
 * sub-path half of `isDeclaredNavigation`, the swr HTML filter / refresh / trim, and
 * every build check in gen-service-worker.mjs reds at least one case here.
 * One build-side double guard: `checkOfflineShape` refuses a `'/'` navigation by
 * `p === '/'` AND by `p.endsWith('/')`, so dropping the first alone stays green (probe
 * w51g1-oe-shape-root-dbl); the shared `endsWith` arm is probed (w51g1-oe-shape-root).
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeatureOffline } from '../../src/sw/offlineTypes.js';
import {
  OFFLINE_CACHE_PREFIX,
  SHELL_URL,
  buildOfflineTable,
  checkOfflineShape,
  checkOfflineTable,
  computePrecache,
  deriveNeverCache,
  firebaseGlobToRegExpSource,
  generateServiceWorker,
  parseLegacyCachePurge,
  prepareOfflineBuild,
  type BundleItem,
  type OfflineTable,
} from '../gen-service-worker.mjs';
import { OFFLINE_CACHE_PREFIX as PAGE_PREFIX } from '../../src/sw/offlineCaches.js';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = join(FRONTEND, '..', '..');
const REAL_FIREBASE = JSON.parse(readFileSync(join(REPO, 'firebase.json'), 'utf8')) as unknown;

const FIXTURE_HOSTING = {
  hosting: [{
    target: 'app',
    rewrites: [
      { source: '/api/**', run: { serviceId: 'be' } },
      { source: '/', run: { serviceId: 'be' } },
      { source: '/runs', run: { serviceId: 'be' } },
      { source: '/runs/**', run: { serviceId: 'be' } },
      { source: '**', destination: '/app-shell.html' },
    ],
  }, { target: 'other', rewrites: [{ source: '/books/**', run: { serviceId: 'x' } }] }],
};
const NEVER = deriveNeverCache(FIXTURE_HOSTING, 'app');

// ---------------------------------------------------------------------------
describe('ADR 0873 D4 — the never-cache set is derived from the hosting config', () => {
  it('takes every run rewrite of the target, and nothing from other targets or destinations', () => {
    expect(NEVER.map((r) => r.glob)).toEqual(['/api/**', '/', '/runs', '/runs/**']);
  });

  it('from the real firebase.json: every Cloud Run rewrite, including /', () => {
    const real = deriveNeverCache(REAL_FIREBASE, 'app');
    expect(real.length).toBeGreaterThanOrEqual(37);
    expect(real.map((r) => r.glob)).toEqual(expect.arrayContaining(['/', '/api/**', '/v1/**', '/.well-known/**', '/runs/**']));
    expect(real.map((r) => r.glob)).not.toContain('**');
  });

  it('refuses a missing target rather than deriving an empty set', () => {
    expect(() => deriveNeverCache(FIXTURE_HOSTING, 'nope')).toThrow(/not found/);
  });

  it('compiles Firebase globs', () => {
    const re = (g: string) => new RegExp(firebaseGlobToRegExpSource(g));
    expect(re('/api/**').test('/api/v1/x')).toBe(true);
    expect(re('/api/**').test('/api')).toBe(false);
    expect(re('/').test('/')).toBe(true);
    expect(re('/').test('/x')).toBe(false);
    expect(re('/a/*').test('/a/b/c')).toBe(false);
    expect(re('/@(sw|sw-push).js').test('/sw-push.js')).toBe(true);
    expect(re('/runs:bulk-cancel').test('/runs:bulk-cancel')).toBe(true);
    expect(re('/x.json').test('/xxjson')).toBe(false);
  });
});

describe('ADR 0873 D1 — the declaration shape is checked strictly', () => {
  it('accepts a full, valid declaration', () => {
    expect(checkOfflineShape('books', {
      navigations: ['/books'], precache: ['/bookai/mark.svg'],
      runtime: [{ match: '/bookai/fonts/**', strategy: 'swr', maxEntries: 20 }], entitlement: 'last-known',
    })).toEqual([]);
  });

  it.each([
    [{ navigations: [] }, 'non-empty'],
    [{ navigations: ['/'] }, 'literal path'],
    [{ navigations: ['/books/:id'] }, 'literal path'],
    [{ navigations: ['/books/'] }, 'literal path'],
    [{ navigations: ['/books'], precache: ['/fonts/*.woff2'] }, 'globs are not allowed'],
    [{ navigations: ['/books'], precache: ['/sw.js'] }, 'generated or derived'],
    [{ navigations: ['/books'], runtime: [{ match: '/assets/**', strategy: 'swr', maxEntries: 5 }] }, 'already owns'],
    [{ navigations: ['/books'], runtime: [{ match: '/x/**', strategy: 'cache-first', maxEntries: 5 }] }, 'strategy'],
    [{ navigations: ['/books'], runtime: [{ match: '/x/**', strategy: 'swr', maxEntries: 0 }] }, 'maxEntries'],
    [{ navigations: ['/books'], entitlement: 'always' }, 'entitlement'],
    [{ navigations: ['/books'], fetch: () => null }, 'unknown key'],
  ])('refuses %j', (offline, message) => {
    expect(checkOfflineShape('f', offline).join('\n')).toContain(message);
  });
});

describe('ADR 0873 D4/D9 — the build refuses a table that touches Cloud Run or cannot launch', () => {
  const ok = { id: 'books', dir: '/x', offline: { navigations: ['/books'] } };
  const check = (offline: FeatureOffline, startUrl = '/books') => checkOfflineTable({ features: [{ ...ok, offline }], neverCache: NEVER, startUrl });

  it('accepts a navigation clear of every rewrite with a launchable start_url', () => {
    expect(check({ navigations: ['/books'] })).toEqual([]);
  });

  it('refuses a navigation that IS a rewrite, or contains one below it', () => {
    expect(check({ navigations: ['/runs'] }, '/runs').join()).toContain('navigation /runs intersects');
    expect(check({ navigations: ['/books', '/runs/abc'] }).join()).toContain('navigation /runs/abc intersects');
    expect(check({ navigations: ['/api'] }).join()).toContain('navigation /api intersects');
  });

  it('refuses a runtime match or a precache path that overlaps a rewrite', () => {
    expect(check({ navigations: ['/books'], runtime: [{ match: '/api/**', strategy: 'swr', maxEntries: 5 }] }).join()).toContain('runtime match /api/** intersects');
    expect(check({ navigations: ['/books'], runtime: [{ match: '/**', strategy: 'swr', maxEntries: 5 }] }).join()).toContain('intersects');
    expect(check({ navigations: ['/books'], precache: ['/api/x.json'] }).join()).toContain('precache /api/x.json');
  });

  it('refuses a runtime match that covers a declared navigation', () => {
    expect(check({ navigations: ['/books'], runtime: [{ match: '/book*', strategy: 'swr', maxEntries: 5 }] }).join()).toContain('covers a declared navigation');
  });

  it('D9: refuses start_url "/" (a Cloud Run document) and one that is not declared', () => {
    expect(check({ navigations: ['/books'] }, '/').join()).toContain('start_url / is a Cloud Run rewrite');
    expect(check({ navigations: ['/books'] }, '/crm').join()).toContain('start_url /crm is not a declared offline navigation');
    expect(check({ navigations: ['/books'] }, '/books/shelf?x=1')).toEqual([]);
  });
});

describe('ADR 0873 — prepareOfflineBuild reads only what the composed registry reaches', () => {
  function fixtureRepo(withHosting: boolean) {
    const root = mkdtempSync(join(tmpdir(), 'owp-swprep-'));
    const features = join(root, 'src', 'features');
    for (const d of ['books', 'crm']) mkdirSync(join(features, d), { recursive: true });
    writeFileSync(join(features, 'books', 'offline.ts'), '');
    writeFileSync(join(features, 'crm', 'offline.ts'), '');
    if (withHosting) writeFileSync(join(root, 'firebase.json'), JSON.stringify(FIXTURE_HOSTING));
    return { root, registryPath: join(features, 'registry.ts') };
  }
  const declarations: Record<string, unknown> = {
    books: { navigations: ['/books'] },
    crm: { navigations: ['/crm'] },
  };
  const importModule = async (file: string) => ({ offline: declarations[file.split('/').at(-2)!] });

  it('a registry that composes no declaring feature yields an empty table and reads no hosting config', async () => {
    const { registryPath } = fixtureRepo(false);
    const out = await prepareOfflineBuild({
      registrySource: "import { usersFeature } from './users/routes.js';\n", registryPath, importModule, hostingConfigPath: '/nonexistent.json',
    });
    expect(out).toEqual({ features: [], neverCache: [] });
  });

  it('only composed features contribute (a distribution that drops crm drops its rules)', async () => {
    const { root, registryPath } = fixtureRepo(true);
    const out = await prepareOfflineBuild({
      registrySource: "import { booksFeature } from './books/routes.js';\n", registryPath, importModule,
      hostingConfigPath: join(root, 'firebase.json'), startUrl: '/books',
    });
    expect(out.features.map((f) => f.id)).toEqual(['books']);
    expect(out.neverCache.length).toBe(4);
  });

  it('fails the build when the hosting config cannot be read and the table is non-empty', async () => {
    const { registryPath } = fixtureRepo(false);
    await expect(prepareOfflineBuild({
      registrySource: "import { booksFeature } from './books/routes.js';\n", registryPath, importModule,
      hostingConfigPath: '/nonexistent/firebase.json', startUrl: '/books',
    })).rejects.toThrow(/cannot read the D4 hosting config/);
  });

  it('fails the build on the default start_url "/" once anything declares', async () => {
    const { root, registryPath } = fixtureRepo(true);
    await expect(prepareOfflineBuild({
      registrySource: "import { booksFeature } from './books/routes.js';\n", registryPath, importModule,
      hostingConfigPath: join(root, 'firebase.json'),
    })).rejects.toThrow(/start_url \/ is a Cloud Run rewrite/);
  });
});

// ---------------------------------------------------------------------------
function chunk(fileName: string, opts: Partial<BundleItem> = {}): BundleItem {
  return { type: 'chunk', fileName, code: `/*${fileName}*/`, isEntry: false, imports: [], dynamicImports: [], moduleIds: [], viteMetadata: { importedCss: new Set(), importedAssets: new Set() }, ...opts };
}
function fixtureBundle(): Record<string, BundleItem> {
  const b: Record<string, BundleItem> = {
    'index.html': { type: 'asset', fileName: 'index.html', source: '<html>shell</html>' },
    'assets/index-A.js': chunk('assets/index-A.js', {
      isEntry: true, imports: ['assets/vendor-B.js'], dynamicImports: ['assets/Books-C.js', 'assets/Crm-X.js'],
      moduleIds: ['/app/src/main.tsx', '/app/src/features/books/routes.tsx'],
      viteMetadata: { importedCss: new Set(['assets/index-A.css']), importedAssets: new Set() },
    }),
    'assets/vendor-B.js': chunk('assets/vendor-B.js'),
    'assets/index-A.css': { type: 'asset', fileName: 'assets/index-A.css', source: 'body{}' },
    'assets/Books-C.js': chunk('assets/Books-C.js', {
      moduleIds: ['/app/src/features/books/BooksPage.tsx'], imports: ['assets/vendor-B.js', 'assets/shared-D.js'],
      dynamicImports: ['assets/Editor-E.js'],
      viteMetadata: { importedCss: new Set(['assets/Books-C.css']), importedAssets: new Set() },
    }),
    'assets/Books-C.css': { type: 'asset', fileName: 'assets/Books-C.css', source: '.b{}' },
    'assets/shared-D.js': chunk('assets/shared-D.js'),
    'assets/Editor-E.js': chunk('assets/Editor-E.js', { moduleIds: ['/app/src/editor/Editor.tsx'] }),
    'assets/Crm-X.js': chunk('assets/Crm-X.js', { moduleIds: ['/app/src/features/crm/CrmPage.tsx'] }),
  };
  return b;
}
const BOOKS = { id: 'books', dir: '/app/src/features/books', offline: { navigations: ['/books'], precache: ['/bookai/mark.svg'] } };
const readPublicFile = (p: string) => (p === '/bookai/mark.svg' ? new TextEncoder().encode('<svg/>') : null);

describe('ADR 0873 D6 — the precache is the shell plus each feature\'s full chunk graph', () => {
  it('shell = index.html + the entry STATIC graph; feature = its chunks closed over static AND dynamic imports', () => {
    const r = computePrecache({ bundle: fixtureBundle(), features: [BOOKS], readPublicFile });
    expect(r.errors).toEqual([]);
    expect(r.precache).toEqual([
      SHELL_URL,
      '/assets/Books-C.css', '/assets/Books-C.js', '/assets/Editor-E.js',
      '/assets/index-A.css', '/assets/index-A.js', '/assets/shared-D.js', '/assets/vendor-B.js',
      '/bookai/mark.svg',
    ]);
    // Another feature's lazy chunk, reachable only through the ENTRY's dynamic
    // imports, is not pulled in: the closure never expands from the shell.
    expect(r.precache).not.toContain('/assets/Crm-X.js');
    expect(r.sizes).toEqual([expect.objectContaining({ id: 'books', chunks: 4 })]);
  });

  it('fails over the gzip budget', () => {
    const r = computePrecache({ bundle: fixtureBundle(), features: [BOOKS], readPublicFile, budgetKb: 0.01 });
    expect(r.errors.join()).toContain('over the 0.01 kB budget');
  });

  it('fails when a precache extra is neither build output nor a public file', () => {
    const r = computePrecache({ bundle: fixtureBundle(), features: [{ ...BOOKS, offline: { navigations: ['/books'], precache: ['/missing.svg'] } }], readPublicFile });
    expect(r.errors.join()).toContain('/missing.svg is neither');
  });

  it('the version changes with the shell\'s CONTENT, not only with file names', () => {
    const a = computePrecache({ bundle: fixtureBundle(), features: [BOOKS], readPublicFile }).version;
    const changed = fixtureBundle();
    changed['index.html'] = { type: 'asset', fileName: 'index.html', source: '<html>rebranded</html>' };
    expect(computePrecache({ bundle: changed, features: [BOOKS], readPublicFile }).version).not.toBe(a);
    expect(computePrecache({ bundle: fixtureBundle(), features: [BOOKS], readPublicFile }).version).toBe(a);
  });
});

describe('ADR 0873 D5/D8 pins', () => {
  it('the shell URL is the name prepare-hosting-shell.cjs deploys index.html as', () => {
    expect(SHELL_URL).toBe('/app-shell.html');
    const predeploy = readFileSync(join(FRONTEND, 'scripts', 'prepare-hosting-shell.cjs'), 'utf8');
    expect(predeploy).toMatch(/join\(dist, 'app-shell\.html'\)/);
  });

  it('the page-side sign-out purge uses the worker\'s cache prefix', () => {
    expect(PAGE_PREFIX).toBe(OFFLINE_CACHE_PREFIX);
  });
});

// ---------------------------------------------------------------------------
// A simulated service-worker global. Request/Response/Headers are Node's own.
// ---------------------------------------------------------------------------
const ORIGIN = 'https://app.test';

class FakeCache {
  store = new Map<string, Response>();
  private key(req: RequestInfo | URL): string { return new URL(typeof req === 'string' ? req : req instanceof URL ? req.href : req.url, ORIGIN).href; }
  async match(req: RequestInfo | URL) { const r = this.store.get(this.key(req)); return r ? r.clone() : undefined; }
  async put(req: RequestInfo | URL, res: Response) { this.store.set(this.key(req), res.clone()); }
  async delete(req: RequestInfo | URL) { return this.store.delete(this.key(req)); }
  async keys() { return [...this.store.keys()].map((u) => new Request(u)); }
}
class FakeCacheStorage {
  caches = new Map<string, FakeCache>();
  async open(name: string) { if (!this.caches.has(name)) this.caches.set(name, new FakeCache()); return this.caches.get(name)!; }
  async keys() { return [...this.caches.keys()]; }
  async delete(name: string) { return this.caches.delete(name); }
  async has(name: string) { return this.caches.has(name); }
}

type Network = (req: Request) => Promise<Response>;

/** The worker's `Request`: relative URLs resolve against the worker's origin, as in a browser. */
class WorkerRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(typeof input === 'string' ? new URL(input, ORIGIN) : input, init);
  }
}

function bootWorker(source: string, network: Network, caches = new FakeCacheStorage()) {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const preload = { enabled: null as boolean | null };
  const self = {
    location: new URL(ORIGIN),
    addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); },
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async () => undefined },
    registration: {
      navigationPreload: { enable: async () => { preload.enabled = true; }, disable: async () => { preload.enabled = false; } },
      showNotification: async () => undefined,
    },
  };
  const fetchFn = (input: RequestInfo | URL) => network(input instanceof Request ? input : new Request(new URL(String(input), ORIGIN)));
  const quiet = { ...console, warn: () => undefined };
  new Function('self', 'caches', 'fetch', 'console', 'Request', source)(self, caches, fetchFn, quiet, WorkerRequest);

  async function lifecycle(type: 'install' | 'activate') {
    const waits: Promise<unknown>[] = [];
    for (const fn of listeners[type] ?? []) fn({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }
  /** Dispatch a fetch; resolves to the response, `undefined` when not handled, or rejects as the page would see. */
  async function dispatch(url: string, init: { mode?: RequestMode; method?: string; preload?: Promise<Response | undefined> } = {}) {
    const request = new Request(new URL(url, ORIGIN), { method: init.method ?? 'GET' });
    Object.defineProperty(request, 'mode', { value: init.mode ?? 'cors' });
    let responded: Promise<Response> | undefined;
    const waits: Promise<unknown>[] = [];
    for (const fn of listeners.fetch ?? []) {
      fn({ request, preloadResponse: init.preload ?? Promise.resolve(undefined), respondWith: (p: Promise<Response>) => { responded = p; }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    }
    if (!responded) return undefined;
    const out = await responded;
    await Promise.all(waits);
    return out;
  }
  return { listeners, caches, preload, lifecycle, dispatch };
}

function tableFor(version: string, precache = [SHELL_URL, '/assets/index-A.js', '/assets/Books-C.js', '/bookai/mark.svg']): OfflineTable {
  return buildOfflineTable({
    features: [{ id: 'books', dir: '/x', offline: { navigations: ['/books'], runtime: [{ match: '/bookai/fonts/**', strategy: 'swr', maxEntries: 2 }] } }],
    neverCache: NEVER, precache, version,
  });
}

/** A static site: every known file 200 with its type; anything else is the ** rewrite (200 text/html). */
function site(files: Record<string, string>, log: string[] = []): Network {
  return async (req) => {
    const path = new URL(req.url).pathname;
    log.push(path);
    if (path in files) {
      const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.html') ? 'text/html' : 'image/svg+xml';
      return new Response(files[path], { headers: { 'content-type': type } });
    }
    return new Response('<html>rewrite</html>', { headers: { 'content-type': 'text/html' } });
  };
}
const offline: Network = async () => { throw new TypeError('Failed to fetch'); };
const FILES = { [SHELL_URL]: '<html>shell v1</html>', '/assets/index-A.js': 'a1', '/assets/Books-C.js': 'c1', '/bookai/mark.svg': '<svg/>' };

describe('ADR 0873 D3/D11 — the empty-table worker', () => {
  it('has no fetch listener, and its activate deletes every offline cache and disables preload', async () => {
    const w = bootWorker(generateServiceWorker(), site(FILES));
    expect(w.listeners.fetch).toBeUndefined();
    await w.caches.open(`${OFFLINE_CACHE_PREFIX}shell-old`);
    await w.caches.open(`${OFFLINE_CACHE_PREFIX}meta`);
    await w.caches.open('someone-elses-cache');
    await w.lifecycle('activate');
    expect(await w.caches.keys()).toEqual(['someone-elses-cache']);
    expect(w.preload.enabled).toBe(false);
  });

  it('a table with no navigations is the empty-table worker', () => {
    const src = generateServiceWorker({ ...tableFor('v1'), navigations: [] });
    expect(src).toBe(generateServiceWorker());
  });
});

describe('ADR 0873 D4–D7 — the engine, run against a simulated worker', () => {
  async function installedWith(table: OfflineTable, files = FILES) {
    const net: { current: Network } = { current: site(files) };
    const w = bootWorker(generateServiceWorker(table), (r) => net.current(r));
    await w.lifecycle('install');
    await w.lifecycle('activate');
    return { w, net };
  }
  async function installed(version = 'v1', files = FILES) {
    return installedWith(tableFor(version, Object.keys(files)), files);
  }

  it('install precaches the whole version and activate enables navigation preload', async () => {
    const { w } = await installed();
    const shell = w.caches.caches.get(`${OFFLINE_CACHE_PREFIX}shell-v1`)!;
    expect([...shell.store.keys()].map((u) => new URL(u).pathname).sort()).toEqual(Object.keys(FILES).sort());
    expect(w.preload.enabled).toBe(true);
  });

  it('install is atomic: a script answered with HTML (the ** rewrite) stores NOTHING', async () => {
    const files: Record<string, string> = { ...FILES };
    const net = site(files);
    const w = bootWorker(generateServiceWorker(tableFor('v1', [...Object.keys(FILES), '/assets/pruned-Z.js'])), net);
    await w.lifecycle('install');
    expect(await w.caches.has(`${OFFLINE_CACHE_PREFIX}shell-v1`)).toBe(false);
  });

  it('D5: a declared navigation is network-first, using the preload response', async () => {
    const { w } = await installed();
    const res = await w.dispatch('/books/shelf', { mode: 'navigate', preload: Promise.resolve(new Response('<html>fresh</html>')) });
    expect(await res!.text()).toBe('<html>fresh</html>');
  });

  it('D5: an HTTP error passes through; the shell is served ONLY when the network fails', async () => {
    const { w, net } = await installed();
    net.current = async () => new Response('down', { status: 503 });
    expect((await w.dispatch('/books', { mode: 'navigate' }))!.status).toBe(503);
    net.current = offline;
    expect(await (await w.dispatch('/books', { mode: 'navigate' }))!.text()).toBe('<html>shell v1</html>');
    // "Covers itself and everything below it": a SUB-path gets the shell too.
    expect(await (await w.dispatch('/books/shelf', { mode: 'navigate' }))!.text()).toBe('<html>shell v1</html>');
  });

  it('D4: an undeclared navigation, "/" and a Cloud Run route fail exactly as the network does', async () => {
    const { w, net } = await installed();
    net.current = offline;
    await expect(w.dispatch('/crm', { mode: 'navigate' })).rejects.toThrow('Failed to fetch');
    await expect(w.dispatch('/', { mode: 'navigate' })).rejects.toThrow('Failed to fetch');
    await expect(w.dispatch('/runs/r1', { mode: 'navigate' })).rejects.toThrow('Failed to fetch');
    // The ENGINE's own never-cache check: a table that DECLARES `/runs` (refused by
    // the build check — a double guard) still never serves the shell for it.
    const declaresRewrite = buildOfflineTable({
      features: [{ id: 'runs', dir: '/x', offline: { navigations: ['/runs'] } }],
      neverCache: NEVER, precache: Object.keys(FILES), version: 'nc',
    });
    expect(declaresRewrite.navigations).toEqual(['/runs']);
    const { w: w2, net: net2 } = await installedWith(declaresRewrite);
    net2.current = offline;
    await expect(w2.dispatch('/runs/r1', { mode: 'navigate' })).rejects.toThrow('Failed to fetch');
  });

  it('D4: never-cache, cross-origin and non-GET requests are not handled at all', async () => {
    const { w } = await installed();
    expect(await w.dispatch('/api/v1/runs')).toBeUndefined();
    expect(await w.dispatch('https://openwop-app-backend.run.app/events')).toBeUndefined();
    // A cross-origin ASSET path: same-origin, this would be served cache-first.
    expect(await w.dispatch('https://cdn.example/assets/index-A.js')).toBeUndefined();
    expect(await w.dispatch('/assets/index-A.js', { method: 'POST' })).toBeUndefined();
    expect(await w.dispatch('/unknown.json')).toBeUndefined();
    // The ENGINE's own subresource never-cache check: a runtime rule over `/api/**`
    // (refused by the build check — a double guard) still leaves `/api` alone,
    // while the same table's other rule is live (positive control).
    const coversApi = buildOfflineTable({
      features: [{ id: 'books', dir: '/x', offline: { navigations: ['/books'], runtime: [
        { match: '/api/**', strategy: 'swr', maxEntries: 5 },
        { match: '/bookai/fonts/**', strategy: 'swr', maxEntries: 5 },
      ] } }],
      neverCache: NEVER, precache: Object.keys(FILES), version: 'api',
    });
    const { w: w2 } = await installedWith(coversApi);
    expect(await w2.dispatch('/api/v1/runs')).toBeUndefined();
    expect(await w2.dispatch('/bookai/fonts/a.woff2')).toBeDefined();
  });

  it('D6: a hashed asset is served from cache, and a miss goes to the network unchanged', async () => {
    const { w, net } = await installed();
    net.current = offline;
    expect(await (await w.dispatch('/assets/Books-C.js'))!.text()).toBe('c1');
    await expect(w.dispatch('/assets/never-seen.js')).rejects.toThrow('Failed to fetch');
  });

  it('D6: after a deploy, the PREVIOUS version still serves an old tab\'s chunks; the one before is purged', async () => {
    const caches = new FakeCacheStorage();
    const run = async (version: string, files: Record<string, string>) => {
      const w = bootWorker(generateServiceWorker(tableFor(version, Object.keys(files))), site(files), caches);
      await w.lifecycle('install');
      await w.lifecycle('activate');
      return w;
    };
    const shells = async () => (await caches.keys()).filter((n) => n.includes('shell-')).sort();
    await run('v1', FILES);
    const w2 = await run('v2', { [SHELL_URL]: '<html>v2</html>', '/assets/index-B.js': 'b2' });
    expect(await shells()).toEqual([`${OFFLINE_CACHE_PREFIX}shell-v1`, `${OFFLINE_CACHE_PREFIX}shell-v2`]);
    expect(await (await w2.dispatch('/assets/index-A.js'))!.text()).toBe('a1');
    await run('v3', { [SHELL_URL]: '<html>v3</html>', '/assets/index-C.js': 'c3' });
    expect(await shells()).toEqual([`${OFFLINE_CACHE_PREFIX}shell-v2`, `${OFFLINE_CACHE_PREFIX}shell-v3`]);
  });

  it('D6: a precache extra is network-first with the precached copy as the offline fallback', async () => {
    const { w, net } = await installed();
    net.current = async () => new Response('<svg>new</svg>', { headers: { 'content-type': 'image/svg+xml' } });
    expect(await (await w.dispatch('/bookai/mark.svg'))!.text()).toBe('<svg>new</svg>');
    net.current = offline;
    expect(await (await w.dispatch('/bookai/mark.svg'))!.text()).toBe('<svg/>');
  });

  it('runtime swr: serves the cached copy, refreshes it, never stores HTML, and trims to maxEntries', async () => {
    const { w, net } = await installed();
    let n = 0;
    net.current = async (req) => {
      n += 1;
      if (new URL(req.url).pathname.endsWith('missing.woff2')) return new Response('<html/>', { headers: { 'content-type': 'text/html' } });
      return new Response(`font${n}`, { headers: { 'content-type': 'font/woff2' } });
    };
    expect(await (await w.dispatch('/bookai/fonts/a.woff2'))!.text()).toBe('font1');
    expect(await (await w.dispatch('/bookai/fonts/a.woff2'))!.text()).toBe('font1'); // cached, refreshed behind
    // The refresh LANDED: the next read serves the copy fetched behind the last one.
    expect(await (await w.dispatch('/bookai/fonts/a.woff2'))!.text()).toBe('font2');
    const runtime = w.caches.caches.get(`${OFFLINE_CACHE_PREFIX}runtime-v1`)!;
    const paths = () => [...runtime.store.keys()].map((u) => new URL(u).pathname);
    await w.dispatch('/bookai/fonts/missing.woff2');
    // Read BEFORE the trim runs again: with maxEntries 2 a stored HTML entry would
    // otherwise be evicted by b/c and the filter would never be observed.
    expect(paths()).not.toContain('/bookai/fonts/missing.woff2');
    await w.dispatch('/bookai/fonts/b.woff2');
    await w.dispatch('/bookai/fonts/c.woff2');
    expect(paths()).toEqual(['/bookai/fonts/b.woff2', '/bookai/fonts/c.woff2']);
  });
});

// ---------------------------------------------------------------------------
describe('ADR 0873 D13 — VITE_SW_LEGACY_CACHE_PURGE, the caches a previous worker left', () => {
  // What MyndHyve's Workbox worker (vite-plugin-pwa) left at its origin.
  const MYNDHYVE = 'workbox-*,js-chunks-v4,google-fonts-stylesheets,google-fonts-webfonts,firebase-api,images';

  /** Boot a worker with open window clients; records each client's navigate(). */
  function bootWithWindows(source: string, caches: FakeCacheStorage, urls: string[]) {
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const navigated: string[] = [];
    let claimed = 0;
    const windows = urls.map((url) => ({ url, navigate: async (to: string) => { navigated.push(to); return undefined; } }));
    const self = {
      location: new URL(ORIGIN),
      addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); },
      skipWaiting: () => undefined,
      clients: {
        claim: async () => { claimed += 1; },
        matchAll: async (opts?: { type?: string }) => (opts?.type === 'window' ? windows : []),
        openWindow: async () => undefined,
      },
      registration: { navigationPreload: { enable: async () => undefined, disable: async () => undefined }, showNotification: async () => undefined },
    };
    new Function('self', 'caches', 'fetch', 'console', 'Request', source)(self, caches, site(FILES), console, WorkerRequest);
    async function activate() {
      const waits: Promise<unknown>[] = [];
      for (const fn of listeners.activate ?? []) fn({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    }
    return { navigated, activate, claims: () => claimed };
  }

  it('unset or blank adds nothing: the worker text is byte-identical for every existing adopter', () => {
    expect(parseLegacyCachePurge(undefined)).toEqual({ names: [], prefixes: [] });
    expect(parseLegacyCachePurge(' , ')).toEqual({ names: [], prefixes: [] });
    expect(generateServiceWorker(null, { legacyCachePurge: parseLegacyCachePurge('') })).toBe(generateServiceWorker());
    expect(generateServiceWorker(tableFor('v1'), { legacyCachePurge: parseLegacyCachePurge(undefined) })).toBe(generateServiceWorker(tableFor('v1')));
    expect(generateServiceWorker()).not.toContain('LEGACY_CACHE_PURGE');
  });

  it('parses names and trailing-* prefixes, trimmed, deduplicated and sorted', () => {
    expect(parseLegacyCachePurge(` ${MYNDHYVE},images `)).toEqual({
      names: ['firebase-api', 'google-fonts-stylesheets', 'google-fonts-webfonts', 'images', 'js-chunks-v4'],
      prefixes: ['workbox-'],
    });
  });

  it.each([
    ['*', 'only a trailing *'],
    ['work*box', 'only a trailing *'],
    ['openwop-offline-shell-v1', 'own'],
    ['openwop-*', 'own'],
    ['o*', 'own'],
  ])('refuses %j', (value, message) => {
    expect(() => parseLegacyCachePurge(value)).toThrow(message);
  });

  it('deletes exactly the legacy caches, then reloads every open tab once', async () => {
    const caches = new FakeCacheStorage();
    for (const name of ['workbox-precache-v2-https://myndhyve.ai/', 'js-chunks-v4', 'images', 'images-v2', `${OFFLINE_CACHE_PREFIX}meta`, 'someone-elses-cache']) await caches.open(name);
    const source = generateServiceWorker(null, { legacyCachePurge: parseLegacyCachePurge(MYNDHYVE) });
    const w = bootWithWindows(source, caches, [`${ORIGIN}/`, `${ORIGIN}/dashboard?x=1`]);
    await w.activate();
    // The D11 purge still removes the worker's own offline caches; D13 removes the legacy ones; nothing else.
    expect((await caches.keys()).sort()).toEqual(['images-v2', 'someone-elses-cache']);
    expect(w.navigated).toEqual([`${ORIGIN}/`, `${ORIGIN}/dashboard?x=1`]);
    expect(w.claims()).toBeGreaterThanOrEqual(2); // the push handlers' claim, and D13's before navigate()

    // A second activation (the next deploy) finds nothing and reloads nobody.
    const again = bootWithWindows(source, caches, [`${ORIGIN}/`]);
    await again.activate();
    expect(again.navigated).toEqual([]);
  });

  it('a browser that never ran the old app is never reloaded', async () => {
    const caches = new FakeCacheStorage();
    await caches.open('someone-elses-cache');
    const w = bootWithWindows(generateServiceWorker(null, { legacyCachePurge: parseLegacyCachePurge(MYNDHYVE) }), caches, [`${ORIGIN}/`]);
    await w.activate();
    expect(w.navigated).toEqual([]);
    expect(await caches.keys()).toEqual(['someone-elses-cache']);
  });

  it('runs beside the offline engine without touching its caches', async () => {
    const caches = new FakeCacheStorage();
    await caches.open('js-chunks-v4');
    const source = generateServiceWorker(tableFor('v1'), { legacyCachePurge: parseLegacyCachePurge(MYNDHYVE) });
    const w = bootWorker(source, site(FILES), caches);
    await w.lifecycle('install');
    await w.lifecycle('activate');
    const names = await caches.keys();
    expect(names).not.toContain('js-chunks-v4');
    expect(names.some((n) => n.startsWith(`${OFFLINE_CACHE_PREFIX}shell-v1`))).toBe(true);
  });
});
