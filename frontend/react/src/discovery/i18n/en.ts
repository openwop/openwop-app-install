/**
 * `discovery` namespace — user-facing copy for the Host capabilities page
 * (CapabilitiesPanel): coverage, host surfaces, envelope discipline, model
 * capabilities, input modalities, conformance & profiles.
 */
export const messages = {
  eyebrow: 'Discovery',
  title: 'Host capabilities',
  lede: 'What this host can and can’t run — so you know which workflows will work here, and why some are blocked.',
  explainTitle: 'How to read this page',
  explainBody: 'Start at the top: “Pack coverage” shows how many installed building blocks this host can run, and which are blocked and why. Everything below — host surfaces, envelopes, model capabilities — is the host’s detailed protocol advertisement, useful when diagnosing conformance.',

  // Pack coverage
  packCoverage: 'Pack coverage',
  packCoverageHelpPrefix: 'The single number that answers "can this host run my workflow?" — runnable nodes over the full installed catalog. Toggle ',
  packCoverageHelpBlocked: 'Blocked',
  packCoverageHelpSuffix: ' to scope the table to only the surfaces that are gating execution.',
  coverageAriaLabel: 'Pack coverage',
  figureRunnable: 'Runnable',
  figureTotalNodes: 'Total nodes',
  figureBlocked: 'Blocked',
  blockedTableCaption: 'Nodes blocked by surface',
  colBlockedBySurface: 'Blocked by surface',
  colNodes: 'Nodes',
  allRunnableClearPrefix: 'All {{count}} runnable nodes clear every required surface. Select ',
  allRunnableClearBlocked: 'Blocked',
  allRunnableClearSuffix: ' to see the {{blocked}} that don\'t.',
  everyNodeRunnableTitle: 'Every installed node is runnable here',
  everyNodeRunnableBody:
    'No node in the catalog is missing a host surface — this host can execute the full pack set.',

  // Host surfaces
  hostSurfaces: 'Host surfaces',
  hostSurfacesHelpPrefix: 'Live render of ',
  hostSurfacesHelpImplLead: '. The',
  hostSurfacesHelpImplEm: 'implementation',
  hostSurfacesHelpImplMid: ' column tells you what\'s backing each surface — values like ',
  hostSurfacesHelpImplOr: ' or ',
  hostSurfacesHelpImplTail: ' mean the surface is non-durable. Phase 6 swaps these with real-backend adapters from ',
  hostSurfacesHelpEnd: '.',
  surfacesTableCaption: 'Host surfaces',
  noSurfacesTitle: 'No host surfaces advertised',
  noSurfacesBodyPrefix: "This host's ",
  noSurfacesBodySuffix: ' is empty.',
  colSurface: 'Surface',
  colSupported: 'Supported',
  colImplementation: 'Implementation',
  colNote: 'Note',

  // Envelope discipline
  envelopeDiscipline: 'Envelope discipline',
  envelopeHelp:
    "What this host promises about LLM-emission envelopes — the inbound payload shape every AI node serves into the run. When a row reads —, the host hasn't advertised that surface yet.",
  envelopeHelp2:
    'When the reliability events below fire on a run, they surface live in the AI chat as inline chips inside the assistant bubble (retries, refusals, truncations, model substitutions, prose-to-JSON coercions, partial-payload recoveries).',
  envelopeTableCaption: 'Envelope discipline',
  colValue: 'Value',
  envReasoningSupportedNoteLead: 'optional',
  envReasoningSupportedNoteTail: 'string on envelope payloads',
  envReasoningDirectiveNote: 'how aggressively the host prompts the model to populate it',
  envTierOneNote: "host's posture on the OpenAI ∩ Anthropic ∩ Gemini schema subset",
  envReliabilitySupportedNote: 'host emits retry / refusal / truncation events',
  envReliabilityEventsNote: 'which reliability event types this host actually emits',
  envTruncationNote: 'host branches retry strategy on truncation vs schema-violation',
  envTruncationBudgetNote: 'how much extra output budget the host gives on a truncation retry',

  // Model capabilities
  modelCapabilities: 'Model capabilities',
  modelCapabilitiesHelpPrefix:
    'What each installed provider/model can do (function-calling, vision, streaming, etc.), and whether this host will silently substitute a fallback model when the workflow asks for a capability the configured model lacks. Substitution is observable via the ',
  modelCapabilitiesHelpSuffix: ' event.',
  advertised: 'Advertised',
  notAdvertised: 'Not advertised',
  substitutionOn: 'Substitution on',
  substitutionOff: 'Substitution off',
  declaredCount: '{{count}} declared',
  modelCapsNotAdvertisedTitle: 'Model capabilities not advertised',
  modelCapsNotAdvertisedBodyPrefix: "This host doesn't declare ",
  modelCapsNotAdvertisedBodySuffix: ' yet, so capability-substitution behavior is unknown.',

  // Input modalities
  inputModalities: 'Input modalities',
  inputModalitiesHelpPrefix: 'The perception modalities this host accepts as ',
  inputModalitiesHelpMid: ' ContentParts. ',
  inputModalitiesHelpTextEm: 'text',
  inputModalitiesHelpAfterText: ' is always valid; a non-text modality is only accepted when advertised here, else the call is rejected with ',
  inputModalitiesHelpSuffix: '.',
  noModalitiesTitle: 'No non-text modalities advertised',
  noModalitiesBodyPrefix: "This host doesn't declare ",
  noModalitiesBodyMid: ' yet — only ',
  noModalitiesBodySuffix: ' ContentParts are accepted.',

  // Raw advertisement
  rawAdvertisement: 'Raw advertisement',
  rawAdvertisementHelpPrefix: 'Full ',
  rawAdvertisementHelpSuffix: ' payload.',
  rawCapsAriaLabel: 'Raw capabilities JSON',

  // Conformance & profiles
  conformanceAndProfiles: 'Conformance & profiles',
  conformanceHelpPrefix: "The connected host's identity + every profile it advertises through ",
  conformanceHelpAnd: ' and ',
  conformanceHelpMid: ' — the surfaces an external implementer can rely on. See the ',
  conformanceLeaderboardLink: 'conformance leaderboard',
  conformanceHelpSuffix: ' for the cross-host pass-rate matrix.',
  implementationLabel: 'Implementation',
  versionPrefix: 'v{{version}}',
  vendorPrefix: '· {{vendor}}',
  profilesClaimed: 'Profiles claimed ({{count}})',
  noneAdvertised: 'none advertised',
  referenceHostBadge: 'Reference-host badge',
  badgeAlt: '{{label}} conformance badge',
  noBadgePrefix:
    'No published badge for this implementation. Hosts that match a reference (in-memory, sqlite, postgres, python) get one inline; see the ',
  leaderboard: 'leaderboard',
  noBadgeSuffix: ' for all published hosts.',
  emDash: '—',

  // Badge host labels
  badgePostgres: 'Postgres reference host',
  badgeSqlite: 'SQLite reference host',
  badgePython: 'Python in-memory reference host',
  badgeInMemory: 'In-memory reference host',
} as const;
