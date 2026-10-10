/**
 * ADR 0857 D3 — the analytics consent decision, in ONE place for every caller, so
 * they can never disagree.
 *
 * > CORRECTED 2026-10-07 (ADR 0860 D3): the decision moved to
 * > `consent/visitorConsent.ts`, so `publishing` and `funnels` reach it over their
 * > existing `consent` edge, and it now carries the request's region. These names
 * > stay as the analytics-side entry points and delegate.
 *
 * THE DEFECT ADR 0857 closed: the beacon evaluated consent only for its own
 * `sessionKey`, and the only consent a VISITOR can record mints its own
 * `visitor:<uuid>` subject (CONS-2), so the two keyspaces never met. The cure is the
 * optional `consentToken`; its rules are documented beside the decision.
 */

export {
  resolveConsentTokenSubject,
  visitorConsentContextOf,
  visitorAnalyticsAllowed as analyticsConsentAllows,
  type VisitorConsentContext,
} from '../consent/visitorConsent.js';
