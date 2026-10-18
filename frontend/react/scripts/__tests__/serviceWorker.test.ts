/**
 * ADR 0873 P1 — one generated service worker, one registration URL, permanent
 * scripts. No behaviour change: the worker is the push handlers and nothing else.
 *
 * The permanence gate runs as the REAL script in a child process against fixture
 * `dist/` trees (the `gates.test.ts` convention), so a weakened gate reds here.
 *
 * Sabotage (wave 51 probes): dropping the push handlers or adding a fetch listener to
 * the empty-table worker, re-pointing the shim or SW_URL, spelling a worker URL in app
 * source, a non-`no-cache` header, and each permanence check (missing / HTML / parse /
 * the permanent list) each red one case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firebaseGlobToRegExpSource, generateServiceWorker } from '../gen-service-worker.mjs';
import { SW_SCOPE, SW_URL } from '../../src/sw/swUrl.js';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = join(FRONTEND, '..', '..');

/** Evaluate a worker source against a fake `self`; return the event types it listens for. */
function listenersOf(source: string): string[] {
  const types: string[] = [];
  const self = {
    addEventListener: (type: string) => { types.push(type); },
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  new Function('self', source)(self);
  return types;
}

describe('ADR 0873 D2/D3 — the generated /sw.js with an empty offline table', () => {
  it('carries the push handlers', () => {
    expect(listenersOf(generateServiceWorker())).toEqual(
      expect.arrayContaining(['install', 'activate', 'push', 'notificationclick']),
    );
  });

  it('has NO fetch listener while the offline table is empty (D3)', () => {
    // A pass-through fetch listener would still start the worker for every request.
    expect(listenersOf(generateServiceWorker())).not.toContain('fetch');
  });
});

describe('ADR 0873 D2 — public/sw-push.js is a permanent shim onto SW_URL', () => {
  const shim = readFileSync(join(FRONTEND, 'public', 'sw-push.js'), 'utf8');

  it('loads exactly SW_URL, and nothing else', () => {
    const imported: string[] = [];
    const code = shim.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    new Function('importScripts', code)((url: string) => { imported.push(url); });
    expect(imported).toEqual([SW_URL]);
  });
});

describe('ADR 0873 D3 — one registration URL', () => {
  it('SW_URL is /sw.js at scope / (D10: no Service-Worker-Allowed needed)', () => {
    expect(SW_URL).toBe('/sw.js');
    expect(SW_SCOPE).toBe('/');
  });

  it('no app source spells a worker URL itself — every register() goes through swUrl.ts', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__') walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name) || full.endsWith(join('sw', 'swUrl.ts'))) continue;
        const text = readFileSync(full, 'utf8');
        if (/['"`]\/sw(-push)?\.js['"`]/.test(text) || /serviceWorker\.register\(\s*['"`]/.test(text)) {
          offenders.push(relative(FRONTEND, full));
        }
      }
    };
    walk(join(FRONTEND, 'src'));
    expect(offenders).toEqual([]);
  });
});

describe('ADR 0873 D10 — Hosting serves both worker scripts with Cache-Control: no-cache', () => {
  it('the app target has a header block for /sw.js and /sw-push.js', () => {
    type Block = { target?: string; headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };
    const cfg = JSON.parse(readFileSync(join(REPO, 'firebase.json'), 'utf8')) as { hosting: Block | Block[] };
    const blocks = Array.isArray(cfg.hosting) ? cfg.hosting : [cfg.hosting];
    const app = blocks.find((h) => h.target === 'app');
    expect(app, 'no hosting target "app" in firebase.json').toBeDefined();
    // Coverage, not spelling: whichever header block's glob matches each worker path
    // (compiled with the same Firebase glob rules the SW build uses) must say no-cache.
    for (const path of ['/sw.js', '/sw-push.js']) {
      const covering = (app?.headers ?? []).filter((h) => new RegExp(firebaseGlobToRegExpSource(h.source)).test(path));
      expect(covering.length, `${path}: a header block covers it`).toBeGreaterThan(0);
      expect(covering.flatMap((h) => h.headers), path).toContainEqual({ key: 'Cache-Control', value: 'no-cache' });
    }
  });
});

describe('ADR 0873 D2 — check-sw-permanence (the real gate)', () => {
  let root: string;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'owp-swgate-')); });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  function runGate(files: Record<string, string>): { code: number; out: string } {
    const dir = mkdtempSync(join(root, 'case-'));
    mkdirSync(join(dir, 'dist'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, 'dist', name), body, 'utf8');
    try {
      const out = execFileSync(process.execPath, [join(FRONTEND, 'scripts', 'check-sw-permanence.mjs')], {
        cwd: dir, encoding: 'utf8', stdio: 'pipe',
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  const GOOD = { 'sw.js': generateServiceWorker(), 'sw-push.js': "importScripts('/sw.js');\n" };

  it('passes when both scripts are present and parse', () => {
    expect(runGate(GOOD).code).toBe(0);
  });

  it('fails when sw.js is missing', () => {
    const r = runGate({ 'sw-push.js': GOOD['sw-push.js'] });
    expect(r.code).toBe(1);
    expect(r.out).toContain('sw.js: missing');
  });

  it('fails when sw-push.js is missing', () => {
    const r = runGate({ 'sw.js': GOOD['sw.js'] });
    expect(r.code).toBe(1);
    expect(r.out).toContain('sw-push.js: missing');
  });

  it('fails when a worker script is HTML (what the ** rewrite would serve)', () => {
    const r = runGate({ ...GOOD, 'sw.js': '<!doctype html><html></html>' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('looks like HTML');
  });

  it('fails when a worker script does not parse', () => {
    const r = runGate({ ...GOOD, 'sw-push.js': 'importScripts(' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('does not parse');
  });
});
