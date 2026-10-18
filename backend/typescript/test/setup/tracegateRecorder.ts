/**
 * ADR 0880 — Tracegate recorder for the backend lane. Loaded ONLY when
 * `OPENWOP_TRACEGATE_RECORD=<dir>` is set (vitest.config.ts); unset, it is never
 * imported. The recorder itself is shared with the frontend lane and documented
 * in scripts/lib/tracegate-recorder.mjs.
 */
import path from 'node:path';
import { afterAll, expect } from 'vitest';
import { installRecorder } from '../../../../scripts/lib/tracegate-recorder.mjs';

await installRecorder({
  afterAll,
  expect,
  repoRoot: path.resolve(import.meta.dirname, '..', '..', '..', '..'),
  laneDir: 'backend/typescript',
});
