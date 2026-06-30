/**
 * `profiles` namespace — user-facing copy for the Profiles feature (My Profile,
 * Team directory, and the profile tabs — ADR 0005 / ADR 0025).
 * Feature-self-contained: every profiles string lives here. Generic actions/
 * states are reused from the `common` namespace via `t('common:…')` and are NOT
 * duplicated. Plural keys use i18next `_one`/`_other` suffixes.
 */
export const messages = {
  // ── My Profile page chrome ────────────────────────────────────────────
  eyebrow: 'Platform',
  title: 'My Profile',
  lede: 'Your self-service profile. Visible to your team in the directory.',
  loadProfileFailed: 'Failed to load your profile.',
  loadBoardFailed: 'Failed to load your board.',

  // Tabs
  tabProfile: 'Profile',
  tabBoard: 'My Board',
  tabWorkflows: 'Assigned workflows',
  tabSchedules: 'Schedules',
  tabActivity: 'Activity',
  tabConnections: 'Connections',
  tabMemory: 'Memory',
  tabKnowledge: 'Knowledge',
  tabTwin: 'Who can recall my memory',

  // Identity card
  avatarAlt: 'avatar',
  youFallback: 'You',
  verified: 'Verified',
  emailUnverified: 'Email unverified',
  completenessLabel: 'Profile completeness: {{percent}}',
  upload: 'Upload',

  // Details fields
  details: 'Details',
  yourName: 'Your name',
  yourNamePlaceholder: 'e.g. Jordan Rivera',
  jobTitleLabel: 'Job title',
  jobTitlePlaceholder: 'Staff Engineer',
  departmentLabel: 'Department',
  departmentPlaceholder: 'Platform',
  bioLabel: 'Bio',
  bioPlaceholder: 'A short bio…',
  equipmentLabel: 'Equipment (comma-separated)',
  equipmentPlaceholder: 'laptop, camera',
  interestsLabel: 'Interests (comma-separated)',
  interestsPlaceholder: 'protocols, distributed systems',
  timezoneLabel: 'Timezone',
  timezonePlaceholder: 'America/New_York',
  hoursLabel: 'Hours / week',
  hoursPlaceholder: '40',
  availabilityLabel: 'Availability',
  availabilityNone: '—',
  saveDetails: 'Save details',

  // Skills card
  skills: 'Skills',
  skillsHint: 'Endorsements from teammates are preserved when you edit a skill you keep.',
  skillPlaceholder: 'Skill',
  removeSkillLabel: 'Remove skill {{name}}',
  endorsedCount: '{{count}} endorsed',
  addSkill: 'Add skill',
  saveSkills: 'Save skills',

  // Board intro (rich — numbered <0><1><2> are <strong> spans)
  boardIntro: '<0>Your board.</0> New work arrives in <1>To Do</1>. <2>Drag a card</2> between lanes to move it along — dropping a card into a trigger lane runs its workflow on your behalf.',
  loadingBoard: 'Loading your board…',

  // ── Toasts (My Profile) ───────────────────────────────────────────────
  hoursRangeError: 'Hours / week must be a number between 0 and 168.',
  profileSaved: 'Profile saved.',
  saveFailed: 'Save failed.',
  skillsSaved: 'Skills saved.',
  saveSkillsFailed: 'Saving skills failed.',
  avatarMustBeImage: 'Avatar must be an image.',
  avatarUpdated: 'Avatar updated.',
  avatarUploadFailed: 'Avatar upload failed.',
  avatarRemoved: 'Avatar removed.',
  avatarRemoveFailed: 'Could not remove avatar.',

  // ── Activity tab ──────────────────────────────────────────────────────
  loadingActivity: 'Loading activity…',
  noActivityTitle: 'No activity yet',
  noActivityBody: 'Run a workflow from My Board or a schedule, and your activity — with outcomes and timestamps — will appear here.',
  sourceHeartbeat: 'picked up a task',
  sourceSchedule: 'ran on a schedule',
  sourceKanban: 'started a workflow from a card',
  sourceApproval: 'ran an approved proposal',
  activityLine: 'You {{source}} · ',
  ranIn: ' · ran in {{duration}}',
  chained: 'chained',
  chainedTitle: 'Caused by an upstream trigger',
  viewRun: 'view run',
  runStatusTitle: 'Run {{status}}',
  truncatedNote: 'Showing your most recent activity. Older runs may exist beyond this window.',

  // Status chips
  statusCompleted: 'Completed',
  statusFailed: 'Failed',
  statusRunning: 'Running',
  statusSuspended: 'Suspended',

  // ── Workflows tab ─────────────────────────────────────────────────────
  workflowStarted: 'Started {{name}} · ',
  viewRunAction: 'View run',
  noWorkflowsTitle: 'No workflows assigned yet',
  noWorkflowsBody: 'Assign one from the library below to build your portfolio — the work you (or your assistant) run.',
  workflowsPortfolioLead: 'Your workflow portfolio — the work you own. Each card explains what it does; run it now or drop a card into a trigger lane on <0>My Board</0> to fire it.',
  localWorkflowPurpose: 'Local workflow — assigned to you.',
  localOnlyWarning: 'Local-only — register on the host before it can run from a board or schedule.',
  running: 'Running…',
  runNow: 'Run now',
  unassign: 'Unassign',
  assignAWorkflow: 'Assign a workflow',
  workflowToAssignLabel: 'Workflow to assign',
  chooseWorkflow: 'Choose a workflow from the library…',
  assignWorkflow: 'Assign workflow',
  createFromTemplate: 'Create from template',

  // ── Schedules tab ─────────────────────────────────────────────────────
  schedulesEmptyBody: 'Create one below to run a workflow from your portfolio on a cadence.',
  schedulesHelper: 'Cadence shown in {{tz}}. Schedules fire automatically on this cadence (a background daemon), or immediately with “Run now”.',
  schedulesNoWorkflowsHint: 'Assign a workflow in the <0>Assigned workflows</0> tab first, then schedule it here.',

  // ── Team directory page ───────────────────────────────────────────────
  teamEyebrow: 'Platform',
  teamTitle: 'Team directory',
  teamLede: "Everyone's profile in this tenant. Endorse a teammate's skill.",
  loadDirectoryFailed: 'Failed to load the directory.',
  endorsementFailed: 'Endorsement failed.',
  unnamedTeammate: 'Unnamed teammate',

  // Toolbar
  searchPlaceholder: 'Search by name, role, skill…',
  searchAriaLabel: 'Search the team directory',
  countFiltered: '{{shown}} of {{total}}',
  countPeople_one: 'person',
  countPeople_other: 'people',

  // States
  noProfilesTitle: 'No profiles yet',
  noProfilesBody: 'Profiles appear here as teammates fill them in.',
  noMatchesTitle: 'No matches',
  noMatchesBody: 'Nobody matches "{{query}}". Try a different name, role, or skill.',

  // Availability labels
  availabilityAvailable: 'Available',
  availabilityBusy: 'Busy',
  availabilityAway: 'Away',

  // Card chips & meta
  emailVerifiedTitle: 'Email verified',
  youChip: 'You',
  hoursPerWeek: ' · {{hours}}h/wk',
  emptyProfileSelf: "You haven't filled in your profile yet.",
  emptyProfileOther: "Hasn't filled in their profile yet.",
  interestsPrefix: 'Interests: {{list}}',

  // Skill endorse affordance
  cannotEndorseOwn: 'You cannot endorse your own skill',
  removeEndorsement: 'Remove your endorsement',
  endorseSkill: 'Endorse this skill',

  // Self footer
  completenessAria: 'Your profile completeness',
  editProfile: 'Edit profile',
} as const;
