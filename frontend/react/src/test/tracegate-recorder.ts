/**
 * ADR 0880 — Tracegate recorder for the frontend lane. Loaded ONLY when
 * `OPENWOP_TRACEGATE_RECORD=<dir>` is set (vitest.config.ts); unset, it is never
 * imported. The recorder is shared with the backend lane and documented in
 * scripts/lib/tracegate-recorder.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, expect } from 'vitest';
import { installRecorder } from '../../../../scripts/lib/tracegate-recorder.mjs';

// Under jsdom `import.meta.url` is an http:// URL, so the repo root comes from
// `import.meta.dirname` where vitest provides it, else from the lane's cwd —
// and is VERIFIED either way, never assumed.
const candidates = [
  import.meta.dirname ? path.resolve(import.meta.dirname, '..', '..', '..', '..') : '',
  path.resolve(process.cwd(), '..', '..'),
];
const repoRoot = candidates.find((c) => c && fs.existsSync(path.join(c, 'scripts', 'lib', 'tracegate-recorder.mjs')));
if (!repoRoot) throw new Error('tracegate recorder: cannot locate the repo root from ' + candidates.join(' or '));

await installRecorder({
  afterAll,
  expect,
  repoRoot,
  laneDir: 'frontend/react',
});
