/**
 * ADR 1031 P2 (security) — the census ratchet over the FEATURE-extensible security
 * surface: management scopes, activation-only roles, public unauthenticated routes
 * and log reason codes (`BackendFeature.security`, sealed by
 * `features/featureSecurity.ts`).
 *
 * Threat: a feature package (first-party or an adopter's) widening the surface —
 * a new admin scope, a broader operator role, an unauthenticated route, a log
 * value trusted past the PII mask — as a side effect of some other change.
 * Controls, each with a sabotage-witnessed case below:
 *  1. CENSUS: every registered entry, with its owner, must equal the owning
 *     package's committed `security.census.json`. Adding, removing or widening an
 *     entry without the baseline diff is red; the diff is the review surface.
 *  2. COMPOSITION-ONLY: entries come only from composed features' declarations;
 *     every owner is a composed feature.
 *  3. SEALED AT BOOT: any registration after the composer's seal throws.
 *  4. Unregistered public paths stay authenticated (a registered route is public
 *     on a segment boundary only); registered reason codes obey the static format.
 * KickTodo's entries, moved here in P2, left with it in ADR 1031 P3 (#5512),
 * together with their owner's byte-identity test.
 *
 * ADR 1031 round 3 — the census also covers three host tables a feature extends by
 * declaration (`hostContributions`, `host/featureContributions.ts`). Each one widens
 * a security surface:
 *  - a tenant-level KB namespace: anyone in the tenant can recall it;
 *  - a managed KB source and its plan owner: `null` means not plan-gated;
 *  - a pure compute node projected as a live agent tool: a new tool the model can
 *    call.
 * Their lines (`featureHostTableSurface()`) sit in the same baseline. No RFC is
 * needed: all three tables are host-internal and change no event, endpoint,
 * capability or schema.
 *
 * Steady state in openwop-app (since #5512): no composed feature declares a
 * security entry or a round-3 host-table entry, and no `security.census.json`
 * exists, so both sides of control 1 are empty. What still goes red here:
 * control 1 on any NEW entry (a feature declaring a log code with no baseline, a
 * host-table line with no baseline), all of control 3 (each seal, the double
 * seal, nothing leaked), control 4's two negative checks (an unregistered route,
 * an unregistered code), and case 5's feature-root check (with a wrong root,
 * control 1 compares [] with [] and stays green). Control 4's per-entry loops
 * (segment boundary, registered codes) and control 2 run over empty lists: they
 * are live only in a checkout whose features declare entries. Control 2 is also
 * implied by control 1 plus case 5. Ceiling B†: a stub-feature case that makes
 * those loops live upstream is new coverage, a human ask (TST-GMA-H1, ex
 * TST-GHF-2), so it is not written here.
 *
 * Sabotage-witnessed (w90, 2026-11-06): a kb feature declaring a log code, an
 * extra host-table line, an uncomposed owner, each of the four seals and the
 * double seal disabled, a catch-all feature public route, a format-only reason
 * code check, and a wrong feature root each red the matching control. Making the
 * segment match a bare prefix stays green (no registered route: TST-GMA-H1).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { featureSecuritySurface, sealFeatureSecurity } from '../src/features/featureSecurity.js';
import { recordFeatureActivationRole, recordFeatureAdminScope } from '../src/host/featureScopes.js';
import { isPublicPath } from '../src/middleware/auth.js';
import { recordFeaturePublicRoute } from '../src/middleware/featurePublicRoutes.js';
import { LOG_REASON_CODE_FORMAT, isLogReasonCode, recordFeatureLogReasonCode } from '../src/observability/logReasonCodes.js';
import { featureSourceRoots } from './helpers/featureSourceRoots.js';
import { featureHostTableSurface } from '../src/host/featureContributions.js';

/** P2's security surface ∪ the round-3 host-table declarations. */
const surface = (): Array<{ featureId: string; entry: string }> => [...featureSecuritySurface(), ...featureHostTableSurface()];

const SRC = join(__dirname, '..', 'src');

/** feature dir → its committed baseline entries (both feature roots). */
function baselines(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const root of featureSourceRoots()) {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      const f = join(root, d.name, 'security.census.json');
      if (d.isDirectory() && existsSync(f)) out.set(d.name, (JSON.parse(readFileSync(f, 'utf8')) as { entries: string[] }).entries);
    }
  }
  return out;
}

describe('feature security census (ADR 1031 P2)', () => {
  it('control 1 — every registered entry equals its package baseline, both ways', () => {
    const live = new Map<string, string[]>();
    for (const { featureId, entry } of surface()) live.set(featureId, [...(live.get(featureId) ?? []), entry]);
    const base = baselines();
    for (const id of new Set([...live.keys(), ...base.keys()])) {
      expect([...(live.get(id) ?? [])].sort(), `${id}: registered entries ≠ ${id}/security.census.json — update the baseline in the same change (that diff is the review)`).toEqual([...(base.get(id) ?? [])].sort());
    }
    // Both sides are the same size. In openwop-app since #5512 this is 0 = 0; the
    // per-id comparison above is what reds a new entry.
    expect(surface().length).toBe([...base.values()].reduce((n, e) => n + e.length, 0));
  });

  it('control 2 — every owner is a composed feature', () => {
    const composed = new Set(BACKEND_FEATURES.filter(Boolean).map((f) => f.id));
    expect(surface().filter((e) => !composed.has(e.featureId))).toEqual([]);
  });

  it('control 3 — registration is closed after the composer seals', () => {
    expect(() => recordFeatureAdminScope('late', 'host:late:manage')).toThrow(/registration is closed/);
    expect(() => recordFeatureActivationRole({ featureId: 'late', id: 'late-op', name: 'x', description: 'x', workspaceId: 'host-late', scopes: [] })).toThrow(/registration is closed/);
    expect(() => recordFeaturePublicRoute('late', '/public/late/hook')).toThrow(/registration is closed/);
    expect(() => recordFeatureLogReasonCode('late', 'late_code')).toThrow(/registration is closed/);
    expect(() => sealFeatureSecurity([])).toThrow(/sealed twice/);
    // …and nothing late leaked in.
    expect(isPublicPath('/public/late/hook')).toBe(false);
    expect(isLogReasonCode('late_code')).toBe(false);
  });

  it('control 4 — an unregistered public path is NOT public; registered codes keep the static format', () => {
    for (const e of featureSecuritySurface().filter((x) => x.entry.startsWith('public-route '))) {
      const route = e.entry.slice('public-route '.length);
      expect(isPublicPath(route), route).toBe(true);
      expect(isPublicPath(`${route}/tok123`), `${route}/…`).toBe(true);
      // Segment boundary: a longer sibling segment is NOT covered by the prefix.
      expect(isPublicPath(`${route}x`), `${route}x`).toBe(false);
    }
    expect(isPublicPath('/public/unregistered/route')).toBe(false);
    for (const e of featureSecuritySurface().filter((x) => x.entry.startsWith('log-reason-code '))) {
      const code = e.entry.slice('log-reason-code '.length);
      expect(code).toMatch(LOG_REASON_CODE_FORMAT);
      expect(isLogReasonCode(code)).toBe(true);
    }
    expect(isLogReasonCode('fixture_not_a_code')).toBe(false);
  });

  it('baselines live only in composed feature directories', () => {
    const composedDirs = new Set(BACKEND_FEATURES.filter(Boolean).map((f) => f.id));
    expect([...baselines().keys()].filter((d) => !composedDirs.has(d))).toEqual([]);
    expect(relative(SRC, featureSourceRoots()[0]!).split(sep).join('/')).toBe('features');
  });
});
