/**
 * Manual-test suites (authored by `/manual-tests`). Full coverage: every
 * user-facing feature in the FEATURES manifest. OFF (toggle-gated) features lead
 * with an "enable-first" case. Each suite records `sourceCommit` + `sourceFiles`
 * so the skill can detect staleness on later runs.
 */
import type { FeatureToggle, TestSuite } from './manualTestTypes.js';

const AT = '2026-06-17';
const SHA0 = '7ebb93b6'; // original first-pass suites
const SHA = 'fbea4434';  // this expansion
const AT2 = '2026-06-20';
const SHA2 = '8e9770e4'; // a11y pass: Strategy suite + chat workflow-progress cases
const ON = { off: false, howToEnable: [] as string[] };

/** OFF feature gated by a `/feature-toggles` flag — the standard enable recipe. */
const offVia = (id: string): FeatureToggle => ({
  off: true,
  howToEnable: [
    'Open Admin → Platform → Feature toggles (/feature-toggles)',
    `Switch the "${id}" toggle ON for your tenant`,
    'Reload — the feature appears in the nav and its route is reachable',
  ],
  howToRevert: [`Switch the "${id}" toggle OFF again on /feature-toggles`],
});

export const SUITES: TestSuite[] = [
  // ── Core always-on (first pass) ──────────────────────────────────────────
  {
    key: 'chat', feature: 'Chat', route: '/', description: 'Conversational entry point — talk to agents and start work.',
    toggle: ON, updatedAt: AT2, sourceCommit: SHA2, sourceFiles: ['frontend/react/src/chat'],
    cases: [
      { id: 'CHAT-01', title: 'Send a message and get a response', priority: 'P0', blocker: true,
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
      { id: 'AGENTS-01', title: 'Roster loads', priority: 'P0', blocker: true, preconditions: [],
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
      { id: 'WF-01', title: 'Workflows dashboard loads', priority: 'P0', blocker: true, preconditions: [],
        steps: [{ action: 'Navigate to /builder', expect: 'The workflows list renders (or an empty state with a create affordance)' }] },
      { id: 'WF-02', title: 'Open the canvas', priority: 'P1', preconditions: ['≥1 workflow exists'],
        steps: [{ action: 'Open a workflow', expect: 'Routes to /builder/:id; nodes and edges render on the canvas' }] },
    ],
  },
  {
    key: 'runs', feature: 'Runs', route: '/runs', description: 'Execution history and detail.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA0, sourceFiles: ['frontend/react/src/runs'],
    cases: [
      { id: 'RUNS-01', title: 'Runs list renders', priority: 'P0', blocker: true, preconditions: [],
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
      { id: 'BOARDS-01', title: 'Board loads', priority: 'P0', blocker: true, preconditions: [],
        steps: [{ action: 'Navigate to /boards', expect: 'Columns (To Do / Working / Waiting / Done) render with any cards' }] },
      { id: 'BOARDS-02', title: 'Move a card', priority: 'P1', preconditions: ['≥1 card on the board'],
        steps: [{ action: 'Drag a card to another column, then reload', expect: 'The card stays in the new column after reload' }] },
    ],
  },
  {
    key: 'workforces', feature: 'Workforces', route: '/workforces', description: 'Governed agent clusters — purpose, telemetry, autonomy.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA0, sourceFiles: ['frontend/react/src/workforces'],
    cases: [
      { id: 'WKF-01', title: 'Workforces list renders', priority: 'P0', blocker: true, preconditions: [],
        steps: [{ action: 'Navigate to /workforces', expect: 'Workforce cards render with purpose, status, and autonomy' }] },
      { id: 'WKF-02', title: 'Workforce detail', priority: 'P1', preconditions: ['≥1 workforce exists'],
        steps: [{ action: 'Open a workforce', expect: 'Routes to /workforces/:id; telemetry + agent cluster render' }] },
    ],
  },
  {
    key: 'inbox', feature: 'Inbox', route: '/inbox', description: 'What needs you — approvals, blockers, notifications.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA0, sourceFiles: ['frontend/react/src/notifications'],
    cases: [
      { id: 'INBOX-01', title: 'Inbox loads', priority: 'P0', blocker: true, preconditions: [],
        steps: [{ action: 'Navigate to /inbox', expect: 'Pending approvals / notifications render (or a clear empty state)' }] },
      { id: 'INBOX-02', title: 'Act on an approval', priority: 'P1', preconditions: ['≥1 pending approval'],
        steps: [{ action: 'Approve or reject an item', expect: 'The item resolves and leaves the pending list' }] },
    ],
  },
  {
    key: 'projects', feature: 'Projects', route: '/projects', description: 'Work containers — board, memory, workflows.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA0, sourceFiles: ['frontend/react/src/features/projects'],
    cases: [
      { id: 'PROJ-01', title: 'Projects list renders', priority: 'P0', blocker: true, preconditions: [],
        steps: [{ action: 'Navigate to /projects', expect: 'Project cards render (or an empty state with create)' }] },
      { id: 'PROJ-02', title: 'Project detail', priority: 'P1', preconditions: ['≥1 project exists'],
        steps: [{ action: 'Open a project', expect: 'Routes to /projects/:id; the project tabs render' }] },
    ],
  },

  // ── Operations / Workforces (admin) ──────────────────────────────────────
  {
    key: 'mission', feature: 'Mission Control', route: '/mission', description: 'Live fleet view across runs.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/runs'],
    cases: [
      { id: 'MC-01', title: 'Fleet view loads', priority: 'P0', blocker: true, preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /mission', expect: 'The live fleet/runs overview renders with current activity (or an empty state)' }] },
    ],
  },
  {
    key: 'agent-templates', feature: 'Agent templates', route: '/agents/templates', description: 'Installed manifest agents + packs.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/agents'],
    cases: [
      { id: 'TMPL-01', title: 'Templates list loads', priority: 'P0', blocker: true, preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /agents/templates', expect: 'Installed agent templates / packs render' }] },
      { id: 'TMPL-02', title: 'Open a template', priority: 'P2', preconditions: ['≥1 template'],
        steps: [{ action: 'Open a template', expect: 'Routes to /agents/templates/:id; detail renders with an install/use affordance' }] },
    ],
  },
  {
    key: 'roster', feature: 'Org chart', route: '/roster', description: 'Roster + org-chart editor (descriptive only).',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/roster', 'frontend/react/src/agents'],
    cases: [
      { id: 'ROST-01', title: 'Org chart renders', priority: 'P0', blocker: true, preconditions: ['Admin access'],
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
      { id: 'MEDIA-01', title: 'Library loads', priority: 'P0', blocker: true, preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /media', expect: 'The asset library renders (grid of assets or an empty state)' }] },
      { id: 'MEDIA-02', title: 'Upload an asset', priority: 'P1', preconditions: [],
        steps: [{ action: 'Upload an image', expect: 'It appears in the library and yields a usable asset token' }] },
    ],
  },
  {
    key: 'cms', feature: 'CMS', route: '/cms', description: 'Pages + page builder.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/cms'],
    cases: [
      { id: 'CMS-01', title: 'Pages list loads', priority: 'P0', blocker: true, preconditions: ['Admin access'],
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
      { id: 'PUB-01', title: 'Publishing settings load', priority: 'P0', blocker: true, preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /publishing', expect: 'The public-site / SEO settings render' }] },
      { id: 'PUB-02', title: 'Set SEO metadata', priority: 'P2', preconditions: ['≥1 published page'],
        steps: [{ action: 'Edit a page’s SEO title/description and save', expect: 'It persists and appears in the public page’s metadata' }] },
    ],
  },
  {
    key: 'front-page', feature: 'Front page', route: '/front-page', description: 'The public landing page at / (which org + page).',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/site'],
    cases: [
      { id: 'FP-01', title: 'Front-page settings load', priority: 'P0', blocker: true, preconditions: ['Superadmin access'],
        steps: [{ action: 'Navigate to /front-page', expect: 'The front-page pointer/enable settings render' }] },
      { id: 'FP-02', title: 'Toggle the public front page', priority: 'P1', preconditions: [],
        steps: [{ action: 'Disable, then re-enable the front page', expect: '/ shows the app when off, the marketing page when on' }] },
    ],
  },

  // ── Platform (admin) ─────────────────────────────────────────────────────
  {
    key: 'prompts', feature: 'Prompts', route: '/prompts', description: 'Reusable templates + variables.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/prompts'],
    cases: [
      { id: 'PROMPT-01', title: 'Prompt library loads', priority: 'P0', blocker: true, preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /prompts', expect: 'The prompt-template library renders' }] },
      { id: 'PROMPT-02', title: 'Create a template', priority: 'P2', preconditions: [],
        steps: [{ action: 'Create a template with a {{variable}} and save', expect: 'It appears in the library and the variable is recognized' }] },
    ],
  },
  {
    key: 'memory', feature: 'Memory', route: '/memory', description: 'Tenant-attributed memory writes.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/memory'],
    cases: [
      { id: 'MEM-01', title: 'Memory ledger loads', priority: 'P0', blocker: true, preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /memory', expect: 'The memory ledger renders, attributed per tenant (or an empty state)' }] },
    ],
  },
  {
    key: 'capabilities', feature: 'Capabilities', route: '/capabilities', description: 'What this host advertises.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/discovery'],
    cases: [
      { id: 'CAP-01', title: 'Capabilities panel loads', priority: 'P0', blocker: true, preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /capabilities', expect: 'The advertised host capabilities render (matches /.well-known/openwop)' }] },
    ],
  },
  {
    key: 'cli', feature: 'CLI', route: '/cli', description: 'In-app CLI quickstart + catalog.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/CliPage.tsx'],
    cases: [
      { id: 'CLI-01', title: 'CLI quickstart renders', priority: 'P0', blocker: true, preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /cli', expect: 'The CLI quickstart + command catalog render' }] },
      { id: 'CLI-02', title: 'Copy a command', priority: 'P2', preconditions: [],
        steps: [{ action: 'Click a copy affordance on a command', expect: 'A toast confirms it copied to the clipboard' }] },
    ],
  },
  {
    key: 'feature-toggles', feature: 'Feature toggles', route: '/feature-toggles', description: 'On / off / beta + multivariant traffic-splitting.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/feature-toggles'],
    cases: [
      { id: 'FT-01', title: 'Toggle list loads', priority: 'P0', blocker: true, preconditions: ['Superadmin access'],
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
      { id: 'ORG-01', title: 'Orgs list loads', priority: 'P0', blocker: true, preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /orgs', expect: 'Orgs / teams / members render with roles' }] },
      { id: 'ORG-02', title: 'Invite a member', priority: 'P1', preconditions: [],
        steps: [{ action: 'Invite a member with a role and save', expect: 'They appear in the members list with that role' }] },
    ],
  },
  {
    key: 'keys', feature: 'Keys', route: '/keys', description: 'BYOK credentials + provider config.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/keys'],
    cases: [
      { id: 'KEYS-01', title: 'Keys page loads', priority: 'P0', blocker: true, preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /keys', expect: 'Provider key slots render with their configured/empty state' }] },
      { id: 'KEYS-02', title: 'Add a provider key', priority: 'P1', preconditions: [],
        steps: [{ action: 'Add a key for a provider and save', expect: 'The provider shows as configured; the secret value is not echoed back' }] },
    ],
  },
  {
    key: 'users', feature: 'Users', route: '/users', description: 'Accounts + identity.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/users'],
    cases: [
      { id: 'USERS-01', title: 'Users list loads', priority: 'P0', blocker: true, preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /users', expect: 'Accounts render in a table with identity details' }] },
    ],
  },
  {
    key: 'connections', feature: 'Connections', route: '/connections', description: 'Credentials for external apps.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/features/connections'],
    cases: [
      { id: 'CONN-01', title: 'Connections list loads', priority: 'P0', blocker: true, preconditions: ['Admin access'],
        steps: [{ action: 'Navigate to /connections', expect: 'Available providers (Google/Slack/Zoom/…) render with connect state' }] },
      { id: 'CONN-02', title: 'Begin linking a provider', priority: 'P2', preconditions: [],
        steps: [{ action: 'Click "Connect" on a provider', expect: 'The OAuth/connect flow starts (consent screen or config prompt)' }] },
    ],
  },
  {
    key: 'example-data', feature: 'Example data', route: '/example-data', description: 'Re-seed the built-in example roster.',
    toggle: ON, updatedAt: AT, sourceCommit: SHA, sourceFiles: ['frontend/react/src/settings'],
    cases: [
      { id: 'EX-01', title: 'Dashboard loads with live counts', priority: 'P0', blocker: true, preconditions: ['Admin access'],
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
          { action: 'Turn the "strategy" toggle ON (Admin → Platform → Feature toggles) and reload', expect: 'Strategy appears under the "Leadership" nav group; /strategy loads the portfolio (no "Strategy is not enabled" StateCard)' },
        ] },
      { id: 'STRAT-01', title: 'Create a strategy from a template (aria-live)', priority: 'P0', blocker: true,
        preconditions: ['Strategy enabled'],
        steps: [
          { action: 'Click "New strategy"; in the modal pick a "Start from" preset (e.g. OKR)', expect: 'The modal heading is an <h2> (STRAT-5); objectives/key-results scaffold in from the preset' },
          { action: 'With a screen reader on, switch between presets', expect: 'A polite live region announces "Pre-filled N objectives…" on change (aria-live status, STRAT-6)' },
          { action: 'Fill the title + organization and submit', expect: 'The strategy is created and opens in the detail view' },
        ] },
      { id: 'STRAT-02', title: 'Detail-view heading outline + tab nav', priority: 'P1', preconditions: ['≥1 strategy exists'],
        steps: [
          { action: 'Open a strategy', expect: 'The detail card leads with an <h2> of the strategy title — outline is page h1 → detail h2 → tablist, no skipped level (STRAT-2)' },
          { action: 'Tab to the Overview/Objectives/Initiatives/Alignment tablist; use Arrow keys', expect: 'role=tablist with arrow-key roving; panels swap; the tablist is not orphaned from a heading' },
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
];
