/**
 * ADR 0446 — the feature-dependency classifier (`scripts/gen-feature-deps.mjs`).
 *
 * The classifier's three-way split ([1] primitive / [2] soft-read / [3] hard-dep) is
 * the load-bearing decision the whole ADR rests on: [1] gets a seam, [3] gets a lock,
 * [2] gets left alone. A regression that silently re-classified a soft-read as a
 * hard-dep would resurrect the phantom-lock anti-pattern ADR 0439 removed, so the
 * counts and the known anchors are pinned here.
 */
import { describe, it, expect } from 'vitest';
// The generator is ESM at the repo root; import it directly.
import { computeEdges, textGatesOwnToggle } from '../../../scripts/gen-feature-deps.mjs';

describe('ADR 0446 feature-dependency classifier', () => {
  const { edges } = computeEdges();
  const undeclaredToggleable = edges.filter((e) => !e.declared && e.toggleable);
  const cat = (n: number) => undeclaredToggleable.filter((e) => e.category === n);

  it('classifies every undeclared→toggleable edge into exactly one of [1]/[2]/[3]', () => {
    for (const e of undeclaredToggleable) expect([1, 2, 3]).toContain(e.category);
    expect(cat(1).length + cat(2).length + cat(3).length).toBe(undeclaredToggleable.length);
  });

  it('[2] soft-reads dominate — the finding that makes "declare them all" wrong', () => {
    // If this inverts (most edges become hard-deps), the ADR's core premise broke;
    // investigate the per-target service-gate scan before touching dependsOn anywhere.
    expect(cat(2).length).toBeGreaterThan(cat(1).length);
    expect(cat(2).length).toBeGreaterThan(cat(3).length * 10);
  });

  it('[1] primitives: ZERO remain — the program extracted the ONE (entitlement, D.1)', () => {
    // The whole "move shared code to core" ask yielded exactly one clean extraction
    // (entitlement, which already had a host seam). Per-edge review reclassified every
    // other candidate as intended coupling / domain integration / compliance-protective.
    expect(cat(1).length).toBe(0);
  });

  it('the reclassified candidates are [2], not [1] (the program\'s core finding)', () => {
    const isCat = (a: string, b: string, c: number) => cat(c).some((e) => e.a === a && e.b === b);
    expect(isCat('crm', 'forms', 2)).toBe(true);       // D.3 submissionSinks — ADR 0330 inversion
    expect(isCat('cdp', 'analytics', 2)).toBe(true);   // D.3 identityLink — analytics owns sessions
    expect(isCat('commerce', 'email', 2)).toBe(true);  // D.4 brokeredProvider — email domain adapter
    expect(isCat('email', 'consent', 2)).toBe(true);   // D.2 consent — compliance-protective, don't extract
    // ADR 0446 F, target-level (2026-08-18): #3326 put ONE resolveOne('email') inside
    // emailService's CRM merge-lifecycle SUBSCRIBER (a relink work-avoidance gate); the
    // exported surface stays ungated, so every inbound email edge is soft. Without the
    // SUBSCRIBER_ONLY_GATE entry these six flip to [3] and this + the [3]==0 test go red
    // (measured 2026-08-18: `expected 6 to be +0`).
    for (const a of ['analytics', 'campaign-intel', 'campaign-journeys', 'commerce', 'crm', 'orgs']) {
      expect(isCat(a, 'email', 2)).toBe(true);
    }
    const crmEmail = cat(2).find((e) => e.a === 'crm' && e.b === 'email');
    expect(crmEmail?.disposition).toContain('merge-lifecycle subscriber');
  });

  it('a genuine domain read of a vacuous-when-off target is [2], never a lock', () => {
    // crm's service does not gate on the crm toggle, so cdp reading contacts is soft —
    // declaring it would be a phantom lock. (commerce→crm is already DECLARED, so it
    // isn't in the undeclared set; cdp→crm is the honest undeclared example.)
    const cdpCrm = undeclaredToggleable.find((e) => e.a === 'cdp' && e.b === 'crm');
    expect(cdpCrm?.category).toBe(2);
  });

  it('[3] hard-deps: ZERO — the one apparent hit was a file-vs-symbol false positive (ADR 0446 F)', () => {
    // service-desk→whatsapp LOOKED [3] (whatsappService self-gates), but service-desk
    // imports the PURE parser extractWaInbound — whatsappService gates only in its SEND
    // path, which service-desk never calls. So it does not break when whatsapp is off.
    // The true hard-dep count is 0: declaring any of these would be a phantom lock.
    expect(cat(3).length).toBe(0);
    const sdWa = undeclaredToggleable.find((e) => e.a === 'service-desk' && e.b === 'whatsapp');
    expect(sdWa?.category).toBe(2);
    expect(sdWa?.disposition).toMatch(/pure parser|SEND path/);
  });

  it('the hard-dep detector sees a CONST-aliased toggle gate, not just a string literal', () => {
    // Guards the ADR 0419 GATE-4 blind spot: a service that gates via
    // `const TOGGLE_ID = 'x'; resolveOne(TOGGLE_ID, …)` must count as hard, or a real
    // hard dep would be silently mis-classified as a soft [2] and hidden. No such
    // service exists today, so this exercises the DETECTOR on synthetic text.
    expect(textGatesOwnToggle(`const x = await resolveOne('wa', s);`, 'wa')).toBe(true); // literal
    expect(textGatesOwnToggle(`const TOGGLE_ID = 'wa';\nawait resolveOne(TOGGLE_ID, s);`, 'wa')).toBe(true); // const-hop
    expect(textGatesOwnToggle(`await resolveOne('other', s);`, 'wa')).toBe(false); // another feature's toggle
    expect(textGatesOwnToggle(`export const x = 1;`, 'wa')).toBe(false); // no gate at all
  });
});
