/**
 * A v2 family record's `witness` is the record's one corpus-derived field: it
 * MUST equal `spec/v2/declaration.json`'s for the same family. Seven records
 * disagreed (MEASURED 2026-10-03) while every advert-validation test passed,
 * because the schema admits any of the five witness values; only the
 * declaration says which one is TRUE.
 *
 * The fix stamps the witness from the declaration at assembly
 * (`routes/discovery.ts` `stampDeclaredWitness`). Sabotage: 8fw4g1-wt-stamp (stamp a
 * constant) and 8fw4g1-wt-off (skip the stamp) both turn this red.
 */
import { describe, expect, it } from 'vitest';
import { buildV2Advertisement } from '../src/routes/discovery.js';
import { declaration } from '../src/host/specDeclaration.js';
import type { AppConfig } from '../src/index.js';

const CONFIG: AppConfig = { port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false };

describe('v2 family witness = the declaration', () => {
  it('every advertised family that the declaration lists carries the declared witness', () => {
    const doc = buildV2Advertisement(CONFIG) as Record<string, unknown>;
    const declared = new Map((declaration().families ?? []).map((f) => [String((f as { key?: unknown }).key), String((f as { witness?: unknown }).witness)]));
    const checked: string[] = [];
    const wrong: string[] = [];
    for (const [key, rec] of Object.entries(doc)) {
      const w = declared.get(key);
      if (!w || !rec || typeof rec !== 'object' || !('witness' in rec)) continue;
      checked.push(key);
      if ((rec as { witness: unknown }).witness !== w) wrong.push(`${key}: ${(rec as { witness: unknown }).witness} ≠ ${w}`);
    }
    // Non-vacuity: the seven that drifted are among those checked.
    expect(checked).toEqual(expect.arrayContaining(['idempotency', 'replay', 'interrupt', 'eventLog', 'forms', 'compensation', 'packs']));
    expect(wrong).toEqual([]);
  });
});
