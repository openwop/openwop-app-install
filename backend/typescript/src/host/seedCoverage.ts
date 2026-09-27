/**
 * Feature ↔ demo-seed coverage projection (DG-SEED-5).
 *
 * "A feature shipped without demo data" was invisible: nothing tied the
 * `EXAMPLE_DATA_SEEDERS` registry to the feature registry, so a new toggled
 * feature could ship with an empty demo surface and no one would notice. This
 * projection makes it review-visible — `test/seed-coverage.test.ts` fails when a
 * toggled feature is neither seeded by the demo program NOR explicitly
 * acknowledged as intentionally demo-data-free below. Adding a feature then
 * forces a decision: give it a `demo-*` seeder (add its toggle to
 * `DEMO_FEATURE_TOGGLE_IDS`) or record WHY it needs none here.
 *
 * Scope: only features that declare a `toggleDefault` — the always-on substrate
 * (users/profiles/orgs/media/agents…) is seeded unconditionally by the base
 * seeders and has no toggle to gate on.
 */

import { BACKEND_FEATURES } from '../features/index.js';
import { DEMO_FEATURE_TOGGLE_IDS } from './demoProvision.js';

const SEEDED = new Set<string>(DEMO_FEATURE_TOGGLE_IDS);

/**
 * Toggle ids of features that legitimately ship NO demo data — plumbing,
 * operator/inspector surfaces, cross-cutting runtime behavior, or capabilities
 * whose "data" is produced by using the app rather than seeded. Keep the reason
 * terse; the point is that the exclusion was a decision, not an oversight.
 */
export const ACKNOWLEDGED_UNSEEDED: Readonly<Record<string, string>> = {
  'work-selection':
    'ranked work selection (ADR 0534) — the feature PERSISTS NOTHING. The ranking is recomputed per heartbeat pass from live card fields (priority, dueAt, age, blockerNote); there is no store, no table and no KV namespace to seed. What a demo needs is richer KANBAN cards, which the kanban seeders own — see DATA-ASSESSMENT-work-loop-0534-0535.md SEED-WL-1.',
  'agent-author':
    'describe-to-create authoring (ADR 0514) — the feature PRODUCES agents; its data is whatever a user authors by using it, and an authored agent lands DISABLED pending human review. Seeding fake authored agents would fabricate the artifact the feature exists to demonstrate, and they would sit disabled anyway. The demo roster is already populated by the base agent seeders.',
  'kicktodo-engagement':
    'engagement (ADR 0425) — opt-in rows encode REAL user consent to visibility; awards/stats derive from real check-ins. Seeding either would fabricate both.',
  'kicktodo-metrics':
    'metrics (ADR 0432) — every number is COMPUTED ON READ from real enrollments/check-ins/candidates; there is nothing to seed, and seeded outcomes would fabricate evidence that the product works.',
  'kicktodo-organizations':
    'org programs (ADR 0428) — libraries/cohort links are REAL org-admin curation over accessControl orgs; reports derive from real cohort outcomes. Seeding would fabricate governance decisions.',
  'kicktodo-community':
    'community (ADR 0426) — profiles need REAL approval decisions; reviews need REAL purchase/completion proof. Seeding either would fabricate social trust signals.',
  'kicktodo-integrations': 'integration consents (ADR 0421) — consent rows encode REAL user decisions over live Connections; seeded fake consents would fabricate consent. Lanes activate through real usage.',
  'kicktodo-accountability': 'accountability circles/grants (ADR 0419) — grants encode REAL consent between real subjects; seeded fake grants would fabricate consent. Demo circles ride real usage.',
  'kicktodo-commerce': 'money adapter (ADR 0420) — entitlements derive from REAL paid orders via the fulfilment observers; seeding fake entitlements would fabricate money truth. Demo commerce data rides the commerce feature seeds.',
  'kicktodo-creator': 'Challenge Factory (ADR 0415) — candidates are produced by governed research with REAL provider evidence (stub retrieval fails closed); a seeded fake candidate would carry fabricated provenance. Content ops (D5) seeds the first real catalog.',
  'kicktodo-core': 'KickTodo consumer spine (ADR 0414) — challenge content is produced by the governed Challenge Factory (ADR 0415) with provenance/evidence bundles; a fabricated demo challenge would violate the PRD content-provenance rule. Seeded content lands with the D-stream factory MVP.',
  whatsapp: 'official BSP messaging channel (ADR 0394) — sends require a live Twilio connection + a bound WhatsApp number + recipient opt-in; no tenant demo entity to seed',
  webinars: 'Zoom webinar connector (ADR 0404) — marketing-events + attendance activities are INGESTED from a live Zoom OAuth connection (registration/attend/no-show webhooks + report sync); a demo seed would fabricate webinar events + fake registrant attendance the tenant never ran',
  'creative-video': 'AI avatar video provider (ADR 0404) — generations require a live HeyGen-class connection + count against the metered (default-OFF) video budget; produced assets land in the (seeded) media library from real jobs, so there is no standalone demo entity to seed',
  'computer-use': 'agent browser sessions (ADR 0418) — sessions are live provider-driven trajectories with human approval gates; a seeded fake trajectory would fabricate an execution record that never ran',
  'app-builder.deploy': 'governed deployment (ADR 0424) — deployments are live provider actions against operator infrastructure; a seeded fake deployment record would fabricate an audit trail for a deploy that never ran',
  'service-desk.widget': 'public widget ticketing (ADR 0422 P5) — visitor threads are live anonymous sessions against a published intake key; nothing to seed',
  'service-desk': 'support tickets (ADR 0422) — tickets are live customer conversations attached to CRM contacts; a seeded fake thread would fabricate customer messages nobody sent (the seeded CRM contacts/activities cover the demo story)',
  bi: 'semantic metric catalog (ADR 0417) — system metrics ship as in-code definitions (never stored rows) and measure the ALREADY-seeded kernel entities (deals/products/companies), so a separate BI demo seed would duplicate the source-data seeds',
  'settings-shell': 'the consolidated personal-settings surface (ADR 0396) — per-user prefs, no tenant demo entity to seed',
  operations: 'operator admin console (ADR 0395) — read panels over live operational state (webhook queue, trigger deliveries, DLQ, readiness); no tenant demo entity to seed',
  // Runtime behavior — "data" is produced by using the app, nothing to seed.
  'chat-autotitle': 'runtime chat behavior — no persisted demo entity',
  'multi-tab-chat': 'runtime chat UI behavior — no data',
  accessibility: 'authored-content a11y (ADR 0363) — alt text/checks ride EXISTING media/cms/document content; no standalone demo entity to seed',
  'tool-output-compaction': 'runtime tool-output behavior — no data',
  'twin-recall': 'runtime memory recall — no seeded corpus',
  voice: 'runtime voice chat — no seeded transcript',
  'chat-deployment': 'operator config (embed/deploy a chat) — not tenant demo data',
  'realtime-collab': 'runtime CRDT sync transport (ADR 0335/0359, all canvas types, OFF) — collaboration sessions are runtime state, no persisted demo entity',
  'workflow-collab': 'builder multiplayer over the same runtime transport (ADR 0481, OFF) — rooms are runtime state; the workflow head remains the seeded/authored entity',
  // Creative authoring tools — content is user-authored, not seeded.
  'canvas-packs': 'editors for pack-declared canvas types (ADR 0310 Phase D) — canvases are user-authored from chat artifacts; demo seeders do not install third-party packs',
  entities: 'headless content-modeling (ADR 0386) — content types + records are tenant-authored modelling artifacts; a demo seed would fabricate a domain the tenant never defined',
  environments: 'config promotion/rollback (ADR 0387) — snapshots + promotions are operator-authored config-version artifacts (like feature toggles themselves); no tenant business demo data to seed',
  'commerce-connect': 'two-sided Stripe Connect marketplace (ADR 0385) — seller onboarding requires live/sandbox Stripe Connect credentials (operator-gated); a demo seed cannot mint Connect accounts',
  docs: 'product-docs surface (ADR 0392) — docs are OPERATOR/product-authored CMS pages published to the public /docs tier + a managed KB collection; tenant demo data would fabricate product documentation (revisit if ADR 0392 grows its own doc seeder)',
  cad: 'creative tool — user-authored CAD',
  drawings: 'creative tool — user-authored drawings',
  notebooks: 'creative tool — user-authored notebooks',
  podcasts: 'creative tool — user-authored podcasts',
  slides: 'creative tool — user-authored slides',
  'document-editor': 'creative tool — user-authored rich-text documents (canvas.document, ADR 0334)',
  'campaign-studio': 'creative surface over the (seeded) campaign features',
  // Operator / infrastructure / registry surfaces.
  'custom-domains': 'operator infra config — no tenant demo data',
  'developer-tools': 'gated dev inspectors — no business data',
  marketplace: 'pack registry surface — not tenant demo data',
  'ui-plugins': 'plugin infra — operator surface',
  'knowledge-sync': 'BYOK connector sync — no credential minting / seed',
  // Derived / self-populating analytics.
  'campaign-intel': 'derived attribution/pacing — self-populates from campaign activity',
  // ADR 0599 — this exemption used to read "derived insights — self-populates".
  // Nothing populated and nothing COULD: all three chains died `invalid_config`
  // at their first node from the ADR 0082 rebuild until ADR 0599. A coverage
  // exemption granted on a false premise is a hole with a note on it. The
  // exemption still stands — the feature genuinely has no seedable store, its
  // results ARE run outputs — but the reason is now the true one.
  'insights-suite': 'no store to seed — results are run outputs (runs/artifacts/notifications), never persisted rows',
  'usage-analytics': 'derived usage metrics — self-populates',
  // Collaboration primitives populated by use.
  comments: 'collaboration primitive — populated by use',
  // Billing = the tenant\'s OWN SaaS plan, not demo business data.
  billing: 'tenant SaaS billing — not demo business data',
  // Campaign plumbing whose user-facing siblings ARE seeded (brief/orchestration).
  'campaign-channels': 'campaign channel plumbing — siblings seeded (brief/orchestration)',
  campaigns: 'campaigns umbrella — seeded via campaign-brief/orchestration',
  // Always-on substrate seeded by a base (non-toggle-gated) seeder.
  orgs: 'org seeded by demo-people (always-on substrate, not toggle-gated)',
  // Owned by another program's demo-data effort.
  funnels: 'owned by the funnel-migration program (ADR 0293–0297); demo data is that program\'s job',
};

export interface SeedCoverageRow {
  featureId: string;
  toggleId: string;
  /** Seeded by a `demo-*` seeder (its toggle is in `DEMO_FEATURE_TOGGLE_IDS`). */
  seeded: boolean;
  /** Deliberately demo-data-free, with the recorded reason. */
  acknowledged: boolean;
  reason?: string;
}

/** One row per toggled feature, sorted by toggle id. */
export function buildSeedCoverage(): SeedCoverageRow[] {
  return BACKEND_FEATURES.filter((f) => f.toggleDefault)
    .map((f) => {
      const toggleId = f.toggleDefault!.id;
      const acknowledged = Object.prototype.hasOwnProperty.call(ACKNOWLEDGED_UNSEEDED, toggleId);
      return {
        featureId: f.id,
        toggleId,
        seeded: SEEDED.has(toggleId),
        acknowledged,
        ...(acknowledged ? { reason: ACKNOWLEDGED_UNSEEDED[toggleId] } : {}),
      };
    })
    .sort((a, b) => a.toggleId.localeCompare(b.toggleId));
}

/** Toggle ids that are neither seeded nor acknowledged — the review-visible gap. */
export function uncoveredFeatureToggles(): string[] {
  return buildSeedCoverage()
    .filter((r) => !r.seeded && !r.acknowledged)
    .map((r) => r.toggleId);
}
