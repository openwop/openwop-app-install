/**
 * The entry budget measures the CODE, not the luck of its chunk hashes (#5461;
 * the async-chunk hash names of ADR 0874 are what it normalizes).
 *
 * MEASURED 2026-11-01: the entries of d56470aa6 and 7b3331c6d were byte-identical
 * apart from ~519 chunk hashes, and gzipped 19 B apart, so upstream read 19 B under
 * the ceiling while every adopter (whose overlay changes chunk contents) read 3–12 B
 * over. Runs the REAL `check-bundle-budget.mjs` on two fixture `dist/`s whose
 * entries differ ONLY in the hash names they reference.
 *
 * Red when: the gate reads the raw gzip (the two builds then report different
 * headroom; this is main before the fix), or the normalization strips the hashes
 * instead of standing in for them (the gated size collapses far below what ships),
 * or the per-file VERDICT loop (`gz > budget`) measures raw gzip while the printed
 * headroom stays normalized (an over-budget entry is then refused by a different
 * margin in each build: case 3).
 *
 * Sabotage-witnessed (w85): headroom line on raw gzip → case 1; stand-ins that
 * strip (`'xxxxxxxx'`) → case 2; stand-in numbering not by first appearance → case 1;
 * printing the gated number as `served` → case 2; verdict loop on raw gzip → case 3.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const BUDGET_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-bundle-budget.mjs');
const CHUNKS = 400;

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'owp-hashnoise-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** A Rollup-shaped 8-character hash: B/C/D first, then base64url. Seeded, so the test is deterministic. */
const hashFor = (seed: string, i: number) => {
  const d = createHash('sha256').update(`${seed}:${i}`).digest();
  return 'BCD'[d.readUInt8(0) % 3] + d.toString('base64url').slice(1, 8);
};

/** The same entry code, referencing CHUNKS lazy chunks named with this seed's hashes. */
function entryText(hashes: string[], pad = ''): string {
  const lines = hashes.map((h, i) => `const L${i}=f.lazy(()=>_(()=>import("./c-${h}.js"),__vite__mapDeps([${i},${(i * 7) % CHUNKS}])));`);
  return `${pad}${lines.join('\n')}\nconst deps=[${hashes.map((h) => `"assets/c-${h}.js"`).join(',')}];\n`;
}

/** Seed-INDEPENDENT incompressible padding (the same in every build), large enough
 *  to push the entry past the 129 kB ENTRY_GZIP_BUDGET on its own. */
const OVER_BUDGET_PAD = (() => {
  const parts: string[] = [];
  let d = createHash('sha256').update('owp-over-budget').digest();
  for (let i = 0; i < 5000; i++) { d = createHash('sha256').update(d).digest(); parts.push(d.toString('base64url')); }
  return `/*${parts.join('')}*/\n`;
})();

function build(seed: string, pad = '') {
  const dir = mkdtempSync(join(root, `${seed}-`));
  const assets = join(dir, 'dist', 'assets');
  mkdirSync(assets, { recursive: true });
  const hashes = Array.from({ length: CHUNKS }, (_, i) => hashFor(seed, i));
  const text = entryText(hashes, pad);
  writeFileSync(join(assets, `index-${hashFor(seed, -1)}.js`), text);
  for (const h of hashes) writeFileSync(join(assets, `c-${h}.js`), 'export const x = 1;\n');
  // The named-chunk overrides must each match a built chunk (as in entryShare.test.ts).
  for (const f of ['i18n-AbCdEf12.js', 'katex-AbCdEf12.js']) writeFileSync(join(assets, f), 'export const x = 1;\n');
  const res = spawnSync(process.execPath, [BUDGET_SCRIPT], { cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, OPENWOP_DISTRIBUTION: 'default' } });
  const out = `${res.stdout}${res.stderr}${res.error ? `\nspawn error: ${res.error.message}` : ''}`;
  const headroom = Number(/(\d+) B of headroom/.exec(out)?.[1]);
  const gated = Number(/gated (\d+) B/.exec(out)?.[1]);
  const served = gzipSync(Buffer.from(text)).length;
  const stripped = gzipSync(Buffer.from(hashes.reduce((t, h) => t.split(`-${h}.`).join('-xxxxxxxx.'), text))).length;
  const refused = /over the ENTRY budget of [\d.]+ kB by (\d+) B/.exec(out);
  const refusedGated = /index-[A-Za-z0-9_-]{8}\.js is [\d.]+ kB gzip \((\d+) B gated, (\d+) B served/.exec(out);
  return { code: res.status, out, headroom, gated, served, stripped, overBy: Number(refused?.[1]), refusedGated: Number(refusedGated?.[1]), refusedServed: Number(refusedGated?.[2]) };
}

describe('check-bundle-budget: the entry is gated on hash-normalized gzip', () => {
  it('two builds of the same code with different chunk hashes get the same verdict', () => {
    const a = build('one');
    const b = build('two');
    expect(a.code, a.out).toBe(0);
    expect(b.code, b.out).toBe(0);
    expect(a.served, 'the fixture must actually exhibit hash luck, or this proves nothing').not.toBe(b.served);
    expect(a.headroom, 'same code, same headroom').toBe(b.headroom);
    expect(a.gated).toBe(b.gated);
  });

  it('the gated size stands in for the hashes, it does not strip them', () => {
    const a = build('three');
    expect(a.gated - a.stripped, 'hash entropy is still counted').toBeGreaterThan(CHUNKS * 3);
    expect(Math.abs(a.gated - a.served), 'close to what ships').toBeLessThan(a.served * 0.02);
    expect(a.out).toMatch(new RegExp(`served ${a.served} B`));
  });

  it('an over-budget entry is refused by the same margin in both builds', () => {
    const a = build('four', OVER_BUDGET_PAD);
    const b = build('five', OVER_BUDGET_PAD);
    expect(a.code, a.out).toBe(1);
    expect(b.code, b.out).toBe(1);
    expect(a.refusedServed, a.out).toBe(a.served);
    expect(a.served, 'the fixture must actually exhibit hash luck').not.toBe(b.served);
    expect(a.refusedGated, a.out).toBeGreaterThan(129 * 1024);
    expect(a.refusedGated, 'same code, same gated size').toBe(b.refusedGated);
    expect(a.overBy, a.out).toBeGreaterThan(0);
    expect(a.overBy, 'same code, same margin').toBe(b.overBy);
  });
});
