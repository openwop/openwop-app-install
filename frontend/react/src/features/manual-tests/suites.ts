/**
 * Manual-test suites (authored by `/manual-tests`). Full coverage: every
 * user-facing feature in the FEATURES manifest. OFF (toggle-gated) features lead
 * with an "enable-first" case. Each suite records `sourceCommit` + `sourceFiles`
 * so the skill can detect staleness on later runs.
 */
import type { FeatureToggle, TestSuite, TestCategory } from './manualTestTypes.js';

const AT = '2026-06-17';
const SHA0 = '7ebb93b6'; // original first-pass suites
const SHA = 'fbea4434';  // this expansion
const AT2 = '2026-06-20';
const SHA2 = '8e9770e4'; // a11y pass: Strategy suite + chat workflow-progress cases
const AT3 = '2026-07-04';
const SHA3 = 'eaf86b86'; // CRM · Gmail inbox sync suite (ADR 0252)
const ON = { off: false, howToEnable: [] as string[] };

/** OFF feature gated by a `/feature-toggles` flag — the standard enable recipe.
 *
 *  ADR 0600 §7 (`ISU-16`) — step 3 used to read "the feature appears in the nav
 *  and its route is reachable" unconditionally. That is FALSE for every feature
 *  with no page, and this boilerplate is what a human tester follows: they would
 *  file the missing nav entry as THE bug and never reach the real one. `hasPage`
 *  makes the claim conditional instead of dropping it — a feature that DOES get
 *  a nav entry should still be told so. */
const offVia = (id: string, opts: { hasPage?: boolean } = {}): FeatureToggle => ({
  off: true,
  id,
  howToEnable: [
    'Open Admin → Platform → Feature toggles (/feature-toggles)',
    `Switch the "${id}" toggle ON for your tenant`,
    opts.hasPage === false
      ? 'Reload. This feature has NO nav entry and NO route of its own — it surfaces through the chat, the Builder gallery, runs and notifications. Do not look for a page.'
      : 'Reload — the feature appears in the nav and its route is reachable',
  ],
  howToRevert: [`Switch the "${id}" toggle OFF again on /feature-toggles`],
});

export const SUITES: TestSuite[] = [
  // ── KickTodo G/H waves (ADRs 0425/0426/0428/0432 + 0429/0430) ───────────
  {
    key: 'kicktodo-engagement', feature: 'KickTodo Engagement', route: '/leaderboard',
    description: 'Opt-in leaderboard (k-floor, closed projection) and deterministic awards.',
    toggle: offVia('kicktodo-engagement'), updatedAt: '2026-07-19', sourceCommit: '',
    sourceFiles: ['frontend/react/src/features/kicktodo-engagement', 'backend/typescript/src/features/kicktodo-engagement'],
    cases: [
      { id: 'KTE-01', title: 'The join gate discloses exactly what becomes visible', priority: 'P0', blocker: true,
        preconditions: ['kicktodo-engagement toggle ON'],
        steps: [
          { action: 'Navigate to /leaderboard without having joined', expect: 'The join card states that ONLY a display name and completed-action count become visible to other members, and that leaving is immediate' },
          { action: 'Enter a display name and press Join', expect: 'The board renders with you on it' },
        ] },
      { id: 'KTE-02', title: 'Below 3 members the board shows only you, and says why', priority: 'P0', blocker: true,
        preconditions: ['Fewer than 3 members have joined in this workspace'],
        steps: [
          { action: 'View the board', expect: 'An info notice explains the board shows others once at least 3 members join; only your own row is listed — no partial list of other people' },
        ] },
      { id: 'KTE-03', title: 'Leaving is immediate', priority: 'P1', blocker: false,
        preconditions: ['You have joined'],
        steps: [
          { action: 'Press "Leave leaderboard", then reload', expect: 'You are back to the join gate; your row is gone from the board for everyone' },
        ] },
      { id: 'KTE-04', title: 'Awards appear as labeled chips after a check-in', priority: 'P1', blocker: false,
        preconditions: ['kicktodo-core ON with an active enrollment'],
        steps: [
          { action: 'Complete one action on /today, then return to the leaderboard', expect: 'A "First check-in" award chip appears; repeating the same check-in does NOT add a duplicate award' },
        ] },
    ],
  },
  {
    key: 'kicktodo-community', feature: 'KickTodo Community', route: '/kicktodo/community',
    description: 'Approval-gated creator profiles and proof-gated challenge reviews.',
    toggle: offVia('kicktodo-community'), updatedAt: '2026-07-19', sourceCommit: '',
    sourceFiles: ['frontend/react/src/features/kicktodo-community', 'backend/typescript/src/features/kicktodo-community'],
    cases: [
      { id: 'KTC-01', title: 'A profile is not public until a DIFFERENT identity approves it', priority: 'P0', blocker: true,
        preconditions: ['kicktodo-community toggle ON'],
        steps: [
          { action: 'Fill in handle + display name and press "Submit for approval"', expect: 'The state chip reads "Pending approval" — not "Public"' },
          { action: 'As the SAME user, attempt to approve your own profile (via the approvals inbox)', expect: 'Refused — separation of duties; the profile stays pending' },
        ] },
      { id: 'KTC-02', title: 'A taken handle is refused', priority: 'P1', blocker: false,
        preconditions: ['Another profile already holds the handle'],
        steps: [
          { action: 'Enter that handle (any casing) and save', expect: 'An error surfaces; the handle is not reassigned' },
        ] },
      { id: 'KTC-03', title: 'Reviews require proven participation', priority: 'P0', blocker: true,
        preconditions: ['An enrollment you have NOT completed and have not purchased'],
        steps: [
          { action: 'Pick a star rating and press "Submit review"', expect: 'An explanatory notice appears saying you must finish or purchase the challenge first — the composer is NOT hidden, the denial is explained' },
          { action: 'Complete the challenge, then submit again', expect: 'The review saves and shows a "verified participant" badge — never your name' },
        ] },
      { id: 'KTC-04', title: 'Editing a review overwrites rather than duplicating', priority: 'P1', blocker: false,
        preconditions: ['You have submitted a review'],
        steps: [
          { action: 'Change the rating and submit again', expect: 'Still exactly ONE review from you; the rating reflects the newer value' },
        ] },
    ],
  },
  {
    key: 'kicktodo-org-programs', feature: 'KickTodo Org programs', route: '/kicktodo/org-programs',
    description: 'Org challenge libraries and k-anonymous cohort outcome reports.',
    toggle: offVia('kicktodo-organizations'), updatedAt: '2026-07-19', sourceCommit: '',
    sourceFiles: ['frontend/react/src/features/kicktodo-org-programs', 'backend/typescript/src/features/kicktodo-organizations'],
    cases: [
      { id: 'KTO-01', title: 'A library turns Discover into an allowlist, and says so', priority: 'P0', blocker: true,
        preconditions: ['kicktodo-organizations toggle ON', 'At least one organization exists', 'You hold an org-admin role'],
        steps: [
          { action: 'With no challenges selected, read the library note', expect: 'It states members see the FULL catalog (not curated)' },
          { action: 'Add one challenge to the library', expect: 'The note flips to state members see ONLY the selected challenges' },
        ] },
      { id: 'KTO-02', title: 'A non-admin cannot mutate the library', priority: 'P0', blocker: true,
        preconditions: ['A member WITHOUT org-admin'],
        steps: [
          { action: 'Attempt to add a challenge to the library', expect: 'Refused (403/404) — the page does not silently appear to succeed' },
        ] },
      { id: 'KTO-03', title: 'Small cohorts are WITHHELD, never shown as a small number', priority: 'P0', blocker: true,
        preconditions: ['A linked cohort with fewer than 5 active members'],
        steps: [
          { action: 'Read the outcome report', expect: 'That row shows a "Withheld — cohort too small" chip; NO counts or percentages appear for it' },
        ] },
    ],
  },
  {
    key: 'kicktodo-studio', feature: 'KickTodo Studio', route: '/kicktodo/studio',
    description: 'Challenge Factory operator surface: intake, risk classification, pipeline, publication state.',
    toggle: offVia('kicktodo-creator'), updatedAt: '2026-07-19', sourceCommit: '',
    sourceFiles: ['frontend/react/src/features/kicktodo-studio', 'backend/typescript/src/features/kicktodo-creator'],
    cases: [
      { id: 'KTS-01', title: 'Intake classifies risk and shows the classifier reasoning', priority: 'P0', blocker: true,
        preconditions: ['kicktodo-creator toggle ON'],
        steps: [
          { action: 'Create a candidate with an everyday topic (e.g. "sleep hygiene basics")', expect: 'It appears in the pipeline with a risk chip AND, when signals matched, the matched classifier signals in plain text' },
        ] },
      { id: 'KTS-02', title: 'A prohibited topic is refused at the door', priority: 'P0', blocker: true,
        preconditions: ['kicktodo-creator toggle ON'],
        steps: [
          { action: 'Create a candidate with a clearly medical/self-harm topic', expect: 'Creation is REFUSED with an explanation — no candidate row is created' },
        ] },
    ],
  },
  {
    key: 'kicktodo-metrics', feature: 'KickTodo Metrics', route: '/kicktodo/metrics',
    description: 'PRD §15 outcome metrics as computed-on-read projections with k-floor withholding.',
    toggle: offVia('kicktodo-metrics'), updatedAt: '2026-07-19', sourceCommit: '',
    sourceFiles: ['frontend/react/src/features/kicktodo-metrics', 'backend/typescript/src/features/kicktodo-metrics'],
    cases: [
      { id: 'KTM-01', title: 'Cells below the k-floor are withheld with a stated reason', priority: 'P0', blocker: true,
        preconditions: ['kicktodo-metrics toggle ON', 'Fewer than 5 enrollments in the workspace'],
        steps: [
          { action: 'Open /kicktodo/metrics', expect: 'Rate cells read "Withheld" with the reason (too few participants) — never a small number; raw totals like "enrollments started" may still show' },
        ] },
      { id: 'KTM-02', title: 'Every rate states its denominator', priority: 'P1', blocker: false,
        preconditions: ['kicktodo-metrics toggle ON'],
        steps: [
          { action: 'Read any rate row', expect: 'The contributor count is shown beside the value — no bare percentage with an implied denominator' },
        ] },
      { id: 'KTM-03', title: 'Verifier quality reports resolved vs sampled', priority: 'P1', blocker: false,
        preconditions: ['At least one verifier sample minted'],
        steps: [
          { action: 'Read the verifier-quality panel', expect: 'It shows resolved / sampled; with nothing graded yet the rate is blank (never 0%)' },
        ] },
    ],
  },
  // ── Core always-on (first pass) ──────────────────────────────────────────
  {
    key: 'chat', feature: 'Chat', route: '/', description: 'Conversational entry point — talk to agents and start work.',
    toggle: ON, updatedAt: AT2, sourceCommit: SHA2, sourceFiles: ['frontend/react/src/chat'],
    cases: [
      { id: 'CHAT-01', title: 'Send a message and get a response', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.chat.first-message',
        preconditions: ['Signed in, or the demo tier is active'],
        steps: [
          { action: 'Navigate to / (Chat)', expect: 'The chat surface renders with a composer and welcome content' },
          { action: 'Type a message and press Send', expect: 'Your message appears, then an assistant response streams in' },
        ] },
      { id: 'CHAT-02', title: 'Mention an agent', priority: 'P1', preconditions: ['At least one agent exists'],
        steps: [
          { action: 'Type "@" in the composer', expect: 'A mention list of agents appears' },
          { action: 'Pick an agent and send', expect: 'The turn is addressed to that agent' },
        ] },
      { id: 'CHAT-03', title: 'Workflow-progress panel — empty state + step a11y', priority: 'P2',
        preconditions: ['Chat open'],
        steps: [
          { action: 'Open the workflow-progress panel in a chat with no runs', expect: 'The empty state is a <StateCard> (Workflow glyph + "No workflow runs yet" + the "Type @…" hint), not a bare muted line (CHAT-11)' },
          { action: 'Dispatch a workflow (type "@" and run one), then read the step list with a screen reader', expect: 'Each step row announces its state — Pending / Running / Completed / Failed — via a visually-hidden label, never icon/colour alone (CHAT-10)' },
          { action: 'Inspect a node that has not started yet', expect: 'It announces "Pending" (not the run-level "Starting…")' },
        ] },
      { id: 'CHAT-04', title: 'Streamed reply error is surfaced and localized', priority: 'P3',
        preconditions: ['Chat open; a way to force a backend error or a >120s reply timeout'],
        steps: [
          { action: 'Trigger an async reply that errors or times out', expect: 'A visible error bubble appears (not a stuck "thinking" state)' },
          { action: 'Switch the locale to fr / pt-BR / es and repeat', expect: 'The error text is localized (the replyFailed / replyTimedOut keys), never hardcoded English (CHAT-14)' },
        ] },
    ],
  },
  {
    key: 'agents', feature: 'Agents', route: '/agents', description: 'Your digital workforce — named AI coworkers.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA0, sourceFiles: ['frontend/react/src/agents'],
    cases: [
      { id: 'AGENTS-01', title: 'Roster loads', priority: 'P0', blocker: true, preconditions: [], walkthroughId: 'walkthrough.agents.roster',
        steps: [{ action: 'Navigate to /agents', expect: 'Agent tiles render with name, status, and role' }] },
      { id: 'AGENTS-02', title: 'Open an agent workspace', priority: 'P1', preconditions: ['≥1 agent in the roster'],
        steps: [{ action: 'Click an agent tile', expect: 'Routes to /agents/:id; the workspace tabs (Board / Memory / Schedules) render' }] },
      { id: 'AGENTS-03', title: 'Create an agent', priority: 'P2', preconditions: [],
        steps: [
          { action: 'Click "New" and complete the wizard', expect: 'The form validates and submits' },
          { action: 'Return to /agents', expect: 'The new agent appears in the roster' },
        ] },
    ],
  },
  {
    key: 'workflows', feature: 'Workflows', route: '/builder', description: 'Author and edit multi-step workflows on a canvas.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA0, sourceFiles: ['frontend/react/src/builder'],
    cases: [
      { id: 'WF-01', title: 'Workflows dashboard loads', priority: 'P0', blocker: true, preconditions: [], walkthroughId: 'walkthrough.workflows.dashboard',
        steps: [{ action: 'Navigate to /builder', expect: 'The workflows list renders (or an empty state with a create affordance)' }] },
      { id: 'WF-02', title: 'Open the canvas', priority: 'P1', preconditions: ['≥1 workflow exists'],
        steps: [{ action: 'Open a workflow', expect: 'Routes to /builder/:id; nodes and edges render on the canvas' }] },
    ],
  },
  {
    key: 'runs', feature: 'Runs', route: '/runs', description: 'Execution history and detail.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA0, sourceFiles: ['frontend/react/src/runs'],
    cases: [
      { id: 'RUNS-01', title: 'Runs list renders', priority: 'P0', blocker: true, preconditions: [], walkthroughId: 'walkthrough.runs.index',
        steps: [{ action: 'Navigate to /runs', expect: 'The runs table renders with status chips; sorting works' }] },
      { id: 'RUNS-02', title: 'Run detail', priority: 'P1', preconditions: ['≥1 run exists'],
        steps: [{ action: 'Click a run row', expect: 'Routes to /runs/:id; the run timeline / events render' }] },
      { id: 'RUNS-03', title: 'Compare two runs', priority: 'P2', preconditions: ['≥2 runs exist'],
        steps: [{ action: 'Open /compare and select two runs', expect: 'A side-by-side diff renders' }] },
    ],
  },
  {
    key: 'boards', feature: 'Boards', route: '/boards', description: 'Kanban — a card can trigger a run.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA0, sourceFiles: ['frontend/react/src/kanban'],
    cases: [
      { id: 'BOARDS-01', title: 'Board loads', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.boards.kanban', preconditions: [],
        steps: [{ action: 'Navigate to /boards', expect: 'Columns (To Do / Working / Waiting / Done) render with any cards' }] },
      { id: 'BOARDS-02', title: 'Move a card', priority: 'P1', preconditions: ['≥1 card on the board'],
        steps: [{ action: 'Drag a card to another column, then reload', expect: 'The card stays in the new column after reload' }] },
      { id: 'BOARDS-03', title: 'Per-board URL + pill links', priority: 'P1', preconditions: ['≥2 boards exist'],
        steps: [
          { action: 'Navigate to /boards', expect: 'The URL redirects (replace) to /boards/<id> of the first board — never an empty shell' },
          { action: 'Click another board pill (cmd/middle-click also works — pills are links)', expect: 'The URL changes to that board\'s /boards/<id>; back/forward switches boards' },
          { action: 'Reload on /boards/<id>', expect: 'The same board re-opens (deep link survives)' },
        ] },
    ],
  },
  {
    key: 'workforces', feature: 'Workforces', route: '/workforces', description: 'Governed agent clusters — purpose, telemetry, autonomy.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA0, sourceFiles: ['frontend/react/src/workforces'],
    cases: [
      { id: 'WKF-01', title: 'Workforces list renders', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.workforces.gallery', preconditions: [],
        steps: [{ action: 'Navigate to /workforces', expect: 'Workforce cards render with purpose, status, and autonomy' }] },
      { id: 'WKF-02', title: 'Workforce detail', priority: 'P1', preconditions: ['≥1 workforce exists'],
        steps: [{ action: 'Open a workforce', expect: 'Routes to /workforces/:id; telemetry + agent cluster render' }] },
    ],
  },
  {
    key: 'inbox', feature: 'Inbox', route: '/inbox', description: 'What needs you — approvals, blockers, notifications.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA0, sourceFiles: ['frontend/react/src/notifications'],
    cases: [
      { id: 'INBOX-01', title: 'Inbox loads', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.inbox.notifications', preconditions: [],
        steps: [{ action: 'Navigate to /inbox', expect: 'Pending approvals / notifications render (or a clear empty state)' }] },
      { id: 'INBOX-02', title: 'Act on an approval', priority: 'P1', preconditions: ['≥1 pending approval'],
        steps: [{ action: 'Approve or reject an item', expect: 'The item resolves and leaves the pending list' }] },
    ],
  },
  {
    key: 'projects', feature: 'Projects', route: '/projects', description: 'Work containers — board, memory, workflows.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA0, sourceFiles: ['frontend/react/src/features/projects'],
    cases: [
      { id: 'PROJ-01', title: 'Projects list renders', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.projects.list', preconditions: [],
        steps: [{ action: 'Navigate to /projects', expect: 'Project cards render (or an empty state with create)' }] },
      { id: 'PROJ-02', title: 'Project detail', priority: 'P1', preconditions: ['≥1 project exists'],
        steps: [{ action: 'Open a project', expect: 'Routes to /projects/:id; the project tabs render' }] },
    ],
  },

  // ── Operations / Workforces (admin) ──────────────────────────────────────
  {
    key: 'mission', feature: 'Active runs (Mission Control)', route: '/runs?tab=active', description: 'Live fleet view across runs — the Runs page "Active runs" tab.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/runs'],
    cases: [
      { id: 'MC-01', title: 'Active runs tab loads', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.runs.index', preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /runs?tab=active (or /mission, which redirects there)', expect: 'The Runs page opens on the "Active runs" tab; the live fleet renders with current activity (or an empty state)' }] },
    ],
  },
  {
    key: 'agent-templates', feature: 'Agent templates', route: '/agents/templates', description: 'Installed manifest agents + packs.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/agents'],
    cases: [
      { id: 'TMPL-01', title: 'Templates list loads', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.agent-templates.list', preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /agents/templates', expect: 'Installed agent templates / packs render' }] },
      { id: 'TMPL-02', title: 'Open a template', priority: 'P2', preconditions: ['≥1 template'],
        steps: [{ action: 'Open a template', expect: 'Routes to /agents/templates/:id; detail renders with an install/use affordance' }] },
    ],
  },
  {
    key: 'roster', feature: 'Org chart', route: '/roster', description: 'Roster + org-chart editor (descriptive only).',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/roster', 'frontend/react/src/agents'],
    cases: [
      { id: 'ROST-01', title: 'Org chart renders', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.roster.orgchart', preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /roster', expect: 'The roster / org-chart renders with members and reporting lines' }] },
      { id: 'ROST-02', title: 'Edit a reporting line', priority: 'P2', preconditions: ['≥2 members'],
        steps: [{ action: 'Reassign a member’s manager and save', expect: 'The change persists after reload' }] },
    ],
  },

  // ── Content (admin) ──────────────────────────────────────────────────────
  {
    key: 'media', feature: 'Media', route: '/media', description: 'Org asset library.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/media'],
    cases: [
      { id: 'MEDIA-01', title: 'Library loads', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.media.library', preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /media', expect: 'The asset library renders (grid of assets or an empty state)' }] },
      { id: 'MEDIA-02', title: 'Upload an asset', priority: 'P1', preconditions: [],
        steps: [{ action: 'Upload an image', expect: 'It appears in the library and yields a usable asset token' }] },
    ],
  },
  {
    key: 'cms', feature: 'CMS', route: '/cms', description: 'Pages + page builder.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/cms'],
    cases: [
      { id: 'CMS-01', title: 'Pages list loads', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.cms.pages', preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /cms', expect: 'The pages list renders with status (draft/published)' }] },
      { id: 'CMS-02', title: 'Create and publish a page', priority: 'P1', preconditions: [],
        steps: [
          { action: 'Create a page, add a section, and publish', expect: 'Status flips to Published' },
          { action: 'Fetch it on the public surface (/p/:slug or the publishing API)', expect: 'The published page renders' },
        ] },
    ],
  },
  {
    key: 'publishing', feature: 'Publishing', route: '/publishing', description: 'Public site + SEO for CMS pages.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/publishing'],
    cases: [
      { id: 'PUB-01', title: 'Publishing settings load', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.publishing.settings', preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /publishing', expect: 'The public-site / SEO settings render' }] },
      { id: 'PUB-02', title: 'Set SEO metadata', priority: 'P2', preconditions: ['≥1 published page'],
        steps: [{ action: 'Edit a page’s SEO title/description and save', expect: 'It persists and appears in the public page’s metadata' }] },
    ],
  },
  {
    // ADR 0027 collapse: "Front page" is now the reserved "Front page (public
    // site)" scope inside the CMS Page Builder — no standalone /front-page route.
    key: 'front-page', feature: 'Front page', route: '/cms', description: 'The public homepage at /, edited as the Front-page scope in CMS.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/cms', 'frontend/react/src/features/site'],
    cases: [
      { id: 'FP-01', title: 'Front-page scope appears in CMS for a superadmin', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.cms.pages', preconditions: ['Superadmin access'],
        steps: [{ action: 'Navigate to /cms and open the workspace picker', expect: 'A "System" group with a "Front page (public site)" scope is offered' }] },
      { id: 'FP-02', title: 'Edit + publish the homepage through the CMS editor', priority: 'P1', preconditions: ['Superadmin access'],
        steps: [{ action: 'Select the Front-page scope, edit the home page, save', expect: 'The edit goes live at / for anonymous visitors' }] },
      { id: 'FP-03', title: 'Toggle the public front page on/off', priority: 'P1', preconditions: ['Superadmin access'],
        steps: [{ action: 'In the Front-page scope, uncheck then re-check "Show the front page at /"', expect: '/ shows the app when off, the marketing page when on' }] },
    ],
  },

  // ── Platform (admin) ─────────────────────────────────────────────────────
  {
    key: 'prompts', feature: 'Prompts', route: '/prompts', description: 'Reusable templates + variables.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/prompts'],
    cases: [
      { id: 'PROMPT-01', title: 'Prompt library loads', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.prompts.library', preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /prompts', expect: 'The prompt-template library renders' }] },
      { id: 'PROMPT-02', title: 'Create a template', priority: 'P2', preconditions: [],
        steps: [{ action: 'Create a template with a {{variable}} and save', expect: 'It appears in the library and the variable is recognized' }] },
    ],
  },
  {
    key: 'memory', feature: 'Memory', route: '/memory', description: 'Tenant-attributed memory writes.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/memory'],
    cases: [
      { id: 'MEM-01', title: 'Memory ledger loads', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.memory.ledger', preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /memory', expect: 'The memory ledger renders, attributed per tenant (or an empty state)' }] },
    ],
  },
  {
    key: 'capabilities', feature: 'Capabilities', route: '/capabilities', description: 'What this host advertises.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/discovery'],
    cases: [
      { id: 'CAP-01', title: 'Capabilities panel loads', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.capabilities.panel', preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /capabilities', expect: 'The advertised host capabilities render (matches /.well-known/openwop)' }] },
    ],
  },
  {
    key: 'cli', feature: 'CLI', route: '/cli', description: 'In-app CLI quickstart + catalog.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/CliPage.tsx'],
    cases: [
      { id: 'CLI-01', title: 'CLI quickstart renders', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.cli.quickstart', preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /cli', expect: 'The CLI quickstart + command catalog render' }] },
      { id: 'CLI-02', title: 'Copy a command', priority: 'P2', preconditions: [],
        steps: [{ action: 'Click a copy affordance on a command', expect: 'A toast confirms it copied to the clipboard' }] },
    ],
  },
  {
    key: 'feature-toggles', feature: 'Feature toggles', route: '/feature-toggles', description: 'On / off / beta + multivariant traffic-splitting.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/feature-toggles'],
    cases: [
      { id: 'FT-01', title: 'Toggle list loads', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.feature-toggles.list', preconditions: ['Superadmin access'],
        steps: [{ action: 'Navigate to /feature-toggles', expect: 'The toggle catalog renders with on/off/beta state per feature' }] },
      { id: 'FT-02', title: 'Flip a toggle', priority: 'P1', preconditions: [],
        steps: [{ action: 'Turn a toggle on, reload the app', expect: 'The gated feature’s nav entry/route appears; turning it off hides it again' }] },
    ],
  },

  // ── Access & data (admin) ────────────────────────────────────────────────
  {
    key: 'orgs', feature: 'Organizations', route: '/orgs', description: 'Orgs, teams, members + RBAC.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/orgs'],
    cases: [
      { id: 'ORG-01', title: 'Orgs list loads', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.orgs.list', preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /orgs', expect: 'Orgs / teams / members render with roles' }] },
      { id: 'ORG-02', title: 'Invite a member', priority: 'P1', preconditions: [],
        steps: [{ action: 'Invite a member with a role and save', expect: 'They appear in the members list with that role' }] },
    ],
  },
  {
    key: 'keys', feature: 'Keys', route: '/keys', description: 'BYOK credentials + provider config.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/keys'],
    cases: [
      { id: 'KEYS-01', title: 'Keys page loads', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.keys.providers', preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /keys', expect: 'Provider key slots render with their configured/empty state' }] },
      { id: 'KEYS-02', title: 'Add a provider key', priority: 'P1', preconditions: [],
        steps: [{ action: 'Add a key for a provider and save', expect: 'The provider shows as configured; the secret value is not echoed back' }] },
    ],
  },
  {
    key: 'users', feature: 'Users', route: '/users', description: 'Accounts + identity.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/users'],
    cases: [
      { id: 'USERS-01', title: 'Users list loads', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.users.list', preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /users', expect: 'Accounts render in a table with identity details' }] },
    ],
  },
  {
    key: 'connections', feature: 'Connections', route: '/connections', description: 'Credentials for external apps.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/connections'],
    cases: [
      { id: 'CONN-01', title: 'Connections list loads', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.connections.list', preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /connections', expect: 'Available providers (Google/Slack/Zoom/…) render with connect state' }] },
      { id: 'CONN-02', title: 'Begin linking a provider', priority: 'P2', preconditions: [],
        steps: [{ action: 'Click "Connect" on a provider', expect: 'The OAuth/connect flow starts (consent screen or config prompt)' }] },
    ],
  },
  {
    key: 'connect-to-continue', feature: 'Connect-to-continue', route: '/', description: 'Mid-run connection prompt (ADR 0189).',
    toggle: ON, updatedAt: '2026-07-02', sourceCommit: 'adr-0189', sourceFiles: ['backend/typescript/src/host/connectionInterrupt.ts', 'frontend/react/src/chat/cards/ConnectionRequiredCard.tsx'],
    cases: [
      { id: 'C2C-01', title: 'Interactive run prompts on a missing connection', priority: 'P1', preconditions: ['A connector provider is NOT connected (e.g. disconnect Workday/BigQuery)', 'Run from CHAT (not the builder) so the run is interactive'],
        steps: [
          { action: 'In chat, run a workflow whose step needs the unconnected provider', expect: 'The run suspends and a "Connection needed" card appears in the chat feed (not a silent skip)' },
          { action: 'Read the card', expect: 'It names the provider + offers Connect (or a Set-up link when the host has no OAuth client), an "I\'ve connected — continue", and Skip' },
        ] },
      { id: 'C2C-02', title: 'Connect → continue resumes the step', priority: 'P1', preconditions: ['C2C-01 showing the card', 'The provider has an OAuth client configured'],
        steps: [
          { action: 'Click Connect, complete consent, return to chat', expect: 'You land back on the chat with the card still open' },
          { action: 'Click "I\'ve connected — continue"', expect: 'The run resumes; the step now succeeds against the connected provider' },
        ] },
      { id: 'C2C-03', title: 'Skip degrades to the graceful no-op', priority: 'P2', preconditions: ['C2C-01 showing the card'],
        steps: [{ action: 'Click Skip this step', expect: 'The run continues; the step returns its graceful not-connected result (no crash, no hang)' }] },
      { id: 'C2C-04', title: 'Headless run never prompts', priority: 'P1', preconditions: ['A scheduled/heartbeat run whose step needs an unconnected provider'],
        steps: [{ action: 'Let a scheduled run execute the step', expect: 'It does NOT suspend — the step no-ops gracefully exactly as before (ADR 0033 preserved)' }] },
      { id: 'C2C-05', title: 'Builder overlay shows "Waiting on you"', priority: 'P2', preconditions: ['A run suspended on an interrupt (this prompt, or an approval gate)'],
        steps: [{ action: 'Watch the builder run-overlay banner', expect: 'It shows a "Waiting on you" state with a Resolve → link to the run detail, not a stale pulsing "Running"' }] },
    ],
  },
  {
    key: 'example-data', feature: 'Example data', route: '/example-data', description: 'Re-seed the built-in example roster.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/settings'],
    cases: [
      { id: 'EX-01', title: 'Dashboard loads with live counts', priority: 'P0', blocker: true, walkthroughId: 'walkthrough.example-data.dashboard', preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /example-data', expect: 'Each seeder row renders with its live "N present" count' }] },
      { id: 'EX-02', title: 'Load and clear example data', priority: 'P1', preconditions: [],
        steps: [
          { action: 'Run "Load demo data"', expect: 'Counts increase; the seed is idempotent on re-run (no duplicates)' },
          { action: 'Run "Clear"', expect: 'Per-tenant entities clear to zero; host-global content (front page, features page) is retained' },
        ] },
    ],
  },

  // ── Toggle-OFF features (enable-first) ───────────────────────────────────
  {
    key: 'kb', feature: 'Knowledge Base', route: '/kb', description: 'Document collections + semantic search (RAG).',
    toggle: offVia('kb'), updatedAt: AT, sourceCommit: SHA0, sourceFiles: ['frontend/react/src/features/kb'],
    cases: [
      { id: 'KB-00', title: 'Enable the Knowledge Base feature', priority: 'P0', blocker: true, preconditions: ['Admin / superadmin'],
        steps: [{ action: 'Turn the "kb" toggle ON (see enable steps) and reload', expect: '"Knowledge Base" appears in the nav and /kb loads' }] },
      { id: 'KB-01', title: 'Create a collection and ingest a document', priority: 'P1', preconditions: ['KB enabled (KB-00)'],
        steps: [{ action: 'Create a collection, then add a text document', expect: 'The document is ingested and listed' }] },
      { id: 'KB-02', title: 'Semantic search returns cited results', priority: 'P2', preconditions: ['KB enabled with ≥1 document'],
        steps: [{ action: 'Search for a phrase from the document', expect: 'Results return with a cited source you can open' }] },
    ],
  },
  {
    key: 'crm', feature: 'CRM', route: '/crm', description: 'Contacts + triage.',
    toggle: offVia('crm'), updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/crm'],
    cases: [
      { id: 'CRM-00', title: 'Enable CRM', priority: 'P0', blocker: true, preconditions: ['Admin'],
        steps: [{ action: 'Turn the "crm" toggle ON and reload', expect: 'CRM appears in the nav and /crm loads' }] },
      { id: 'CRM-01', title: 'Create a contact', priority: 'P1', preconditions: ['CRM enabled'],
        steps: [{ action: 'Add a contact', expect: 'It appears in the pipeline/list' }] },
    ],
  },
  {
    key: 'crm-gmail-sync', feature: 'CRM · Gmail inbox sync', route: '/crm',
    description: 'Per-user opt-in Gmail inbox → CRM activity sync — refs-only metadata, matched contacts only, scheduler-driven (ADR 0252). The "Gmail sync" tab on /crm.',
    toggle: offVia('crm'), updatedAt: AT3, sourceCommit: SHA3,
    sourceFiles: [
      'frontend/react/src/features/crm/GmailSyncTab.tsx',
      'frontend/react/src/features/crm/gmailSyncClient.ts',
      'backend/typescript/src/features/crm/gmailSyncService.ts',
      'backend/typescript/src/features/crm/gmailSyncRoutes.ts',
    ],
    cases: [
      { id: 'GMAIL-00', title: 'Reach the Gmail sync tab', priority: 'P0', blocker: true,
        preconditions: ['crm enabled', 'Signed in as a REAL user (not the anonymous demo session — it 401s by design)', 'An organization selected on /crm'],
        steps: [
          { action: 'Open /crm, pick an org, and open the "Gmail sync" tab', expect: 'The tab renders with a leading privacy notice, and either a create form or a "Connect Google first" card' },
        ] },
      { id: 'GMAIL-01', title: 'Refs-only privacy notice is prominent', priority: 'P1', blocker: true,
        preconditions: ['On the Gmail sync tab'],
        steps: [
          { action: 'Read the leading notice at the top of the tab', expect: 'It states plainly that ONLY refs/metadata are stored — never subject, body, snippet, or email content — and stays visible above the form/table' },
        ] },
      { id: 'GMAIL-02', title: 'Empty state — no Google connection', priority: 'P1',
        preconditions: ['On the Gmail sync tab', 'No google connection on your account'],
        steps: [
          { action: 'Observe the create area with no google connection', expect: 'A "Connect Google first" StateCard replaces the form, with a "Manage connections" button' },
          { action: 'Tab to the "Manage connections" button, then activate it', expect: 'It shows a visible focus ring (keyboard) and navigates to /connections' },
        ] },
      { id: 'GMAIL-03', title: 'Connect a Google account', priority: 'P1',
        preconditions: ['On /connections'],
        steps: [
          { action: 'Connect a Google account carrying the gmail.readonly scope', expect: 'The connection is created. If Google OAuth is not configured on this deployment you get a provider error here — an env/BYOK gap, NOT a feature bug; note it and skip to GMAIL-07..09' },
        ] },
      { id: 'GMAIL-04', title: 'Opt in (create a sync)', priority: 'P1',
        preconditions: ['A google connection exists', 'On the Gmail sync tab'],
        steps: [
          { action: 'Pick the Google connection + a cadence (15m / hourly / daily) and click Enable', expect: 'A success toast; a new row appears — connection label, cadence, an "Active" chip, "Never synced"' },
        ] },
      { id: 'GMAIL-05', title: 'Sync now → refs-only, back-dated activity', priority: 'P0', blocker: true,
        preconditions: ['An active sync exists', 'Your Gmail has mail to/from an address that matches an EXISTING CRM contact'],
        steps: [
          { action: 'Click "Sync now" on the row', expect: 'A 202 + toast; "Last synced" updates' },
          { action: 'Open a matched contact and view its activity timeline', expect: 'An "Email exchanged" activity appears with NO subject/body/snippet/email, and its timestamp is the EMAIL\'s real date — not "just now" (back-dating)' },
        ] },
      { id: 'GMAIL-06', title: 'Matched contacts only — never creates', priority: 'P2',
        preconditions: ['A sync ran (GMAIL-05)'],
        steps: [
          { action: 'Review the contact list after a sync', expect: 'No new contacts were created; only existing matched contacts got an activity; mail to/from unknown addresses produced nothing' },
        ] },
      { id: 'GMAIL-07', title: 'Pause / resume + re-cadence', priority: 'P2',
        preconditions: ['A sync exists'],
        steps: [
          { action: 'Click the status chip to toggle Active↔Paused; change the cadence', expect: 'The chip flips with a toast; the scheduled cadence updates' },
          { action: 'With a screen reader, focus the status toggle', expect: 'It announces the state ("Active"/"Paused"), not only pressed/unpressed' },
        ] },
      { id: 'GMAIL-08', title: 'Delete (opt out)', priority: 'P1',
        preconditions: ['A sync exists'],
        steps: [
          { action: 'Click Delete and confirm in the dialog', expect: 'The row disappears with a toast; the sync + its scheduler job are gone — no further background pulls' },
        ] },
      { id: 'GMAIL-09', title: 'Owner-only guard (multi-user)', priority: 'P1',
        preconditions: ['A second user with workspace-write in the SAME org', 'Your sync exists'],
        steps: [
          { action: 'As the second user, open the Gmail sync tab for the shared org', expect: 'They see only THEIR OWN syncs — your sync is not listed' },
          { action: 'Have them attempt to pause / delete / sync-now your sync (by its id)', expect: 'Refused with 403 — a co-worker cannot manage another user\'s personal-mailbox sync' },
        ] },
      { id: 'GMAIL-10', title: 'Load-error state', priority: 'P2',
        preconditions: ['On the Gmail sync tab'],
        steps: [
          { action: 'If the sync list fails to load (transient network/backend error)', expect: 'A red error notice WITH a Retry button — not a contradictory "No syncs yet" empty card underneath' },
        ] },
      { id: 'GMAIL-11', title: 'Accessibility · theme · responsive', priority: 'P2',
        preconditions: ['On the Gmail sync tab'],
        steps: [
          { action: 'Keyboard-only: Tab through every control (cadence/connection selects, Enable, status toggle, Sync now, Delete, Manage-connections link)', expect: 'Each is reachable and shows a visible focus ring' },
          { action: 'Toggle dark mode and shrink to ~375px width', expect: 'Colors theme correctly (no hard-coded light values); the syncs table reflows (stacked, labeled cells) with no horizontal scroll; the form wraps cleanly' },
        ] },
    ],
  },
  {
    key: 'csm', feature: 'Customer Success', route: '/csm', description: 'Customer-success accounts.',
    toggle: offVia('csm'), updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/csm'],
    cases: [
      { id: 'CSM-00', title: 'Enable Customer Success', priority: 'P0', blocker: true, preconditions: ['Admin'],
        steps: [{ action: 'Turn the "csm" toggle ON and reload', expect: 'CSM appears in the nav and /csm loads' }] },
      { id: 'CSM-01', title: 'Accounts list', priority: 'P1', preconditions: ['CSM enabled'],
        steps: [{ action: 'Open /csm', expect: 'Customer-success accounts render with health state' }] },
    ],
  },
  {
    key: 'forms', feature: 'Forms', route: '/forms', description: 'Public forms → CRM contacts.',
    toggle: offVia('forms'), updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/forms'],
    cases: [
      { id: 'FORMS-00', title: 'Enable Forms', priority: 'P0', blocker: true, preconditions: ['Admin'],
        steps: [{ action: 'Turn the "forms" toggle ON and reload', expect: 'Forms appears in the nav and /forms loads' }] },
      { id: 'FORMS-01', title: 'Create a form', priority: 'P1', preconditions: ['Forms enabled'],
        steps: [{ action: 'Create a form and submit a test response', expect: 'A new contact lands in the CRM' }] },
    ],
  },
  {
    key: 'email', feature: 'Email', route: '/email', description: 'Templated campaigns over CRM contacts.',
    toggle: offVia('email'), updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/email'],
    cases: [
      { id: 'EMAIL-00', title: 'Enable Email', priority: 'P0', blocker: true, preconditions: ['Admin'],
        steps: [{ action: 'Turn the "email" toggle ON and reload', expect: 'Email appears in the nav and /email loads' }] },
      { id: 'EMAIL-01', title: 'Draft a campaign', priority: 'P1', preconditions: ['Email enabled'],
        steps: [{ action: 'Create a templated campaign', expect: 'It saves and is ready to send to a contact segment' }] },
    ],
  },
  {
    key: 'analytics', feature: 'Analytics', route: '/analytics', description: 'Traffic + conversions on the public surface.',
    toggle: offVia('analytics'), updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/analytics'],
    cases: [
      { id: 'AN-00', title: 'Enable Analytics', priority: 'P0', blocker: true, preconditions: ['Admin'],
        steps: [{ action: 'Turn the "analytics" toggle ON and reload', expect: 'Analytics appears in the nav and /analytics loads' }] },
      { id: 'AN-01', title: 'Dashboard renders', priority: 'P1', preconditions: ['Analytics enabled'],
        steps: [{ action: 'Open /analytics', expect: 'Traffic/conversion metrics render (or a zero-state)' }] },
    ],
  },
  {
    key: 'consent', feature: 'Consent', route: '/consent', description: 'Region-aware consent + data-subject (GDPR).',
    toggle: offVia('consent'), updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/consent'],
    cases: [
      { id: 'CONSENT-00', title: 'Enable Consent', priority: 'P0', blocker: true, preconditions: ['Admin'],
        steps: [{ action: 'Turn the "consent" toggle ON and reload', expect: 'Consent appears in the nav and /consent loads' }] },
      { id: 'CONSENT-01', title: 'Consent records render', priority: 'P1', preconditions: ['Consent enabled'],
        steps: [{ action: 'Open /consent', expect: 'Region-aware consent + data-subject request tooling render' }] },
    ],
  },
  {
    key: 'comments', feature: 'Comments', route: '/comments', description: 'Threaded comments on pages + collections.',
    toggle: offVia('comments'), updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/comments'],
    cases: [
      { id: 'COMM-00', title: 'Enable Comments', priority: 'P0', blocker: true, preconditions: ['Admin'],
        steps: [{ action: 'Turn the "comments" toggle ON and reload', expect: 'Comments appears in the nav and /comments loads' }] },
      { id: 'COMM-01', title: 'Post a comment', priority: 'P1', preconditions: ['Comments enabled'],
        steps: [{ action: 'Add a comment to a page/collection', expect: 'It appears in the thread and persists' }] },
    ],
  },
  {
    key: 'marketplace', feature: 'Marketplace', route: '/marketplace', description: 'Browse + install signed feature packs.',
    toggle: offVia('marketplace'), updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/marketplace'],
    cases: [
      { id: 'MKT-00', title: 'Enable Marketplace', priority: 'P0', blocker: true, preconditions: ['Admin'],
        steps: [{ action: 'Turn the "marketplace" toggle ON and reload', expect: 'Marketplace appears in the nav and /marketplace loads' }] },
      { id: 'MKT-01', title: 'Browse + install a pack', priority: 'P1', preconditions: ['Marketplace enabled'],
        steps: [{ action: 'Open a signed pack and install it', expect: 'The pack installs and its capabilities become available' }] },
    ],
  },
  {
    key: 'advisors', feature: 'Board of Advisors', route: '/advisors', description: 'Councils of advisor agents.',
    toggle: offVia('advisory-board'), updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/advisory-board'],
    cases: [
      { id: 'ADV-00', title: 'Enable Board of Advisors', priority: 'P0', blocker: true, preconditions: ['Admin'],
        steps: [{ action: 'Turn the "advisory-board" toggle ON and reload', expect: 'Board of Advisors appears in the nav and /advisors loads' }] },
      { id: 'ADV-01', title: 'Convene a council', priority: 'P1', preconditions: ['Advisory board enabled'],
        steps: [{ action: 'Create a council and ask it a question', expect: 'Advisor agents respond with a council view' }] },
    ],
  },
  {
    key: 'priority-matrix', feature: 'Priority Matrix', route: '/priority-matrix', description: 'Score & rank ideas, plan sessions.',
    toggle: offVia('priority-matrix'), updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/priority-matrix'],
    cases: [
      { id: 'PM-00', title: 'Enable Priority Matrix', priority: 'P0', blocker: true, preconditions: ['Admin'],
        steps: [{ action: 'Turn the "priority-matrix" toggle ON and reload', expect: 'Priority Matrix appears in the nav and /priority-matrix loads' }] },
      { id: 'PM-01', title: 'Score and rank ideas', priority: 'P1', preconditions: ['Priority Matrix enabled'],
        steps: [{ action: 'Add ideas and score them', expect: 'The ranking updates from the scores' }] },
      { id: 'PM-02', title: 'Per-list URL + back to portfolio', priority: 'P1', preconditions: ['≥1 priority list exists'],
        steps: [
          { action: 'Open a list from the portfolio card grid (cmd/middle-click also works — cards are links)', expect: 'The URL becomes /priority-matrix/<id>; the page leads with an <h1> of the list name + a "Back to portfolio" link (ADR 0058 routing correction)' },
          { action: 'Reload the browser on /priority-matrix/<id>', expect: 'The same list re-opens (deep link survives)' },
        ] },
    ],
  },
  {
    key: 'documents', feature: 'Documents', route: '/documents', description: 'Business documents + templates (SOW, PRD, RFP, agendas).',
    toggle: offVia('documents'), updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/documents'],
    cases: [
      { id: 'DOC-00', title: 'Enable Documents', priority: 'P0', blocker: true, preconditions: ['Admin'],
        steps: [{ action: 'Turn the "documents" toggle ON and reload', expect: 'Documents appears in the nav and /documents loads' }] },
      { id: 'DOC-01', title: 'Draft from a template', priority: 'P1', preconditions: ['Documents enabled'],
        steps: [{ action: 'Create a document from a template (e.g. SOW)', expect: 'A draft is generated and editable' }] },
    ],
  },
  {
    key: 'sharing', feature: 'Sharing', route: '/sharing', description: 'Public share links to pages + collections.',
    toggle: offVia('sharing'), updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/sharing'],
    cases: [
      { id: 'SHARE-00', title: 'Enable Sharing', priority: 'P0', blocker: true, preconditions: ['Admin'],
        steps: [{ action: 'Turn the "sharing" toggle ON and reload', expect: 'Sharing appears in the nav and /sharing loads' }] },
      { id: 'SHARE-01', title: 'Create a public share link', priority: 'P1', preconditions: ['Sharing enabled'],
        steps: [{ action: 'Create a share link for a page/collection, open it logged-out', expect: 'The shared content renders without sign-in' }] },
    ],
  },
  {
    key: 'strategy', feature: 'Strategy', route: '/strategy',
    description: 'Executive strategy portfolio — objectives, key results, initiatives, alignment (ADR 0079/0080).',
    toggle: offVia('strategy'), updatedAt: AT2, sourceCommit: SHA2, sourceFiles: ['frontend/react/src/features/strategy'],
    cases: [
      { id: 'STRAT-00', title: 'Enable Strategy', priority: 'P0', blocker: true, preconditions: ['Admin'],
        steps: [
          { action: 'Turn the "strategy" toggle ON (Admin → Platform → Feature toggles) and reload', expect: 'Strategy appears under the "Planning" nav group; /strategy loads the portfolio (no "Strategy is not enabled" StateCard)' },
        ] },
      { id: 'STRAT-01', title: 'Create a strategy from a template (aria-live)', priority: 'P0', blocker: true,
        preconditions: ['Strategy enabled'],
        steps: [
          { action: 'Click "New strategy"; in the modal pick a "Start from" preset (e.g. OKR)', expect: 'The modal heading is an <h2> (STRAT-5); objectives/key-results scaffold in from the preset' },
          { action: 'With a screen reader on, switch between presets', expect: 'A polite live region announces "Pre-filled N objectives…" on change (aria-live status, STRAT-6)' },
          { action: 'Fill the title + organization and submit', expect: 'The strategy is created and opens in the detail view' },
        ] },
      { id: 'STRAT-02', title: 'Detail page URL + heading outline + tab nav', priority: 'P1', preconditions: ['≥1 strategy exists'],
        steps: [
          { action: 'Open a strategy from the portfolio (cmd/middle-click also works — cards are links)', expect: 'The URL becomes /strategy/<id>; the page leads with an <h1> of the strategy title + a "Back to portfolio" link (ADR 0079 routing correction)' },
          { action: 'Tab to the Overview/Objectives/Initiatives/Alignment/Timeline tablist; use Arrow keys', expect: 'role=tablist with arrow-key roving; panels swap; the active tab is written to ?tab= (reload restores it)' },
          { action: 'Reload the browser on /strategy/<id>?tab=objectives', expect: 'The same strategy re-opens on the Objectives tab (deep link survives)' },
        ] },
      { id: 'STRAT-03', title: 'Key-result rows grouped for assistive tech', priority: 'P2', preconditions: ['A strategy is open'],
        steps: [
          { action: 'On the Objectives tab, add an objective then a key result', expect: 'A KR row (title / target / current) appears' },
          { action: 'Traverse the KR row with a screen reader', expect: 'The three fields announce as one unit "Key result N" (role="group" + aria-label, STRAT-4)' },
        ] },
      { id: 'STRAT-04', title: 'Delete / archive requires confirmation', priority: 'P0', blocker: true,
        preconditions: ['A user-scoped (private) strategy is open'],
        steps: [
          { action: 'On the Overview tab, click Delete', expect: 'A confirm prompt appears ("Delete this strategy? This cannot be undone.") — nothing is deleted yet (STRAT-1)' },
          { action: 'Dismiss/Cancel the prompt', expect: 'The strategy is NOT deleted; you remain on the detail view' },
          { action: 'For a workspace/org strategy, click Archive', expect: 'A confirm prompt appears before archiving' },
        ] },
      { id: 'STRAT-05', title: 'Chip legibility — dark mode + colour-blind', priority: 'P2',
        preconditions: ['≥1 strategy with status / health / confidence set'],
        steps: [
          { action: 'Toggle dark mode and view the portfolio', expect: 'Health (on-track/at-risk/off-track), status, confidence, and risk render as icon+text chips — legible, never colour-alone (CT-15)' },
          { action: 'Apply a colour-blindness filter (or grayscale) and re-check', expect: 'Each chip is still distinguishable by glyph + label, not hue' },
        ] },
      { id: 'STRAT-06', title: 'Mobile reflow at 375px', priority: 'P2', preconditions: ['Strategy enabled'],
        steps: [
          { action: 'Resize to 375px on the portfolio', expect: 'The card grid reflows to one column; the filter bar wraps with no horizontal overflow (CT-15)' },
          { action: 'Open a strategy at 375px', expect: 'The detail tabs + editors stay usable; no clipped controls' },
        ] },
    ],
  },
  // ── Commerce & Ops (ADR 0172-0178, shipped 2026-07-01) ────────────────────
  {
    key: 'production', feature: 'Production Intelligence', route: '/production', description: 'Vendor Directory + AI production planning (Production Planner agent). ADR 0172.',
    toggle: offVia('production'), updatedAt: '2026-07-02', sourceCommit: '5066d95e', sourceFiles: ['backend/typescript/src/features/production', 'frontend/react/src/features/production'],
    cases: [
      { id: 'PROD-01', title: 'Vendor CRUD + capabilities', priority: 'P1', preconditions: ['production enabled; an org you own'],
        steps: [
          { action: 'Open /production, pick an org, create a vendor (type contractor/agency; a capability with category + quality rating; a price range; a past project; portfolio Media tokens; contract status)', expect: '201; it appears in the Vendors tab with its capabilities; reload keeps it' },
          { action: 'Edit the vendor, then delete another', expect: 'Edits persist; delete removes it; workspace:write is required (a viewer cannot edit)' },
        ] },
      { id: 'PROD-02', title: 'Vendor search / filter', priority: 'P2', preconditions: ['Several vendors with varied capabilities/regions'],
        steps: [ { action: 'Filter/search the directory by capability category, region, and contract status', expect: 'The list narrows correctly; an empty result shows a designed empty state' } ] },
      { id: 'PROD-03', title: 'Contract status', priority: 'P3', preconditions: ['A vendor'],
        steps: [ { action: 'Set contract status active → preferred → inactive', expect: 'The status chip updates and persists; preferred vendors are distinguishable' } ] },
      { id: 'PROD-04', title: 'Generate a production plan via chat', priority: 'P1', preconditions: ['≥1 vendor; the Production Planner agent'],
        steps: [
          { action: 'Open the Plans tab and drive the Production Planner agent in chat to plan a project', expect: 'Plan GENERATION rides the shared chat (not a bespoke panel — ADR 0172); the plan references REAL vendors from the directory' },
          { action: 'Reopen the saved plan later', expect: 'It reads back intact' },
        ] },
      { id: 'PROD-05', title: 'Org scope + tenant isolation', priority: 'P1', preconditions: ['Two orgs'],
        steps: [ { action: 'Create vendors under org A, then view org B', expect: 'Vendors are org-scoped; org B never sees org A’s directory (tenant+org IDOR-guarded)' } ] },
      { id: 'PROD-06', title: 'Toggle gating + a11y', priority: 'P2', preconditions: ['production toggle'],
        steps: [
          { action: 'With production OFF navigate to /production; then enable + reload', expect: 'Off → 404/not-enabled; on → the page + org picker render' },
          { action: 'Check the org picker + empty states', expect: 'The org select has an aria-label; empty vendors/plans are designed StateCards' },
        ] },
    ],
  },
  {
    key: 'commerce', feature: 'E-Commerce', route: 'admin / API — no dedicated page (catalog+orders are backend; exercise via the API / route tests, observe catalog via the UCP admin)', description: 'Product catalog + order lifecycle (payment verified against Stripe when a key is configured; demo-mode keyless). ADR 0177 — backend surface under /host/openwop-app/commerce/orgs/:orgId/*.',
    toggle: offVia('commerce'), updatedAt: '2026-07-02', sourceCommit: '95df964c', sourceFiles: ['backend/typescript/src/features/commerce'],
    cases: [
      { id: 'ECOM-01', title: 'Product catalog CRUD + variants', priority: 'P1', preconditions: ['commerce enabled; an org you own'],
        steps: [
          { action: 'POST a physical product (price, currency, inventory, lowStockThreshold) + two variants (name/sku/price)', expect: '201; the product lists with its variants; images/downloads are Media tokens, not blobs' },
          { action: 'PATCH the product (price + one field to null) and GET it', expect: 'Only the sent fields change; a null clears the field; updatedAt advances' },
          { action: 'Create a digital and a service product; DELETE one; list with a q= filter', expect: 'All three types persist; delete removes it; q filters by name' },
        ] },
      { id: 'ECOM-02', title: 'Order lifecycle state machine', priority: 'P0', blocker: true, preconditions: ['A physical product with inventory ≥ 3'],
        steps: [
          { action: 'Create an order for 3 units', expect: 'subtotal/total compute; status=pending, fulfillmentStatus=pending' },
          { action: 'Mark it paid (external paymentIntentId)', expect: 'status→paid; inventory decrements by 3; paymentIntentId recorded' },
          { action: 'Refund it', expect: 'status→refunded; inventory restored (+3)' },
          { action: 'Try to mark a NON-pending order paid, and cancel a non-pending order', expect: 'Both 409 (only a pending order can be paid/canceled) — the state machine is enforced' },
        ] },
      { id: 'ECOM-03', title: 'Fulfillment axis', priority: 'P2', preconditions: ['A paid order'],
        steps: [
          { action: 'Advance fulfillment pending → processing → shipped → delivered', expect: 'Each transition persists on the separate fulfillment axis' },
          { action: 'Observe the order once fulfillment=delivered', expect: 'The order status flips to fulfilled' },
        ] },
      { id: 'ECOM-04', title: 'Cart → checkout', priority: 'P2', preconditions: ['Two active products (same currency)'],
        steps: [
          { action: 'PUT cart items (qty), GET the cart, then POST cart/checkout', expect: 'The cart persists per user; checkout creates an order from the lines and clears the cart' },
          { action: 'Provide a contactId that belongs to ANOTHER tenant at checkout', expect: '400 — contactId must reference a contact in this tenant (CRM = customer, ADR 0008)' },
        ] },
      { id: 'ECOM-05', title: 'Coupons + multi-currency guard', priority: 'P2', preconditions: ['Products in two currencies'],
        steps: [
          { action: 'Create a percentage coupon, then order with that couponCode', expect: 'discount applies; total = max(0, subtotal − discount); an invalid/inactive code is rejected 400 (not silently ignored)' },
          { action: 'Build a cart mixing two currencies and check out', expect: 'Rejected with a clear validation error — an order is single-currency (no FX in Phase 1)' },
        ] },
      { id: 'ECOM-06', title: 'Public storefront (tenant-from-resource)', priority: 'P2', preconditions: ['An org with ≥1 active + 1 inactive product'],
        steps: [
          { action: 'GET /host/openwop-app/public-store/:orgId/products unauthenticated', expect: 'Only ACTIVE products; no inventory/operational fields leak; tenant resolved from the ORG (getOrg.tenantId), never the request' },
          { action: 'GET the public store for an unknown org', expect: 'Uniform 404 "Store not found" (no existence leak)' },
        ] },
      { id: 'ECOM-07', title: 'Stripe webhook (demo-mode + idempotency)', priority: 'P2', preconditions: ['A pending order; the commerce webhook path is public'],
        steps: [
          { action: 'POST the commerce webhook with NO signing secret configured', expect: '503 not_configured (demo-mode) — no state change' },
          { action: 'With the secret set, POST a signed payment_intent.succeeded carrying metadata {orderId,tenantId,orgId}', expect: 'The order → paid (markAsPaid); a re-delivery is a no-op ack (idempotent via the pending-only guard)' },
        ] },
      { id: 'ECOM-08', title: 'Affiliate commission + order-confirmation on pay', priority: 'P3', preconditions: ['An affiliate with a code; SMTP/notification transports are mock in tests'],
        steps: [
          { action: 'Create an order carrying the affiliate code, then mark it paid', expect: 'Commission ACCRUES to the affiliate balance once (only on pending→paid, no double-accrual); a payout records advisory (no real disbursement)' },
          { action: 'Inspect the side-effects of markAsPaid on a paid order with a linked CRM contact', expect: 'A commerce.order.paid notification is emitted + a best-effort order-confirmation email to the contact — failures never block payment' },
        ] },
    ],
  },
  {
    key: 'commerce-ucp', feature: 'UCP commerce', route: '/commerce-ucp', description: 'Agentic-commerce (ucp.dev) surface projecting commerce — admin panel + public agent REST (OAuth client-credentials, AP2) + MCP tools. ADR 0178.',
    toggle: offVia('commerce-ucp'), updatedAt: '2026-07-02', sourceCommit: '95df964c', sourceFiles: ['backend/typescript/src/features/commerce/ucp', 'frontend/react/src/features/commerce-ucp'],
    cases: [
      { id: 'UCP-01', title: 'Admin panel — endpoints + client provisioning', priority: 'P1', preconditions: ['commerce-ucp + commerce enabled; an org you own'],
        steps: [
          { action: 'Open /commerce-ucp and pick a merchant', expect: 'The discovery / OAuth-server / catalog endpoint URLs render, each with a copy button; empty-org tenant → a StateCard' },
          { action: 'Provision an agent client (name + a subset of scope checkboxes)', expect: 'The client id + secret are shown ONCE in a warning Notice (aria-live); the granted scopes match the boxes' },
          { action: 'Uncheck ALL scopes and provision; then revoke a client', expect: 'An explicit empty selection grants NOTHING (least-privilege, not full); revoke goes through the ui/confirm dialog and the row disappears' },
        ] },
      { id: 'UCP-02', title: 'Discovery + OAuth-AS metadata honesty', priority: 'P2', preconditions: ['A merchant with commerce-ucp on'],
        steps: [
          { action: 'GET the discovery URL (.well-known/ucp)', expect: 'vertical=shopping, merchant=org, payment methods include ap2 (mode demo); transports.rest present but mcp/a2a are NULL — advertise-only-what-is-honored' },
          { action: 'GET .well-known/oauth-authorization-server', expect: 'RFC 8414 metadata: token_endpoint, grant_types_supported=[client_credentials], scopes_supported' },
          { action: 'GET discovery for an unknown org OR while commerce-ucp is OFF', expect: 'Uniform 404 (tenant-from-resource + toggle gate; no existence leak)' },
        ] },
      { id: 'UCP-03', title: 'OAuth token + fail-closed scope gate', priority: 'P0', blocker: true, preconditions: ['A provisioned client (id+secret)'],
        steps: [
          { action: 'POST /oauth/token grant_type=client_credentials with the id+secret', expect: '200 Bearer access_token + scope list + expires_in' },
          { action: 'Call a cart write with NO bearer, then with a WRONG scope (e.g. cart:write-only token → checkout)', expect: '401 (no bearer) and 403 (missing checkout:write) — fail-closed' },
          { action: 'POST /oauth/token with a bad client_secret', expect: '401 invalid_client (uniform, no existence leak)' },
        ] },
      { id: 'UCP-04', title: 'Catalog projection (no leak)', priority: 'P2', preconditions: ['A merchant with active + inactive products'],
        steps: [
          { action: 'GET /catalog (public, no auth)', expect: 'Only ACTIVE products, projected to UCP items (title/price/availability/images/variants); the operational inventory count is NOT exposed' },
        ] },
      { id: 'UCP-05', title: 'Cart → checkout → order (no new store)', priority: 'P1', preconditions: ['A bearer with cart:write + checkout:write; an active product'],
        steps: [
          { action: 'POST /cart/items (bearer) then GET /cart', expect: 'The UCP cart projects the commerce cart keyed by the token subject; subtotal computes' },
          { action: 'POST /checkout, then GET /orders/:id', expect: 'A commerce order is created (status pending, payment unpaid) and projected as a UCP order' },
          { action: 'As the merchant admin, look up that same order in commerce', expect: 'It is the SAME order (UCP projects commerce — no parallel order store)' },
        ] },
      { id: 'UCP-06', title: 'AP2 payment + buyer-agent lifecycle', priority: 'P1', preconditions: ['A pending UCP order + a checkout:write bearer'],
        steps: [
          { action: 'POST /orders/:id/pay with an ap2_mandate {amount,currency} MATCHING the order', expect: 'demo-mode: order → paid; payment.warnings flags the VC as not_cryptographically_verified (honest, never claimed verified)' },
          { action: 'Pay with a mandate amount/currency that MISMATCHES, and pay with NEITHER mandate nor payment_intent_id', expect: 'Both 400 (real guard; a mandate must match the order, and something must authorize the charge)' },
          { action: 'Cancel a still-pending order, then try to pay it', expect: 'Cancel → canceled; paying a canceled order → 409 (markAsPaid pending-only)' },
        ] },
      { id: 'UCP-07', title: 'Cross-org IDOR + admin gating', priority: 'P1', preconditions: ['Two merchants A and B, both with commerce-ucp on'],
        steps: [
          { action: 'Mint a bearer for merchant A, then use it against merchant B’s /cart', expect: '401 — a token is bound to its org (verifyToken checks tenant+org); no cross-merchant access' },
          { action: 'Turn commerce-ucp OFF, then hit the ADMIN client-provisioning routes', expect: '404 — the admin routes are gated on commerce-ucp too (not just the public surface)' },
        ] },
      { id: 'UCP-08', title: 'UCP over the inbound MCP server', priority: 'P2', preconditions: ['MCP server enabled; commerce-ucp on for your tenant'],
        steps: [
          { action: 'List MCP tools as an authenticated caller with commerce-ucp on', expect: 'ucp-catalog-search + ucp-place-order appear (backed by feature.commerce.nodes.* — no new node types)' },
          { action: 'List them as an ANONYMOUS caller, or with commerce-ucp OFF', expect: 'They are absent — fail-closed via the workflow metadata gate (mcpFeatureToggle + mcpRequiresAuth)' },
        ] },
    ],
  },
  {
    key: 'billing', feature: 'Subscriptions & Billing', route: '/billing', description: 'Subscription/plan + prepaid AI-token balance ledger; Stripe host-side via BYOK, demo-mode default. ADR 0176.',
    toggle: offVia('billing'), updatedAt: '2026-07-02', sourceCommit: '95df964c', sourceFiles: ['backend/typescript/src/features/billing', 'frontend/react/src/features/billing'],
    cases: [
      { id: 'BILL-01', title: 'Plan + balance render + manage', priority: 'P1', preconditions: ['billing enabled; signed in'],
        steps: [
          { action: 'Open /billing', expect: 'Plan tier + a status chip (tone maps active/trial/past-due/canceled) + prepaid token balance render; a Skeleton while loading' },
          { action: 'Click Manage billing with NO Stripe key configured', expect: 'A demo-mode toast (never a broken redirect); with a live key it opens the Stripe portal (https)' },
          { action: 'Switch locale to fr / pt-BR / es', expect: 'All chrome is localized (billing namespace) — no hardcoded English' },
        ] },
      { id: 'BILL-02', title: 'Entitlements gating (central, not per-feature)', priority: 'P1', blocker: true, preconditions: ['billing enabled; a plan with a known limit'],
        steps: [
          { action: 'Read entitlements for the tenant', expect: 'resolveEntitlements maps plan → allowedFeatures + limits (one central resolver)' },
          { action: 'Exceed a plan LIMIT on a guarded op', expect: 'Blocked at the ONE opt-in guard (GovernancePolicy), not via scattered per-feature edits — the blast-radius anti-pattern is avoided' },
        ] },
      { id: 'BILL-03', title: 'Prepaid balance drawn BEFORE the managed daily cap', priority: 'P1', preconditions: ['A tenant with a prepaid token balance > 0; managed provider in use'],
        steps: [
          { action: 'Run a managed AI call and inspect the balance', expect: 'Tokens draw from the prepaid balance at the managedProvider choke point (managedBalanceHook) BEFORE the daily cap is consulted' },
          { action: 'Deplete the balance, then run again', expect: 'Depletion is enforced at the same choke point (not silently ignored)' },
        ] },
      { id: 'BILL-04', title: 'Seat sync from org membership', priority: 'P2', preconditions: ['billing enabled; an org with N members'],
        steps: [
          { action: 'Add/remove an org member, then POST sync-seats (superadmin)', expect: 'The subscription quantity tracks org membership count (seats = members)' },
        ] },
      { id: 'BILL-05', title: 'Coupons + invoice generation', priority: 'P2', preconditions: ['billing enabled'],
        steps: [
          { action: 'Create a billing coupon and compute a discount', expect: 'billingCouponDiscount applies the coupon correctly' },
          { action: 'Generate an invoice, then list + get it', expect: 'An invoice record (markdown) persists and reads back; a real PDF composes Documents (0053), not a new store' },
        ] },
      { id: 'BILL-06', title: 'Stripe webhook — signature + idempotency', priority: 'P2', preconditions: ['A billing Stripe webhook path (public, signature-is-credential)'],
        steps: [
          { action: 'POST the webhook with NO signing secret set', expect: '503 (demo-mode) — no state change' },
          { action: 'POST a validly-signed event, then RE-DELIVER the same event.id', expect: 'processStripeEvent applies once; the replay is idempotent (per event.id) — a wrong signature is 401' },
        ] },
      { id: 'BILL-07', title: 'Checkout session demo/live seam', priority: 'P3', preconditions: ['billing enabled'],
        steps: [
          { action: 'Create a checkout session with no Stripe key', expect: 'A demo sentinel (mode: demo) — no live redirect' },
          { action: 'Configure a BYOK Stripe key and retry', expect: 'A live checkout URL (mode: live)' },
        ] },
      { id: 'BILL-08', title: 'R-1 cutover — id-preserving import', priority: 'P3', preconditions: ['An export of an existing Stripe account state'],
        steps: [
          { action: 'Run importBillingState with customers/subscriptions/invoices/token-balances', expect: 'Every Stripe id carries over VERBATIM (no re-provisioning); a subsequent webhook for an imported customer resolves to the right tenant (tenantForStripeCustomer)' },
        ] },
    ],
  },
  {
    // ADR 0342 Phase 8 residue — the app-builder application-model journey as a
    // human-runnable suite (the golden-journey vitest walks the same seams over
    // HTTP; this is the per-toggle-state manual counterpart).
    key: 'app-builder', feature: 'App Builder', route: '/app-builder',
    description: 'Multi-screen app design: AI create → facets → catalog kits → export with preflight/lineage → sanitized share.',
    toggle: ON, updatedAt: '2026-07-23', sourceCommit: '29ab77bd7',
    sourceFiles: ['frontend/react/src/features/app-builder', 'backend/typescript/src/features/app-builder', 'backend/typescript/test/app-builder-golden-journey.test.ts'],
    cases: [
      { id: 'APPB-01', title: 'Create with AI from a blank canvas', priority: 'P0', blocker: true,
        preconditions: ['app-builder ON (default)', 'A BYOK provider configured'],
        steps: [
          { action: 'Open /app-builder, create an app-builder canvas, then use the shared chat to ask the App Architect for a small two-screen app', expect: 'The App Architect returns a structured design; screens + component trees render on the canvas — never raw code' },
          { action: 'Ask for a change that references the current design (e.g. "add a settings screen")', expect: 'The revision composes with the existing design (the agent read before writing); the canvas updates without losing prior screens' },
        ] },
      { id: 'APPB-02', title: 'Closed-world validation refuses an unknown component', priority: 'P0', blocker: true,
        preconditions: ['An app-builder canvas open'],
        steps: [
          { action: 'Attempt to save a screen naming a component type outside the host catalog (via the editor JSON view if exposed, or observe an AI repair)', expect: 'The write is refused with a typed validation error (422) or repaired — an unknown type NEVER persists silently' },
        ] },
      { id: 'APPB-03', title: 'Catalog kits install onto the canvas', priority: 'P1', blocker: false,
        preconditions: ['An app-builder canvas open'],
        steps: [
          { action: 'Browse the content catalog and apply a multi-screen kit', expect: 'The kit’s screens append with prefixed ids; existing screens are untouched; template variables prompt before splice' },
        ] },
      { id: 'APPB-04', title: 'Export runs preflight and yields lineage-pinned artifacts', priority: 'P0', blocker: true,
        preconditions: ['code-export toggle ON', 'A canvas with at least two screens'],
        steps: [
          { action: 'Export the canvas (pick any framework target) with preflight on', expect: 'Preflight reports unmapped components as warnings (never a silent drop); the export produces a file manifest with content hashes and the OpenAPI document in-bundle' },
          { action: 'Re-export the SAME canvas version without edits', expect: 'The manifest hash is identical (deterministic export); the lineage/history view records both exports against the same canvas version' },
        ] },
      { id: 'APPB-05', title: 'A public share is sanitized', priority: 'P0', blocker: true,
        preconditions: ['A canvas with an export history'],
        steps: [
          { action: 'Create a public share link for the canvas and open it logged-out', expect: 'The share renders the design ONLY — no export artifacts, no env requirement values, no lineage internals, no tenant identifiers' },
        ] },
    ],
  },
  {
    key: 'code-export', feature: 'Code Export', route: '/builder', description: 'Export an app-builder canvas to code (incl. React Native, Flutter).',
    toggle: offVia('code-export'), updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['backend/typescript/src/features/app-builder/export'],
    cases: [
      { id: 'CXP-01', title: 'Export targets', priority: 'P2', preconditions: ['code-export enabled; an app-builder canvas'],
        steps: [
          { action: 'Export the canvas and pick each target (HTML, React, Vue, Angular, React Native, Flutter)', expect: 'Each produces code; text is HTML-escaped except Flutter (Dart string literals)' },
        ] },
    ],
  },
  {
    key: 'market-intel', feature: 'Market Intelligence', route: '/', description: 'Market-intel agent + workflow packs (chat-driven, no page).',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['packs'],
    cases: [
      { id: 'MKTI-01', title: 'Market-intel digest via chat', priority: 'P2', preconditions: ['The market-intel packs installed'],
        steps: [
          { action: 'In chat, run the market-intel digest workflow', expect: 'A digest artifact is produced; the shift-detect variant flags notable changes' },
        ] },
    ],
  },
  {
    key: 'messaging-gateway', feature: 'Messaging Gateway', route: '/connections', description: 'Inbound webhook pairing + outbound send seam (Connections).',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['backend/typescript/src/features/connections/messagingOutbound.ts', 'backend/typescript/src/features/connections/inboundWebhooks.ts'],
    cases: [
      { id: 'MSG-01', title: 'Pair + outbound (mock transport)', priority: 'P2', preconditions: ['A connection exists'],
        steps: [
          { action: 'Trigger the /pair flow for a connection, then send an outbound message', expect: 'Pairing records; an unpaired send returns no_pairing; with a wired transport it delivers (mock in tests)' },
        ] },
    ],
  },
  // ── Chat platform (ADR 0118-0154; several graduated always-on by ADR 0134) ──
  { key: 'channels', feature: 'Channels', route: '/', description: 'Multi-party channels with presence/typing in the chat rail.',
    toggle: offVia('channels'), updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['frontend/react/src/features/channels'],
    cases: [ { id: 'CHAN-01', title: 'Create + post to a channel', priority: 'P2', preconditions: ['channels enabled'],
      steps: [ { action: 'Create a channel from the chat rail and post a message', expect: 'The channel lists; the message appears; presence/typing cues show for a second member' } ] } ] },
  { key: 'chat-widget', feature: 'Embeddable chat widget', route: '/widgets', description: 'Configure + embed a public chat widget.',
    toggle: offVia('chat-widget'), updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['frontend/react/src/features/chat-widget'],
    cases: [ { id: 'WIDGET-01', title: 'Configure a widget', priority: 'P2', preconditions: ['chat-widget enabled'],
      steps: [ { action: 'Open /widgets, create a widget, copy the embed snippet', expect: 'A widget config saves; the embed snippet is copyable' } ] } ] },
  { key: 'chat-export', feature: 'Conversation export', route: '/', description: 'Export a conversation to Markdown/JSON.',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['backend/typescript/src/features/chat-export'],
    cases: [ { id: 'CXPT-01', title: 'Export a conversation', priority: 'P2', preconditions: ['A conversation with a few turns'],
      steps: [ { action: 'Use the conversation export affordance (Markdown then JSON)', expect: 'A file/clipboard export is produced containing the turns' } ] } ] },
  { key: 'chat-autotitle', feature: 'Conversation auto-titling', route: '/', description: 'New chats get an AI-generated title.',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['backend/typescript/src/features/chat-autotitle'],
    cases: [ { id: 'TITLE-01', title: 'Auto-title a new chat', priority: 'P3', preconditions: ['Chat open'],
      steps: [ { action: 'Start a new conversation and send a couple of messages', expect: 'The rail title updates from "New chat" to a generated summary title' } ] } ] },
  { key: 'conversation-search', feature: 'Conversation search', route: '/', description: 'Search across conversations from the chat rail.',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['backend/typescript/src/features/conversation-search'],
    cases: [ { id: 'CSRCH-01', title: 'Search conversations', priority: 'P2', preconditions: ['Several conversations exist'],
      steps: [ { action: 'Open the chat rail search and query a known phrase', expect: 'Matching conversations/messages are returned and open on click' } ] } ] },
  { key: 'conversation-tools', feature: 'Per-conversation capability scope', route: '/', description: 'Scope which tools a conversation may use.',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['backend/typescript/src/features/conversation-tools'],
    cases: [ { id: 'CTOOL-01', title: 'Scope tools for a conversation', priority: 'P2', preconditions: ['Chat open'],
      steps: [ { action: 'Open the conversation capability-scope control and disable a tool', expect: 'The agent can no longer call the disabled tool in that conversation' } ] } ] },
  { key: 'interactive-artifacts', feature: 'Interactive artifacts', route: '/', description: 'Sandboxed renderer for charts/mermaid/math/live-edit.',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['backend/typescript/src/features/interactive-artifacts'],
    cases: [ { id: 'ART-01', title: 'Render an interactive artifact', priority: 'P2', preconditions: ['A conversation that can produce an artifact'],
      steps: [ { action: 'Produce a chart/mermaid artifact and open the workbench', expect: 'It renders in the sandboxed frame; dark-mode themes correctly; no console errors' } ] } ] },
  { key: 'model-router', feature: 'Model router', route: '/model-router', description: 'Route requests across models by policy.',
    toggle: offVia('model-router'), updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['frontend/react/src/features/model-router'],
    cases: [ { id: 'MROUTE-01', title: 'Configure a routing rule', priority: 'P2', preconditions: ['model-router enabled'],
      steps: [ { action: 'Open /model-router and add a routing rule', expect: 'The rule persists; a matching chat request is routed to the target model' } ] } ] },
  { key: 'scheduled-agent-chats', feature: 'Scheduled agent chats', route: '/scheduled-chats', description: 'Recurring agent conversations on a schedule.',
    toggle: offVia('scheduled-agent-chats'), updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['frontend/react/src/features/scheduled-chats'],
    cases: [ { id: 'SCHED-01', title: 'Create a scheduled chat', priority: 'P2', preconditions: ['scheduled-agent-chats enabled'],
      steps: [ { action: 'Open /scheduled-chats and create a schedule', expect: 'It lists with its cadence + next-run; disabling stops it' } ] } ] },
  { key: 'evals', feature: 'Evals leaderboard', route: '/leaderboard', description: 'Model/agent Elo ARENA + per-org leaderboard. ADR 0123.',
    toggle: offVia('evals'), updatedAt: '2026-07-02', sourceCommit: '5066d95e', sourceFiles: ['backend/typescript/src/features/evals', 'frontend/react/src/features/evals'],
    cases: [
      { id: 'EVAL-01', title: 'Leaderboard renders (empty state)', priority: 'P2', preconditions: ['evals enabled; an org selected'],
        steps: [ { action: 'Open /leaderboard for an org with no matches', expect: 'A designed empty state (no matches yet), not a crash or a bare list' } ] },
      { id: 'EVAL-02', title: 'Record an arena match → Elo updates', priority: 'P1', preconditions: ['evals enabled; two competitors (models/agents)'],
        steps: [
          { action: 'POST an arena match where A beats B (evals/orgs/:orgId/arena/match)', expect: 'The match records; A’s Elo rises and B’s falls (getArenaRating reflects it)' },
          { action: 'Record several matches, then GET the leaderboard', expect: 'Competitors rank by Elo (computeEloRatings → computeLeaderboard); a higher rating ranks higher' },
        ] },
      { id: 'EVAL-03', title: 'Aggregation is well-formed', priority: 'P2', preconditions: ['Matches recorded'],
        steps: [ { action: 'View the combined leaderboard', expect: 'combineLeaderboard aggregates consistently; expectedScore stays bounded (no NaN/∞)' } ] },
      { id: 'EVAL-04', title: 'Tenant isolation', priority: 'P1', preconditions: ['Two orgs, each with matches'],
        steps: [ { action: 'GET org A’s leaderboard, then attempt org B’s as an A-only member', expect: 'Per-org (buildTenantLeaderboard) — no cross-org leak' } ] },
      { id: 'EVAL-05', title: 'Toggle gating', priority: 'P2', preconditions: ['evals OFF'],
        steps: [ { action: 'Navigate to /leaderboard with evals off, then enable + reload', expect: 'Off → unreachable/404; on → it renders' } ] },
    ] },
  { key: 'task-deck', feature: 'Run / task deck', route: 'chrome — Run/Task deck panel (opened from the app shell, not a route)', description: 'Cross-run task deck.',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['backend/typescript/src/features/task-deck'],
    cases: [ { id: 'DECK-01', title: 'Task deck buckets', priority: 'P2', preconditions: ['Some runs/tasks exist'],
      steps: [ { action: 'Open /tasks', expect: 'Tasks group into buckets that scroll; empty state is designed' } ] } ] },
  { key: 'code-exec', feature: 'Code execution', route: '/', description: 'Sandboxed (CPython-WASI) code execution in chat — HITL-approved, honest-off. ADR 0114/0146.',
    toggle: ON, updatedAt: '2026-07-02', sourceCommit: '5066d95e', sourceFiles: ['backend/typescript/src/features/code-exec', 'backend/typescript/src/host/wasiSandbox.ts'],
    cases: [
      { id: 'CEXE-01', title: 'HITL approval gates execution', priority: 'P0', blocker: true, preconditions: ['Chat open; a runtime available (WASI asset or external endpoint)'],
        steps: [
          { action: 'Ask the agent to run a small Python snippet', expect: 'A HITL approval card appears BEFORE anything runs' },
          { action: 'Approve it; in a fresh turn deny another', expect: 'Approve → runs sandboxed + returns output; Deny → blocked (an untrusted client can never silently execute)' },
        ] },
      { id: 'CEXE-02', title: 'Sandbox isolation (the escape class)', priority: 'P0', blocker: true, preconditions: ['A run that reaches the WASI sandbox'],
        steps: [ { action: 'Run code attempting import js / fs / os.environ / socket / subprocess and reading a host path', expect: 'All denied by construction (node:wasi grants only the passed syscalls/preopens; plain CPython has no js FFI); /tmp is per-exec isolated' } ] },
      { id: 'CEXE-03', title: 'Wall-clock timeout', priority: 'P1', preconditions: ['A runtime available'],
        steps: [ { action: 'Run an infinite loop', expect: 'The worker is terminated (exit 124); the host does not hang' } ] },
      { id: 'CEXE-04', title: 'Honest-off when unconfigured', priority: 'P1', preconditions: ['A build with NO vendored WASI asset and no external endpoint'],
        steps: [ { action: 'Ask to run code', expect: 'The capability is advertised OFF / not offered — an honest not-configured state, never a false claim (an external endpoint wins when set)' } ] },
      { id: 'CEXE-05', title: 'Language allowlist', priority: 'P2', preconditions: ['WASI runtime present'],
        steps: [ { action: 'Request a non-Python language', expect: 'Only Python is offered (wasiAllowedLanguages) — no unsupported-runtime execution' } ] },
      { id: 'CEXE-06', title: 'Per-tenant daily budget', priority: 'P3', preconditions: ['A tenant near its exec budget'],
        steps: [ { action: 'Exceed the per-tenant daily execution budget', expect: 'Further executions are refused at the budget guard (bounds the availability residual)' } ] },
    ] },
  { key: 'memory-auto-extract', feature: 'Chat memory auto-extraction', route: '/', description: 'Auto-extract durable memory from chats.',
    toggle: offVia('memory-auto-extract'), updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['backend/typescript/src/features/memory-auto-extract'],
    cases: [ { id: 'MAX-01', title: 'Auto-extracted memory surfaces in My Profile', priority: 'P2', preconditions: ['memory-auto-extract enabled'],
      steps: [ { action: 'Have a chat mentioning a durable preference, then open My Profile memory', expect: 'An auto-extracted memory item appears and is editable/removable' } ] } ] },
  { key: 'voice', feature: 'Live voice mode', route: '/', description: 'Realtime voice on the chat surface.',
    toggle: offVia('voice'), updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['backend/typescript/src/features/voice'],
    cases: [ { id: 'VOICE-01', title: 'Enter voice mode', priority: 'P2', preconditions: ['voice enabled; mic permission'],
      steps: [ { action: 'Start voice mode in chat', expect: 'A voice UI appears; the error/unsupported phase is labelled (never a stuck state)' } ] } ] },
  // ── Governance & platform (ADR 0135-0148) ─────────────────────────────────
  { key: 'capability-firewall', feature: 'Capability Firewall', route: '/capability-firewall', description: 'Allow/deny of tool/host capability CLASSES per scope; fail-closed on unknown. ADR 0135.',
    toggle: ON, updatedAt: '2026-07-02', sourceCommit: '5066d95e', sourceFiles: ['backend/typescript/src/features/capability-firewall', 'frontend/react/src/features/capability-firewall'],
    cases: [
      { id: 'CFW-01', title: 'Deny a capability class (fail-closed)', priority: 'P0', blocker: true, preconditions: ['Admin; a tool with a known capability class'],
        steps: [
          { action: 'Set a DENY rule for a capability class (setCapabilityRules), then have an agent call a tool of that class', expect: 'The call is blocked at the firewall hook (buildFirewallHook) — fail-closed' },
          { action: 'Remove the rule and retry', expect: 'The tool is allowed again' },
        ] },
      { id: 'CFW-02', title: 'Unknown-tool policy', priority: 'P1', preconditions: ['A tool whose capability class is unknown'],
        steps: [ { action: 'Invoke an unknown-class tool under the configured policy', expect: 'It follows getUnknownToolPolicy (deny-by-default unless explicitly allowed) — never fails open' } ] },
      { id: 'CFW-03', title: 'Composition precedence', priority: 'P1', preconditions: ['A rule set mixing allow + deny'],
        steps: [ { action: 'Configure an allow AND a deny that both match one tool, then invoke it', expect: 'evaluateComposition resolves precedence deterministically (explicit deny wins); parseExpression parses the rule expression' } ] },
      { id: 'CFW-04', title: 'Recommended exfil / count rules', priority: 'P2', preconditions: ['Admin'],
        steps: [ { action: 'Apply the recommended exfil + count rules (recommendedExfilRule / recommendedCountRule)', expect: 'A high-egress or high-call-count tool sequence is caught by the rule' } ] },
      { id: 'CFW-05', title: 'Decision is stamped / auditable', priority: 'P2', preconditions: ['A firewall decision occurred on a run'],
        steps: [ { action: 'Inspect the run’s firewall stamp', expect: 'computeFirewallStamp records the applied rule set — the decision is auditable + replay-stable' } ] },
      { id: 'CFW-06', title: 'Malformed rules rejected', priority: 'P3', preconditions: ['Admin'],
        steps: [ { action: 'Submit an invalid rule set', expect: 'validateRules rejects it with a clear error — no partial/ambiguous state persists' } ] },
    ] },
  { key: 'intent-ledger', feature: 'Intent Ledger', route: '/', description: 'Durable record of agent intents (host-ext, no page).',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['backend/typescript/src/features/intent-ledger'],
    cases: [ { id: 'ILDG-01', title: 'Intents are recorded', priority: 'P2', preconditions: ['Run an agent action that declares intent'],
      steps: [ { action: 'Drive an agent action, then inspect the intent ledger (governance surface / API)', expect: 'The intent is recorded with actor + timestamp' } ] } ] },
  { key: 'ambient-work-graph', feature: 'Ambient Work Graph', route: '/', description: 'Suggested next work from activity (host-ext).',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['frontend/react/src/features/ambient-work-graph'],
    cases: [ { id: 'AWG-01', title: 'Suggestions surface', priority: 'P3', preconditions: ['Some activity exists'],
      steps: [ { action: 'Open the ambient work-graph panel', expect: 'Suggestions render (or a designed empty state)' } ] } ] },
  { key: 'access-hub', feature: 'Access Hub', route: '/access', description: 'Unified credentials + identity landing (IA).',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['frontend/react/src/features/access-hub'],
    cases: [ { id: 'ACC-01', title: 'Access hub clusters', priority: 'P3', preconditions: ['Admin'],
      steps: [ { action: 'Open /access', expect: 'Credentials + identity surfaces cluster with working links' } ] } ] },
  { key: 'navigation-settings', feature: 'Configurable Navigation', route: '/menu-settings', description: 'Reorder/hide nav destinations.',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['frontend/react/src/features/navigation-settings'],
    cases: [ { id: 'NAVS-01', title: 'Reorder nav', priority: 'P3', preconditions: ['Admin'],
      steps: [ { action: 'Open /menu-settings, hide a destination and reorder another', expect: 'The sidebar reflects the change and persists across reload' } ] } ] },
  { key: 'context-economy', feature: 'Context Economy', route: '/', description: 'Host-internal context/token economy (admin-visible).',
    toggle: offVia('context-economy'), updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['backend/typescript/src/features/context-economy'],
    cases: [ { id: 'CECON-01', title: 'Economy applies', priority: 'P3', preconditions: ['context-economy enabled'],
      steps: [ { action: 'Run a long conversation and observe context handling', expect: 'Context is economized per policy; no truncation error surfaces to the user' } ] } ] },
  // ADR 0604 (TOCU-3) — REWRITTEN. The single P3 case here was unfalsifiable:
  // it asked the tester to confirm compaction "via run detail", a surface ADR
  // 0099 deliberately does not create, and it targeted the chat lane, which was
  // not wired at all. Every case below now names a screen a human can open and
  // an outcome that can come out WRONG.
  { key: 'tool-output-compaction', feature: 'Tool-output Compaction', route: '/runs',
    description: 'Compact verbose tool output before the model context. Default mode is minify-only; savings need the per-agent lossy opt-in (ADR 0099 / 0604).',
    toggle: offVia('tool-output-compaction'), updatedAt: '2026-08-23', sourceCommit: '3044a6301',
    sourceFiles: ['backend/typescript/src/features/tool-output-compaction', 'backend/typescript/src/host/toolResultTransform.ts', 'frontend/react/src/runs/CompactionNotice.tsx'],
    cases: [
      { id: 'TOC-01', title: 'A shortened list is DISCLOSED, not passed off as complete', priority: 'P1',
        preconditions: ['tool-output-compaction ON', 'an agent with configParameters.compaction.lossy = true', 'a run whose tool returned >5 rows'],
        steps: [
          { action: 'Open /runs → the run → select the compacting step in the timeline', expect: 'Above the JSON, an info notice states how many rows were removed (e.g. "137 rows were removed from the middle of a list"). FAIL if the payload shows `{"_elided": N}` with no notice — that is the TOCU-1 defect.' },
          { action: 'Expand the same event’s "payload" disclosure in the timeline lane', expect: 'The same notice appears there too — both surfaces render the raw payload, so both must disclose.' },
        ] },
      { id: 'TOC-02', title: 'The DEFAULT mode does not delete anything', priority: 'P1',
        preconditions: ['tool-output-compaction ON', 'NO per-agent lossy opt-in (the default)'],
        steps: [
          { action: 'Run a tool that returns an honest empty, e.g. a search with no hits (`{"results":[],"query":"…"}`)', expect: 'The model’s tool result still contains `"results": []`. FAIL if the field is missing — pre-ADR-0604 the "lossless" mode dropped it, turning "we looked and found nothing" into "no information".' },
          { action: 'Compare the byte content of the tool result before/after enabling the toggle', expect: 'Identical apart from JSON whitespace. The default mode minifies and nothing else.' },
        ] },
      { id: 'TOC-03', title: 'A :fork never acquires compaction the source never had', priority: 'P1',
        preconditions: ['tool-output-compaction OFF'],
        steps: [
          { action: 'Start a run with the toggle OFF, then turn the toggle ON, then fork that run from /runs → "Fork from here"', expect: 'The fork runs UNCOMPACTED, exactly as its source was born. FAIL if the fork compacts — that is TOCWF-1, and it applies to every run created before the toggle was first enabled.' },
        ] },
      { id: 'TOC-04', title: 'Schema/catalog tools stay byte-exact even under lossy', priority: 'P2',
        preconditions: ['tool-output-compaction ON', 'lossy opt-in ON for the agent'],
        steps: [
          { action: 'In chat, ask the agent to list the app-builder component catalog (`openwop:app-builder.catalog`)', expect: 'The full catalog reaches the model — no `_elided` marker inside it. A truncated enum makes the model author against a catalog this host does not have.' },
        ] },
      { id: 'TOC-05', title: 'Toggle gating', priority: 'P2', preconditions: ['tool-output-compaction OFF'],
        steps: [ { action: 'Run a tool-calling turn with the toggle OFF, then ON, comparing the run record', expect: 'OFF → `run.metadata.compaction` absent and output byte-identical; ON → the key is present as `{"mode":"lossless"}`.' } ] },
    ] },
  { key: 'usage-analytics', feature: 'Usage Analytics', route: '/usage', description: 'Recorded usage events → per-org rollup (+ cost). ADR 0118.',
    toggle: offVia('usage-analytics'), updatedAt: '2026-07-02', sourceCommit: '929e30a4', sourceFiles: ['backend/typescript/src/features/usage-analytics', 'frontend/react/src/features/usage-analytics'],
    cases: [
      { id: 'USAGE-01', title: 'Dashboard renders', priority: 'P2', preconditions: ['usage-analytics enabled; an org selected'],
        steps: [ { action: 'Open /usage for an org with no data', expect: 'A designed empty state; skeletons have the correct column count while loading (USAGE-1 fix)' } ] },
      { id: 'USAGE-02', title: 'Rollup reflects recorded usage', priority: 'P1', preconditions: ['Some recorded usage events'],
        steps: [
          { action: 'Generate activity (recordUsage), then open /usage (getUsageRollup for the org)', expect: 'Charts aggregate the events by dimension (model/agent/period); totals match the events' },
        ] },
      { id: 'USAGE-03', title: 'Cost rollup', priority: 'P2', preconditions: ['Usage across ≥2 models with catalog pricing'],
        steps: [ { action: 'View the cost view (getUsageRollupWithCost)', expect: 'Cost is computed from providers.json pricing (the model-catalog SSoT), per model; no NaN/blank costs' } ] },
      { id: 'USAGE-04', title: 'Tenant / org isolation', priority: 'P1', preconditions: ['Usage under two orgs'],
        steps: [ { action: 'View org A’s rollup, then attempt org B’s as an A-only member', expect: 'Per-org (usage/orgs/:orgId/rollup) — no cross-org leak' } ] },
      { id: 'USAGE-05', title: 'Toggle gating', priority: 'P2', preconditions: ['usage-analytics OFF'],
        steps: [ { action: 'Navigate to /usage with it off, then enable + reload', expect: 'Off → unreachable/404; on → the dashboard renders' } ] },
    ] },
  { key: 'workflow-author', feature: 'AI Workflow Author', route: '/builder', description: '"Create with AI" scoped to the Workflow Architect.',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['backend/typescript/src/features/workflow-author'],
    cases: [ { id: 'WFA-01', title: 'Create a workflow with AI', priority: 'P1', preconditions: ['Builder open'],
      steps: [ { action: 'Use "Create with AI" and describe a workflow', expect: 'A workflow is authored on the canvas via the embedded chat (Workflow Architect agent)' } ] } ] },
  { key: 'assistant', feature: 'Assistant / Chief of Staff', route: '/agents', description: 'The always-on assistant capability (Iris) driving proactive work.',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['backend/typescript/src/features/assistant'],
    cases: [ { id: 'ASST-01', title: 'Chief-of-Staff loop', priority: 'P2', preconditions: ['The Chief-of-Staff agent exists'],
      steps: [ { action: 'Open the Chief-of-Staff agent and ask it to plan the day', expect: 'It reads across surfaces and produces a briefing/recommendations' } ] } ] },
  // ── Content, knowledge & identity (earlier-missed) ────────────────────────
  { key: 'notebooks', feature: 'Research Notebooks', route: '/projects', description: 'Sources + notes + grounded RAG (NotebookLM-style) — surfaced as a PROJECT tab: open a project → Sources (no standalone route). ADR 0084/0087.',
    toggle: offVia('notebooks'), updatedAt: '2026-07-02', sourceCommit: '929e30a4', sourceFiles: ['backend/typescript/src/features/notebooks', 'frontend/react/src/features/notebooks'],
    cases: [
      { id: 'NB-01', title: 'Create a notebook + add sources', priority: 'P1', preconditions: ['notebooks enabled'],
        steps: [
          { action: 'createNotebook, then addSource (text) twice; listSources', expect: 'The notebook persists; both sources list with their per-source context level' },
          { action: 'listNotebooks + reopen', expect: 'The notebook reads back with its sources' },
        ] },
      { id: 'NB-02', title: 'Per-source context level', priority: 'P2', preconditions: ['A notebook with ≥2 sources'],
        steps: [ { action: 'setSourceContextLevel on one source (e.g. exclude it)', expect: 'The change persists; that source’s contribution to retrieval reflects its level' } ] },
      { id: 'NB-03', title: 'Semantic search + grounded ask (RAG)', priority: 'P1', preconditions: ['A notebook with sources containing a known phrase'],
        steps: [
          { action: 'Run a semantic search over the notebook', expect: 'Ranked hits with CITATIONS back to the source' },
          { action: 'Ask a grounded question', expect: 'A fenced, cited context block is returned to answer from — grounded in the sources, not free-form' },
        ] },
      { id: 'NB-04', title: 'Notes', priority: 'P3', preconditions: ['A notebook'],
        steps: [ { action: 'Add and list notes', expect: 'Notes persist alongside sources' } ] },
      { id: 'NB-05', title: 'Project-bound notebook + tenant scope', priority: 'P2', preconditions: ['A project; two orgs'],
        steps: [
          { action: 'ensureNotebookForProject, then open the project’s Sources tab', expect: 'The notebook is surfaced as a PROJECT tab (ADR 0084 correction — not a standalone nav destination)' },
          { action: 'Try to read another tenant’s notebook', expect: 'Not visible — notebooks are tenant/org-scoped' },
        ] },
      { id: 'NB-06', title: 'Delete + toggle gating', priority: 'P3', preconditions: ['notebooks toggle'],
        steps: [ { action: 'deleteNotebook; with notebooks OFF open a project detail page', expect: 'Delete removes it + its sources; off → the Sources tab is absent (the standalone /notebooks route was withdrawn, ADR 0084 correction)' } ] },
    ] },
  // ADR 0603 §7 — POD-01 used to be ONE step whose expectation was
  // UNFALSIFIABLE: "produced and playable (or an honest not-configured state)"
  // passes whether the generate path works perfectly or is wholly broken, because
  // every possible outcome satisfies one of the two disjuncts. A test that cannot
  // fail is not coverage, and this feature is toggled OFF by default, so there was
  // also no enable-first case: a tester following the suite verbatim reached a
  // surface that does not exist and had nothing to record.
  { key: 'podcasts', feature: 'Podcasts', route: '/projects', description: 'Generate audio overviews from sources — surfaced as a PROJECT tab: open a project → Podcast (no standalone route).',
    toggle: offVia('podcasts'), updatedAt: '2026-08-23', sourceCommit: '8073d5396', sourceFiles: ['frontend/react/src/features/podcasts', 'backend/typescript/src/features/podcasts', 'packs/feature.podcasts.nodes'],
    cases: [
      { id: 'POD-00', title: 'Enable Podcasts and reach the Studio', priority: 'P0', blocker: true, preconditions: ['Admin / superadmin'],
        steps: [{ action: 'Turn the "podcasts" toggle ON (see enable steps), reload, open a project and select its Podcast tab', expect: 'The Podcast Studio renders. It is a PROJECT TAB — there is no /podcasts nav entry, and its absence from the rail is correct, not a failure' }] },
      { id: 'POD-01', title: 'Generate an episode — each stage is separately checkable', priority: 'P1', preconditions: ['POD-00; the notebooks toggle ON with a notebook holding ≥1 source; a cast profile with a real voiceId; a TTS provider key configured'],
        steps: [
          { action: 'Create a cast (speaker) profile with 1–2 speakers, then a show-format profile referencing it', expect: 'Both save and appear in their lists' },
          { action: 'Pick the notebook + show format and press Generate', expect: 'An episode appears with status Queued or Running, and a "View the run" link next to it that opens /runs/<id>' },
          { action: 'Wait for the run to finish (or open the run page and watch it)', expect: 'The episode reaches Done and a player appears — EITHER one audio element (the muxed file) OR the sequential clip player. A Done episode with NO player is a FAIL' },
          { action: 'Open the run page and read the transcript node output', expect: 'The transcript node produced turns, and a "— transcript" Document exists on the notebook. Zero turns with the run reported Done is a FAIL (ADR 0603 §3)' },
        ] },
      { id: 'POD-02', title: 'A generation that CANNOT succeed fails visibly and says why', priority: 'P1', preconditions: ['POD-00; a cast profile'],
        steps: [
          { action: 'Delete the cast (speaker) profile the episode\'s show format references, then Generate', expect: 'The episode reaches FAILED — not Done. The failure text on the card names the cast/speaker profile (ADR 0603 §3 `podcast_no_cast_voice`), and is not the generic "Generation failed"' },
          { action: 'Re-create the cast profile and press Retry on the failed episode', expect: 'The previous failure text is GONE from the card the moment it re-queues (it is the LAST run\'s testimony, and is cleared on re-run)' },
          { action: 'Check the episode still lists its earlier clips if it had any', expect: 'A failed re-run never ERASES a previously recorded clip list or its audio (ADR 0603 §1 — this was a real defect)' },
        ] },
      { id: 'POD-03', title: 'Publish an episode and check the PUBLIC page has a transcript', priority: 'P1', preconditions: ['POD-01 produced a Done episode'],
        steps: [
          { action: 'Create a show, publish it, then publish the episode onto it', expect: 'The episode shows a Published chip and the show exposes a feed URL' },
          { action: 'Open the public episode page (/pod/<orgId>/<showSlug>/<episodeSlug>) in a logged-OUT window', expect: 'The audio plays AND a "Transcript" section renders the episode text (WCAG 2.1 SC 1.2.1, Level A). A page with audio and NO transcript section at all is a FAIL — an episode with no transcript must still show the section saying so' },
          { action: 'With the podcasts toggle OFF, reload that same public URL', expect: 'A uniform 404 — no existence leak' },
        ] },
      { id: 'POD-04', title: 'The Studio recovers from a failed read instead of hanging', priority: 'P2', preconditions: ['POD-00'],
        steps: [
          { action: 'Open the Studio with the backend stopped (or DevTools offline)', expect: 'Failure cards render with a Retry button — NOT an endless skeleton, and NOT "No shows yet" (ADR 0603 §5)' },
          { action: 'Restore the backend and press Retry', expect: 'The lists load and the failure card disappears' },
        ] },
    ] },
  { key: 'brand', feature: 'Brand & Appearance', route: '/brand', description: 'Token-based theming / white-label.',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['frontend/react/src/features/brand'],
    cases: [ { id: 'BRAND-01', title: 'Apply a theme', priority: 'P2', preconditions: ['Admin'],
      steps: [ { action: 'Open /brand, adjust theme tokens, view the live preview', expect: 'Preview updates via tokens; save persists; light/dark both valid' } ] } ] },
  { key: 'cms-localization', feature: 'CMS content localization', route: '/cms', description: 'Per-locale content overrides + Accept-Language delivery.',
    toggle: offVia('cms-localization'), updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['backend/typescript/src/features/cms'],
    cases: [ { id: 'CMSL-01', title: 'Author a locale override', priority: 'P2', preconditions: ['cms-localization enabled; a CMS page'],
      steps: [ { action: 'Add a per-locale override and request the page with that Accept-Language', expect: 'The localized content is delivered; unlocalized falls back to default' } ] } ] },
  { key: 'cms-approval-gate', feature: 'CMS editorial approval gate', route: '/cms', description: 'Gate CMS publish on an Approvals-inbox decision.',
    toggle: offVia('cms-approval-gate'), updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['backend/typescript/src/features/cms'],
    cases: [ { id: 'CMSA-01', title: 'Publish requires approval', priority: 'P2', preconditions: ['cms-approval-gate enabled; a draft page'],
      steps: [ { action: 'Submit a page for publish', expect: 'A content-publish approval queues in the Approvals inbox; direct approve defers to it; approving publishes' } ] } ] },
  // ADR 0600 §7 (`ISU-16`) — INS-01 used to be one step ("Run the insights/drafting
  // workflow from chat" → "A drafted insight artifact is produced and readable"),
  // which could not pass: all three chains died `invalid_config` at their FIRST
  // node (ADR 0599 §4 witnessed it by execution). It has never been run against a
  // working feature. The cases below name what each chain actually NEEDS, so a
  // tester who cannot supply it reports "blocked on a Workday connection" rather
  // than a false negative.
  { key: 'insights-suite', feature: 'Insights & Drafting', route: '/', description: 'Insight/draft generation (chat / Builder gallery / runs / notifications — no page of its own).',
    toggle: offVia('insights-suite', { hasPage: false }), updatedAt: '2026-08-23', sourceCommit: '07c1b2e8', sourceFiles: ['backend/typescript/src/features/insights-suite', 'examples/workflow-chain-packs/insights-suite'],
    cases: [
      { id: 'INS-01', title: 'Weekly variance runs and reports a verdict it computed', priority: 'P2',
        preconditions: ['insights-suite enabled', 'A BigQuery connection', 'A `sql` returning metric/actual/plan rows'],
        steps: [
          { action: 'Open the Builder gallery, use the "Weekly variance (Actual vs Plan)" template, and run it with a real projectId + sql', expect: 'The run reaches the red-team approval gate. The gate card shows the VARIANCE FIGURES, not just a prompt (ADR 0600 §2).' },
          { action: 'Approve the gate', expect: 'A tenant-wide notification arrives, titled "Weekly variance (Actual vs Plan)", with a working link to the run. Its BODY IS EMPTY — that is expected, not a bug: this chain’s notify is fed by a resumed approval gate, which completes `{output: …}` with no top-level string to bind (ADR 0600 §5 / ISU-7, still open). A MISSING LINK is the defect this step is for.' },
          { action: 'Point `sql` at a table with NO rows and re-run', expect: 'The run FAILS `insufficient_data`. It must NOT report "on_plan" (ADR 0599 §3 — the defect this case exists for).' },
        ] },
      { id: 'INS-02', title: 'Talent readiness notifies ONLY you, with the score in the body', priority: 'P1',
        preconditions: ['insights-suite enabled', 'A Workday connection + tenant REST base URL', 'A second, non-admin user in the tenant'],
        steps: [
          { action: 'Run "Talent readiness prep" from chat against a real subjectId', expect: 'The score is derived from the pulled review rows — never box 1 / "Underperformer" for everyone (ADR 0599 §3).' },
          { action: 'Check YOUR inbox', expect: 'One notification, body carries the 9-box label, and its link opens the run.' },
          { action: 'Sign in as the second user and check THEIR inbox', expect: 'NOTHING. A named colleague\u2019s readiness score must not be broadcast workspace-wide (ADR 0600 §5 / ISU-6).' },
        ] },
      { id: 'INS-03', title: 'The anniversary draft is a DRAFT — nothing is ever sent', priority: 'P1',
        preconditions: ['insights-suite enabled', 'A Workday connection', 'A connected Gmail or Outlook mailbox'],
        steps: [
          { action: 'Run "Work-anniversary recognition draft" from chat', expect: 'A draft appears in your own mailbox Drafts folder, carrying the AI-written body (not an empty draft).' },
          { action: 'REJECT the approval gate — do it TWICE, once on the chat card and once from /inbox (start a second run for the second half)', expect: 'BOTH surfaces ask first with a confirm dialog, and cancelling it sends nothing (ADR 0600 §7 / ISU-12 + §Correction 5 — the confirm shipped on the inbox card only). After confirming, the run fails and no notification is sent.' },
          { action: 'Check the mailbox Sent folder', expect: 'Empty. Nothing was sent at any point.' },
        ] },
    ] },
  { key: 'knowledge-sync', feature: 'Knowledge Sync', route: '/kb', description: 'Keep a KB collection synced from an external source (folder). ADR 0107.',
    toggle: offVia('knowledge-sync'), updatedAt: '2026-07-02', sourceCommit: '929e30a4', sourceFiles: ['backend/typescript/src/features/knowledge-sync', 'frontend/react/src/features/knowledge-sync'],
    cases: [
      { id: 'KSYNC-01', title: 'Configure a sync source', priority: 'P2', preconditions: ['knowledge-sync enabled; a KB collection; a connected source'],
        steps: [
          { action: 'Open the KB panel, pick a folder (FolderPicker), createSyncSource against a collection', expect: 'The sync source lists (listSyncSources) bound to that collection' },
        ] },
      { id: 'KSYNC-02', title: 'Trigger a sync → ingest', priority: 'P1', preconditions: ['A configured sync source'],
        steps: [
          { action: 'Trigger the sync and watch status (setSyncStatus)', expect: 'Status transitions (idle → syncing → done); documents from the folder ingest into the KB collection and become searchable' },
        ] },
      { id: 'KSYNC-03', title: 'Failure is a labelled state', priority: 'P2', preconditions: ['A sync source that will error (e.g. revoked access)'],
        steps: [ { action: 'Trigger a sync that fails, read the panel', expect: 'lastError surfaces a LABELLED error state (not a silent failure or a raw stack)' } ] },
      { id: 'KSYNC-04', title: 'Edit + delete', priority: 'P3', preconditions: ['A sync source'],
        steps: [ { action: 'updateSyncSource (change scope), then deleteSyncSource', expect: 'Edits persist; delete removes the source (does not delete already-ingested docs unless specified)' } ] },
      { id: 'KSYNC-05', title: 'Tenant scoping', priority: 'P2', preconditions: ['Sync sources under two tenants'],
        steps: [ { action: 'Enumerate active sync sources for a tenant (listActiveSyncSourcesForTenant)', expect: 'Only that tenant’s sources — no cross-tenant leak (the sync daemon runs per-tenant)' } ] },
    ] },
  { key: 'twin', feature: 'Digital Twin recall', route: '/', description: 'Personal twin recall in chat (My Profile).',
    toggle: offVia('twin-recall'), updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['frontend/react/src/features/twin'],
    cases: [ { id: 'TWIN-01', title: 'Twin recalls a fact', priority: 'P3', preconditions: ['twin-recall enabled; a stored personal fact'],
      steps: [ { action: 'Ask the assistant something that requires a personal fact', expect: 'The twin recalls the fact into the answer' } ] } ] },
  { key: 'profile-memory', feature: 'Personal Knowledge & Memory', route: '/profile', description: 'My Profile knowledge + memory tabs.',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['frontend/react/src/features/profile-memory'],
    cases: [ { id: 'PMEM-01', title: 'Add + read personal memory', priority: 'P2', preconditions: ['Signed in'],
      steps: [ { action: 'Open My Profile, add a personal knowledge/memory item', expect: 'It persists and is editable/removable; scoped to you' } ] } ] },
  { key: 'agent-knowledge', feature: 'Per-agent knowledge & memory', route: '/agents', description: 'Bind knowledge/memory to a named agent.',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['frontend/react/src/features/agent-knowledge'],
    cases: [ { id: 'AKN-01', title: 'Bind knowledge to an agent', priority: 'P2', preconditions: ['An agent exists'],
      steps: [ { action: "Open an agent's detail panel and bind a knowledge collection", expect: 'The agent uses that knowledge in its next turn; binding persists' } ] } ] },
  { key: 'profiles', feature: 'User Profiles', route: '/profile', description: 'Account profile + team page.',
    toggle: ON, updatedAt: '2026-07-01', sourceCommit: 'e1a37bb2', sourceFiles: ['frontend/react/src/features/profiles'],
    cases: [ { id: 'PROF-01', title: 'Edit profile', priority: 'P2', preconditions: ['Signed in'],
      steps: [ { action: 'Open /profile, edit display name/avatar, view /team', expect: 'Changes persist; the team page lists members' } ] } ] },
  // ── KickTodo (ADR 0414 — participant loop; authored 2026-07-18) ──────────
  {
    key: 'kicktodo', feature: 'KickTodo', route: '/today',
    description: 'Guided challenges: Discover → enroll → Today actions → check-in → judged completion.',
    toggle: offVia('kicktodo-core'), updatedAt: '2026-07-18', sourceCommit: 'bd772c33',
    sourceFiles: ['frontend/react/src/features/kicktodo', 'backend/typescript/src/features/kicktodo-core'],
    cases: [
      { id: 'KT-01', title: 'Discover shows the published catalog (or its designed empty state)', priority: 'P0', blocker: true,
        preconditions: ['kicktodo-core toggle ON', 'Optionally: at least one published challenge (operator: publish one via the creator API / Challenge Factory)'],
        steps: [
          { action: 'Navigate to /discover', expect: 'The Discover page renders; published challenges appear as cards with days/actions/outcome, or the "No challenges published yet" empty state shows' },
        ] },
      { id: 'KT-20', title: 'Substitute swaps today\u2019s action for a publisher-declared alternative (ADR 0429)', priority: 'P1', blocker: false,
        preconditions: ['An active enrollment whose today action declares alternatives'],
        steps: [
          { action: 'On /today press "Substitute" on an action', expect: 'The alternatives disclose as a list, each with its VISIBLE instructions (not a tooltip)' },
          { action: 'Choose one', expect: 'The card retitles to the alternative; the action still checks in normally and counts as done' },
          { action: 'Press Substitute again and pick the SAME alternative', expect: 'No error and no duplicate — the choice is idempotent' },
        ] },
      { id: 'KT-21', title: 'Missed-window recovery collapses missed days into ONE action (ADR 0429)', priority: 'P1', blocker: false,
        preconditions: ['A challenge published with missedWindowPolicy collapse-recovery', 'At least one missed day within the last week'],
        steps: [
          { action: 'Let the daily loop run (or invoke the apply-missed-window node)', expect: 'Exactly ONE "Recovery: get back on track" card appears — never a backlog of every missed day' },
          { action: 'Run it again', expect: 'Still exactly one recovery card (deterministic id)' },
        ] },
      { id: 'KT-22', title: 'Challenge language is independent of the interface language (ADR 0430)', priority: 'P1', blocker: false,
        preconditions: ['At least one challenge with a published translation'],
        steps: [
          { action: 'On /discover set "Challenge language" to a language you have a translation for', expect: 'The card shows the translated title; the option list shows language NAMES, not raw tags like pt-BR' },
          { action: 'Set it to a language with NO translation', expect: 'The source-language card still appears with a "Shown in <language>" chip — an honest fallback, never an empty catalog' },
        ] },
      { id: 'KT-02', title: 'Enroll in a challenge', priority: 'P0', blocker: true,
        preconditions: ['A published challenge exists'],
        steps: [
          { action: 'On /discover, press "Start this challenge" on a card', expect: 'The button shows "Starting…" then the card flips to an "Enrolled" chip' },
          { action: 'Press "Start this challenge" flow again by revisiting the page', expect: 'The same challenge still shows "Enrolled" (idempotent — no duplicate enrollment)' },
        ] },
      { id: 'KT-03', title: 'Today lists due actions; Done completes with a check-in', priority: 'P0', blocker: true,
        preconditions: ['An active enrollment (KT-02)'],
        steps: [
          { action: 'Navigate to /today', expect: 'The enrollment section shows day/action chips and today’s due actions with Done buttons' },
          { action: 'Press Done on an action', expect: 'The action flips to a green "Done" chip; the counter (e.g. "1 of 2 actions done") updates' },
          { action: 'Reload the page', expect: 'The completed action stays Done (recorded evidence wins — no reset)' },
        ] },
      { id: 'KT-04', title: 'Progress verdict via "Check progress"', priority: 'P1', blocker: false,
        preconditions: ['An active enrollment with at least one incomplete action'],
        steps: [
          { action: 'On /today press "Check progress"', expect: 'An info notice reports remaining actions with encouraging copy (no guilt language)' },
          { action: 'Complete ALL actions across the challenge days, then press "Check progress"', expect: 'A success notice celebrates completion and the section shows the "Completed" chip' },
        ] },
      { id: 'KT-05', title: 'Snooze and resume are first-class (no guilt mechanics)', priority: 'P1', blocker: false,
        preconditions: ['An active enrollment'],
        steps: [
          { action: 'Press Snooze on the enrollment', expect: 'A "Snoozed" chip appears; Done buttons disable; copy stays neutral' },
          { action: 'Press Resume', expect: 'The enrollment returns to "Active" and actions are actionable again' },
        ] },
      { id: 'KT-06', title: 'Ask your guide deep-links the ONE shared chat', priority: 'P1', blocker: false,
        preconditions: ['An active enrollment'],
        steps: [
          { action: 'Press "Ask your guide" on /today', expect: 'The main chat opens scoped to the KickBot agent (URL /?agent=host:kickbot) — the same shared chat surface, not a separate panel' },
        ] },
    ],
  },
  // ── KickTodo Admin & Trust console (ADR 0438 A0–A8 + 0460 exception ledger) ──
  {
    key: 'kicktodo-admin', feature: 'KickTodo Admin & Trust', route: '/admin/kicktodo',
    description: 'Admin-tier trust console riding the kicktodo-core toggle: exception ledger, Safety inbox, catalog health, audit & metrics, honest AI/connections state, commerce reconciliation + payouts, and the read-only people & access lens.',
    toggle: offVia('kicktodo-core'), updatedAt: '2026-07-24', sourceCommit: 'ee10aabe4',
    sourceFiles: ['frontend/react/src/features/kicktodo-admin', 'backend/typescript/src/features/kicktodo-core'],
    cases: [
      { id: 'KTADM-01', title: 'The console loads with the "Needs you" count and the Exception ledger', priority: 'P0', blocker: true,
        preconditions: ['kicktodo-core toggle ON', 'Signed in as a platform ADMIN (the /admin tier gates on isAdminCaller)'],
        steps: [
          { action: 'Navigate to /admin/kicktodo (nav: Operations → "KickTodo Trust")', expect: 'The page titles "KickTodo Trust & Operations"; the "Needs you" card shows "Open safety queue" plus a live chip — "Nothing awaiting a decision" or "N awaiting a decision" — never a stale flash of "nothing" while loading (it shows "checking…" first)' },
          { action: 'Read the "Exception ledger" card', expect: 'Rows render with severity chips (Blocker / Action required / Attention / Feed down) and each deep-links its owning surface via Review/Open/Moderate; empty reads "Nothing needs attention right now."' },
          { action: 'If any ledger source is down, read the notice', expect: 'A red "Some feeds could not be read (…) — this list may be incomplete." notice — a degraded feed is never a silent "all clear"' },
        ] },
      { id: 'KTADM-02', title: 'Safety inbox: a decision is recorded through the ONE shared review system', priority: 'P0', blocker: true,
        preconditions: ['A pending KickTodo review exists (e.g. submit a community profile or a challenge publication)'],
        steps: [
          { action: 'Navigate to /admin/kicktodo/safety (nav: "KickTodo Safety")', expect: 'The "Safety & approvals" page renders with the note "You decide here; the server enforces who may decide. A decision updates every other surface live."; empty state is "Nothing waiting"' },
          { action: 'Decide a pending item on its ReviewCard', expect: 'A green "Decision recorded." notice; the item leaves this queue AND the chat Reviews rail (same store, no parallel queue)' },
        ] },
      { id: 'KTADM-03', title: 'Catalog health and Audit & metrics lenses are honest about thin data', priority: 'P1', blocker: false,
        preconditions: ['On /admin/kicktodo'],
        steps: [
          { action: 'Click "Open catalog & content health" (→ /admin/kicktodo/catalog)', expect: '"Catalog & content health" shows the "Candidate pipeline" by state (intake/researched/planned/published/withdrawn) and the "Published catalog" by lifecycle; with a thin pipeline the publish rate reads "Publish rate withheld (below the privacy floor; N contributors)." — never a small number' },
          { action: 'Back to console, click "Open audit & metrics" (→ /admin/kicktodo/audit-metrics)', expect: '"Verifier quality" shows "No verifier samples yet." when empty; with unverified samples the caveat "Disagreement rate is indicative, not audited, until the sample is verified." appears; the Audit trail card links "Open audit log" (superadmin authority) rather than rebuilding it' },
        ] },
      { id: 'KTADM-04', title: 'AI & connections states the calendar-write port honestly', priority: 'P1', blocker: false,
        preconditions: ['On /admin/kicktodo', 'Deployment has NO calendar transport configured (OPENWOP_CALENDAR_MCP_ENABLED / OPENWOP_CALENDAR_PROVIDER_ENABLED unset — the default)'],
        steps: [
          { action: 'Click "Open AI & connections" (→ /admin/kicktodo/connections) and read the "Calendar write" card', expect: 'The chip reads "awaiting adapter — no production transport" (read from the server, never assumed), with the copy explaining the port is inactive but "participants can still subscribe to the read-only calendar feed"' },
          { action: 'Read "Providers & delivery"', expect: 'It links "Open Connections" to the platform surface instead of duplicating BYOK/provider management here' },
        ] },
      { id: 'KTADM-05', title: 'Commerce: entitlement + seat reconcile are idempotent; payout runs need evidence', priority: 'P1', blocker: false,
        preconditions: ['On /admin/kicktodo/commerce ("Open commerce & reconciliation")', 'Optionally: kicktodo-commerce data (orders, a cohort circle id, accrued author shares)'],
        steps: [
          { action: 'Press "Run reconciliation" on a healthy tenant', expect: '"Healthy — nothing to repair (N orders scanned)." — idempotent, repairs nothing; a stranded paid order instead reports "Repaired N entitlement(s) across N orders scanned."' },
          { action: 'Under "Reconcile cohort seats", enter a cohort circle id (circle:…) and press "Reconcile seats"', expect: '"Seats now X of Y." — a healthy cohort is unchanged; a bad id surfaces "Could not reconcile that cohort. Check the circle id and retry."' },
          { action: 'Under "Author share & payout runs", press "Open payout run", then try "Confirm paid" with an empty Payment-evidence field', expect: 'Confirming is blocked — "Needs external payment evidence (a payout id or note) before rows can flip to paid." Nothing moves money here (the page says so); "Cancel run" asks "Cancel this payout run?" and keeps balances accrued' },
        ] },
      { id: 'KTADM-06', title: 'People & access is a read-only aggregate lens (role chips, consent posture)', priority: 'P1', blocker: false,
        preconditions: ['On /admin/kicktodo', 'Workspace has members with mixed roles'],
        steps: [
          { action: 'Click "Open people & access lens" (→ /admin/kicktodo/people)', expect: '"People & access" shows "N members in this workspace." with per-role COUNT chips ("Viewer: N", "Editor: N", "Admin: N", "Owner: N", "N without a role") — never a per-person row, name, or email' },
          { action: 'Read "Organizations & cohorts" and "Consent posture"', expect: 'Orgs list member/cohort-link counts (+ a "Curated library" chip where set); the consent card states cohort aggregate reports stay consent-gated and only LINKS each surface at its own authority ("Open access & roles", "Open org programs") — no write control exists anywhere on the page' },
        ] },
    ],
  },
  // ── KickTodo Circles (ADR 0419 P5 accountability + ADR 0431 P4 seats) ────
  {
    key: 'kicktodo-circles', feature: 'KickTodo Circles', route: '/circles',
    description: 'Consensual accountability: create a circle from an enrollment, invite with explicit scopes + a concrete privacy preview, instant revoke, coach proposals, cohort sessions — plus the coach-shared cohort seat purchase (/kicktodo/seats/:productId, kicktodo-commerce).',
    toggle: offVia('kicktodo-accountability'), updatedAt: '2026-07-24', sourceCommit: 'ee10aabe4',
    sourceFiles: ['frontend/react/src/features/kicktodo-circles', 'frontend/react/src/features/kicktodo-seats', 'backend/typescript/src/features/kicktodo-accountability'],
    cases: [
      { id: 'KTCIR-01', title: 'Enable + create a circle from an active enrollment', priority: 'P0', blocker: true,
        preconditions: ['kicktodo-accountability toggle ON (and kicktodo-core ON)', 'An ACTIVE KickTodo enrollment that has no circle yet'],
        steps: [
          { action: 'Navigate to /circles (nav: KickTodo → Circles)', expect: 'The page renders with the lede "Share exactly what you choose, with exactly who you choose."; with no circles, the "No circles yet" empty state offers "New circle" (only when an active enrollment exists)' },
          { action: 'Press "New circle"', expect: 'A circle card appears named after the page title with a type chip (Partner) and a "Members & scopes" section' },
        ] },
      { id: 'KTCIR-02', title: 'Invite with explicit scopes — the privacy preview is the disclosure', priority: 'P0', blocker: true,
        preconditions: ['A circle exists (KTCIR-01)', 'A second workspace member exists'],
        steps: [
          { action: 'Under "Invite someone", pick a member from the "Invite a workspace member" select (people, not ids)', expect: 'The scope chips (Progress summary / Action status / Check-in notes / Messages & nudges / Coach proposals) toggle; the "They will see:" preview lists the CONCRETE reveal copy for each selected scope (e.g. "…but not your check-in notes or measurements")' },
          { action: 'Select "Check-in notes" with "Action status" off', expect: '"Action status" is pulled in automatically (notes only disclose with action status); dropping "Action status" drops "Check-in notes" with it — the preview can never promise what the feed won\u2019t make' },
          { action: 'Press "Invite"', expect: 'The member appears under "Members & scopes" with their scope chips and an "Invited" (then "Active") badge' },
        ] },
      { id: 'KTCIR-03', title: 'Revoke is immediate and never silent', priority: 'P1', blocker: true,
        preconditions: ['A circle with an active/invited grant'],
        steps: [
          { action: 'Press "Revoke" on the member row', expect: 'The badge flips to "Revoked", the Revoke button disappears for that row, and the member loses the projected feed immediately; a failure surfaces "That change didn\u2019t save. Try again." — never a silent no-op' },
        ] },
      { id: 'KTCIR-04', title: 'Coach proposals + sessions ride the ONE chat', priority: 'P2', blocker: false,
        preconditions: ['A circle you own', 'Optionally a pending coach plan-proposal'],
        steps: [
          { action: 'Read the "Coach proposals" section', expect: 'Empty reads "Ask KickBot to adjust your plan — swaps, schedule moves, and recovery land here for your decision."; a carded pending proposal shows "Awaiting your decision" and the hint "Decide these on the card in this circle\u2019s conversation, or in your reviews rail." with "Open the conversation" — the decision happens on the card, not here (Apply/Decline appear inline ONLY for a degraded, card-less proposal)' },
          { action: 'Under "Sessions", set a title + a datetime and press "Schedule"', expect: 'The session lists with its date and a "Join in chat" link that deep-links the circle\u2019s conversation (/?conversation=…) — the shared chat, no second chat surface' },
        ] },
      { id: 'KTCIR-05', title: 'Cohort seat purchase: hold → pay → confirm, honest full state', priority: 'P1', blocker: false,
        preconditions: ['kicktodo-commerce toggle ON', 'A coach-shared seat link /kicktodo/seats/<productId> for a cohort with seats left'],
        steps: [
          { action: 'Open the shared link', expect: '"Reserve your seat" renders with a start-date chip, a "N seats left" chip, and the "Cancellation and refunds" terms BEFORE the reserve action; an invalid link shows "This seat link is not valid"' },
          { action: 'Press "Hold a seat" (panel "1 · Reserve")', expect: 'The panel flips to the real countdown ("A seat is held for you for about N more minutes…", serif "min held" figure) and panel "2 · Pay" offers "Continue to checkout" (storefront link) — panel "3 · Confirm" stays words-only: confirmation is the verified-payment CAS, never a client button' },
          { action: 'On a FULL cohort (or after losing the race), reload / press reserve', expect: 'The "Full" chip shows and the reserve button is gone; the race loser reads "The last seat was taken while you were deciding. Nothing was charged."; an expired hold reads "Your hold has expired. Reserve again if a seat is still free."' },
        ] },
    ],
  },
  // ── KickTodo Wearables (ADR 0462 webhook lane — NO dedicated FE surface) ──
  {
    key: 'kicktodo-wearables', feature: 'KickTodo Wearables', route: '/journal',
    description: 'ADR 0462 wearable evidence is backend-webhook-only — there is NO wearable page, settings, or consent UI in the SPA. This suite exercises it through its VISIBLE EFFECTS: a consented, rule-matched wearable metric auto-attaches a check-in (visible on /journal + /today), and a quiet stream raises an admin Exception-ledger row. Setup steps go through the owner-session REST lane.',
    toggle: offVia('kicktodo-integrations'), updatedAt: '2026-07-24', sourceCommit: 'ee10aabe4',
    sourceFiles: ['backend/typescript/src/features/kicktodo-integrations/integrationService.ts', 'backend/typescript/src/features/kicktodo-integrations/routes.ts', 'backend/typescript/src/features/kicktodo-integrations/exceptionSources.ts', 'frontend/react/src/features/kicktodo/JournalPage.tsx'],
    cases: [
      { id: 'KTW-01', title: 'A wearable metric over threshold auto-completes the check-in (visible in Journal/Today)', priority: 'P0', blocker: true,
        preconditions: ['kicktodo-integrations AND kicktodo-core toggles ON', 'An active enrollment with a today action', 'Via the owner-session REST lane (/host/openwop-app/kicktodo/integrations/…): grant the wearable-evidence consent, POST wearable-link for a provider, and POST a wearable-rule mapping a metric (e.g. steps, threshold 8000) to that activity'],
        steps: [
          { action: 'POST …/kicktodo/integrations/wearable-ingest with { metric: "steps", value: 10000 } as the enrolled user', expect: '200 — the kernel records a check-in for the mapped activity (fail-closed: with the consent revoked the same call is refused, ConsentRequiredError)' },
          { action: 'Open /journal (and /today)', expect: 'A journal entry appears with the verbatim note "wearable:steps=10000 (threshold 8000)" and a "measured: 10000" chip; on Today the mapped action shows Done — the evidence auto-attached, no manual tap' },
        ] },
      { id: 'KTW-02', title: 'The public webhook is honest-off by default; a quiet stream surfaces in the Exception ledger', priority: 'P1', blocker: false,
        preconditions: ['OPENWOP_WEARABLE_PROVIDER_ENABLED unset (the default)', 'Admin access for the ledger check'],
        steps: [
          { action: 'POST /public/kicktodo/wearable-webhook/<any-token> (the provider-push lane)', expect: '404 — with the operator env gate unset the public route does not exist; no silent accept, no partial ingest' },
          { action: 'With a registered webhook whose stream has stopped reporting, open /admin/kicktodo as an admin', expect: 'The "Exception ledger" shows the row "A consented wearable stream has gone quiet (last reading …)." with an Open action deep-linking /admin/kicktodo/connections — staleness is surfaced, never silently dropped' },
        ] },
    ],
  },
  // ── KickTodo Calendar (ADR 0421 P1 ICS feed + ADR 0466 calendar-write MCP) ──
  {
    key: 'kicktodo-calendar', feature: 'KickTodo Calendar', route: '/admin/kicktodo/connections',
    description: 'The read-only ICS feed (consent-gated mint via REST — there is NO mint/copy/revoke button in the SPA) + the ADR 0466 calendar-WRITE port, whose only FE surface is the honest status on the admin "AI & connections" page. Feed lifecycle is exercised via REST + the public feed URL; write stays "awaiting adapter" until an operator wires a transport.',
    toggle: offVia('kicktodo-integrations'), updatedAt: '2026-07-24', sourceCommit: 'ee10aabe4',
    sourceFiles: ['frontend/react/src/features/kicktodo-admin/AiConnectionsPage.tsx', 'backend/typescript/src/features/kicktodo-integrations/integrationService.ts', 'backend/typescript/src/features/kicktodo-integrations/routes.ts', 'backend/typescript/src/features/kicktodo-integrations/agentTools.ts'],
    cases: [
      { id: 'KTCAL-01', title: 'The calendar-write port states its honest awaiting-adapter state', priority: 'P0', blocker: true,
        preconditions: ['kicktodo-integrations AND kicktodo-core toggles ON', 'Admin access', 'No calendar transport configured (OPENWOP_CALENDAR_MCP_ENABLED / OPENWOP_CALENDAR_PROVIDER_ENABLED unset — the default)'],
        steps: [
          { action: 'Open /admin/kicktodo → "Open AI & connections" and read the "Calendar write" card', expect: 'The chip reads "awaiting adapter — no production transport" — READ from the server status, never assumed — with copy stating the port is inactive and that "participants can still subscribe to the read-only calendar feed"' },
        ] },
      { id: 'KTCAL-02', title: 'Mint the ICS feed (consent-gated) and subscribe unauthenticated', priority: 'P0', blocker: true,
        preconditions: ['An enrolled user session', 'Grant the calendar-project consent via POST /host/openwop-app/kicktodo/integrations/consents'],
        steps: [
          { action: 'POST …/kicktodo/integrations/feed-token as the user', expect: '200 with { token, feedPath } — the raw token is returned exactly ONCE (stored hashed); without the consent the mint is refused (409 ConsentRequired)' },
          { action: 'GET /public/kicktodo/feed/<token> with NO auth (or subscribe in a calendar app)', expect: 'A valid ICS calendar renders containing the enrollment\u2019s scheduled action events — the read-only projection, no write' },
        ] },
      { id: 'KTCAL-03', title: 'Revoking the consent kills EVERY feed URL — uniform 404', priority: 'P1', blocker: true,
        preconditions: ['A live feed URL (KTCAL-02); optionally mint a second token — both must die together'],
        steps: [
          { action: 'POST …/kicktodo/integrations/consents/revoke for calendar-project, then GET the old feed URL(s)', expect: 'Every previously-minted URL now returns 404 with the uniform body "Not found." (never 401, never a distinguishable "revoked" hint); re-render also fail-closes if the tenant toggle is switched off' },
        ] },
      { id: 'KTCAL-04', title: 'The chat reads integration state through the read-only status tool', priority: 'P2', blocker: false,
        preconditions: ['KickBot available in the chat (kicktodo packs installed)'],
        steps: [
          { action: 'In the ONE chat, ask KickBot whether your calendar feed / integrations are set up', expect: 'It answers from the openwop:kicktodo.integrations-status tool — granted consents, linked wearable providers, and whether a calendar-write transport is configured — and states that granting/linking happens on the integration surfaces, not in chat; no MCP calendar-write tool is exposed to the user' },
        ] },
    ],
  },
  // ── Challenge Factory authoring (outline canvas + publish SoD — NOT covered by 'kicktodo-studio') ──
  {
    key: 'challenge-outline', feature: 'Challenge Factory authoring', route: '/kicktodo/studio',
    description: 'What the kicktodo-studio suite does not cover: the structured-outline canvas (/challenge-outline/:canvasId) with validate-then-persist Apply, and the publication separation-of-duties flow — submit via the Challenge Author chat as one identity, decide in the Reviews inbox as ANOTHER, with both 403 lanes.',
    toggle: offVia('kicktodo-creator'), updatedAt: '2026-07-24', sourceCommit: 'ee10aabe4',
    sourceFiles: ['frontend/react/src/features/kicktodo-studio/CandidateWorkspacePage.tsx', 'frontend/react/src/features/challenge-outline', 'backend/typescript/src/features/kicktodo-creator/publishService.ts', 'backend/typescript/src/features/kicktodo-creator/routes.ts'],
    cases: [
      { id: 'KTCO-01', title: 'Open the outline canvas from a candidate workspace', priority: 'P0', blocker: true,
        preconditions: ['kicktodo-creator toggle ON (depends on kicktodo-core)', 'A candidate exists (create one on /kicktodo/studio)', 'Caller holds host:kicktodo:manage'],
        steps: [
          { action: 'Open /kicktodo/studio/candidates/<id> and find the "Structured outline" section', expect: 'Copy explains it is a working draft — "the validated plan revision stays the source of truth until you apply" — with an "Open outline" button' },
          { action: 'Press "Open outline"', expect: 'Routes to the full-bleed /challenge-outline/<canvasId> editor ("Challenge outline editor"); with no validated plan yet it seeds a skeleton and says "Seeded from the intake targets — no validated plan yet, so the days start empty."' },
          { action: 'Add a day from the palette and fill Title / Action instruction / Why it matters / Evidence', expect: 'The "Outline preview" renders "Day N" cards live ("Days (N)"); empty reads "No days yet — add days from the palette or refine the plan in chat."' },
        ] },
      { id: 'KTCO-02', title: 'Apply outline is validate-then-persist — defects block, nothing half-saves', priority: 'P0', blocker: true,
        preconditions: ['An outline draft with edits (KTCO-01)'],
        steps: [
          { action: 'Back on the candidate workspace, press "Apply outline" with a VALID draft', expect: '"Outline applied — plan revision N saved." — a new plan revision persists only on zero defects' },
          { action: 'Make the draft invalid (e.g. an empty day title / broken day numbering) and press "Apply outline" again', expect: 'A defect list under "The outline was not applied (N issues)" — the plan revision is unchanged; no partial write' },
        ] },
      { id: 'KTCO-03', title: 'Publish SoD: submit as identity A, decide as identity B — self-approval 403s', priority: 'P0', blocker: true,
        preconditions: ['A candidate with a validated plan and passing gates', 'TWO identities with host:kicktodo:manage (A = author, B = approver)'],
        steps: [
          { action: 'As A, read the publication section of the candidate workspace', expect: 'There is NO submit button — "Submission happens through the factory\u2019s final step (drive it with the Challenge Author in chat) — there is no submit button here."; the gate matrix shows Evidence/Claims/Rights/Safety/Simulation with Pass/Open/Disclosure chips' },
          { action: 'As A, drive submission through the Challenge Author in the chat (the factory\u2019s terminal step)', expect: 'The candidate strip shows the "submitted · needs a different approver" pill and "Submitted — awaiting a decision by someone other than the submitter, in the chat\u2019s Reviews rail." with an "Open the Reviews inbox" link (/chat?rail=reviews)' },
          { action: 'As the SAME identity A, attempt to approve the publication (Reviews inbox or complete-publication)', expect: 'Refused with 403: "Publication must be approved by someone other than the submitter (separation of duties)." — the candidate stays submitted' },
          { action: 'As B, decide the approval in the Reviews inbox', expect: 'The publication completes ("approved by <B>", phase "completed"); the challenge reaches the published catalog and the candidate state chip reads "Published"' },
        ] },
      { id: 'KTCO-04', title: 'The second 403 lane: deciding without KickTodo manage authority', priority: 'P1', blocker: false,
        preconditions: ['A submitted publication (KTCO-03)', 'An identity WITHOUT host:kicktodo:manage'],
        steps: [
          { action: 'As that identity, attempt to decide the challenge-publish approval', expect: 'Refused with 403: "Deciding a challenge publication requires KickTodo manage authority." — authority and SoD are enforced server-side on the generic decision lane too (review card, decide-by-email included)' },
        ] },
      { id: 'KTCO-05', title: 'A published challenge refuses outline re-apply', priority: 'P2', blocker: false,
        preconditions: ['A candidate whose challenge is published (KTCO-03)'],
        steps: [
          { action: 'Reopen the candidate\u2019s outline and press "Apply outline"', expect: 'Refused with "This challenge is already published; the outline cannot be re-applied. Start a new candidate to revise it." — published content is immutable from the draft lane' },
        ] },
    ],
  },

  // ── Reviews & HITL (ADR 0068/0074 inbox + ADR 0070 quorum + ADR 0478 completion) ──
  {
    key: 'reviews-hitl', feature: 'Reviews & HITL approvals', route: '/',
    description: 'The one human-review surface: chat Reviews inbox + conversation strip (ADR 0068/0074), quorum votes with bound voter identity (ADR 0070/0198), and the ADR 0478 completion — SLA/escalation ladder, decide-by-email, reasoning-at-the-gate.',
    toggle: ON, updatedAt: '2026-07-24', sourceCommit: 'ee10aabe4',
    sourceFiles: [
      'frontend/react/src/chat/reviews',
      'frontend/react/src/chat/leftRail/LeftRail.tsx',
      'frontend/react/src/notifications/EmailApprovalSection.tsx',
      'backend/typescript/src/host/approvalSla.ts',
      'backend/typescript/src/host/emailApprovalDelivery.ts',
      'backend/typescript/src/host/approvalDecision.ts',
    ],
    cases: [
      { id: 'RVW-01', title: 'A pending review appears in the inbox AND the conversation strip; approve with a note', priority: 'P0', blocker: true,
        preconditions: ['A pending review exists — run a workflow with an approval gate from chat (an "In-flight" interrupt), or have the Workflow Architect propose a workflow (a "Proposal")'],
        steps: [
          { action: 'On / (Chat), look at the left rail\u2019s "Reviews" tab', expect: 'The tab shows a badge with the pending count (screen reader: "reviews pending: N"); opening it renders the review card with a source chip ("In-flight" or "Proposal"), the kind, requester, requested time, and — when set — a risk chip and due time. An "Approval SLA ladder…" disclosure sits above the list' },
          { action: 'Open the conversation the review traces back to', expect: 'A "Needs your approval (from this conversation)" strip renders the SAME card above the composer — one card model, no second decision path' },
          { action: 'If the review was requested by an agent that stated reasoning, expand the disclosure', expect: 'It is labeled "Agent\u2019s reasoning (stated by the agent)" — attributed as the agent\u2019s claim, never as the app\u2019s own assessment, and separate from the reviewer note field' },
          { action: 'Type a note ("Approved for testing") and press Approve', expect: '"Decision recorded" notice; the card leaves the pending list and the badge decrements; the decision propagates LIVE to the other surfaces (strip, run detail) without a reload' },
        ] },
      { id: 'RVW-02', title: 'Reject resolves everywhere; a second decision is refused', priority: 'P1', blocker: false,
        preconditions: ['A second pending review (as in RVW-01)'],
        steps: [
          { action: 'Reject the review with a note', expect: 'The card resolves: a status badge replaces the action buttons and your note renders as the decision-note blockquote' },
          { action: 'Attempt to decide the same review again from another surface (e.g. /inbox or the API)', expect: 'Refused with a 409 ("Approval already rejected") — decisions are CAS-final, never double-applied' },
        ] },
      { id: 'RVW-03', title: 'SLA/escalation ladder — configure, and each rung fires once', priority: 'P1', blocker: false,
        preconditions: ['Workspace admin (saving the policy 403s otherwise)', 'A way to leave an approval pending for a few minutes'],
        steps: [
          { action: 'Open the Reviews tab and expand "Approval SLA ladder…"', expect: 'A compact editor: an enable checkbox + Remind/Escalate/Expire minute fields (empty rung = off); a failed load shows Retry, never a live form over defaults' },
          { action: 'Enable with remind=1, escalate=2, expire=3 and press Save', expect: '"Saved" confirms; as a non-admin the same Save fails with copy naming the workspace-admin requirement, not a generic error' },
          { action: 'Leave a fresh approval undecided and watch notifications', expect: 'At ~1 min the addressed approval notification re-emits ("awaiting your review since …"); at ~2 min the approvers\u2019 active delegates (or tenant admins when none) are notified — escalation NOTIFIES, it never widens who may decide' },
          { action: 'Keep waiting past the expire rung', expect: 'The approval auto-rejects with the sla_expired note (fail-closed deadline — opt-in, off by default); each rung fired exactly once' },
        ] },
      { id: 'RVW-04', title: 'Decide-by-email — opt-in, one-click gate links, link-out for proposals', priority: 'P2', blocker: false,
        preconditions: ['Host SMTP configured (env-gated; without it the email lane is silently absent — note and skip)', 'Signed in with a reachable mailbox'],
        steps: [
          { action: 'Open the notification bell → "Notification preferences" and find "Email me approval requests"', expect: 'A free-entered address field PREFILLED with your account email + an Enabled checkbox; the copy states the responsibility for the address and that one-click approve/reject links ride workflow gates' },
          { action: 'Save, then trigger an interrupt-backed approval gate addressed to you', expect: 'An email arrives with the title + summary and APPROVE/REJECT links — no secrets or payload bodies' },
          { action: 'Click a decide link', expect: 'A GET renders a small confirm page (the link itself never mutates — mail-scanner safe); confirming POSTs the decision via the signed token, no session needed; an expired token yields 410' },
          { action: 'Trigger a composed-workflow proposal email instead', expect: 'It LINKS OUT to the in-app inbox (/inbox?approval=…) rather than deciding by mail — quorum/RBAC decisions stay in-app' },
        ] },
      { id: 'RVW-05', title: 'Multi-approver quorum — progress meter + one vote per bound identity', priority: 'P1', blocker: false,
        preconditions: ['A quorum approval pending — instantiate the "Threshold-based approval" workflow template (requiredApprovals: 2) and run it', 'TWO eligible approver identities'],
        steps: [
          { action: 'Open the review card as approver A', expect: 'A quorum row shows a "0 of 2 approved" chip and a progress meter (plus a rejections chip once any exist)' },
          { action: 'Approve as A', expect: 'The card stays PENDING at "1 of 2 approved" — a vote is recorded, the gate does not finalize' },
          { action: 'Attempt a second approval as A (or as A\u2019s delegate)', expect: 'The count stays at 1 — the vote ledger dedups on the consumed identity, so a principal + their delegate can never count twice' },
          { action: 'Approve as B', expect: 'Quorum met — the gate finalizes exactly once and the run proceeds' },
        ] },
      { id: 'RVW-06', title: 'Challenge-publish eligibility (KTFULL-B2) — a two-identity test', priority: 'P1', blocker: false,
        preconditions: ['kicktodo-creator toggle ON', 'User A (KickTodo manage authority) has submitted a challenge for publication from /kicktodo/studio, raising a challenge-publish approval'],
        steps: [
          { action: 'As user B — workspace WRITE access but WITHOUT host:kicktodo:manage — decide the review (card button, or POST the reviews decide endpoint)', expect: '403: "Deciding a challenge publication requires KickTodo manage authority." — the generic decision lane (cards, inbox, decide-by-email) enforces the owner\u2019s eligibility, not just the Studio routes' },
          { action: 'As user A (the submitter, WITH manage authority), decide it', expect: '403 — a publication must be decided by someone other than the submitter (separation of duties)' },
          { action: 'As a THIRD user holding manage authority, approve', expect: 'The decision lands and the challenge publishes' },
        ] },
      ],
  },
  // ── Chat-first remediation (ADR 0467 / CFP sweep — agents got real tools, pages got chat entry points) ──
  {
    key: 'chat-first-remediation', feature: 'Chat-first surfaces (CFP remediation)', route: '/',
    description: 'ADR 0467 chat-first-port remediation: every agent-pack tool now RESOLVES at dispatch (no toothless personas), feature pages deep-link the ONE chat with seeded prompts, and org-wide page actions ride the shared Reviews inbox instead of bespoke apply buttons.',
    toggle: ON, updatedAt: '2026-07-24', sourceCommit: 'ee10aabe4',
    sourceFiles: [
      'frontend/react/src/features/cms/CmsPage.tsx',
      'frontend/react/src/features/crm/ContactsTab.tsx',
      'frontend/react/src/features/csm/CsmPage.tsx',
      'frontend/react/src/features/territories/TerritoriesPage.tsx',
      'frontend/react/src/features/scheduled-chats/ScheduledChatsPage.tsx',
      'backend/typescript/test/agent-allowlist-resolution.test.ts',
    ],
    cases: [
      { id: 'CFP-01', title: 'CMS "Edit with the assistant" drives the ONE chat — and the agent actually edits', priority: 'P0', blocker: true,
        preconditions: ['Admin access', 'A CMS page exists on /cms'],
        steps: [
          { action: 'On /cms, select a page and press "Edit with the assistant"', expect: 'You land on the MAIN chat (/?agent=…) scoped to the content-editor agent with a pre-seeded composer draft naming the page ("Help me edit the page \u201c<title>\u201d…") — no bespoke chat panel' },
          { action: 'Send the seeded message', expect: 'The agent READS the page first, then proposes concrete section changes — real tool calls against the page content, not generic prose that ignores what the page says (the pre-remediation "toothless persona" failure)' },
        ] },
      { id: 'CFP-02', title: 'CRM segment copilot entry point + explainable lead score', priority: 'P1', blocker: false,
        preconditions: ['crm toggle ON', 'Contacts exist on /crm'],
        steps: [
          { action: 'On the /crm contacts surface, press "Draft with the assistant"', expect: 'The main chat opens scoped to the segment-author agent with the seeded segment-drafting prompt ("…draft and validate it — I\u2019ll review before it\u2019s saved")' },
          { action: 'Back on contacts, press "Lead score" on a contact row', expect: '"Scoring…" then a "Lead score N" chip whose tooltip states the DERIVATION (funnel views × weight + completions × weight + paid orders × weight) — an explainable on-demand score, no longer computed-but-invisible' },
        ] },
      { id: 'CFP-03', title: 'CSM "Ask health insights" — grounded in the account book', priority: 'P1', blocker: false,
        preconditions: ['csm toggle ON', 'At least one customer-success account with health state on /csm'],
        steps: [
          { action: 'On /csm, press "Ask health insights" in the page header', expect: 'The main chat opens at /?agent=feature.csm.agents.health-insights with the seeded at-risk-accounts prompt' },
          { action: 'Send it and compare the reply against /csm', expect: 'The named accounts and health states MATCH the page — the agent read the account book via its tools (grounded), it did not hallucinate a portfolio' },
        ] },
      { id: 'CFP-04', title: 'Territory model activate/archive is submitted for review, never applied directly', priority: 'P1', blocker: false,
        preconditions: ['territories toggle ON', 'A draft territory model on /territories'],
        steps: [
          { action: 'Open the model and read the lifecycle button', expect: 'It reads "Submit to activate" (not "Activate"); the confirm dialog states the change goes to the workspace\u2019s Reviews inbox first and only a manager\u2019s approval makes the model live' },
          { action: 'Confirm the submission', expect: '"Submitted for review" — the model does NOT flip live; a pending review appears in the Reviews inbox (D9 fix: page buttons no longer bypass the shared HITL machinery)' },
          { action: 'Approve the review as a manager identity', expect: 'The model becomes active org-wide, replacing the previous active model' },
        ] },
      { id: 'CFP-05', title: 'Scheduled chats paint an honest status and support pause/resume', priority: 'P2', blocker: false,
        preconditions: ['scheduled-agent-chats toggle ON', 'A scheduled chat exists on /scheduled-chats'],
        steps: [
          { action: 'Read a scheduled chat row\u2019s status chip', expect: 'It reflects ENABLEMENT: a paused chat reads "Paused" — never "Active" for a disabled job (the pre-fix page read workflowId, not enabled)' },
          { action: 'Press "Pause", then "Resume"', expect: 'The chip flips each way and persists across reload; a failure surfaces "Could not update the scheduled chat. Please try again." rather than silently lying' },
        ] },
      ],
  },
  // ── Composed-workflow proposals (ADR 0473 — propose → review → approve-what-you-see → run) ──
  {
    key: 'workflow-proposals', feature: 'Composed-workflow proposals', route: '/',
    description: 'ADR 0473: an agent proposes a composed workflow in chat (openwop:workflows.propose — nothing runs until a human approves), reviewed on the shared card with a live step/risk view, approved hash-pinned ("approve what you see"), plus the builder ProposalBanner. Auto-approval policies are superadmin-API-only (no UI page).',
    toggle: ON, updatedAt: '2026-07-24', sourceCommit: 'ee10aabe4',
    sourceFiles: [
      'frontend/react/src/chat/reviews/ComposedWorkflowSection.tsx',
      'frontend/react/src/builder/ProposalBanner.tsx',
      'backend/typescript/src/host/workflowComposeTool.ts',
      'backend/typescript/src/routes/workflowProposalPolicies.ts',
    ],
    cases: [
      { id: 'WFP-01', title: 'The agent proposes; the review card shows the live evidence', priority: 'P0', blocker: true,
        preconditions: ['BYOK/provider configured so chat turns run', 'The Workflow Architect agent available (workflow-author packs installed)'],
        steps: [
          { action: 'In chat with the Workflow Architect (@-mention it, or the builder\u2019s "Create with AI"), ask it to BUILD AND RUN a small workflow', expect: 'The agent calls the propose tool and reports a pending proposal — NO run starts; a card appears in the "Needs your approval (from this conversation)" strip and the Reviews inbox with a "Proposal" chip and "Proposed workflow" kind' },
          { action: 'Read the card body', expect: 'The summary is labeled "Agent\u2019s description" (the agent\u2019s words, not the app\u2019s); node/edge counts, the per-step list with pack-role risk badges (read/gate/action/side-effect — undeclared roles warn as unclassified), frozen run inputs, an AI cost-floor estimate when present, the expiry date, and an "Open in builder" link' },
        ] },
      { id: 'WFP-02', title: 'Approve & run — hash-pinned, run starts only after the decision', priority: 'P0', blocker: true,
        preconditions: ['A pending proposal (WFP-01)'],
        steps: [
          { action: 'Optionally add a note, then press "Approve & run" on the card', expect: 'The decision records with the hash of the definition THE CARD displayed (approve-what-you-see); a run starts and is visible on /runs / the chat workflow-progress panel' },
          { action: 'Check /builder', expect: 'The proposed workflow exists as a tenant-owned draft (it was registered at propose time, runnable only via the approval)' },
        ] },
      { id: 'WFP-03', title: 'An edited draft can never be approved stale', priority: 'P1', blocker: false,
        preconditions: ['A pending proposal', 'The builder open in a second tab'],
        steps: [
          { action: 'Edit + save the proposed workflow in the builder, then return to the UNREFRESHED chat card', expect: 'On the refreshed card a warning chip reads "Edited since proposed — approving runs the current version"' },
          { action: 'Approve from a card still showing the OLD version', expect: 'Refused with "The draft changed since you reviewed it — the card has refreshed; review it and approve again." (409 proposal_stale) — the card reloads with the fresh hash and a retry then succeeds' },
        ] },
      { id: 'WFP-04', title: 'Builder ProposalBanner — the canvas is the preview, saved before approval', priority: 'P1', blocker: false,
        preconditions: ['A pending proposal', 'Open its workflow at /builder/:id'],
        steps: [
          { action: 'Look above the canvas', expect: 'A banner: "Proposed by an agent" chip, "This draft is awaiting your review — approve to run it.", the agent\u2019s description, an optional-note field, Approve & run / Reject, and an "Open the conversation" link back to the proposing chat' },
          { action: 'Make an UNSAVED canvas tweak, then press "Approve & run"', expect: 'The banner persists the canvas FIRST, then approves pinned to exactly what was just saved — "Approved — the run has started." with a "View run" link; you approved the canvas you were looking at' },
          { action: 'Decide a proposal from chat while the banner is visible', expect: 'The banner updates live off the review signal; deciding an already-decided proposal shows "This proposal was already decided on another surface."' },
        ] },
      { id: 'WFP-05', title: 'Reject archives; expiry is honest', priority: 'P2', blocker: false,
        preconditions: ['A pending proposal'],
        steps: [
          { action: 'Press Reject with a note (the note field stays available even on the compact in-chat card)', expect: 'The proposal resolves rejected and the draft is archived ("Rejected — the draft was archived."); the note is preserved as feedback' },
          { action: 'Let a proposal pass its TTL (default 7 days — OPENWOP_WORKFLOW_PROPOSAL_TTL_DAYS; or set it low on a test host)', expect: 'The card shows "Expired — ask the agent to propose again" and approval is refused (410-class proposal_expired) — expiry never silently runs anything' },
        ] },
      ],
  },

  // ── Workflow orchestration program (ADRs 0474-0480) ──────────────────────
  {
    key: 'workflow-versioning', feature: 'Workflow revision history & publish', route: '/builder',
    description: 'Content-hash revisions, restore, publish=pin + published-launch resolution (ADR 0474), and published pins as an environments config domain (ADR 0479).',
    toggle: ON, updatedAt: '2026-07-24', sourceCommit: 'ee10aabe4',
    sourceFiles: ['frontend/react/src/builder/HistoryDrawer.tsx', 'backend/typescript/src/host/workflowRevisions.ts', 'frontend/react/src/features/environments/EnvironmentsPage.tsx', 'backend/typescript/src/features/environments/domains/workflowPinsDomain.ts'],
    cases: [
      { id: 'WFV-01', title: 'Every save appends a revision to the History drawer', priority: 'P0', blocker: true,
        preconditions: ['A tenant-owned workflow open on /builder/:workflowId'],
        steps: [
          { action: 'Add a node, wait for autosave, then open the toolbar "History" menu entry', expect: 'The "Revision history" drawer opens; the newest row carries the "Current" chip, a relative time, and a node count — older saves list beneath it' },
          { action: 'Archive/unarchive the workflow from the dashboard, then reopen History', expect: 'NO new revision appeared — lifecycle-only changes are hash-stripped (no noise revisions)' },
        ] },
      { id: 'WFV-02', title: 'Restore is previewed, confirmed, and itself undoable', priority: 'P0', blocker: true,
        preconditions: ['≥2 revisions in the History drawer'],
        steps: [
          { action: 'Press "Restore" on an older revision', expect: 'A confirm appears: "Replace the current version (N nodes) with this one (M nodes)? The current version stays in history." with "Restore this version" / "Keep current"' },
          { action: 'Confirm with "Restore this version"', expect: 'Toast "Version restored — the canvas reloaded."; the canvas shows the old graph; History gained a NEW head row (append-only — the pre-restore version is still restorable)' },
        ] },
      { id: 'WFV-03', title: 'Publish=pin: production runs the published revision, drafts are badged', priority: 'P0', blocker: true,
        preconditions: ['A workflow published once (toolbar "Publish changes"), then edited again'],
        steps: [
          { action: 'Press "Publish changes" in the builder toolbar, then edit the workflow again and return to /builder', expect: 'The dashboard card shows the warning chip "Unpublished changes" ("The published version runs in production; this workflow has newer edits…")' },
          { action: 'Launch the workflow from the chat "/" picker, then open its run detail; also test-run from the builder', expect: 'The picker entry for an unpublished-only workflow carries a "Draft" chip; the production launch ran the PUBLISHED (pre-edit) definition; the builder test-run detail carries the "Draft run" chip ("executed the editing head, not the published revision")' },
        ] },
      { id: 'WFV-04', title: 'The run revision chip is the visible half of the pin', priority: 'P1',
        preconditions: ['A completed run of a workflow you can edit'],
        steps: [
          { action: 'Open /runs/:runId and read the "Definition revision" summary row', expect: 'A rev hash chip with "as-run" state' },
          { action: 'Edit the workflow head, reload the run detail', expect: 'The chip flips to "workflow edited since" — and its tooltip states replay and fork still use the pinned revision' },
        ] },
      { id: 'WFV-05', title: 'ADR 0479 — published pins snapshot/apply as an environments domain (apply-only)', priority: 'P1',
        preconditions: ['environments toggle ON (/feature-toggles — the pins domain rides the Environments page)', 'Admin; ≥1 published workflow'],
        steps: [
          { action: 'On /environments press "Snapshot current config", then "Preview diff" in the Promote wizard (or "Apply to live" on a snapshot)', expect: 'The per-domain breakdown lists "Published workflow pins" beside "Feature toggles" and "Publish pointers"' },
          { action: 'Publish a different revision of one workflow, then apply the older snapshot and re-read the diff line', expect: 'The pins domain restores APPLY-ONLY: removed entries render as "kept (not in snapshot — apply never clears)" — a workflow absent from the snapshot keeps its live pin; a foreign/pruned revision fails NAMED (listing workflowIds), never silently' },
        ] },
    ],
  },
  {
    key: 'workflow-debug', feature: 'Workflow debug loop', route: '/runs',
    description: 'Pinned node outputs, execute-from-step, failed-run→editor deep link, and bulk redrive (ADR 0475).',
    toggle: ON, updatedAt: '2026-07-24', sourceCommit: 'ee10aabe4',
    sourceFiles: ['frontend/react/src/builder/DebugSessionBanner.tsx', 'frontend/react/src/builder/debugSession.ts', 'frontend/react/src/runs/RunsIndexPage.tsx', 'backend/typescript/src/routes/workflowDebug.ts', 'backend/typescript/src/host/workflowDebugPins.ts'],
    cases: [
      { id: 'WFD-01', title: 'Failed run → "Debug in builder" prefills pins from the real outputs', priority: 'P0', blocker: true,
        preconditions: ['A FAILED run of a tenant-owned workflow'],
        steps: [
          { action: 'On /runs/:runId of the failed run press "Debug in builder"', expect: 'Navigates to /builder/:workflowId?debugRun=:runId; a "Debug session" banner shows the pin count ("N pinned outputs"), "View source run", and "Clear pins"; nodes whose outputs were captured carry a pinned badge ("Output pinned for debugging")' },
          { action: 'Select a pinned node and open the inspector "Debug" section', expect: 'A "Pinned output" block shows the run\'s real output JSON with "Edit pin" / "Unpin"' },
        ] },
      { id: 'WFD-02', title: 'Execute-from-step runs the subgraph on pinned data', priority: 'P0', blocker: true,
        preconditions: ['A debug session with all upstream nodes of the failed step pinned'],
        steps: [
          { action: 'On the failed node press "Run from here" ("Run this node and everything after it, using pinned outputs for the nodes before it.")', expect: 'A run starts and paints node states onto the canvas through the run overlay — upstream nodes never re-execute' },
          { action: 'Open the new run on /runs', expect: 'It is honestly tagged with the "Debug run" chip ("Execute-from-step debug run (from node X); upstream nodes used pinned outputs")' },
          { action: 'Repeat with "Only this node"', expect: 'Just the target node runs (descendants do not)' },
        ] },
      { id: 'WFD-03', title: 'Missing pin coverage names the exact nodes; published launches never read pins', priority: 'P1',
        preconditions: ['A debug session; one upstream node deliberately unpinned ("Unpin")'],
        steps: [
          { action: 'Press "Run from here"', expect: 'A named refusal: "Pin these upstream nodes first: <nodeIds>." — the error lists the exact nodes, nothing runs' },
          { action: 'With pins present, launch the SAME workflow normally (chat "/" picker or trigger)', expect: 'The production run ignores pins entirely — pins are draft-side debug state only' },
        ] },
      { id: 'WFD-04', title: 'Bulk redrive from the runs index, per-run outcome, as-run revision', priority: 'P1',
        preconditions: ['≥2 terminal failed/cancelled runs on /runs'],
        steps: [
          { action: 'On /runs tick table rows', expect: 'Only failed/cancelled rows are selectable; running/completed rows are not' },
          { action: 'Press "Redrive N runs" ("Start fresh runs of the selected failed runs, on the exact definition each originally ran.")', expect: 'Outcome notice "{ok} redriven, {failed} failed." — partial success is explicit, with per-run reasons (e.g. "not failed or cancelled", "its workflow no longer exists")' },
          { action: 'Open a redriven run\'s detail', expect: 'It carries the "Redriven" chip linking the original, and its "Definition revision" is the source run\'s AS-RUN revision even if the head moved since' },
        ] },
    ],
  },
  {
    key: 'workflow-fleet-cost', feature: 'Fleet insights & run cost', route: '/builder',
    description: 'Fleet stats band + per-card chips, builder failure heatmap, pre-run cost estimate, per-run cost rollup, cancelled-spend honesty (ADR 0476).',
    toggle: ON, updatedAt: '2026-07-24', sourceCommit: 'ee10aabe4',
    sourceFiles: ['frontend/react/src/builder/WorkflowsDashboard.tsx', 'frontend/react/src/builder/WorkflowCardViews.tsx', 'frontend/react/src/builder/BuilderToolbar.tsx', 'frontend/react/src/runs/RunCostPanel.tsx', 'backend/typescript/src/routes/workflows.ts'],
    cases: [
      { id: 'WFC-01', title: 'The fleet band aggregates honestly, with the window disclosed', priority: 'P0', blocker: true,
        preconditions: ['≥1 workflow with recent runs'],
        steps: [
          { action: 'Open /builder and read the "Fleet run statistics" band', expect: 'Figures for "Recent runs", "Success rate", "Slowest p95", "Model cost" — with the window note "Over the last N runs (since …). Not all-time totals." (never presented as all-time)' },
          { action: 'If the stats call fails (e.g. offline), reload', expect: 'Fail-soft: "Run statistics are unavailable right now — the workflows below are unaffected." — the dashboard still lists workflows' },
        ] },
      { id: 'WFC-02', title: 'Per-card stat chips + the canvas failure heatmap', priority: 'P1',
        preconditions: ['A workflow with some failed runs'],
        steps: [
          { action: 'Read that workflow\'s dashboard card', expect: 'Chips "N% success" (tooltip: cancellations excluded from the denominator), "p95 Ns", and the hotspot chip "fails at <node> (count)"' },
          { action: 'Open the workflow and pick the toolbar menu "Show failure heatmap"', expect: 'Nodes where recent runs failed gain danger count badges; a workflow with no failures states "No recorded failures for this workflow in the recent-runs window."' },
        ] },
      { id: 'WFC-03', title: 'The pre-run estimate is an order-of-magnitude floor, never a quote', priority: 'P2',
        preconditions: ['A workflow with AI nodes open in the builder'],
        steps: [
          { action: 'Read the "~$X/run" chip beside the Run affordance and hover it', expect: 'With run history: "Median recorded model cost of this workflow\'s recent runs (N samples). Not a quote." Without: the static floor "A rough floor from N AI steps at current model rates (~1K tokens in/out per step). Not a quote." — absent entirely when no data (fail-soft, no fake $0)' },
        ] },
      { id: 'WFC-04', title: 'Per-run cost rollup on run detail, advisory-labeled', priority: 'P1',
        preconditions: ['A run that made AI provider calls'],
        steps: [
          { action: 'Open /runs/:runId and expand "Tokens & cost"', expect: 'A per-model table (Model / Calls / In / Out / Cost) with a "Total" row and the summary "N tokens · M calls"' },
          { action: 'Read the footnote', expect: '"Advisory estimates — not billing." — locally-computed rates are marked ("computed from providers.json rates where the host omitted an estimate")' },
        ] },
      { id: 'WFC-05', title: 'Cancelled runs still report their real spend', priority: 'P0', blocker: true,
        preconditions: ['A run cancelled AFTER at least one AI call ("Cancel run" on run detail)'],
        steps: [
          { action: 'Open the cancelled run\'s detail and expand "Tokens & cost"', expect: 'The spend that occurred before cancellation is shown — a cancelled run never reads $0 while money was spent' },
          { action: 'Return to /builder and read the fleet band + that card\'s chips', expect: 'The cancelled run\'s cost is included in "Model cost"; it is EXCLUDED from the success-rate denominator (cancellation is an operator act, not a workflow outcome) but counted in the /runs "Cancelled" figure' },
        ] },
    ],
  },
  {
    key: 'workflow-evals', feature: 'Workflow evaluations', route: '/builder',
    description: 'Eval sets with fixtures/assertions + the evals-green publish gate (ADR 0477) and online scoring of production runs with daily trends (ADR 0480). NOT the /leaderboard model arena.',
    toggle: ON, updatedAt: '2026-07-24', sourceCommit: 'ee10aabe4',
    sourceFiles: ['frontend/react/src/builder/EvalsDrawer.tsx', 'frontend/react/src/workflows/workflowEvalsClient.ts', 'backend/typescript/src/routes/workflowEvals.ts', 'backend/typescript/src/host/workflowEvalSets.ts'],
    cases: [
      { id: 'WEV-01', title: 'Create a set, run it, read per-case + per-assertion results', priority: 'P0', blocker: true,
        preconditions: ['A tenant-owned, server-synced workflow open on /builder/:workflowId'],
        steps: [
          { action: 'Open the toolbar menu "Evaluations…"', expect: 'The "Evaluations" drawer opens; empty state "No evaluation sets yet" explains sets are "like tests for code"' },
          { action: 'Press "New set…", adjust the seeded JSON in the "Evaluation set JSON" editor, press "Save set"', expect: 'The set lists with its name and case count; invalid JSON is refused ("The set is not valid JSON."), an unknown assertion kind is a 400 — never silently stored' },
          { action: 'Press "Run now" (tooltip discloses it "Runs the last-saved draft")', expect: '"Running…" then a verdict chip — "All N cases green" or "N of M failed"; "Show results" lists each case Passed/Failed/Timed out with failed assertions ("kind: detail") and an "Open run" deep link per case' },
        ] },
      { id: 'WEV-02', title: 'The publish gate: a required set must be green for the CURRENT draft', priority: 'P0', blocker: true,
        preconditions: ['A set saved with "requiredForPromote": true (it shows the "Publish gate" chip)'],
        steps: [
          { action: 'Make the set fail (break an assertion), run it, then try to save/publish the workflow', expect: 'The save is blocked with "A required evaluation set is not green for this draft. Run it (and pass) before saving." and the Evaluations drawer opens on the failing set' },
          { action: 'Get a green run, then edit the workflow and re-check the chip', expect: 'The old result renders muted as "Green — older revision" — a stale green does NOT satisfy the gate until the set is re-run' },
        ] },
      { id: 'WEV-03', title: 'Pins mock upstream nodes; negative tests are first-class', priority: 'P1',
        preconditions: ['A set whose case has "pins" for an upstream node and an assertion {"kind":"status","value":"failed"}'],
        steps: [
          { action: 'Run the set and open the case\'s run via "Open run"', expect: 'Pinned nodes show as completed with the case\'s mocked data (they never executed); everything downstream ran live' },
          { action: 'Read the negative case\'s verdict', expect: 'A run that terminates FAILED scores "Passed" against the status:"failed" assertion — expected-failure tests work' },
        ] },
      { id: 'WEV-04', title: 'ADR 0480 — online scoring of production runs + the daily trend', priority: 'P1',
        preconditions: ['A set saved with "online": {"enabled": true, "sampleRate": 1, "assertions": [...]}', 'A published workflow receiving production launches'],
        steps: [
          { action: 'Read the set row in the drawer', expect: 'An "Online" chip ("Online scoring is on — 100% of production runs are scored against this set\'s invariants.")' },
          { action: 'Launch the workflow in production a few times, then expand the set', expect: 'The trend block shows "N% pass · last 7 days (M runs)", a daily pass-rate sparkline, and the window note ("…% of production runs sampled… not all-time totals"); before any scored run: "Online scoring is on (100% sample) — no production runs scored yet."' },
          { action: 'Run the workflow as a builder test-run / debug run / eval run', expect: 'Those do NOT enter the online buckets — only production launches are scored' },
          { action: 'Cause a production run to fail an assertion', expect: '"Recent failing runs:" lists it, deep-linked to /runs/:runId' },
        ] },
      { id: 'WEV-05', title: 'Judge budget honesty + the kill switch', priority: 'P2',
        preconditions: ['An online set with an llm-judge assertion; operator access to env config'],
        steps: [
          { action: 'Exceed the tenant-day judge budget (OPENWOP_ONLINE_EVAL_JUDGE_RUNS_PER_DAY, default 50) or score a non-completed run', expect: 'The trend block discloses "Judge skipped on N runs (daily judge budget, or runs didn\'t complete) — their deterministic checks still scored and judge verdicts were EXCLUDED, never failed."' },
          { action: 'Set OPENWOP_ONLINE_EVALS=off and produce production runs', expect: 'No new online scoring occurs (global kill switch); existing buckets still read' },
        ] },
    ],
  },
  // ── Design-system human verification (ADR 0510 Phase 9 — HV-DS-1..4 + DSCT-8) ──
  {
    key: 'design-system-hv', feature: 'Design system — human AT/device verification', route: '/design-system',
    description: 'The screen-reader, real-device, and custom-brand checks the automated matrix cannot run (DSA-022 tail). Requires NVDA/Chrome or VoiceOver/Safari and at least one real phone/tablet.',
    toggle: { off: true, id: 'developer-tools', howToEnable: [
      'Open Admin → Platform → Feature toggles (/feature-toggles)',
      'Switch the "developer-tools" toggle ON for your tenant (the demo host defaults it ON)',
      'Reload — Design system appears under Admin → Platform',
    ], howToRevert: ['Switch "developer-tools" OFF again on /feature-toggles'] },
    updatedAt: '2026-08-02', sourceCommit: '',
    sourceFiles: ['frontend/react/src/features/design-system-gallery', 'frontend/react/src/brand/AppearancePanel.tsx', 'frontend/react/src/chrome/AdminLayout.tsx', 'frontend/react/src/canvas/CanvasEditorPage.tsx'],
    cases: [
      { id: 'HVDS-01', title: 'Screen reader over the gallery: named controls, NO phantom announcements', priority: 'P0', blocker: true,
        preconditions: ['NVDA/Chrome or VoiceOver/Safari running', 'developer-tools ON'],
        steps: [
          { action: 'Open /design-system and let it settle WITHOUT interacting', expect: 'NOTHING is auto-announced — the failed-state and notice SPECIMENS are deliberately silent (renderings, not events)' },
          { action: 'Tab through the Buttons section', expect: 'Every stop announces role button + its visible label; the loading specimen conveys busy; the icon-button announces "Search"' },
          { action: 'Tab into the Tabs specimen and use Arrow keys', expect: 'Tab role + selected state announced; arrows move selection; the panel text updates and is discoverable' },
        ] },
      { id: 'HVDS-02', title: 'Appearance AA refusal is SPOKEN, and the reason is reachable', priority: 'P0', blocker: true,
        preconditions: ['Screen reader running', 'Superadmin (demo host: the anonymous session is)'],
        steps: [
          { action: 'On Appearance, drag the Brand color swatch to a nearly-white value (a lightness around 99% — deliberately unreadable on paper)', expect: 'The contrast warning notice appears and is announced; the Contrast panel marks the failing pair(s) below AA' },
          { action: 'Press Save', expect: 'Save REFUSES with an announced below-AA reason; nothing persists (reload shows the prior theme); Save was reachable and enabled — never a silent dead button' },
        ] },
      { id: 'HVDS-03', title: 'Mobile admin disclosure on a REAL phone', priority: 'P1', blocker: false,
        preconditions: ['A real phone (or ≤860px touch viewport)', 'Admin access'],
        steps: [
          { action: 'Open any admin page (e.g. /orgs)', expect: 'One compact labeled row ("Admin · <current page>" once the nav resolves; bare "Admin" is a degradation to REPORT, not a pass/fail) — no wrapping link cloud' },
          { action: 'Tap the row', expect: 'Sections disclose VERTICALLY; every target comfortably tappable (≥44px)' },
          { action: 'Tap a destination', expect: 'It navigates and the disclosure closes on its own' },
        ] },
      { id: 'HVDS-04', title: 'Canvas touch levels on a REAL tablet read honestly per family', priority: 'P1', blocker: false,
        preconditions: ['A real tablet (or ≤600px touch viewport)', 'A drawing, a slides deck, and a CAD doc'],
        steps: [
          { action: 'Open a drawing at tablet width', expect: 'The notice states common edits work on touch — and they DO: finger ink, pinch-zoom, two-finger-tap undo' },
          { action: 'Open a CAD doc', expect: 'The notice states view-only — and no touch gesture silently mutates the model' },
          { action: 'Open slides Present mode', expect: 'Present flows are touch-complete (advance/exit); the wording matches' },
        ] },
      { id: 'HVDS-05', title: 'A real custom brand with light+dark marks, everywhere', priority: 'P1', blocker: false,
        preconditions: ['Superadmin', 'Two small PNGs (light-suited + dark-suited)'],
        steps: [
          { action: 'On Appearance, use the Upload controls for "Logo URL" and "Logo URL (dark mode)", then Save', expect: 'Both publish (toast) and Save persists' },
          { action: 'Toggle app theme light ↔ dark with the OS set to the OPPOSITE mode', expect: 'Header mark AND public-shell mark follow the APP mode instantly (dark variant in app-dark even on an OS-light machine)' },
          { action: 'Check the tab favicon + a signed-out window', expect: 'Favicon renders; the anonymous page shows the correct-mode mark — its bytes serve from the HOST copy (ADR 0511), so deleting any original upload cannot break it' },
        ] },
      { id: 'HVDS-06', title: 'DSCT-8 core-flow screen-reader smoke (sign-in → chat → workflow → modal)', priority: 'P0', blocker: true,
        preconditions: ['NVDA/Chrome AND VoiceOver/Safari (run once each)'],
        steps: [
          { action: 'Enter the app and reach /chat; send a message', expect: 'Focus lands predictably after navigation; the composer is labeled; the response arriving is perceivable, not silent' },
          { action: 'On /builder, operate a workflow card by keyboard', expect: 'Each card is ONE named button ("Open workflow <name>"); the kebab menu has menu semantics and never also activates the card' },
          { action: 'Complete one modal write flow (e.g. Set budget)', expect: 'Focus trapped while open, restored on close; validation and success are announced' },
        ] },
    ],
  },
];

// ── Categories (ADR 0183) — the Category → Suite → Case grouping ported from the
// myndhyve runner. `CATEGORY_OF` maps each suite key to a category id; the runner
// groups the flat SUITES list by it. Keep in sync when a suite is added.
export const CATEGORIES: TestCategory[] = [
  { id: 'workspace', title: 'Workspace', description: 'The daily work surfaces — chat, agents, workflows, runs, boards.', colorKey: 'clay' },
  { id: 'content', title: 'Content & CMS', description: 'Media, pages, publishing, prompts, documents, comments, sharing.', colorKey: 'info' },
  { id: 'crm', title: 'CRM & Marketing', description: 'Contacts, success, forms, email, analytics, consent.', colorKey: 'success' },
  { id: 'knowledge', title: 'Knowledge & Memory', description: 'RAG collections + tenant memory.', colorKey: 'accent' },
  { id: 'leadership', title: 'Leadership & Strategy', description: 'Advisors, priority matrix, strategy.', colorKey: 'warning' },
  { id: 'platform', title: 'Platform', description: 'Capabilities, CLI, toggles, marketplace, example data.', colorKey: 'muted' },
  { id: 'access', title: 'Access & Data', description: 'Orgs, keys, users, connections.', colorKey: 'danger' },
  { id: 'commerce', title: 'Commerce & Ops', description: 'Storefront, UCP, billing, production, exports.', colorKey: 'success' },
  { id: 'chat-platform', title: 'Chat Platform', description: 'Channels, widget, search, router, artifacts, voice, evals.', colorKey: 'accent' },
  { id: 'governance', title: 'Governance & Platform', description: 'Firewall, ledger, work-graph, access, nav, usage, economy.', colorKey: 'warning' },

];

/** suite key → category id. A suite with no entry falls into an "Other" bucket in the runner. */
export const CATEGORY_OF: Record<string, string> = {
  kicktodo: 'workspace',
  'kicktodo-admin': 'governance', 'kicktodo-circles': 'workspace', 'kicktodo-wearables': 'workspace',
  'kicktodo-calendar': 'workspace', 'challenge-outline': 'workspace',
  'reviews-hitl': 'workspace', 'chat-first-remediation': 'workspace', 'workflow-proposals': 'governance',
  'workflow-versioning': 'workspace', 'workflow-debug': 'workspace', 'workflow-fleet-cost': 'workspace',
  'workflow-evals': 'workspace',
  'kicktodo-engagement': 'workspace', 'kicktodo-community': 'workspace', 'kicktodo-org-programs': 'workspace',
  'kicktodo-studio': 'workspace', 'kicktodo-metrics': 'workspace', 'app-builder': 'workspace',
  chat: 'workspace', agents: 'workspace', workflows: 'workspace', runs: 'workspace', boards: 'workspace',
  workforces: 'workspace', inbox: 'workspace', projects: 'workspace', mission: 'workspace',
  'agent-templates': 'workspace', roster: 'workspace',
  media: 'content', cms: 'content', publishing: 'content', 'front-page': 'content', prompts: 'content',
  documents: 'content', comments: 'content', sharing: 'content',
  crm: 'crm', 'crm-gmail-sync': 'crm', csm: 'crm', forms: 'crm', email: 'crm', analytics: 'crm', consent: 'crm',
  kb: 'knowledge', memory: 'knowledge',
  advisors: 'leadership', 'priority-matrix': 'leadership', strategy: 'leadership',
  capabilities: 'platform', cli: 'platform', 'feature-toggles': 'platform', marketplace: 'platform', 'example-data': 'platform',
  orgs: 'access', keys: 'access', users: 'access', connections: 'access', 'connect-to-continue': 'access',
  production: 'commerce', commerce: 'commerce', 'commerce-ucp': 'commerce', billing: 'commerce', 'code-export': 'commerce', 'market-intel': 'commerce', 'messaging-gateway': 'commerce',
  channels: 'chat-platform', 'chat-widget': 'chat-platform', 'chat-export': 'chat-platform', 'chat-autotitle': 'chat-platform', 'conversation-search': 'chat-platform', 'conversation-tools': 'chat-platform', 'interactive-artifacts': 'chat-platform', 'model-router': 'chat-platform', 'scheduled-agent-chats': 'chat-platform', evals: 'chat-platform', 'task-deck': 'chat-platform', 'code-exec': 'chat-platform', 'memory-auto-extract': 'chat-platform', voice: 'chat-platform',
  'capability-firewall': 'governance', 'intent-ledger': 'governance', 'ambient-work-graph': 'governance', 'access-hub': 'governance', 'navigation-settings': 'governance', 'context-economy': 'governance', 'tool-output-compaction': 'governance', 'usage-analytics': 'governance', 'workflow-author': 'governance', assistant: 'governance',
  notebooks: 'content', podcasts: 'content', brand: 'content', 'cms-localization': 'content', 'cms-approval-gate': 'content', 'insights-suite': 'content',
  'knowledge-sync': 'knowledge', twin: 'knowledge', 'profile-memory': 'knowledge', 'agent-knowledge': 'knowledge',
  profiles: 'access',
  'design-system-hv': 'platform',
};
