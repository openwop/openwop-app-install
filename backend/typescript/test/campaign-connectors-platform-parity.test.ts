/**
 * R3 CC-SP-15 — the SPA duplicates AD_PLATFORMS (its <select> needs the list
 * synchronously) while `/platforms` serves the backend SSoT. Two copies of an
 * enum drift (the promptCatalogParity lesson: two real drifts shipped before
 * a parity pin existed elsewhere). This pin makes the duplicate SAFE: the
 * frontend copy must stay byte-identical (order included) to the backend SSoT.
 * The `/platforms` route serving that SSoT is STRUCTURAL (`routes.ts` responds
 * with the imported `AD_PLATFORMS` constant) and is not asserted here.
 *
 * Sabotage that turns it red: reorder, add or drop an entry in EITHER copy.
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
    // Non-vacuity: the regex parsed a real, non-trivial list (not a stray fragment).
    expect(frontend.length).toBeGreaterThanOrEqual(5);
    expect(frontend).toEqual([...AD_PLATFORMS]);
  });
});
