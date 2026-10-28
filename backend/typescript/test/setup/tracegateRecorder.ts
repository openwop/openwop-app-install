/**
 * ADR 0880 — Tracegate recorder for the backend lane. Loaded ONLY when
 * `OPENWOP_TRACEGATE_RECORD=<dir>` is set (vitest.config.ts); unset, it is never
 * imported. The recorder itself is shared with the frontend lane and documented
 * in scripts/lib/tracegate-recorder.mjs.
 *
 * ADR 0968 P2: the boot digest is loaded only when `OPENWOP_TRACEGATE_BOOT=1`
 * (the daemon's runs; a gate never loads it). It imports no src module (it reads
 * the registries this file's boot already evaluated), so loading it changes no
 * test's module graph; the recorder leaves it out of every footprint.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, expect } from 'vitest';
import { installRecorder } from '../../../../scripts/lib/tracegate-recorder.mjs';

const bootDigest = process.env.OPENWOP_TRACEGATE_BOOT === '1'
  ? (await import('../support/tracegateBootDigest.js')).bootDigest
  : undefined;

const srcDir = path.resolve(import.meta.dirname, '..', '..', 'src');
// The registry lookup below reads vitest's module-runner state, an internal. It
// is verified on this version only: any other makes every registry part of the
// digest an error (loud in the shadow log), never a silently wrong digest.
const VITEST_VERIFIED = '4.1.11';
const vitestVersion = (createRequire(import.meta.url)('vitest/package.json') as { version: string }).version;
await installRecorder({
  afterAll,
  expect,
  repoRoot: path.resolve(import.meta.dirname, '..', '..', '..', '..'),
  laneDir: 'backend/typescript',
  // Registries come from the modules this file already evaluated (vitest's
  // module runner keeps them on the worker state), so the digest imports nothing.
  bootDigest: bootDigest && ((app: unknown) => bootDigest(app as never, (rel) => {
    if (vitestVersion !== VITEST_VERIFIED) throw new Error(`vitest ${vitestVersion}: module lookup verified only on ${VITEST_VERIFIED}`);
    const file = path.join(srcDir, `${rel}.ts`);
    const runner = (globalThis as { __vitest_worker__?: { evaluatedModules?: { getModulesByFile(f: string): Set<{ evaluated: boolean; exports?: unknown }> | undefined } } }).__vitest_worker__?.evaluatedModules;
    if (!runner) throw new Error('no vitest module runner state');
    const node = [...(runner.getModulesByFile(file) ?? [])].find((n) => n.evaluated && n.exports);
    if (!node) throw new Error(`not loaded: ${rel}`);
    return node.exports;
  })),
  bootDigestFile: 'backend/typescript/test/support/tracegateBootDigest.ts',
});
