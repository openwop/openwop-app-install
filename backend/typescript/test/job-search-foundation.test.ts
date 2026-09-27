/**
 * ADR 0539 D0 — ONE package, ONE toggle, ONE sellable bundle.
 *
 * The honesty consequence the ADR names: the moment the bundle is priced,
 * `job-search` must genuinely fail closed for a workspace that has not bought
 * it. A toggle that is merely *declared* off but gates nothing would sell an
 * entitlement the host does not enforce.
 *
 * These assert the STRUCTURE that makes that true, since the four-toggle split
 * this replaced would have made the vertical partially purchasable.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { jobSearchFeature } from '../src/features/job-search/feature.js';
import { JOB_SEARCH_TOGGLE } from '../src/features/job-search/service.js';
import { ACKNOWLEDGED_UNSEEDED } from '../src/host/seedCoverage.js';

interface Catalog { core: string[]; bundles: Record<string, { label?: string; features: string[] }> }
const catalog = (): Catalog =>
  JSON.parse(readFileSync(join(process.cwd(), '..', '..', 'distributions', 'bundles.json'), 'utf8')) as Catalog;

describe('ADR 0539 — the job-search vertical is one gated, sellable thing', () => {
  it('registers exactly ONE feature, not four', () => {
    const ids = BACKEND_FEATURES.filter((f) => f.id.startsWith('job')).map((f) => f.id);
    expect(ids, 'a second job-* feature id would make the vertical partially purchasable').toEqual([
      JOB_SEARCH_TOGGLE,
    ]);
  });

  it('is default OFF and bucketed per tenant', () => {
    // Per-USER bucketing would let one member of a paying workspace see the
    // vertical and another not — incoherent for a per-workspace purchase.
    expect(jobSearchFeature.toggleDefault?.status).toBe('off');
    expect(jobSearchFeature.toggleDefault?.bucketUnit).toBe('tenant');
  });

  it('the bundle contains EXACTLY the one feature id', () => {
    const c = catalog();
    expect(c.bundles['job-search']?.features).toEqual([JOB_SEARCH_TOGGLE]);
  });

  it('is bundled and therefore entitlement-gated — never core', () => {
    // `isSellableBundleFeature` reads bundle membership to decide whether a
    // feature is entitlement-gated. A feature in `core` is free by definition,
    // so being in both would price something that cannot gate.
    const c = catalog();
    expect(c.core, 'a core feature is free — it cannot also be sold').not.toContain(JOB_SEARCH_TOGGLE);
    const bundled = new Set(Object.values(c.bundles).flatMap((b) => b.features));
    expect(bundled.has(JOB_SEARCH_TOGGLE)).toBe(true);
  });

  it('declares CRM as a hard dependency and computer-use as NOT one', () => {
    // An application IS a deal (D1) — without CRM there is no pipeline. But
    // `computer-use` absent must DEGRADE (manual-entry applications), not fail,
    // so a disable-lock on it would misrepresent the design.
    expect(jobSearchFeature.dependsOn).toContain('crm');
    expect(jobSearchFeature.dependsOn ?? [], 'computer-use is optional by design').not.toContain('computer-use');
  });

  it('declares no pack it does not ship', () => {
    // Originally this asserted the pack was ABSENT (it arrived at ADR 0540 P4).
    // The general rule is stronger and survives the phase: every declared pack
    // must exist on disk, since a declared-but-missing pack fails validation at
    // boot — the phase-ordering trap this guards.
    const repoRoot = join(process.cwd(), '..', '..');
    for (const p of jobSearchFeature.requiredPacks ?? []) {
      expect(existsSync(join(repoRoot, 'packs', p.name)), `declared pack ${p.name} does not exist on disk`).toBe(true);
      const manifest = JSON.parse(readFileSync(join(repoRoot, 'packs', p.name, 'pack.json'), 'utf8')) as { name: string; version: string };
      expect(manifest.name).toBe(p.name);
      expect(manifest.version, 'declared version must match the shipped manifest').toBe(p.version);
    }
  });

  it('the demo-seed acknowledgement EXPIRES the moment this package gains a store', () => {
    // A recorded disposition decays: the seed-coverage acknowledgement says
    // "this package persists nothing", which is true today and becomes FALSE at
    // ADR 0540 P1 (the job-digest store). Rather than trust a future session to
    // remember, pin the residue — the moment a `DurableCollection` appears under
    // features/job-search/, this fails and forces the call to be re-made.
    const dir = join(process.cwd(), 'src', 'features', 'job-search');
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((e) => {
        const f = join(d, e);
        return statSync(f).isDirectory() ? walk(f) : f.endsWith('.ts') ? [f] : [];
      });
    expect(existsSync(dir), 'the package moved — this guard is now vacuous').toBe(true);
    const persists = walk(dir).filter((f) => /new DurableCollection|hostExtKv|storage\.(put|set)\b/.test(readFileSync(f, 'utf8')));
    if (persists.length > 0) {
      expect(
        ACKNOWLEDGED_UNSEEDED[JOB_SEARCH_TOGGLE],
        `job-search now persists (${persists.map((f) => f.split('/').pop()).join(', ')}) — ` +
          'the "persists nothing" acknowledgement is now FALSE. Ship a demo seeder and remove it.',
      ).toBeUndefined();
    } else {
      expect(ACKNOWLEDGED_UNSEEDED[JOB_SEARCH_TOGGLE], 'storeless ⇒ must stay acknowledged').toBeDefined();
    }
  });

  it('advertises ONLY the modules that exist — in BOTH directions', () => {
    // `/status` listed all six PLANNED modules while only `domain` existed:
    // "advertise only what is honored", broken on a host-extension surface.
    // Pinned in both directions so the advert can neither outrun the tree nor
    // silently lag it when a module lands.
    const src = readFileSync(join(process.cwd(), 'src', 'features', 'job-search', 'routes.ts'), 'utf8');
    const declared = (/const MODULES = \[([^\]]*)\]/.exec(src)?.[1] ?? '')
      .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
    const onDisk = readdirSync(join(process.cwd(), 'src', 'features', 'job-search'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== '__tests__')
      .map((e) => e.name).sort();
    expect(declared.length, 'the advert is empty — the regex broke, so this assertion is vacuous').toBeGreaterThan(0);
    expect(declared, 'the /status advert and the module directories disagree').toEqual(onDisk);
  });
});
