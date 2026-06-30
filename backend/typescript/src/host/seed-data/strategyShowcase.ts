/**
 * Strategy + Priority Matrix + Board of Advisors SHOWCASE data (demo seeder).
 *
 * A coherent fictional company — "Northwind AI", a B2B AI-orchestration platform —
 * with a real-looking strategic plan: org/workspace strategies across horizons,
 * three scored priority-matrix lists, strategies LINKED to those priorities, and a
 * "Board of Directors" advisory board that carries the org strategies as context.
 *
 * The narrative carries DELIBERATE, analyzable gaps the Board / Strategy Analyst
 * can surface (so the demo shows real guidance, not a flat all-green portfolio):
 *   - `emea-expansion` has objectives but NO linked execution → off-track health.
 *   - `platform-ga` has an objective with NO key results (unmeasurable) + high risk
 *     + key results behind target.
 *   - `fy26-arr` has an owner-less initiative.
 *
 * Cross-references are SYMBOLIC (by `key`): the seeder creates lists/ideas first,
 * captures the generated ids, then wires strategy links + board contextRefs.
 */

export interface ShowcaseIdea {
  key: string;
  title: string;
  description?: string;
  /** criterionId → 1..10 (ids must match the list's preset). */
  scores: Record<string, number>;
}

export interface ShowcaseList {
  key: string;
  name: string;
  presetId: 'weighted' | 'wsjf' | 'rice';
  description: string;
  ideas: ShowcaseIdea[];
}

export type ShowcaseLink =
  | { kind: 'priority-list'; listKey: string }
  | { kind: 'priority-idea'; listKey: string; ideaKey: string };

export interface ShowcaseStrategy {
  key: string;
  title: string;
  scope: 'org' | 'workspace';
  planningHorizon: 'quarter' | 'half-year' | 'annual' | 'multi-year';
  period: { label: string; startDate?: string; endDate?: string };
  summary: string;
  rationale?: string;
  accountableExecutive?: string;
  status: 'active' | 'draft' | 'paused';
  confidence?: 'high' | 'medium' | 'low';
  risk?: 'low' | 'medium' | 'high';
  objectives: Array<{ title: string; keyResults: Array<{ title: string; target?: string; current?: string; unit?: string }> }>;
  initiatives: Array<{ title: string; status?: 'active' | 'draft' | 'paused'; ownerUserId?: string }>;
  links: ShowcaseLink[];
}

export interface ShowcaseBoard {
  name: string;
  handle: string;
  /** Strategy `key`s carried as the board's contextRefs (resolved to ids). */
  contextStrategyKeys: string[];
}

export interface Showcase {
  company: string;
  lists: ShowcaseList[];
  strategies: ShowcaseStrategy[];
  board: ShowcaseBoard;
}

export const SHOWCASE: Showcase = {
  company: 'Northwind AI',

  lists: [
    {
      key: 'product-roadmap',
      name: 'Product Roadmap Bets',
      presetId: 'weighted',
      description: 'Customer-facing roadmap candidates, scored on strategic alignment, ROI, urgency, compliance risk, and cost.',
      ideas: [
        { key: 'sso', title: 'Enterprise SSO & SCIM', description: 'SAML SSO + SCIM provisioning — table stakes for enterprise procurement.', scores: { 'strategic-alignment': 9, roi: 8, urgency: 8, 'compliance-risk': 9, cost: 4 } },
        { key: 'billing', title: 'Usage-based billing', description: 'Metered, consumption-based pricing to capture expansion revenue.', scores: { 'strategic-alignment': 8, roi: 9, urgency: 7, 'compliance-risk': 3, cost: 5 } },
        { key: 'copilot', title: 'In-product AI copilot', description: 'An embedded copilot that authors and explains orchestrations.', scores: { 'strategic-alignment': 9, roi: 8, urgency: 6, 'compliance-risk': 2, cost: 6 } },
        { key: 'onboarding', title: 'Self-serve onboarding', description: 'Guided, no-touch onboarding to shorten time-to-value.', scores: { 'strategic-alignment': 6, roi: 7, urgency: 5, 'compliance-risk': 1, cost: 3 } },
        { key: 'marketplace', title: 'Marketplace integrations', description: 'First-party connectors + a partner marketplace.', scores: { 'strategic-alignment': 7, roi: 6, urgency: 4, 'compliance-risk': 2, cost: 5 } },
        { key: 'mobile', title: 'Mobile SDK', description: 'Native mobile SDK for on-the-go approvals.', scores: { 'strategic-alignment': 3, roi: 4, urgency: 2, 'compliance-risk': 1, cost: 6 } },
        { key: 'whitelabel', title: 'White-label theming', description: 'Customer-branded white-label deployments.', scores: { 'strategic-alignment': 2, roi: 3, urgency: 2, 'compliance-risk': 1, cost: 4 } },
      ],
    },
    {
      key: 'platform-investments',
      name: 'Platform Investments',
      presetId: 'rice',
      description: 'Foundational platform bets, scored RICE (reach × impact × confidence ÷ effort).',
      ideas: [
        { key: 'ga-hardening', title: 'GA hardening & SLO program', description: 'Error budgets, SLOs, and load hardening to reach GA.', scores: { reach: 9, impact: 9, confidence: 8, effort: 5 } },
        { key: 'multiregion', title: 'Multi-region failover', description: 'Active-active multi-region for enterprise uptime.', scores: { reach: 8, impact: 9, confidence: 7, effort: 6 } },
        { key: 'residency', title: 'Data residency controls', description: 'Per-tenant data residency (EU/US) for regulated buyers.', scores: { reach: 6, impact: 7, confidence: 6, effort: 5 } },
        { key: 'observability', title: 'Observability v2', description: 'Unified traces/metrics/logs with customer-facing dashboards.', scores: { reach: 6, impact: 6, confidence: 7, effort: 4 } },
        { key: 'cost-rearch', title: 'Cost-efficiency re-architecture', description: 'Re-architect the inference tier to cut COGS.', scores: { reach: 5, impact: 7, confidence: 5, effort: 8 } },
        { key: 'edge', title: 'Edge inference', description: 'Edge-deployed inference for low-latency regions.', scores: { reach: 3, impact: 5, confidence: 4, effort: 9 } },
      ],
    },
    {
      key: 'engineering-investments',
      name: 'Engineering Investments',
      presetId: 'wsjf',
      description: 'Internal engineering bets, scored WSJF (cost of delay ÷ job size).',
      ideas: [
        { key: 'incident', title: 'Incident-response automation', description: 'Auto-triage, runbooks, and paging to cut MTTR.', scores: { 'user-business-value': 8, 'time-criticality': 8, 'risk-reduction': 9, 'job-size': 4 } },
        { key: 'cicd', title: 'CI/CD modernization', description: 'Faster, safer pipelines with progressive delivery.', scores: { 'user-business-value': 6, 'time-criticality': 5, 'risk-reduction': 6, 'job-size': 5 } },
        { key: 'flaky', title: 'Flaky-test elimination', description: 'Kill nondeterministic tests so CI is a trustworthy gate.', scores: { 'user-business-value': 5, 'time-criticality': 6, 'risk-reduction': 7, 'job-size': 3 } },
        { key: 'techdebt', title: 'Tech-debt paydown', description: 'Pay down the highest-interest architectural debt.', scores: { 'user-business-value': 5, 'time-criticality': 4, 'risk-reduction': 6, 'job-size': 6 } },
        { key: 'mesh', title: 'Service mesh rollout', description: 'mTLS + traffic policy via a service mesh.', scores: { 'user-business-value': 3, 'time-criticality': 3, 'risk-reduction': 4, 'job-size': 8 } },
      ],
    },
  ],

  strategies: [
    {
      key: 'fy26-arr',
      title: 'FY26 — Scale to $50M ARR',
      scope: 'org',
      planningHorizon: 'annual',
      period: { label: 'FY26', startDate: '2026-02-01', endDate: '2027-01-31' },
      summary: 'Triple ARR to $50M by winning net-new enterprise logos and expanding within existing accounts.',
      rationale: 'The category is consolidating and the window to capture marquee enterprise reference logos is FY26. Net-new logo growth plus best-in-class net revenue retention compounds into durable, efficient growth.',
      accountableExecutive: 'CEO — Dana Reyes',
      status: 'active',
      confidence: 'medium',
      risk: 'medium',
      objectives: [
        { title: 'Grow net-new ARR', keyResults: [
          { title: 'New ARR booked', target: '$20M', current: '$8.4M' },
          { title: 'Net-new logos', target: '120', current: '64' },
          { title: 'Pipeline coverage', target: '3.5x', current: '2.1x' },
        ] },
        { title: 'Expand within accounts', keyResults: [
          { title: 'Net revenue retention', target: '125', current: '112', unit: '%' },
          { title: 'Expansion ARR', target: '$12M', current: '$5.1M' },
        ] },
      ],
      initiatives: [
        { title: 'Launch the Enterprise tier', status: 'active', ownerUserId: 'exec:cro' },
        // Deliberate gap: an active initiative with NO accountable owner.
        { title: 'Usage-based pricing rollout', status: 'active' },
      ],
      links: [
        { kind: 'priority-list', listKey: 'product-roadmap' },
        { kind: 'priority-idea', listKey: 'product-roadmap', ideaKey: 'sso' },
        { kind: 'priority-idea', listKey: 'product-roadmap', ideaKey: 'billing' },
      ],
    },
    {
      key: 'category-leader',
      title: 'Become the category leader by FY28',
      scope: 'org',
      planningHorizon: 'multi-year',
      period: { label: 'FY26–FY28', startDate: '2026-02-01', endDate: '2029-01-31' },
      summary: 'Define and lead the AI-orchestration category through analyst recognition, marquee logos, and platform breadth.',
      rationale: 'Whoever sets the category narrative and the integration standard wins the durable platform position. Breadth of first-party integrations is the moat.',
      accountableExecutive: 'CEO — Dana Reyes',
      status: 'active',
      confidence: 'high',
      risk: 'medium',
      objectives: [
        { title: 'Define the category', keyResults: [
          { title: 'Analyst placement', target: 'Leader quadrant', current: 'Challenger' },
          { title: 'Marquee reference logos', target: '8', current: '3' },
        ] },
        { title: 'Platform breadth', keyResults: [
          { title: 'First-party integrations', target: '40', current: '18' },
        ] },
      ],
      initiatives: [
        { title: 'Partner ecosystem program', status: 'active', ownerUserId: 'exec:cpo' },
        { title: 'Open orchestration standard', status: 'draft', ownerUserId: 'exec:cto' },
      ],
      links: [
        { kind: 'priority-list', listKey: 'platform-investments' },
        { kind: 'priority-idea', listKey: 'product-roadmap', ideaKey: 'marketplace' },
      ],
    },
    {
      key: 'platform-ga',
      title: 'Ship the AI Platform GA',
      scope: 'org',
      planningHorizon: 'half-year',
      period: { label: 'H1 FY26', startDate: '2026-02-01', endDate: '2026-07-31' },
      summary: 'Take the orchestration platform from beta to general availability with enterprise-grade reliability and compliance.',
      rationale: 'GA unblocks enterprise procurement; reliability and SOC 2 are the gating risks. Execution is behind plan, so this is the highest-risk org bet this half.',
      accountableExecutive: 'CTO — Sam Okafor',
      status: 'active',
      confidence: 'medium',
      risk: 'high',
      objectives: [
        { title: 'GA reliability readiness', keyResults: [
          { title: 'Uptime SLO', target: '99.9', current: '99.4', unit: '%' },
          { title: 'p95 latency', target: '250ms', current: '420ms' },
          { title: 'SOC 2 Type II', target: 'Certified', current: 'In audit' },
        ] },
        // Deliberate gap: an objective with NO key results (unmeasurable).
        { title: 'Migrate beta customers to GA', keyResults: [] },
      ],
      initiatives: [
        { title: 'SLO & error-budget program', status: 'active', ownerUserId: 'exec:vpe' },
        { title: 'Multi-region rollout', status: 'active', ownerUserId: 'exec:cto' },
      ],
      links: [
        { kind: 'priority-list', listKey: 'platform-investments' },
        { kind: 'priority-idea', listKey: 'platform-investments', ideaKey: 'ga-hardening' },
        { kind: 'priority-idea', listKey: 'platform-investments', ideaKey: 'multiregion' },
      ],
    },
    {
      key: 'q3-ops',
      title: 'Operational Excellence & Trust (Q3)',
      scope: 'workspace',
      planningHorizon: 'quarter',
      period: { label: 'Q3 FY26', startDate: '2026-08-01', endDate: '2026-10-31' },
      summary: 'Harden reliability and security posture so enterprise buyers trust the platform in production.',
      rationale: 'Reliability and security incidents are the top churn and stalled-deal driver; fixing the operational basics protects ARR.',
      accountableExecutive: 'VP Eng — Priya Nair',
      status: 'active',
      confidence: 'high',
      risk: 'low',
      objectives: [
        { title: 'Reliability', keyResults: [
          { title: 'Sev-1 incidents', target: '<2 / qtr', current: '5 / qtr' },
          { title: 'MTTR', target: '30m', current: '82m' },
        ] },
        { title: 'Security posture', keyResults: [
          { title: 'Open critical vulnerabilities', target: '0', current: '4' },
        ] },
      ],
      initiatives: [
        { title: 'Incident-response automation', status: 'active', ownerUserId: 'exec:vpe' },
      ],
      links: [
        { kind: 'priority-list', listKey: 'engineering-investments' },
        { kind: 'priority-idea', listKey: 'engineering-investments', ideaKey: 'incident' },
      ],
    },
    {
      key: 'emea-expansion',
      title: 'Enter the EMEA market (FY26)',
      scope: 'org',
      planningHorizon: 'annual',
      period: { label: 'FY26', startDate: '2026-02-01', endDate: '2027-01-31' },
      summary: 'Establish an EMEA go-to-market motion and data-residency compliance to land European enterprise accounts.',
      rationale: 'Strong inbound from EU enterprises is blocked on data residency and a local GTM presence. The opportunity is real but nothing is yet resourced against it.',
      accountableExecutive: 'CRO — Marco Bianchi',
      status: 'draft',
      confidence: 'low',
      risk: 'high',
      objectives: [
        { title: 'Stand up the EMEA GTM motion', keyResults: [
          { title: 'EMEA qualified pipeline', target: '$6M', current: '$0.4M' },
          { title: 'EU reference logos', target: '5', current: '0' },
        ] },
      ],
      initiatives: [
        // Deliberate gap: a draft initiative with no owner — and the strategy has
        // NO linked execution at all (see empty `links`), so health is off-track.
        { title: 'EU data-residency compliance', status: 'draft' },
      ],
      links: [],
    },
  ],

  board: {
    name: 'Board of Directors',
    handle: 'board-of-directors',
    // The four company-level (org) strategies; the board reviews company strategy,
    // and each strategy carries its linked priorities into the advisors' context.
    contextStrategyKeys: ['fy26-arr', 'category-leader', 'platform-ga', 'emea-expansion'],
  },
};
