/**
 * ADR 0819 §1 — the paywall opt-out ratchet.
 *
 * `resolveOne` is the ACCESS resolver (toggle + the ADR 0419 plan check), so a
 * new chat tool, node surface, socket, daemon or recall source is paywalled
 * without anyone remembering to add the check. `resolveToggle` is the pure
 * toggle read, and every call to it OPTS a lane OUT of the paywall. The legal
 * reasons are narrow: a public shopper lane, a route that applies the plan
 * itself, a toggle whose OFF loosens a restriction, money/compliance truth, and
 * the FE/admin projections. So every call site is pinned here, per file and by
 * count. A new opt-out is a reviewed diff of this file, never a silent edit.
 *
 * The guard is derived from the CALL, not the import or the filename: a file
 * that imports `resolveToggle` and never calls it is not counted, and a call in
 * a file of any name is.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

const ALLOWED: Record<string, number> = {
  // The definition, plus resolveOne's own toggle half.
  'host/featureToggles/service.ts': 2,
  // Applies the plan itself, with its 403 + the operator's person exemption.
  'features/featureRoute.ts': 1,
  // The billing toggle read inside the entitlement verdict (billing is never sold).
  'features/billing/entitlementGuard.ts': 1,
  // The FE single-assignment read (the bulk map resolves configs directly).
  'routes/featureToggles.ts': 1,
  // ADR 0892 Phase B — the store card's "is this bundle already on here" read.
  // Visibility only; the plan half is asked explicitly through
  // `checkTenantEntitlement` before the state can say anything but `locked`, and
  // before any enable writes.
  'host/featureBundleActivation.ts': 1,
  // ADR 0820 §7 — the owner-lapse helper for PUBLIC lanes (`checkOwnerPublicAccess`,
  // first caller: the storefront). It reads the toggle alone because it applies the
  // plan half ITSELF, with the grace window and fault-serves rule that `resolveOne`
  // (fail-closed, no grace) cannot express. Never consults the visitor.
  'host/publicLapse.ts': 1,
  // Routes that run `checkEntitlement` themselves for a distinct 403.
  'features/crm/routes.ts': 1,
  'features/csm/routes.ts': 1,
  // PUBLIC lanes: tenant from the resource; ADR 0419's shopper exemption.
  // +2 (strategy §8): the paywall-funnel beacon reads `workspace-nav-telemetry` and
  // `analytics` WITHOUT the plan. `analytics` is CRM-bundled, so a plan check would
  // drop the beacon for exactly the tenants who meet a lock (the funnel would count
  // only payers). The lane serves no paid capability; it accepts a count.
  'features/analytics/routes.ts': 3,
  'features/campaign-connectors/routes.ts': 2,
  'features/commerce/ucp/routes.ts': 1,
  'features/consent/routes.ts': 1,
  'features/crm/bookingRoutes.ts': 2,
  'features/crm/signRoutes.ts': 1,
  'features/dealers/routes.ts': 1,
  'features/discovery/routes.ts': 1,
  'features/funnels/routes.ts': 1,
  'features/podcasts/publicRoutes.ts': 1,
  'features/podcasts/podcastsService.ts': 1,
  'features/recommendations/routes.ts': 1,
  'features/docs/docsService.ts': 1,
  // Every anonymous share-link entry gates here first (booking manage, e-sign, frames).
  'features/sharing/sharingService.ts': 1,
  // Public form-submission sinks.
  'features/crm/formsSubmissionSink.ts': 1,
  'features/email/formsConsentSink.ts': 1,
  'features/funnels/formsAttributionSink.ts': 1,
  'features/webinars/formsSubmissionSink.ts': 1,
  // ADR 0850 D1 — the service-desk form sink now reads its toggle (FRMWF-13); a
  // public visitor lane, tenant from the resource, the same opt-out as its siblings.
  // +1 ADR 0878 D9 — the WhatsApp intake observer read NO toggle (SD2-S7); the sender
  // is not a member, so it is the same visitor opt-out, plus the owner-lapse policy.
  'features/service-desk/intake.ts': 2,
  // ADR 0878 D3 — a reply's widget delivery reads the `service-desk.widget` sub-toggle
  // to answer "can the VISITOR see this thread" — the question the visitor lane
  // (widgetRoutes, below) answers with the same toggle-only read. The member's own
  // access is the route's `resolveOne`; this grants nothing.
  'features/service-desk/delivery.ts': 1,
  // ADR 0820 §8.2 — public VISITOR lanes of features moved into the Support bundle.
  // The tenant comes from the resource (widget token / intake key); paywalling the
  // visitor would 404 every visitor of a lapsed owner, and every tenant's visitors
  // on an entitlement-read fault (ADR 0819 A2). Owner-lapse policy: ADR 0820 §7.
  'features/chat-widget/publicGateway.ts': 1,
  'features/service-desk/widgetRoutes.ts': 2, // the parent toggle + the `.widget` sub-toggle
  // OFF loosens a restriction: a paywalled read would fail OPEN.
  'features/territories/visibility.ts': 1,
  'features/consent/consentService.ts': 1,
  // Money / compliance truth: applies whatever the plan.
  'features/promotions/promotionsService.ts': 1,
  // 1: the CRM merge relink (compliance truth, as above). 2 (ADR 0905 D4): the
  // `email-approval-gate` read — OFF loosens a restriction (unapproved sends), so a
  // paywalled read would fail OPEN on a lapsed plan (the territories/consent reason).
  'features/email/emailService.ts': 2,
  // A tool gate whose every caller then applies the plan with its own message.
  'features/email/agentTools.ts': 1,
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Calls of `resolveToggle(` on code lines (comment lines are not calls). */
function callCount(text: string): number {
  return text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .reduce((n, l) => n + (l.match(/\bresolveToggle\(/g)?.length ?? 0), 0);
}

/**
 * The OTHER ways to read a toggle without the plan: the raw effective config and
 * the pure resolver. Each bypasses `resolveOne` exactly like `resolveToggle`
 * (review L4), so their callers outside the toggle service are pinned too.
 */
const RAW_READS_ALLOWED: Record<string, number> = {
  // The FE assignments map (the plan lock renders from billing, not from here).
  'routes/featureToggles.ts': 1,
  // A readiness REPORT of global state, not a gate; reports a kill as `off`.
  'features/kicktodo-core/readinessService.ts': 1,
};

function rawReadCount(text: string): number {
  return text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .reduce((n, l) => n + (l.match(/\b(getEffectiveConfig|resolveConfig|resolveAssignments)\(/g)?.length ?? 0), 0);
}

describe('ADR 0819 §1 — every paywall opt-out is listed', () => {
  it('raw toggle reads outside the toggle service match their allowlist exactly', () => {
    const actual: Record<string, number> = {};
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      if (rel === 'host/featureToggles/service.ts') continue;
      const n = rawReadCount(readFileSync(file, 'utf8'));
      if (n > 0) actual[rel] = n;
    }
    expect(actual).toEqual(RAW_READS_ALLOWED);
  });

  it('the set of files calling resolveToggle, and their call counts, match the allowlist exactly', () => {
    const actual: Record<string, number> = {};
    for (const file of walk(SRC)) {
      const n = callCount(readFileSync(file, 'utf8'));
      if (n > 0) actual[relative(SRC, file).split('\\').join('/')] = n;
    }
    // Floor: the scan must see the definition, or it read the wrong tree.
    expect(actual['host/featureToggles/service.ts']).toBeGreaterThan(0);
    expect(actual).toEqual(ALLOWED);
  });
});
