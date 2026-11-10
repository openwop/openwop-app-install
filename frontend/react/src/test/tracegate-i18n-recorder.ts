/**
 * ADR 0880 — Tracegate: which i18n keys THIS test file looked up.
 *
 * Loaded only when `OPENWOP_TRACEGATE_RECORD` is set, and AFTER `i18n-setup.ts`
 * (vitest.config.ts), so the setup's own bulk loading and its
 * `assertNamespacesPopulated` check are not counted, while every lookup the test
 * file and the modules it imports make — at import time or in a test — is.
 *
 * Every read of the catalog goes through the store i18next keeps
 * (`Translator` → `resourceStore.getResource`), so wrapping that store sees it:
 *   keys  — `<lng>\0<ns>\0<dotted.path>`, one per lookup (misses included, so
 *           plural/context/fallback probes are all there);
 *   whole — `<lng>\0<ns>`, `<lng>\0*` or `*\0*` for a read that can see more than
 *           one key (a bundle, a language's data, the raw `data`, a new instance).
 * `scripts/lib/tracegate-i18n.mjs` turns these into key-level invalidation. It
 * never changes a return value: tracing must not change behaviour.
 *
 * ADR 1028 P1: when the recorder loaded is the tracegate-ci PACKAGE's (its state has
 * `keyReads`), the same reads are also reported to it as keyed reads of each catalog
 * file (`tracegate-package-keys.ts`). Under the fork's recorder nothing more happens.
 */
import fs from 'node:fs';
import path from 'node:path';
import i18n from '../i18n/index.js';
import { packageKeys } from './tracegate-package-keys.js';

interface Rec { keys: Set<string>; whole: Set<string> }
type Fn = (...a: unknown[]) => unknown;
type Store = Record<string, unknown> & { options?: { keySeparator?: string | false; defaultNS?: string | string[] }; data: Record<string, unknown> };

const tg = (globalThis as { __tracegate?: { i18n?: Rec | null; keyReads?: unknown; repoRoot?: string } }).__tracegate;

/** Every catalog the store can load, as repo paths (the three layouts in tracegate-package-keys.ts). */
function catalogFiles(root: string): string[] {
  const src = path.join(root, 'frontend/react/src');
  const ls = (d: string): string[] => { try { return fs.readdirSync(path.join(src, d)); } catch { return []; } };
  const out: string[] = [];
  for (const f of ls('features')) for (const t of ls(`features/${f}/i18n`)) out.push(`features/${f}/i18n/${t}`);
  for (const l of ls('i18n/locales')) for (const t of ls(`i18n/locales/${l}`)) out.push(`i18n/locales/${l}/${t}`);
  for (const d of ls('')) if (d !== 'features' && d !== 'i18n') for (const t of ls(`${d}/i18n`)) out.push(`${d}/i18n/${t}`);
  return out.map((p) => `frontend/react/src/${p}`);
}

let pkg: ReturnType<typeof packageKeys> | null = null;
if (tg?.keyReads && tg.repoRoot) {
  try {
    const spec = 'tracegate-ci/recorder'; // a variable: resolved only when the package's recorder is the one loaded
    const { recordKeyRead } = (await import(/* @vite-ignore */ spec)) as { recordKeyRead: (file: string, key: string) => void };
    pkg = packageKeys(catalogFiles(tg.repoRoot), recordKeyRead);
  } catch { /* the package is not installed: record for the fork only */ }
}

if (tg) {
  const store = i18n.services.resourceStore as unknown as Store & { __tg?: { cur: Rec | null } };
  const rec: Rec = { keys: new Set(), whole: new Set() };
  tg.i18n = rec;
  if (store.__tg) {
    store.__tg.cur = rec; // the same instance in a non-isolated worker: already wrapped
  } else {
    const holder = { cur: rec as Rec | null };
    store.__tg = holder;
    let quiet = 0;
    const whole = (k: string): void => {
      if (quiet || !holder.cur) return;
      holder.cur.whole.add(k);
      if (pkg) { const [l, n] = k.split('\0'); pkg.whole(l ?? '*', n ?? '*'); }
    };
    const around = (obj: Record<string, unknown>, name: string, before: (...a: unknown[]) => void): void => {
      const orig = obj[name];
      if (typeof orig !== 'function') return;
      obj[name] = function (this: unknown, ...a: unknown[]) {
        try { before(...a); } catch { /* recording must never change behaviour */ }
        quiet++;
        try { return (orig as Fn).apply(this, a); } finally { quiet--; }
      };
    };
    around(store, 'getResource', (lng, ns, key, options) => {
      if (quiet || !holder.cur) return;
      let l = String(lng), n = ns as string | undefined, k = key as unknown;
      if (l.includes('.')) { const p = l.split('.'); l = p[0] ?? ''; n = p[1]; k = p.slice(2).join('.'); }
      if (k === undefined || k === null || k === '') { whole(`${l}\0${n ?? '*'}`); return; }
      const sepOpt = (options as { keySeparator?: string | false } | undefined)?.keySeparator;
      const sep = sepOpt !== undefined ? sepOpt : store.options?.keySeparator ?? '.';
      const p = Array.isArray(k) ? k.join('.') : typeof k === 'string' && sep && sep !== '.' ? k.split(sep).join('.') : String(k);
      holder.cur.keys.add(`${l}\0${n ?? ''}\0${p}`);
      if (pkg) { if (n) pkg.key(l, n, p); else pkg.whole(l, '*'); }
    });
    // Presence checks see no value, and writes are not reads.
    for (const name of ['hasResourceBundle', 'hasLanguageSomeTranslations', 'addResource', 'addResources', 'addResourceBundle', 'removeResourceBundle']) {
      around(store, name, () => {});
    }
    around(store, 'getResourceBundle', (lng, ns) => {
      const d = store.options?.defaultNS;
      whole(`${String(lng)}\0${String(ns ?? (Array.isArray(d) ? '*' : d ?? '*'))}`);
    });
    around(store, 'getDataByLanguage', (lng) => whole(`${String(lng)}\0*`));
    around(store, 'toJSON', () => whole('*\0*'));
    store.data = new Proxy(store.data, {
      get(t, k, r) { if (typeof k === 'string') whole(`${k}\0*`); return Reflect.get(t, k, r) as unknown; },
      ownKeys(t) { whole('*\0*'); return Reflect.ownKeys(t); },
    });
    // A second instance has its own store, which nothing here records.
    const inst = i18n as unknown as Record<string, unknown>;
    around(inst, 'createInstance', () => whole('*\0*'));
    around(inst, 'cloneInstance', () => whole('*\0*'));
  }
}
