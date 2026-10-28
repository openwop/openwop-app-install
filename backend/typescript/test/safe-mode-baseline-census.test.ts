/**
 * ADR 0834 D4 — the safe-mode baseline census: EVERY tool this host can offer a model is
 * an explicit decision about whether `safe` permission mode asks before it runs.
 *
 * The baseline used to be a hand-kept name list (`SENSITIVE_APPROVAL_TOOLS`) and a class
 * gate whose population is empty for agent tools (every id is `openwop:`-prefixed; the
 * classifier's egress rows are node ids). Nothing checked that the list covered the tools
 * that actually send data off-host or run model-written work, so
 * `openwop:workflows.compose-and-run` and `openwop:destination-sync.run` ran unasked.
 *
 * The denominator is the LIVE `builtinAgentToolIds()` after a real boot (registration is
 * a runtime mutation, so no static census can be a floor), NOT `effect` — `effect` is
 * display-only by its own contract and declares `http.fetch` a read. A newly registered
 * tool fails here until it is placed in exactly one table below.
 *
 * Sabotage witnessed red (8f grade-tests wave 2): destination-sync's
 * safe-mode declaration dropped (`8fw2g3-cen-destsync-decl`), compose-and-run's
 * reviewed-lane reason dropped (`-cen-compose-reason`), a dead name added to
 * the hand-kept set (`-cen-dead-name`), a READS tool's effect flipped
 * (`-cen-read-effect`), and a name removed from the baseline
 * (`-cen-baseline-names`).
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { builtinAgentToolIds, builtinAgentTool } from '../src/host/agentToolProvider.js';
import { SENSITIVE_APPROVAL_TOOLS } from '../src/features/capability-firewall/firewallHook.js';
import { safeModeBaseline } from '../src/host/laneFirewall.js';

/** Held in `safe` mode. Exact set. */
const ASKS: ReadonlyArray<readonly [string, string]> = [
  ['openwop:feature.code-exec.nodes.run', 'runs model-written code (name set, ADR 0150)'],
  ['openwop:core.openwop.http.fetch', 'sends a model-chosen request off-host (name set, ADR 0150)'],
  ['openwop:kicktodo.log-checkin', 'commits the participant\'s own non-reversible check-in (name set, ADR 0442)'],
  ['openwop:workflows.compose-and-run', 'runs a model-written workflow unreviewed — http/email nodes included (declared, ADR 0834)'],
  ['openwop:destination-sync.run', 'forwards model-supplied records to a peer host (declared, ADR 0834)'],
  ['openwop:agent-evals.run', 'spends model calls on every task × trial of an eval suite (declared, ADR 0889)'],
];

const OWN_GATE = 'reaches a human approval through its own mechanism (approvals inbox / reviews / editorial queue) — nothing leaves without it';
const DRAFT = 'writes a DRAFT or a canvas/artifact inside this workspace, scoped to the acting user; nothing leaves the host';
const IN_HOST = 'in-host workspace bookkeeping the user can see and undo; no off-host send, no model-written execution';
const FIXED_RUN = 'starts a FIXED, code-reviewed feature workflow the user asked for by name; its sends carry node-level gates (core.email.send approval) — the arbitrary composer is the ask';
const SELF = 'addressed only to the acting user (their inbox / their own board / their own later turn, which re-enters the always-safe run lane)';

/** Writes that are NOT held in safe mode, with the reason. */
const NO_ASK_WRITES: ReadonlyArray<readonly [string, string]> = [
  ['openwop:campaign-intel.propose-reallocation', `${OWN_GATE}. It reads the campaigns' live daily budgets through the acting user's own ad connections (ids out, budgets in) and opens ONE campaign-spend approval; it changes no budget (ADR 0952 D8)`],
  ['openwop:app-builder.render', DRAFT],
  ['openwop:assistant.enqueue-action', OWN_GATE],
  ['openwop:assistant.populate-board', IN_HOST],
  ['openwop:assistant.upsert-commitment', IN_HOST],
  ['openwop:cad.render', DRAFT],
  ['openwop:campaign-brief.generate-kernel', FIXED_RUN],
  ['openwop:campaign-brief.research.run', FIXED_RUN],
  ['openwop:campaign-channels.generate', FIXED_RUN],
  ['openwop:campaign-orchestration.run', FIXED_RUN],
  ['openwop:campaign-studio.render', DRAFT],
  ['openwop:cms.submit-page', OWN_GATE],
  ['openwop:cms.update-section-draft', DRAFT],
  ['openwop:comments.post', 'an in-host comment; mentions notify tenant members through the inbox'],
  ['openwop:conversations.export-document', DRAFT],
  ['openwop:crm.lead.capture', 'the anonymous widget\'s bounded write — held by the surface\'s own control (ADR 0469)'],
  ['openwop:crm.lead.qualify', 'anonymous-only evidence claim; anonHitlOnly forces the surface human gate and refuses auto-run (ADR 0954 P4)'],
  ['openwop:discovery.create-collection', IN_HOST],
  ['openwop:discovery.create-rule', IN_HOST],
  ['openwop:documents.draft', DRAFT],
  ['openwop:documents.generate-from-template', DRAFT],
  ['openwop:documents.revise', 'a new version of a document the user can write, checked against the version read; an approved document\'s published text changes only when an approver re-approves (ADR 0838)'],
  ['openwop:drawings.render', DRAFT],
  ['openwop:email.draft', DRAFT],
  ['openwop:email.save-draft', DRAFT],
  ['openwop:email.submit-for-review', OWN_GATE], // ADR 0905 D5 — queues a human send review; never approves or sends
  ['openwop:feature.agent-author.nodes.persist', 'creates the agent DISABLED — a human enables it'],
  ['openwop:feature.builder-pair.nodes.suggest-edits', 'suggestions the user keeps or drops on the canvas; never applies'],
  ['openwop:feature.commerce.buyer.nodes.build-cart', 'a capped cart draft; buys nothing'],
  ['openwop:feature.commerce.buyer.nodes.checkout', OWN_GATE],
  ['openwop:feature.commerce.buyer.nodes.track-order', 're-reads an existing order\'s status from the merchant the connection names; sends no model-chosen data'],
  ['openwop:feature.commerce.nodes.create-quote', DRAFT],
  ['openwop:feature.crm.nodes.create-task', IN_HOST],
  ['openwop:feature.crm.nodes.log-activity', IN_HOST],
  ['openwop:feature.crm.nodes.persist-segment', 'closed-world re-validated before write (ADR 0815); in-host'],
  ['openwop:feature.workflow-author.nodes.persist', 'registers a validated draft; running it is a separate, gated act'],
  ['openwop:funnels.draft', DRAFT],
  ['openwop:funnels.generate', 'starts a FIXED, code-reviewed funnel blueprint the user asked for; it drafts a funnel and pages, and publishing is a human funnel-publish review (ADR 0948)'],
  ['openwop:intent-ledger.draft-contract', 'a draft mission contract the user approves'],
  ['openwop:interactive-artifacts.render', DRAFT],
  ['openwop:kanban.add-todo', SELF],
  ['openwop:kicktodo.convene', 'dispatches a specialist bounded to a read-only allowlist (ADR 0104 override)'],
  ['openwop:kicktodo.factory.run', FIXED_RUN],
  ['openwop:kicktodo.replan', FIXED_RUN],
  ['openwop:notebooks.write-transformation', FIXED_RUN],
  ['openwop:notifications.notify-me', SELF],
  ['openwop:podcasts.produce', FIXED_RUN],
  ['openwop:priority-matrix.generate-agenda', DRAFT],
  ['openwop:priority-matrix.score-idea', IN_HOST],
  ['openwop:priority-matrix.submit-idea', IN_HOST],
  ['openwop:production.plan', FIXED_RUN],
  ['openwop:promotions.draft', 'lands PROPOSED (inactive) — a human activates it'],
  ['openwop:recommendations.create-placement', IN_HOST],
  ['openwop:servicedesk.draft-reply', OWN_GATE],
  ['openwop:servicedesk.set-status', IN_HOST],
  ['openwop:slides.render', DRAFT],
  ['openwop:strategy.create-board-memo', DRAFT],
  ['openwop:tasks.schedule-followup', SELF],
  ['openwop:team-ledger.propose', 'only PROPOSES a change; the ledger owner accepts or rejects it'],
  ['openwop:tasks.schedule-recurring', SELF],
  ['openwop:walkthroughs.register-draft', DRAFT],
  ['openwop:workflows.propose', OWN_GATE],
];

/** Reads that DO reach off-host, adjudicated individually. */
const NO_ASK_READ_EGRESS: ReadonlyArray<readonly [string, string]> = [
  ['openwop:ai.research.web', 'a search query to the configured search provider (classified read/safe-fetch); default-on baseline — asking would gate every research turn'],
];

/** Reads with no off-host send and no durable change. Reviewed as a set; a new read that
 *  egresses belongs in NO_ASK_READ_EGRESS (or ASKS), never here. */
const READS: readonly string[] = [
  'openwop:accessibility.alt-text.generate',
  'openwop:accessibility.check',
  'openwop:agent-evals.get-summary',
  'openwop:agent-evals.list-suites',
  'openwop:analytics.query',
  'openwop:app-builder.catalog',
  'openwop:app-builder.get-design',
  'openwop:assistant.compose-briefing',
  'openwop:assistant.list-commitments',
  'openwop:assistant.list-pending-actions',
  'openwop:bi.list-metrics',
  'openwop:bi.run-metric',
  'openwop:brand.compliance-check',
  'openwop:brand.list-brands',
  'openwop:brand.resolve-voice',
  'openwop:cad.get-design',
  'openwop:campaign-brief.get-brief',
  'openwop:campaign-brief.validate',
  'openwop:campaign-channels.channels',
  'openwop:campaign-intel.attribution',
  'openwop:campaign-intel.budget-optimize',
  'openwop:campaign-intel.caps',
  'openwop:campaign-intel.forecast',
  'openwop:campaign-intel.pacing',
  'openwop:campaign-intel.plan-budget',
  'openwop:campaign-orchestration.get-campaign',
  'openwop:campaign-orchestration.get-autonomy',
  'openwop:campaign-orchestration.status',
  'openwop:campaign-studio.get-design',
  'openwop:cdp.identity.resolve',
  'openwop:channels.list',
  'openwop:cms.get-draft-page',
  'openwop:cms.get-page',
  'openwop:cms.list-pages',
  'openwop:cms.translate-section',
  'openwop:comments.list',
  'openwop:computer-use.status',
  'openwop:conversations.search',
  'openwop:core.flow.aggregate-text',
  'openwop:core.flow.split-in-batches',
  'openwop:core.openwop.data.json-schema-validate',
  'openwop:core.openwop.data.jsonpath-query',
  'openwop:core.rag.retriever-basic',
  'openwop:core.rag.retriever-contextual-compression',
  'openwop:creative-briefs.list',
  'openwop:dealers.list-dealers',
  'openwop:dealers.list-outlets',
  'openwop:dealers.list-registrations',
  'openwop:destination-sync.dry-run',
  'openwop:destination-sync.list',
  'openwop:discovery.list-collections',
  'openwop:discovery.list-rules',
  'openwop:discovery.search',
  'openwop:documents.get',
  'openwop:documents.get-template',
  'openwop:documents.list-templates',
  'openwop:drawings.get-design',
  'openwop:email.get-campaign',
  'openwop:entities.describe-type',
  'openwop:entities.query',
  'openwop:feature.agent-author.nodes.draft',
  'openwop:feature.agent-author.nodes.get',
  'openwop:feature.agent-author.nodes.validate',
  'openwop:feature.assistant.nodes.prioritize',
  'openwop:feature.builder-pair.nodes.read-canvas',
  'openwop:feature.commerce.buyer.nodes.list-purchases',
  'openwop:feature.commerce.nodes.get-order',
  'openwop:feature.commerce.nodes.get-quote',
  'openwop:feature.commerce.nodes.list-coupons',
  'openwop:feature.commerce.nodes.list-orders',
  'openwop:feature.commerce.nodes.list-products',
  'openwop:feature.commerce.nodes.list-quotes',
  'openwop:feature.commerce.nodes.resolve-price',
  'openwop:feature.crm.nodes.get-company',
  'openwop:feature.crm.nodes.get-deal',
  'openwop:feature.crm.nodes.list-companies',
  'openwop:feature.crm.nodes.list-deals',
  'openwop:feature.crm.nodes.list-segment-members',
  'openwop:feature.crm.nodes.list-tasks',
  'openwop:feature.crm.nodes.segment-vocabulary',
  'openwop:feature.crm.nodes.validate-segment',
  'openwop:feature.csm.nodes.health-read',
  'openwop:feature.csm.nodes.renewals-due', // ADR 0882 D8 — a read (effect:'read'), same predicate as health-read
  'openwop:feature.insights-suite.nodes.talent-score',
  'openwop:feature.insights-suite.nodes.variance-compute',
  'openwop:feature.workflow-author.nodes.draft',
  'openwop:feature.workflow-author.nodes.get',
  'openwop:feature.workflow-author.nodes.validate',
  'openwop:forms.list-forms',
  'openwop:forms.list-submissions',
  'openwop:funnels.blueprints',
  'openwop:funnels.get',
  'openwop:funnels.list',
  'openwop:funnels.step-stats',
  'openwop:goals.list',
  'openwop:intent-ledger.get',
  'openwop:interactive-artifacts.get',
  'openwop:job-search.applications.read',
  'openwop:job-search.listings.read',
  'openwop:kicktodo.candidates',
  'openwop:kicktodo.challenge-performance',
  'openwop:kicktodo.circles',
  'openwop:kicktodo.community-reviews',
  'openwop:kicktodo.engagement-summary',
  'openwop:kicktodo.integrations-status',
  'openwop:kicktodo.journal',
  'openwop:kicktodo.plan',
  'openwop:kicktodo.progress',
  'openwop:kicktodo.proposals',
  'openwop:kicktodo.today',
  'openwop:knowledge.search',
  'openwop:marketplace.search',
  'openwop:media.list',
  'openwop:notebooks.ask',
  'openwop:notebooks.search',
  'openwop:podcasts.list',
  'openwop:priority-matrix.list-lists',
  'openwop:priority-matrix.list-ranked-ideas',
  'openwop:priority-matrix.schedule-status',
  'openwop:production.get-vendors',
  'openwop:projects.list',
  'openwop:promotions.apply-preview',
  'openwop:promotions.list',
  'openwop:proposals.list',
  'openwop:recommendations.list-placements',
  'openwop:recommendations.resolve',
  'openwop:runs.diagnose',
  'openwop:sales-commissions.list-plans',
  'openwop:sales-commissions.list-statements',
  'openwop:schema.lookup',
  'openwop:servicedesk.get-ticket',
  'openwop:servicedesk.list-tickets',
  'openwop:slides.catalog',
  'openwop:slides.get-design',
  'openwop:strategy.get-context',
  'openwop:strategy.get-health',
  'openwop:strategy.get-strategy',
  'openwop:strategy.list-strategies',
  'openwop:tasks.deck',
  'openwop:team-ledger.get',
  'openwop:territories.active-model',
  'openwop:territories.attainment',
  'openwop:territories.list-models',
  'openwop:territories.list-quotas',
  'openwop:territories.list-rules',
  'openwop:territories.list-territories',
  'openwop:territories.preview',
  'openwop:tutorials.catalog',
  'openwop:tutorials.get',
  'openwop:work-selection.preview',
];

let server: http.Server | undefined;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = app.listen(0, '127.0.0.1');
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => (server ? server.close(() => res()) : res())); });

describe('safe-mode baseline census (ADR 0834 D4)', () => {
  it('every live tool is adjudicated exactly once — no ghosts, no strays', () => {
    const tables = [ASKS.map(([id]) => id), NO_ASK_WRITES.map(([id]) => id), NO_ASK_READ_EGRESS.map(([id]) => id), [...READS]];
    const all = tables.flat();
    expect(new Set(all).size).toBe(all.length); // no id in two tables
    expect([...all].sort()).toEqual([...builtinAgentToolIds()].sort());
  });

  it('the live baseline IS the ASKS table (declared + name set)', () => {
    expect([...safeModeBaseline().tools].sort()).toEqual(ASKS.map(([id]) => id).sort());
  });

  it('every hand-kept name is a registered tool (no dead entries)', () => {
    for (const id of SENSITIVE_APPROVAL_TOOLS) expect(builtinAgentTool(id), id).toBeDefined();
  });

  it('a READS entry really is effect:read (a write cannot hide in the read table)', () => {
    for (const id of READS) expect(builtinAgentTool(id)?.effect, id).toBe('read');
  });

  it('compose-and-run points the model at the reviewed lane when held', () => {
    expect(safeModeBaseline().reasons.get('openwop:workflows.compose-and-run')).toContain('openwop:workflows.propose');
  });
});
