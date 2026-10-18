/**
 * ADR 0641 decision 12 + test-plan item 6 — the public-route toggle contract.
 *
 * The ADR marks this guard SABOTAGE-FIRST, and the reason is specific rather
 * than ritual: this guard's entire purpose is to catch a declaration that would
 * otherwise be **green and meaningless**. A public route with a 50% rollout
 * renders fine every single time it is loaded. There is no error, no empty
 * state, no log line — the variant just resolves to something arbitrary and
 * plausible within one session. So a passing guard and an ABSENT guard produce
 * identical observable behaviour, and the only way to tell them apart is to
 * break the thing on purpose and watch it go red.
 *
 * Each case below therefore asserts the THROW and its MESSAGE, not merely a
 * falsy return. A message-pinned assertion is what reports a guard that starts
 * firing for the wrong reason.
 *
 * Sabotage that turns it red (w35 probes): count variants/overrides/percent wrongly;
 * accept a relative path; default an omitted `auth` to optional; stop at the first
 * violation; drop the tier check (the non-site fixtures are `auth:'optional'` with a
 * relative path, so ONLY the tier check spares them); delete the import-time
 * `assertSiteRouteContracts(...)` call in chrome/features.tsx (a violating route
 * injected through the feature registry must fail the manifest AT IMPORT).
 */

import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import {
  assertSiteRouteContract,
  assertSiteRouteContracts,
  SiteRouteContractError,
  type SiteRouteDeclaration,
} from '../siteRouteContract.js';

const publicRoute = (toggle?: SiteRouteDeclaration['toggle']): SiteRouteDeclaration => ({
  path: '/discover',
  tier: 'site',
  auth: 'optional',
  ...(toggle === undefined ? {} : { toggle }),
});

describe('site-route contract: public routes must be binary (ADR 0641 d12)', () => {
  it('accepts a public route with no toggle at all', () => {
    expect(() => assertSiteRouteContract(publicRoute())).not.toThrow();
  });

  it('accepts a public route whose toggle is plainly binary', () => {
    expect(() =>
      assertSiteRouteContract(publicRoute({ rolloutPercentage: 100 })),
    ).not.toThrow();
    expect(() => assertSiteRouteContract(publicRoute({ rolloutPercentage: 0 }))).not.toThrow();
  });

  it('REFUSES variants — the visitor is re-bucketed every session', () => {
    expect(() => assertSiteRouteContract(publicRoute({ variants: ['a', 'b'] }))).toThrow(
      SiteRouteContractError,
    );
    expect(() => assertSiteRouteContract(publicRoute({ variants: ['a', 'b'] }))).toThrow(
      /2 toggle variant\(s\)[\s\S]*per-session random/,
    );
  });

  it('REFUSES variants declared as a record, not just an array', () => {
    // The shape a toggle definition is likeliest to use. A guard that only
    // understood arrays would pass this and measure nothing.
    expect(() =>
      assertSiteRouteContract(publicRoute({ variants: { control: {}, treatment: {} } })),
    ).toThrow(/2 toggle variant\(s\)/);
  });

  it('REFUSES a partial percentage rollout', () => {
    expect(() => assertSiteRouteContract(publicRoute({ rolloutPercentage: 50 }))).toThrow(
      /50% rollout[\s\S]*coin flip/,
    );
  });

  it('REFUSES tenant overrides, and names them', () => {
    expect(() =>
      assertSiteRouteContract(publicRoute({ tenantOverrides: { 'tenant-a': true } })),
    ).toThrow(/1 tenant override\(s\) \(tenant-a\)[\s\S]*can never match/);
  });

  it('permits all three on an auth:required site route — there IS a principal there', () => {
    // The constraint is a consequence of `anon:<sid>`, not a blanket ban. A
    // signed-in site route buckets on a real tenant, so ordinary rollout
    // mechanics are meaningful. A guard that refused here would be over-broad
    // and would push authors away from the tier for the wrong reason.
    const signedIn: SiteRouteDeclaration = {
      path: '/today',
      tier: 'site',
      auth: 'required',
      toggle: { variants: ['a', 'b'], rolloutPercentage: 50, tenantOverrides: { t: 1 } },
    };
    expect(() => assertSiteRouteContract(signedIn)).not.toThrow();
  });

  it('ignores non-site tiers entirely', () => {
    // Relative path + optional posture + partial rollout: every rule would fire on
    // a site route, so only the tier check can let this through.
    const workspace: SiteRouteDeclaration = {
      path: 'crm',
      tier: 'workspace',
      auth: 'optional',
      toggle: { rolloutPercentage: 50 },
    };
    expect(() => assertSiteRouteContract(workspace)).not.toThrow();
  });

  it('defaults a site route with NO auth field to required (fail-closed)', () => {
    // Omission must select the SAFE branch. If the default were 'optional' a
    // forgotten field would silently expose a surface AND silently relax this
    // contract — two failures from one omission.
    const noAuth: SiteRouteDeclaration = {
      path: '/plan',
      tier: 'site',
      toggle: { rolloutPercentage: 50 },
    };
    expect(() => assertSiteRouteContract(noAuth)).not.toThrow();
  });
});

describe('site-route contract: path shape', () => {
  it('REFUSES a relative path', () => {
    expect(() =>
      assertSiteRouteContract({ path: 'today', tier: 'site', auth: 'required' }),
    ).toThrow(/must be absolute/);
  });

  it('REFUSES an empty path', () => {
    expect(() => assertSiteRouteContract({ path: '', tier: 'site' })).toThrow(/must be absolute/);
  });
});

describe('site-route contract: manifest-level reporting', () => {
  it('reports EVERY violation, not just the first', () => {
    // A first-failure-only guard makes a composer fix violations one build at a
    // time, which on a slow gate is the difference between one iteration and four.
    let msg = '';
    try {
      assertSiteRouteContracts([
        publicRoute({ variants: ['a', 'b'] }),
        { path: '/plan', tier: 'site', auth: 'optional', toggle: { rolloutPercentage: 25 } },
        { path: 'relative', tier: 'site' },
      ]);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toMatch(/3 site-route contract violation\(s\)/);
    expect(msg).toMatch(/toggle variant/);
    expect(msg).toMatch(/25% rollout/);
    expect(msg).toMatch(/must be absolute/);
  });

  it('passes a clean manifest', () => {
    expect(() =>
      assertSiteRouteContracts([
        { path: '/today', tier: 'site', auth: 'required' },
        { path: '/discover', tier: 'site', auth: 'optional' },
        { path: 'crm', tier: 'workspace', auth: 'optional', toggle: { rolloutPercentage: 50 } },
      ]),
    ).not.toThrow();
  });
});

describe('ADR 0641 phase 5 — the contract runs at manifest composition', () => {
  it('importing the manifest does not throw', async () => {
    // The assertion is at module scope in chrome/features.tsx, so a violating
    // route fails at IMPORT. This case pins that the REAL manifest is clean; the
    // next case pins that the call is there at all.
    await expect(import('../features.js')).resolves.toBeDefined();
  });

  it('a violating site route injected through the feature registry fails the manifest AT IMPORT', async () => {
    // Without this, deleting the module-scope `assertSiteRouteContracts(...)` call
    // left every case green (w35 probe `src-manifest-call`).
    vi.resetModules();
    vi.doMock('../../features/registry.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../features/registry.js')>();
      return {
        ...real,
        featureRoutes: () => [
          ...real.featureRoutes(),
          { path: 'relative-probe', tier: 'site' as const, auth: 'optional' as const, archetype: 'standard-index' as const, element: createElement('div') },
        ],
      };
    });
    try {
      await expect(import('../features.js')).rejects.toThrow(/site-route contract violation[\s\S]*must be absolute/);
    } finally {
      vi.doUnmock('../../features/registry.js');
      vi.resetModules();
    }
  });

  it('the manifest resolves a site rail', async () => {
    const { FEATURES } = await import('../features.js');
    const site = FEATURES.filter((f) => f.tier === 'site');
    // Site routes ship today (kicktodo*, showcase — ADR 0641), so the rail is
    // NOT empty (the old "zero is correct today" note was stale). The path
    // loop below is a double guard: the import-time contract throws first, so a
    // relative site path reds the import, not this loop (w35 `src-site-relative`).
    expect(site.map((r) => r.path)).toContain('/showcase');
    for (const r of site) {
      expect(r.path.startsWith('/')).toBe(true);
    }
  });
});
