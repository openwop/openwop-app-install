/** ADR 0954 — lead-intelligence identifiers shared by routes, surface and tests. */

/** The sub-toggle (ADR 0941 D5): AND-ed with `crm` in code, no `dependsOn`. */
export const LEAD_INTEL_TOGGLE = 'crm.lead-intelligence';

/** The host-written run stamp naming the client and lead a grading run is for.
 *  Stripped from caller metadata (`runDispatch.ts` CAMPAIGN_ATTRIBUTION_KEYS). */
export const LEAD_INTEL_RUN_STAMP = 'crmLeadIntel';

/** The same-id chain-backed grading workflow. */
export const GRADE_LEAD_WORKFLOW_ID = 'crm-ops.grade-lead';

/** ADR 0954 D5 — grade, then route: the same-id chain the Route action starts. */
export const ROUTE_LEAD_WORKFLOW_ID = 'crm-ops.route-lead';

/** ADR 0954 D4 — assess, then grade: the same-id chain the Qualify action starts. */
export const QUALIFY_LEAD_WORKFLOW_ID = 'crm-ops.qualify-lead';
