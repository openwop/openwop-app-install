/**
 * ADR 0820 G2 — a feature surface whose id matches no toggle is UNGATED.
 *
 * `featureSurfaces.gate` skips the access check for a surface id with no
 * registered toggle default (the ADR 0027 always-on rule). So a surface id that
 * differs from its feature's toggle id is silently served to every tenant
 * whatever its toggle or plan says: `ctx.features.commissions` ran ungated while
 * the toggle was `sales-commissions`. This ratchet makes that impossible to
 * reintroduce: every surface id is its OWN feature's toggle id, or is listed as
 * always-on below with the reason it is core.
 *
 * Observed RED against unmodified source: `sales-commissions → surface
 * 'commissions'` was the one offender.
 */
import { describe, expect, it } from 'vitest';
import { BACKEND_FEATURES } from '../src/features/index.js';

function allToggleIds(): Set<string> {
  const ids = new Set<string>();
  for (const f of BACKEND_FEATURES) {
    if (f.toggleDefault) ids.add(f.toggleDefault.id);
    for (const t of f.extraToggleDefaults ?? []) ids.add(t.id);
  }
  return ids;
}

/**
 * Surfaces with NO toggle: `featureSurfaces.gate` serves them unconditionally.
 * Each entry is a decision that the surface is core (never sold), with its
 * reason. A surface id that is neither a toggle id nor listed here is the
 * `commissions` defect — a paid surface silently read as always-on.
 */
const ALWAYS_ON_SURFACES: Record<string, string> = {
  'agent-knowledge': 'graduated to always-on (feature header); per-agent knowledge binding is core agent substrate',
  assistant: 'graduated always-on (ADR 0010/0024); the assistant is core chat substrate',
  brand: 'graduated to core (ADR 0170); brand voice feeds every authoring surface',
  cms: 'graduated always-on (ADR 0027); pages are content-kernel rows',
  goals: 'always-on, no toggle; goals are core workspace planning',
  kb: 'core always-on KB; no paid toggle exists (lapse de-index is workstream F)',
  media: 'the media library is core asset storage for every feature',
  notifications: 'in-app notifications are core',
  profiles: 'user profiles are identity substrate',
  prompts: 'the prompt library is core chat substrate',
  tutorials: 'always-on so tutorials can teach features a workspace may not have',
  users: 'user records are identity substrate',
  'workflow-author': 'graduated always-on (2026-06-19); authoring workflows is core',
};

describe('G2 — every feature surface id is a toggle id or a declared always-on surface', () => {
  it('no surface is ungated by an id that matches no toggle', () => {
    const toggles = allToggleIds();
    const offenders: string[] = [];
    for (const f of BACKEND_FEATURES) {
      const id = f.surface?.id;
      if (!id) continue;
      if (toggles.has(id)) continue;
      if (ALWAYS_ON_SURFACES[id]) continue;
      offenders.push(`${f.id} → surface '${id}'`);
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('a surface that HAS a toggle uses its OWN feature\'s toggle, not a sibling\'s', () => {
    const toggles = allToggleIds();
    for (const f of BACKEND_FEATURES) {
      const id = f.surface?.id;
      if (!id || !toggles.has(id)) continue;
      const own = new Set([f.toggleDefault?.id, ...(f.extraToggleDefaults ?? []).map((t) => t.id)].filter(Boolean));
      expect(own.has(id), `${f.id}: surface '${id}' is gated on a toggle this feature does not own`).toBe(true);
    }
  });

  it('every always-on entry is still a registered surface with no toggle (no stale exemptions)', () => {
    const toggles = allToggleIds();
    const surfaces = new Set(BACKEND_FEATURES.map((f) => f.surface?.id).filter(Boolean));
    for (const id of Object.keys(ALWAYS_ON_SURFACES)) {
      expect(surfaces.has(id), `always-on '${id}' is not a registered surface`).toBe(true);
      expect(toggles.has(id), `always-on '${id}' now has a toggle — remove the exemption so it is gated`).toBe(false);
    }
  });
});
