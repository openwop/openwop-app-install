/**
 * ADR 0657 D3 (CNWF-3) — `feature.consent.nodes` classified honestly: `record` is a
 * SIDE EFFECT (floored + served from the recorded outcome on replay/fork — a `:fork`
 * must never re-merge a historical run's consent over current state); `check` is a
 * READ (re-executes; a gate verdict is live by design). The 1.1.0 manifest declared
 * both `role:"action"` with no capability, so NEITHER was in the floor — while the
 * pack docblock and the 2026-08 inventory row claimed both were served. Born red on
 * legs 1–3 and 5 against 1.1.0.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED, MANIFEST_DECLARED_TYPE_IDS } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PM = JSON.parse(readFileSync(join(REPO, 'packs', 'feature.consent.nodes', 'pack.json'), 'utf8')) as {
  version: string;
  nodes: { typeId: string; version: string; role: string; capabilities?: string[] }[];
};
const RECORD = 'feature.consent.nodes.record';
const CHECK = 'feature.consent.nodes.check';

describe('ADR 0657 D3 — feature.consent.nodes classification', () => {
  const byId = new Map(PM.nodes.map((n) => [n.typeId, n]));
  it('leg 1: record is role:side-effect + side-effectful; check is role:read with no capability', () => {
    expect(byId.get(RECORD)?.role).toBe('side-effect');
    expect(byId.get(RECORD)?.capabilities ?? []).toContain('side-effectful');
    expect(byId.get(CHECK)?.role).toBe('read');
    expect(byId.get(CHECK)?.capabilities ?? []).not.toContain('side-effectful');
  });
  it('leg 2: record is floored AND served; check is neither; both are declared', () => {
    expect(MANIFEST_SIDE_EFFECT_FLOOR.has(RECORD), 'record is a side effect').toBe(true);
    expect(MANIFEST_FAST_PATH_SERVED.has(RECORD), 'record is replay-served').toBe(true);
    expect(MANIFEST_SIDE_EFFECT_FLOOR.has(CHECK), 'check is a read').toBe(false);
    expect(MANIFEST_FAST_PATH_SERVED.has(CHECK), 'check re-executes').toBe(false);
    for (const id of [RECORD, CHECK]) expect(MANIFEST_DECLARED_TYPE_IDS.has(id), `${id} declared`).toBe(true);
  });
  it('leg 3: isSideEffectingNode agrees', () => {
    expect(isSideEffectingNode(RECORD)).toBe(true);
    expect(isSideEffectingNode(CHECK)).toBe(false);
  });
  it('leg 4: the manifest and node versions moved together (a reclassification is a pack bump)', () => {
    expect(PM.version).toBe('1.2.0');
    for (const n of PM.nodes) expect(n.version, n.typeId).toBe(PM.version);
  });
  it('leg 5: the consent feature pin equals the manifest version', () => {
    const feature = readFileSync(join(REPO, 'backend', 'typescript', 'src', 'features', 'consent', 'feature.ts'), 'utf8');
    expect(feature).toContain(`{ name: 'feature.consent.nodes', version: '${PM.version}' }`);
  });
  it('leg 6: the pack docblock no longer claims both nodes are served', () => {
    const src = readFileSync(join(REPO, 'packs', 'feature.consent.nodes', 'index.mjs'), 'utf8');
    expect(src).not.toMatch(/Both are role:"action"/);
    expect(src).toMatch(/`check` is role:"read" and RE-EXECUTES/);
  });
});
