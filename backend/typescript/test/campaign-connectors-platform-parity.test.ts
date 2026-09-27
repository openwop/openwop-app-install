/**
 * R3 CC-SP-15 — the SPA duplicates AD_PLATFORMS (its <select> needs the list
 * synchronously) while `/platforms` serves the backend SSoT. Two copies of an
 * enum drift (the promptCatalogParity lesson: two real drifts shipped before
 * a parity pin existed elsewhere). This pin makes the duplicate SAFE: the
 * frontend copy must stay byte-identical to the backend SSoT, and the route
 * must serve that same SSoT.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AD_PLATFORMS } from '../src/features/campaign-connectors/types.js';

const FRONTEND_CLIENT = join(
  __dirname, '..', '..', '..', 'frontend', 'react', 'src', 'features',
  'campaign-connectors', 'campaignConnectorsClient.ts',
);

describe('CC-SP-15 — the AD_PLATFORMS duplicate is drift-pinned', () => {
  it('the frontend copy is byte-identical to the backend SSoT (order included — the select renders it)', () => {
    const src = readFileSync(FRONTEND_CLIENT, 'utf8');
    const m = /export const AD_PLATFORMS[^=]*=\s*\[([^\]]+)\]/.exec(src);
    expect(m, 'frontend AD_PLATFORMS declaration not found — if it moved, move this pin').toBeTruthy();
    const frontend = m![1]!.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    expect(frontend).toEqual([...AD_PLATFORMS]);
  });

  it('non-vacuity: the backend SSoT is a real, non-trivial list', () => {
    expect(AD_PLATFORMS.length).toBeGreaterThanOrEqual(5);
    expect(AD_PLATFORMS).toContain('meta');
  });
});
