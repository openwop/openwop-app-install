/**
 * TOCC-2 / TOCC-2a (ADR 0604) — the COMPLETENESS ratchet for
 * `SCHEMA_READ_EXEMPT_TOOLS` / `BuiltinTool.schemaCarrying`.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE. The exemption used to be a hand-kept array
 * of nine ids, and the only test over it iterated that same array — so it could
 * confirm what was listed and nothing else. Emptying the array was GREEN. Worse,
 * NO static gate over that array could ever have been complete, because the
 * population is not statically enumerable: `BUILTINS` (host/agentToolProvider.ts)
 * is six static entries plus TWO SPREADS (`RAG_RETRIEVER_IDS`,
 * `PROJECTABLE_COMPUTE_NODE_TYPE_IDS`), and `registerFeatureAgentTool` MUTATES
 * the map at runtime from ~184 feature call sites. Any census of the source is a
 * floor BY CONSTRUCTION. That is not a hypothetical: the assessment's own
 * prescribed census said "6 static + 7 projected" when the truth is 6 + 2 + 9,
 * and it missed `feature.crm.nodes.segment-vocabulary` — a SCHEMA-CARRYING tool
 * invisible to any grep of `features/*​/agentTools.ts`, because it is projected
 * from a node typeId rather than registered.
 *
 * THE INSTRUMENT. Boot the real app (which runs `registerBackendFeatures`, so
 * every feature has registered) and take the denominator from the RUNTIME
 * registry — `builtinAgentToolIds()`. A runtime denominator cannot be a floor.
 * Then require that EVERY id in it appears in the total classification below.
 * Registering a new tool therefore reddens this file until somebody answers the
 * question "does this tool's output carry a closed world the model must cite
 * back exactly?" — which is the judgment that was never being forced.
 *
 * The classification is `[toolId, schemaCarrying]`. Adding a row is the whole
 * maintenance burden; getting it wrong is a review question, not a silent gap.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { builtinAgentToolIds, builtinAgentTool } from '../src/host/agentToolProvider.js';
import { SCHEMA_READ_EXEMPT_TOOLS, isSchemaReadExempt } from '../src/host/toolResultTransform.js';

/**
 * The TOTAL classification of every tool this host can offer a model, derived on
 * 2026-08-23 from a live `builtinAgentToolIds()` (201 ids), NOT from reading
 * source. `true` ⇒ the output IS a schema / enum / closed catalog / design body
 * whose element list is the contract, so `lossy` compaction must never touch it.
 */
const CLASSIFICATION: ReadonlyArray<readonly [string, boolean]> = [
  ['openwop:accessibility.alt-text.generate', false],
  ['openwop:accessibility.check', false],
  ['openwop:ai.research.web', false],
  ['openwop:analytics.query', false],
  ['openwop:app-builder.catalog', true],
  ['openwop:app-builder.get-design', true],
  ['openwop:app-builder.render', false],
  ['openwop:assistant.compose-briefing', false],
  ['openwop:assistant.enqueue-action', false],
  ['openwop:assistant.list-commitments', false],
  ['openwop:assistant.list-pending-actions', false],
  ['openwop:assistant.populate-board', false],
  ['openwop:assistant.upsert-commitment', false],
  ['openwop:bi.list-metrics', true],
  ['openwop:bi.run-metric', false],
  ['openwop:brand.compliance-check', false],
  ['openwop:brand.list-brands', false],
  ['openwop:brand.resolve-voice', false],
  ['openwop:cad.get-design', true],
  ['openwop:cad.render', false],
  ['openwop:campaign-brief.generate-kernel', false],
  ['openwop:campaign-brief.get-brief', false],
  ['openwop:campaign-brief.research.run', false],
  ['openwop:campaign-brief.validate', false],
  ['openwop:campaign-channels.channels', true],
  ['openwop:campaign-channels.generate', false],
  ['openwop:campaign-intel.attribution', false],
  ['openwop:campaign-intel.budget-optimize', false],
  ['openwop:campaign-intel.forecast', false],
  ['openwop:campaign-intel.pacing', false],
  ['openwop:campaign-intel.plan-budget', false],
  ['openwop:campaign-orchestration.run', false],
  ['openwop:campaign-orchestration.status', false],
  ['openwop:campaign-studio.get-design', true],
  ['openwop:campaign-studio.render', false],
  ['openwop:cdp.identity.resolve', false],
  ['openwop:channels.list', false],
  ['openwop:cms.get-draft-page', true],
  ['openwop:cms.get-page', false],
  ['openwop:cms.list-pages', false],
  ['openwop:cms.submit-page', false],
  ['openwop:cms.translate-section', false],
  ['openwop:cms.update-section-draft', false],
  ['openwop:comments.list', false],
  ['openwop:comments.post', false],
  ['openwop:computer-use.status', false],
  ['openwop:conversations.export-document', false],
  ['openwop:conversations.search', false],
  ['openwop:core.flow.aggregate-text', false],
  ['openwop:core.flow.split-in-batches', false],
  ['openwop:core.openwop.data.json-schema-validate', false],
  ['openwop:core.openwop.data.jsonpath-query', false],
  ['openwop:core.openwop.http.fetch', false],
  ['openwop:core.rag.retriever-basic', false],
  ['openwop:core.rag.retriever-contextual-compression', false],
  ['openwop:creative-briefs.list', false],
  ['openwop:crm.lead.capture', false],
  ['openwop:dealers.list-dealers', false],
  ['openwop:dealers.list-outlets', false],
  ['openwop:dealers.list-registrations', false],
  ['openwop:destination-sync.dry-run', false],
  ['openwop:destination-sync.list', false],
  ['openwop:destination-sync.run', false],
  ['openwop:discovery.create-collection', false],
  ['openwop:discovery.create-rule', false],
  ['openwop:discovery.list-collections', false],
  ['openwop:discovery.list-rules', false],
  ['openwop:discovery.search', false],
  ['openwop:documents.draft', false],
  ['openwop:documents.generate-from-template', false],
  ['openwop:documents.get', false],
  ['openwop:documents.get-template', true],
  ['openwop:documents.list-templates', true],
  ['openwop:drawings.get-design', true],
  ['openwop:drawings.render', false],
  ['openwop:email.draft', false],
  ['openwop:email.get-campaign', false],
  ['openwop:email.save-draft', false],
  ['openwop:entities.describe-type', true],
  ['openwop:entities.query', false],
  ['openwop:feature.agent-author.nodes.draft', false],
  ['openwop:feature.agent-author.nodes.get', true],
  ['openwop:feature.agent-author.nodes.persist', false],
  ['openwop:feature.agent-author.nodes.validate', false],
  ['openwop:feature.assistant.nodes.prioritize', false],
  ['openwop:feature.code-exec.nodes.run', false],
  ['openwop:feature.commerce.buyer.nodes.build-cart', false],
  ['openwop:feature.commerce.buyer.nodes.checkout', false],
  ['openwop:feature.commerce.buyer.nodes.list-purchases', false],
  ['openwop:feature.commerce.buyer.nodes.track-order', false],
  ['openwop:feature.commerce.nodes.create-quote', false],
  ['openwop:feature.commerce.nodes.get-order', false],
  ['openwop:feature.commerce.nodes.get-quote', false],
  ['openwop:feature.commerce.nodes.list-coupons', false],
  ['openwop:feature.commerce.nodes.list-orders', false],
  ['openwop:feature.commerce.nodes.list-products', false],
  ['openwop:feature.commerce.nodes.list-quotes', false],
  ['openwop:feature.commerce.nodes.resolve-price', false],
  ['openwop:feature.crm.nodes.create-task', false],
  ['openwop:feature.crm.nodes.get-company', false],
  ['openwop:feature.crm.nodes.get-deal', false],
  ['openwop:feature.crm.nodes.list-companies', false],
  ['openwop:feature.crm.nodes.list-deals', false],
  ['openwop:feature.crm.nodes.list-segment-members', false],
  ['openwop:feature.crm.nodes.list-tasks', false],
  ['openwop:feature.crm.nodes.log-activity', false],
  ['openwop:feature.crm.nodes.persist-segment', false],
  ['openwop:feature.crm.nodes.segment-vocabulary', true],
  ['openwop:feature.crm.nodes.validate-segment', true],
  ['openwop:feature.csm.nodes.health-read', false],
  ['openwop:feature.insights-suite.nodes.talent-score', false],
  ['openwop:feature.insights-suite.nodes.variance-compute', false],
  ['openwop:feature.workflow-author.nodes.draft', true],
  ['openwop:feature.workflow-author.nodes.get', true],
  ['openwop:feature.workflow-author.nodes.persist', false],
  ['openwop:feature.workflow-author.nodes.validate', false],
  ['openwop:forms.list-forms', false],
  ['openwop:forms.list-submissions', false],
  ['openwop:funnels.draft', false],
  ['openwop:funnels.get', false],
  ['openwop:funnels.list', false],
  ['openwop:funnels.step-stats', false],
  ['openwop:goals.list', false],
  ['openwop:intent-ledger.draft-contract', false],
  ['openwop:intent-ledger.get', true],
  ['openwop:interactive-artifacts.get', true],
  ['openwop:interactive-artifacts.render', false],
  ['openwop:job-search.applications.read', false],
  ['openwop:job-search.listings.read', false],
  ['openwop:kanban.add-todo', false],
  ['openwop:kicktodo.candidates', false],
  ['openwop:kicktodo.circles', false],
  ['openwop:kicktodo.community-reviews', false],
  ['openwop:kicktodo.convene', false],
  ['openwop:kicktodo.engagement-summary', false],
  ['openwop:kicktodo.factory.run', false],
  ['openwop:kicktodo.integrations-status', false],
  ['openwop:kicktodo.journal', false],
  ['openwop:kicktodo.log-checkin', false],
  ['openwop:kicktodo.plan', false],
  ['openwop:kicktodo.progress', false],
  ['openwop:kicktodo.proposals', false],
  ['openwop:kicktodo.replan', false],
  ['openwop:kicktodo.today', false],
  ['openwop:knowledge.search', false],
  ['openwop:marketplace.search', false],
  ['openwop:media.list', false],
  ['openwop:notebooks.ask', false],
  ['openwop:notebooks.search', false],
  ['openwop:notebooks.write-transformation', false],
  ['openwop:notifications.notify-me', false],
  ['openwop:podcasts.list', false],
  ['openwop:podcasts.produce', false],
  ['openwop:priority-matrix.generate-agenda', false],
  ['openwop:priority-matrix.list-lists', true],
  ['openwop:priority-matrix.list-ranked-ideas', true],
  ['openwop:priority-matrix.schedule-status', false],
  ['openwop:priority-matrix.score-idea', false],
  ['openwop:priority-matrix.submit-idea', false],
  ['openwop:production.get-vendors', false],
  ['openwop:production.plan', false],
  ['openwop:projects.list', false],
  ['openwop:promotions.apply-preview', false],
  ['openwop:promotions.draft', false],
  ['openwop:promotions.list', false],
  ['openwop:proposals.list', false],
  ['openwop:recommendations.create-placement', false],
  ['openwop:recommendations.list-placements', false],
  ['openwop:recommendations.resolve', false],
  ['openwop:runs.diagnose', false],
  ['openwop:sales-commissions.list-plans', false],
  ['openwop:sales-commissions.list-statements', false],
  ['openwop:schema.lookup', true],
  ['openwop:servicedesk.draft-reply', false],
  ['openwop:servicedesk.get-ticket', false],
  ['openwop:servicedesk.list-tickets', false],
  ['openwop:servicedesk.set-status', false],
  ['openwop:slides.catalog', true],
  ['openwop:slides.get-design', true],
  ['openwop:slides.render', false],
  ['openwop:strategy.create-board-memo', false],
  ['openwop:strategy.get-context', false],
  ['openwop:strategy.get-health', false],
  ['openwop:strategy.get-strategy', false],
  ['openwop:strategy.list-strategies', false],
  ['openwop:tasks.deck', false],
  ['openwop:tasks.schedule-followup', false],
  ['openwop:tasks.schedule-recurring', false],
  ['openwop:territories.active-model', false],
  ['openwop:territories.attainment', false],
  ['openwop:territories.list-models', false],
  ['openwop:territories.list-quotas', false],
  ['openwop:territories.list-rules', false],
  ['openwop:territories.list-territories', false],
  ['openwop:territories.preview', false],
  ['openwop:tutorials.catalog', false],
  ['openwop:tutorials.get', false],
  ['openwop:walkthroughs.register-draft', false],
  ['openwop:work-selection.preview', false],
  ['openwop:workflows.compose-and-run', false],
  ['openwop:workflows.propose', false],
];

/**
 * ADR 0604 review H4 — THE ADJUDICATION OF EVERY `TOCC-2a` LEAD.
 *
 * "The gate forces a ROW, not a CORRECT row. Emptying the array reddens; adding
 * an unclassified tool reddens; classifying a schema-carrying tool `false` is
 * GREEN today, in production." The runtime denominator fixed COMPLETENESS and
 * does nothing for CORRECTNESS — and three rows were in fact wrong, answered
 * `false` in one pass with no recorded reasoning, after which the negative
 * control at the bottom of this file PINNED those answers.
 *
 * `TOCC-2a` named five verified misses AND ~14 LEADS TO VERIFY, explicitly
 * flagged "a filed count is a floor". Every lead is adjudicated below, `true`
 * and `false` alike, with the mechanism that decided it. A silent `false` is
 * not an answer.
 *
 * THE RULE APPLIED, stated once so the verdicts are checkable rather than
 * taste. `schemaCarrying: true` iff the payload's ELEMENT LIST IS ITSELF THE
 * CONTRACT — some consumer REJECTS or MISBEHAVES on a value that is not in it —
 * in one of four shapes:
 *   (a) a schema / enum body (`schema.lookup`, `entities.describe-type`);
 *   (b) a closed catalog of legal ids whose SIBLING ENFORCES membership with a
 *       typed refusal (`app-builder.catalog`, `bi.list-metrics`);
 *   (c) a body the model READS BEFORE IT WRITES a replacement (the `get-design`
 *       family, `cms.get-draft-page`);
 *   (d) an INVERTED-POLARITY list — a prohibition/ban list, where truncation
 *       removes a constraint (`intent-ledger.get`'s `forbidden`).
 * Plus a necessary condition that is easy to forget and settled two leads here:
 * the payload must actually be TRUNCATABLE by the kernel. `lossy` elides
 * ARRAYS and drops EMPTIES; it never shortens a string.
 *
 * ── THE DESCRIPTION-PARITY RATCHET: MEASURED, THEN DECLINED ──
 *
 * The review proposed a stronger gate — "a description containing 'the only
 * legal' / 'closed' / 'catalog' / 'never invent' ⇒ must be
 * `schemaCarrying: true`" — and correctly flagged it as a suggestion needing a
 * blast-radius measurement first. MEASURED over all `registerFeatureAgentTool`
 * descriptions in `src/**`: 21 tools match that phrase set. About 7 are
 * genuinely schema-carrying. The other ~14 are FALSE POSITIVES with a common
 * shape — they are WRITE tools whose description mentions the closed world they
 * validate AGAINST: `app-builder.render`, `cad.render`, `slides.render`,
 * `workflows.propose`, `walkthroughs.register-draft`,
 * `commerce.buyer.build-cart`, `crm.lead.capture` — plus reads whose "catalog"
 * is a product catalogue in the retail sense (`commerce.list-products`,
 * `discovery.search`). A ~67% false-positive rate on a 21-item population would
 * force fourteen wrong exemptions or fourteen suppressions, and a gate whose
 * normal state is "suppressed" teaches people to suppress it.
 *
 * NOT ADOPTED as a hard rule. The salvageable form, recorded for whoever picks
 * this up: use the phrase set to NOMINATE a lead and require an adjudicated row
 * (true or false), never to force the verdict — i.e. exactly the shape of
 * `ADJUDICATED` below, widened from the `TOCC-2a` list to the phrase hits. That
 * is a real forcing function; it just costs ~14 more written judgments than
 * this review's scope, and filler rows would be worse than none.
 */
const ADJUDICATED: Record<string, { schemaCarrying: boolean; why: string }> = {
  // ── FLIPPED to true (was a silent `false`) ────────────────────────────────
  'openwop:bi.list-metrics': {
    schemaCarrying: true,
    why:
      '(b) Its description calls it "the BI catalog" and `bi.run-metric` resolves `metricId` with a TYPED '
      + 'not-found (features/bi/agentTools.ts). Structural twin of app-builder.catalog / slides.catalog. '
      + 'Probed eliding: ["metric-0","metric-1","metric-2",{_elided:8},"metric-11"].',
  },
  'openwop:campaign-channels.channels': {
    schemaCarrying: true,
    why:
      '(b) `channelCatalog()`\'s own comment states it verbatim — "grounds the agent — never a guessed '
      + 'channel id" — and each row carries the workflowId the generator dispatches. MEASURED: five '
      + 'channels today and lossy elides at >5, so the exemption is PREVENTIVE; the contract is the '
      + 'invariant, not the current length.',
  },
  'openwop:intent-ledger.get': {
    schemaCarrying: true,
    why:
      '(d) Returns the mission contract\'s `allowed` AND `forbidden` tool-id arrays; a `forbidden` list of '
      + 'five or more truncates under lossy, deleting a PROHIBITION from what the model is told. Honest '
      + 'bound: enforcement is server-side, so this is model misinformation, not privilege escalation.',
  },
  'openwop:cms.get-draft-page': {
    schemaCarrying: true,
    why:
      '(b)+(c) "the read-before-write for editing", and `surface.updateSectionDraft` returns '
      + '{updated:false, reason:"section_not_found"} — a typed refusal, no write — for any sectionId not '
      + 'in the `sections[]` it returns. A page over five sections elides its middle.',
  },
  'openwop:interactive-artifacts.get': {
    schemaCarrying: true,
    why:
      '(c) "read before revising", and `render` OVERWRITES. Truncatability VERIFIED, not assumed: for '
      + 'kind:"chart" the stored payload is the structured {chartType, data, options} object whose `data` '
      + 'arrays elide. (The text kinds store a raw source STRING, which the kernel never truncates.)',
  },

  // ── ADJUDICATED false, with the mechanism ─────────────────────────────────
  'openwop:brand.resolve-voice': {
    schemaCarrying: false,
    why:
      'FALSIFIED, and it was the lead with the best prior — an inverted-polarity BAN list, the worst '
      + 'polarity in the class. But `resolveVoice` (brand/scoring.ts:157) returns a STRING: the banned '
      + 'phrases are joined into markdown prose, so the payload is {brandId, brandName, voice:"…"} and '
      + 'the kernel cannot truncate it. Necessary condition fails. Re-open if `voice` ever becomes structured.',
  },
  'openwop:tutorials.catalog': {
    schemaCarrying: false,
    why:
      'Closed-world PHRASING ("the only way to know what already exists"; `tutorials.get` points back at '
      + 'it "for the real ids") but no ENFORCEMENT: `tutorials.get` on an unknown id returns an honest '
      + '{tutorial:null, note} — nothing is refused, nothing is forbidden. Truncation degrades a '
      + 'RECOMMENDATION, which is the ordinary loss `lossy` is opted into for.',
  },
  'openwop:forms.list-forms': {
    schemaCarrying: false,
    why:
      'Same shape as tutorials: `forms.list-submissions` says "Requires a formId (from list-forms)" but '
      + 'an unknown/foreign formId returns `toolEmpty({submissions: [], note})`, deliberately, to avoid a '
      + 'cross-tenant existence probe. No typed refusal ⇒ the list is not a contract.',
  },
  'openwop:cms.get-page': {
    schemaCarrying: false,
    why:
      'The PUBLISHED read. Its draft sibling IS exempt, and the difference is load-bearing rather than an '
      + 'oversight: `update-section-draft` "works ONLY on draft pages", so no write tool cites a sectionId '
      + 'from this payload. Nothing enforces the element list.',
  },
  'openwop:discovery.list-collections': {
    schemaCarrying: false,
    why:
      '`discovery.search` takes `collectionId` as an OPTIONAL narrowing filter, not an enforced key — an '
      + 'unknown value narrows to nothing rather than being refused, and no tool requires an id from this '
      + 'list. Plain app-state read.',
  },
  'openwop:discovery.list-rules': {
    schemaCarrying: false,
    why:
      'No tool in the feature consumes a `ruleId` at all — `create-rule` MINTS one and returns it. The '
      + 'list has no downstream citer, so its element list cannot be a contract.',
  },
  'openwop:recommendations.list-placements': {
    schemaCarrying: false,
    why:
      '`recommendations.resolve` selects by `slot`, which is an ENUM ON ITS OWN INPUT SCHEMA (RECO_SLOTS) '
      + '— the closed world reaches the model through the schema, not through this payload. `placementId` '
      + 'is an OUTPUT of resolve, never an input.',
  },
  'openwop:kicktodo.today': {
    schemaCarrying: false,
    why:
      "A coaching read of the caller's own day. No id in it is required byte-exact by any sibling; the "
      + 'write tools (log-checkin / replan) key off activity ids the same call already carries in context. '
      + 'Ordinary app state.',
  },
  'openwop:cad.get-design': {
    schemaCarrying: true,
    why: '(c) read-before-write design body. Already exempt before this review; adjudicated here because TOCC-2a listed the get-design family as leads.',
  },
  'openwop:drawings.get-design': {
    schemaCarrying: true,
    why: '(c) read-before-write design body. Already exempt before this review; listed by TOCC-2a as part of the get-design family.',
  },
  'openwop:campaign-studio.get-design': {
    schemaCarrying: true,
    why: '(c) read-before-write design body. Already exempt before this review; listed by TOCC-2a as part of the get-design family.',
  },
};

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('schema-read exemption completeness (ADR 0604 / TOCC-2)', () => {
  it('the runtime registry is fully booted — the denominator is real', () => {
    // Without this the whole file is vacuous: an empty registry makes every
    // "for each id" assertion below pass by iterating nothing. The floor is the
    // measured count at authoring time.
    expect(builtinAgentToolIds().length).toBeGreaterThanOrEqual(201);
    expect(builtinAgentToolIds()).toContain('openwop:schema.lookup');
    expect(builtinAgentToolIds()).toContain('openwop:feature.crm.nodes.segment-vocabulary'); // a PROJECTED id
  });

  it('EVERY registered tool is classified — a new tool fails until someone decides', () => {
    const classified = new Set(CLASSIFICATION.map(([id]) => id));
    const unclassified = builtinAgentToolIds().filter((id) => !classified.has(id));
    expect(
      unclassified,
      'A tool was registered without a schema-carrying decision. Add it to CLASSIFICATION in ' +
        'this file: `true` if its output is a schema / enum / closed catalog of legal ids / a ' +
        'design body whose element list IS the contract, else `false`. If `true`, also set ' +
        '`schemaCarrying: true` on its `registerFeatureAgentTool({...})` and add its id to ' +
        'SCHEMA_READ_EXEMPT_TOOLS.',
    ).toEqual([]);
  });

  it('the classification has no ghosts — every classified id is still registered', () => {
    const live = new Set(builtinAgentToolIds());
    expect(CLASSIFICATION.filter(([id]) => !live.has(id)).map(([id]) => id)).toEqual([]);
  });

  it('every schema-carrying tool is actually EXEMPT at the transform boundary', () => {
    const shouldBeExempt = CLASSIFICATION.filter(([, s]) => s).map(([id]) => id);
    // Floor: the loop is vacuous empty. Raised 18 → 23 by the five review-H4
    // flips; a floor that lags the population lets a deletion pass unseen.
    expect(shouldBeExempt.length).toBeGreaterThanOrEqual(23);
    for (const id of shouldBeExempt) {
      expect(isSchemaReadExempt(id), `${id} is schema-carrying but NOT exempt`).toBe(true);
      expect(builtinAgentTool(id)?.schemaCarrying, `${id} must DECLARE it, not only be listed`).toBe(true);
      expect(SCHEMA_READ_EXEMPT_TOOLS, `${id} must also be in the registration-independent floor`).toContain(id);
    }
  });

  it('the two lanes agree — the literal array never exempts something undeclared', () => {
    // The array is a floor for processes where a feature has not registered. It
    // must not become a SECOND source of truth that drifts from the declarations.
    for (const id of SCHEMA_READ_EXEMPT_TOOLS) {
      expect(builtinAgentTool(id)?.schemaCarrying, `${id} is listed but does not declare schemaCarrying`).toBe(true);
    }
  });

  it('every TOCC-2a lead has a RECORDED adjudication, not a silent false', () => {
    // The lead list from the feature-32 assessment, pinned so the population
    // cannot quietly shrink. "A filed count is a floor" — these are the ids
    // that were named and left unverified; each now carries its mechanism.
    const LEADS = [
      'openwop:bi.list-metrics', 'openwop:forms.list-forms', 'openwop:cms.get-page',
      'openwop:cms.get-draft-page', 'openwop:brand.resolve-voice', 'openwop:tutorials.catalog',
      'openwop:campaign-channels.channels', 'openwop:intent-ledger.get',
      'openwop:discovery.list-collections', 'openwop:discovery.list-rules',
      'openwop:recommendations.list-placements', 'openwop:kicktodo.today',
      'openwop:cad.get-design', 'openwop:drawings.get-design',
      'openwop:campaign-studio.get-design', 'openwop:interactive-artifacts.get',
    ];
    const missing = LEADS.filter((id) => !(id in ADJUDICATED));
    expect(missing, 'a TOCC-2a lead was left without a recorded judgment').toEqual([]);
    for (const [id, row] of Object.entries(ADJUDICATED)) {
      expect(row.why.length, `${id}'s adjudication states no mechanism`).toBeGreaterThan(120);
    }
  });

  it('every adjudication AGREES with the classification it justifies', () => {
    // The two cannot drift: a note saying "true" beside a row saying `false` is
    // the exact shape of the defect this whole section exists to close.
    const classified = new Map(CLASSIFICATION);
    for (const [id, row] of Object.entries(ADJUDICATED)) {
      expect(classified.has(id), `${id} is adjudicated but not classified — is it still registered?`).toBe(true);
      expect(classified.get(id), `${id}: the adjudication and the classification disagree`).toBe(row.schemaCarrying);
    }
  });

  it('NEGATIVE CONTROL — a classified-false tool is NOT exempt', () => {
    const plainData = CLASSIFICATION.filter(([, s]) => !s).map(([id]) => id);
    expect(plainData.length).toBeGreaterThan(150);
    for (const id of plainData) {
      expect(isSchemaReadExempt(id), `${id} is classified plain data but is exempt`).toBe(false);
    }
  });
});
