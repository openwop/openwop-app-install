/**
 * ADR 0655 D4 (EMWF-4 / EMWF-14) — `feature.email.nodes` are READS: classified as
 * such, NOT in the side-effect floor, NOT fast-path served (they re-execute on a
 * fork and re-read live templates — the old docblock claimed the opposite), the
 * feature pin equals the manifest version, the one consumer chain expands
 * byte-identically, and a missing `orgId` is a TYPED refusal at the surface, never
 * success-with-empty (the ANLWF-2 class ADR 0651 D2 closed for analytics).
 *
 * Sabotage-witnessed (grade-tests w9): `role:"action"` in pack.json reds leg 1; adding an
 * id to MANIFEST_FAST_PATH_SERVED reds legs 2–3, to the floor reds leg 2; a matching
 * SIDE_EFFECTING_TYPE_PATTERNS entry reds leg 3; a stale pin reds leg 4; a random field
 * in `expandedFrom` reds leg 5; coercing any surface `orgId` to '' reds leg 6.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED, MANIFEST_DECLARED_TYPE_IDS } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';
import { loadWorkflowChainPacks, getChain, expandChain, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { buildEmailSurface } from '../src/features/email/surface.js';
import { pinnedPackRef } from '../src/features/packPins.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PM = JSON.parse(readFileSync(join(REPO, 'packs', 'feature.email.nodes', 'pack.json'), 'utf8')) as {
  version: string;
  nodes: { typeId: string; role: string; capabilities?: string[] }[];
};
const READS = ['feature.email.nodes.list-templates', 'feature.email.nodes.get-template', 'feature.email.nodes.render'];

describe('ADR 0655 D4 — feature.email.nodes are honest reads', () => {
  it('leg 1: the manifest declares role:read for all three (was "action" over three pure reads)', () => {
    const byId = new Map(PM.nodes.map((n) => [n.typeId, n]));
    for (const r of READS) { expect(byId.get(r)?.role, r).toBe('read'); expect(byId.get(r)?.capabilities ?? []).not.toContain('side-effectful'); }
  });
  it('leg 2: none is in the floor, none is served, all three are declared', () => {
    for (const r of READS) {
      expect(MANIFEST_SIDE_EFFECT_FLOOR.has(r), `${r} is not a side effect`).toBe(false);
      expect(MANIFEST_FAST_PATH_SERVED.has(r), `${r} is NOT replay-served (the old docblock lied)`).toBe(false);
      expect(MANIFEST_DECLARED_TYPE_IDS.has(r), `${r} is declared`).toBe(true);
    }
  });
  it('leg 3: isSideEffectingNode says false for all three', () => {
    for (const r of READS) expect(isSideEffectingNode(r)).toBe(false);
  });
  it('leg 4: the email feature pin equals the manifest version', () => {
    const feature = readFileSync(join(REPO, 'backend', 'typescript', 'src', 'features', 'email', 'feature.ts'), 'utf8');
    expect(feature).toContain(`'feature.email.nodes'`);
    expect(pinnedPackRef('feature.email.nodes').version, 'the pin (features/packPins.ts, ADR 0919) must match the manifest').toBe(PM.version);
  });
  it('leg 5: expandChain of marketing.content-repurposing (the one consumer) is BYTE-IDENTICAL across two builds', () => {
    _resetChainRegistryForTest();
    const { errors } = loadWorkflowChainPacks({ roots: [join(REPO, 'examples', 'workflow-chain-packs')] });
    expect(errors, 'the packs must load cleanly — otherwise this leg is vacuous').toEqual([]);
    const entry = getChain('marketing.content-repurposing');
    expect(entry, 'the consumer chain must be present').toBeTruthy();
    const params = { orgId: 'o1', templateId: 't1' } as Record<string, unknown>;
    const a = JSON.stringify(expandChain(entry!.chain, { params }));
    const b = JSON.stringify(expandChain(entry!.chain, { params }));
    expect(a).toBe(b);
    expect(a).toContain('feature.email.nodes.render');
  });
  it('leg 6 (D4): a missing orgId is a TYPED refusal at the surface, never success-with-empty', async () => {
    const surface = buildEmailSurface({ tenantId: 'tEmailNodes' });
    // templateId is SUPPLIED so the orgId check is the only refusal on the path — without it,
    // getTemplate/render refused on the missing templateId and the orgId leg could not fail
    // (grade-tests w9 probes nr-org-get / nr-org-render were vacuous).
    for (const name of ['listTemplates', 'getTemplate', 'render'] as const) {
      const fn = surface[name];
      expect(fn, `${name} is on the surface`).toBeTypeOf('function');
      await expect(fn!({ templateId: 't1' }), `${name}({templateId}) without orgId must refuse`).rejects.toMatchObject({ code: 'validation_error' });
      await expect(fn!({ orgId: '', templateId: 't1' }), `${name}({orgId:''}) must refuse`).rejects.toMatchObject({ code: 'validation_error' });
    }
  });
});
