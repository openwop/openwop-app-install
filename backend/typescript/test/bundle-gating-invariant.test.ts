/**
 * ADR 0419 `priced ⟹ gated` — the STRUCTURAL invariant, statically enforced.
 *
 * ADR 0419 §Correction moved entitlement to ONE central choke inside
 * `requireFeatureEnabled` (`features/featureRoute.ts`), so every feature in a
 * sellable bundle gates automatically. The correction then asserted an audit had
 * found only `crm`/`csm` bypassing that choke with their own `resolveOne` gate.
 * **That audit was wrong**: `cdp` and `destination-sync` bypassed it too, and both
 * are in the sellable `customer-data-platform` bundle — so pricing that bundle
 * would have been a dishonest paywall (buyers pay, non-buyers get it free).
 *
 * Prose invariants rot. This test replaces the audit with a check.
 *
 * ── The predicate (why it keys on the SUBJECT, not on `resolveOne`) ──────────
 * A bundle feature may legitimately resolve its OWN toggle when it serves a
 * PUBLIC, unauthenticated route: the tenant comes from the RESOURCE
 * (`{ tenantId: org.tenantId }`), and the central choke deliberately skips such
 * callers (no `req.principal`) — the ADR 0176 shopper exemption, so a public
 * visitor is never 403'd on the operator's plan. `funnels`, `consent`,
 * `discovery` and `recommendations` all do exactly this and are CORRECT.
 *
 * A BYPASS looks different: it resolves the feature's own toggle with a subject
 * derived from the REQUEST/principal (`subjectOf(req)`), i.e. it is standing in
 * for `requireFeatureEnabled` on an authenticated route — and therefore silently
 * skips the entitlement gate.
 *
 * So the fingerprint is: **own toggle + request-derived subject**. Keying on the
 * mere presence of `resolveOne` would flag the four public helpers above, and
 * "fixing" them would 403 anonymous visitors — a worse bug than the one closed.
 *
 * ── Detection is now AST-based (GATE-4) ──────────────────────────────────────
 * The self-gate fingerprint is detected by a `typescript`-compiler-API walk
 * (`helpers/detectSelfGate.ts`, unit-tested in `detect-self-gate.test.ts`), which
 * closed the three false-negatives the earlier source-text heuristic documented —
 * a subject bound to a variable, an aliased `resolveOne` import, and a wide argument
 * gap. The remaining residual is the OTHER shape:
 *   4. registering routes with NO gate at all — the "forgot entirely" case, which
 *      the request-subject check cannot see (it only finds HAND-ROLLED gates).
 *      **Now covered** by the separate "references SOME gate" invariant below, which
 *      models the canvas-editor factory via the `registerCanvasEditorRoutes` CALL —
 *      so `document-editor`/`slides` register as gated-by-injection with no
 *      name-based exception (the earlier false-positive on `document-editor`).
 *
 * Residual (1)–(3) remain: a source-text heuristic, not a type-aware AST pass.
 *
 * What this check IS: a ratchet against the specific regression that already
 * happened twice (a feature hand-rolling a toggle gate and thereby skipping the
 * entitlement choke). It is not a proof of universal gating, and the route-level
 * cases in `entitlement-central-gate.test.ts` are what actually prove enforcement.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { detectRequestSubjectSelfGate } from './helpers/detectSelfGate.js';
import { join } from 'node:path';
import { bundleForPrice } from '../src/features/billing/billingService.js';
import { knownBundleIds } from '../src/host/featureBundles.js';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const FEATURES_DIR = join(import.meta.dirname, '../src/features');

interface Catalog { core: string[]; bundles: Record<string, { features: string[] }> }
const catalog = (): Catalog =>
  JSON.parse(readFileSync(join(REPO_ROOT, 'distributions/bundles.json'), 'utf8')) as Catalog;

/**
 * Features exempt from the bypass rule, each with the reason it is safe.
 * An entry here is a claim that the feature gates by some OTHER honest means.
 */
const BYPASS_ALLOWLIST: Record<string, string> = {
  // `crm` and `csm` roll their own toggle gate but apply the entitlement check
  // EXPLICITLY per-choke — the pre-central-gate pattern ADR 0419 R2/P3 established.
  // The entitlement call is now the HOST SEAM (`checkEntitlement`, ADR 0446 D.1) rather
  // than a direct `requireEntitledFeature` import from billing; both are honest explicit
  // gating (`checkEntitlement` calls the billing-registered `requireEntitledFeature`).
  // An allowlist entry is NOT a free pass: the test below proves each of these actually
  // gates entitlement via ONE of the two symbols, so it can't wave through an ungated one.
  crm: 'gates entitlement explicitly per-choke via checkEntitlement/requireEntitledFeature (ADR 0419 R2/P3, ADR 0446 D.1)',
  csm: 'gates entitlement explicitly per-choke via checkEntitlement/requireEntitledFeature (ADR 0419 R2/P3, ADR 0446 D.1)',
};

/** Every .ts file under a feature dir (recursive), excluding tests. */
function featureSources(featureId: string): string[] {
  const root = join(FEATURES_DIR, featureId);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) { if (e !== '__tests__') walk(p); continue; }
      if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * Does `featureId` resolve its OWN toggle with a REQUEST-derived subject? (The bypass
 * fingerprint.) GATE-4: this is now an AST walk (`helpers/detectSelfGate.ts`) over the
 * `typescript` compiler API — already a dependency — which closes the three residual
 * false-negatives the prior source-text heuristic documented (a subject bound to a
 * variable, an aliased `resolveOne` import, and an argument gap wider than the regex
 * window). A resource-derived subject (`{ tenantId: org.tenantId }`) stays exempt —
 * the ADR 0176 public-route case. The invariant assertions below (crm/csm MUST be
 * detected; cdp/destination-sync MUST be clean) are the guard against a weakening
 * rewrite.
 */
function hasRequestSubjectSelfGate(featureId: string): { file: string; snippet: string } | null {
  for (const file of featureSources(featureId)) {
    const hit = detectRequestSubjectSelfGate(readFileSync(file, 'utf8'), featureId, file.replace(REPO_ROOT + '/', ''));
    if (hit) return hit;
  }
  return null;
}

describe('ADR 0419 — priced ⟹ gated (structural)', () => {
  const c = catalog();
  const bundleFeatures = Object.entries(c.bundles).flatMap(([bundle, def]) =>
    (def.features ?? []).map((f) => [bundle, f] as const),
  );

  it('every bundle has at least one feature (no empty sellable SKU)', () => {
    for (const [bundle, def] of Object.entries(c.bundles)) {
      expect(def.features?.length ?? 0, `bundle '${bundle}' is empty — an empty SKU can still be priced`).toBeGreaterThan(0);
    }
  });

  it.each(bundleFeatures)('bundle %s: feature %s does not bypass the central entitlement choke', (bundle, feature) => {
    const bypass = hasRequestSubjectSelfGate(feature);
    if (BYPASS_ALLOWLIST[feature]) {
      expect(bypass, `'${feature}' is allowlisted but no longer bypasses — remove the allowlist entry`).not.toBeNull();
      // The allowlist claims this feature gates by an OTHER honest means. Prove it,
      // so an entry can never be used to wave through a genuinely ungated feature.
      // The honest invariant is "gates entitlement explicitly", not the literal fn name:
      // ADR 0446 D.1 moved the call to the host seam (`checkEntitlement`), so accept
      // EITHER symbol as proof. (Same shape as the ADR 0439 phantom-lock fix — the
      // invariant is the intent, not the function name.)
      const gatesExplicitly = featureSources(feature)
        .some((f) => /\bcheckEntitlement\b|\brequireEntitledFeature\b/.test(readFileSync(f, 'utf8')));
      expect(
        gatesExplicitly,
        `'${feature}' is allowlisted as "${BYPASS_ALLOWLIST[feature]}" but gates entitlement nowhere `
        + `(neither checkEntitlement nor requireEntitledFeature) — the reason is false and the bundle would be a dishonest paywall`,
      ).toBe(true);
      return;
    }
    expect(
      bypass,
      bypass
        ? `'${feature}' (bundle '${bundle}') resolves its OWN toggle with a request-derived subject at `
          + `${bypass.file} — that bypasses the ADR 0419 central choke in requireFeatureEnabled, so pricing `
          + `'${bundle}' would be a dishonest paywall. Use requireFeatureEnabled(req, '${feature}', '<Label>') `
          + `instead. (${bypass.snippet})`
        : '',
    ).toBeNull();
  });

  it.each(bundleFeatures)('bundle %s: feature %s that registers routes references SOME gate (no ungated surface)', (_bundle, feature) => {
    // GATE-1: the widest false-negative of the bypass check above is a feature that
    // registers routes with NO gate at ALL — that check only finds features that
    // HAND-ROLLED a gate. This catches the "forgot entirely" case.
    //
    // A gate can be:
    //   - direct: the file references requireFeatureEnabled / authorizeOrgScope /
    //     requireEntitledFeature / resolveOne, OR
    //   - injected by a FACTORY: a route factory (canvas-editor) receives `authz` /
    //     `loadCanvas` helpers that route through authorizeOrgScope → the choke.
    //     Detected by the factory CALL, not by feature name (which would rot) — so a
    //     new injection factory is one GATE_FACTORIES entry, not a per-feature
    //     exception. `slides` and `document-editor` both use canvasEditorRoutes, so
    //     the factory is already plural, not a one-off.
    // ANY authz gate counts here — this check is "is the surface open?", NOT "is the
    // ENTITLEMENT choke present?" (that is the request-subject check above). So the
    // RBAC gates (`requireOrgScope`, `requireTenantScope`, `requireKicktodoManage`)
    // are included: a route behind RBAC is not "ungated", even though RBAC alone does
    // not apply the paywall. Omitting them would false-positive a legitimately
    // RBAC-gated feature. The request-subject check remains the entitlement-specific
    // guard; between the two, a feature that gates on RBAC but skips the choke is the
    // known residual, covered by the behavioural test, not this tripwire.
    const GATE_HELPERS = /requireFeatureEnabled|authorizeOrgScope|requireEntitledFeature|requireOrgScope|requireTenantScope|requireKicktodoManage|resolveOne/;
    const GATE_FACTORIES = ['registerCanvasEditorRoutes'];
    // Matches `app.<verb>(` and the factory's `d.app.<verb>(`. A feature registering
    // on a passed-in sub-router (`router.get(`) would be missed — but no bundle
    // feature does that today (verified), and a sub-router still ultimately mounts on
    // `app`, so this stays a tripwire, not a proof.
    const registersRoutes = /\bapp\.(get|post|put|patch|delete)\s*\(|\.app\.(get|post|put|patch|delete)\s*\(/;

    let registers = false;
    let gated = false;
    for (const file of featureSources(feature)) {
      const src = readFileSync(file, 'utf8');
      if (registersRoutes.test(src)) registers = true;
      if (GATE_HELPERS.test(src) || GATE_FACTORIES.some((f) => src.includes(f))) gated = true;
    }
    if (!registers) return; // no HTTP surface (e.g. a pack-only or FE-only feature) — nothing to gate
    expect(
      gated,
      `'${feature}' registers routes but references NO gate (direct or via a route factory) — `
      + `if any of those routes reach durable state, the bundle is a dishonest paywall. `
      + `Gate through requireFeatureEnabled, or via the canvas-editor factory's injected authz.`,
    ).toBe(true);
  });

  it('core and bundles are disjoint — core substrate is never sellable', () => {
    // `core ∩ bundle` is also a gen-distribution error, but the PAYWALL consequence
    // is what matters here: ADR 0419's buy-to-unlock UI (`useFeatureLocked`) silently
    // no-ops for a feature with no toggle, and core features trend toward always-on.
    const core = new Set(c.core);
    for (const [bundle, feature] of bundleFeatures) {
      expect(core.has(feature), `'${feature}' is in core AND bundle '${bundle}'`).toBe(false);
    }
  });

  it('the two features this correction fixed now route through the shared choke', () => {
    // Regression pin for the specific holes ADR 0419's audit missed.
    for (const id of ['cdp', 'destination-sync']) {
      expect(hasRequestSubjectSelfGate(id), `'${id}' regressed to a local toggle gate`).toBeNull();
      const routes = readFileSync(join(FEATURES_DIR, id, 'routes.ts'), 'utf8');
      expect(routes).toContain('requireFeatureEnabled');
    }
  });

  // ── ENG-8: `priced ⟹ gated` — the pricing-LAYER linchpin ────────────────────
  // The `it` blocks above prove every bundle in `bundles.json` gates + is non-core.
  // But `priced ⟹ gated` only actually holds if the ONE thing that turns money into
  // an entitlement — an `OPENWOP_BILLING_BUNDLE_PRICES` entry → a bundle id — can
  // point at NOTHING BUT a real bundle. That guard lives in `parseBundlePriceMap`
  // (`billingService.ts`: it honors only ids in `knownBundleIds()`), and until now
  // was prose + code, never pinned by a test. Drop the `known.has` filter and a
  // configured price could "sell" a core feature id or a phantom bundle — and the
  // catalog checks above would never see it, because they only inspect `bundles.json`,
  // not the price → bundle map. This is the single named invariant ADR 0419's
  // `priced ⟹ gated` prose can cite (the runtime env-priced boot-assert was
  // architect-rejected; this static linchpin is the honest enforcement).
  describe('priced ⟹ gated — a price can only sell a real, gated bundle (ENG-8)', () => {
    const PRICES_ENV = 'OPENWOP_BILLING_BUNDLE_PRICES';
    const original = process.env[PRICES_ENV];
    afterEach(() => {
      if (original === undefined) delete process.env[PRICES_ENV];
      else process.env[PRICES_ENV] = original;
    });

    it('a price pointing at a phantom bundle is unsellable (returns undefined)', () => {
      process.env[PRICES_ENV] = JSON.stringify({ price_phantom: 'not-a-real-bundle-xyz' });
      expect(bundleForPrice('price_phantom')).toBeUndefined();
    });

    it('a price pointing at a CORE feature id is unsellable — no core feature is ever priced', () => {
      // The catalog test above proves core ∩ bundle = ∅; this proves the SAME at the
      // pricing layer: even a hand-configured `{"price_x":"<coreFeature>"}` cannot sell
      // core, because a core feature id is not a bundle id (`knownBundleIds` is the
      // bundle KEYS only) — so it is dropped, never entitled.
      const coreId = c.core[0];
      expect(coreId, 'bundles.json must list core features').toBeTruthy();
      process.env[PRICES_ENV] = JSON.stringify({ price_core: coreId });
      expect(bundleForPrice('price_core')).toBeUndefined();
    });

    it('a price pointing at a real bundle sells exactly that bundle — which the checks above prove gates + is non-core', () => {
      const realBundle = knownBundleIds()[0];
      expect(realBundle, 'there must be at least one sellable bundle').toBeTruthy();
      process.env[PRICES_ENV] = JSON.stringify({ price_real: realBundle });
      expect(bundleForPrice('price_real')).toBe(realBundle);
      // Close the chain: everything sellable is a `knownBundleId`, and every
      // `knownBundleId` is a `bundles.json` bundle — which the `it` blocks above prove
      // gates + is disjoint from core. Therefore: priced ⟹ gated.
      expect(knownBundleIds().every((b) => b in c.bundles)).toBe(true);
    });
  });
});
