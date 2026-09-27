/**
 * `site` namespace — user-facing copy for the site front page.
 * Feature-self-contained: every site string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Default hero — the thesis, beside the run ledger (visual: 'run')
  heroHeading: 'AI work happens in the run. Now the run is open.',
  heroSubheading: 'Agents don’t follow a script. They decide while they work: which tool to call, what to hand off, when to stop and ask you. OpenWOP is an open protocol for that run, and this is where you can build one, watch it, and take it with you.',
  heroCtaLabel: 'Start building — no sign-up',
  heroCtaLabel2: 'Read the protocol',

  // The "workflow" hero visual (HeroSchematic) — kept for CMS pages that pick it
  heroVignetteName: 'OpenWOP / workflow',
  heroVignetteReady: 'ready to run',
  heroVignetteContext: '01 · context',
  heroVignetteBrief: 'New brief',
  heroVignetteCapture: 'Capture the work',
  heroVignetteWorkflow: '02 · workflow',
  heroVignetteRoute: 'Route & decide',
  heroVignetteTogether: 'People and AI together',
  heroVignetteRecord: '03 · record',
  heroVignetteReview: 'Review the run',
  heroVignetteReplay: 'Replayable by design',
  heroVignetteOpen: 'Open standard',
  heroVignetteInfrastructure: 'Your infrastructure',

  // The hero run ledger (SectionRenderer HeroRunLedger). Event names are wire
  // literals and stay untranslated; these are their plain-language glosses.
  heroRunName: 'run r-7f3a',
  heroRunLog: 'event log',
  heroRunStarted: 'The run begins with your inputs',
  heroRunDecided: 'The agent picks a tool to call',
  heroRunToolReturned: 'The tool answers; its output is marked untrusted',
  heroRunBudget: 'Spend is checked against the cap',
  heroRunApprovalRequested: 'The next step can’t be undone, so the run stops',
  heroRunWaiting: 'paused for a person',
  heroRunApprovalGranted: 'A person says yes',
  heroRunCompleted: 'Done, and replayable from any step',
  heroRunFooter: 'The same events, on any compliant host',

  // Default story: why the run matters (richText, markdown emphasis)
  shiftHeading: 'Software used to do exactly what it was told.',
  shiftText: 'For decades, software did what someone wrote, line by line. Agents are different: they make decisions *during the run*. So the run is now where the value gets made, where things go wrong, and where someone has to answer for the result.\n\nToday every platform builds that run its own way, and none of them agree. The work your agents do belongs to whichever vendor happens to host it.',

  // Default story: the history lesson (richText)
  historyHeading: 'We’ve seen how this goes.',
  historyText: 'Workflow standards like BPMN and BPEL agreed on how a process is *drawn*. Running it stayed proprietary, so the drawings never really traveled. Email and the web went the other way: SMTP and HTTP standardized the *conversation* between machines, and everyone could build on it.\n\nOpenWOP makes the same bet for AI work. Don’t standardize the diagram. Standardize the run.',

  // Default story: what an open run guarantees (columns, layout 'rows')
  openHeading: 'What changes when the run is open',
  openLeaveTitle: 'You can leave.',
  openLeaveText: 'Move your agents, packs, and workflows to another compliant host. Secrets are rebound on the new host, never copied across.',
  openSeeTitle: 'You can see why.',
  openSeeText: 'Every decision, tool call, and handoff is an event in one shared vocabulary, readable by any tool — not only the one that ran it.',
  openDecideTitle: 'A person decides the irreversible part.',
  openDecideText: 'Approval is part of the protocol, not a plugin. The run stops and waits wherever you say it must.',
  openBoundTitle: 'Nothing runs unbounded.',
  openBoundText: 'Loop caps and budgets are part of the contract, and untrusted tool output can’t push an approval through.',
  openReplayTitle: 'Anyone can replay it.',
  openReplayText: 'An auditor can fork any run from any point, with side effects suppressed, and see exactly what happened and why.',

  // Default story: the evidence + one honest caveat (richText). The paper link
  // is a separate paragraph so white-label installs can drop it (ADR 0196).
  proofHeading: 'One workflow. Two languages. The same run.',
  proofText: 'The OpenWOP paper reports that one workflow definition, run on a TypeScript host and on a Python host, ends in the same terminal state with the same event-log structure. The run is defined by the protocol, not by whoever hosts it.\n\nIt’s early, and you don’t have to take our word for it. Run something here, open its event log, and check.',
  proofPaperLink: 'The full method and results are in [the paper](https://doi.org/10.5281/zenodo.20576239).',

  // Default story: what you can do in this app today (columns, layout 'steps' —
  // a real sequence, so the numbering is earned)
  tryHeading: 'Try it here, today.',
  tryBuildTitle: 'Build',
  tryBuildText: 'Sketch an agent or a workflow on the visual canvas, or describe it in chat.',
  tryRunTitle: 'Run',
  tryRunText: 'Run it on the published `core.openwop.*` packs and watch every event arrive live.',
  tryDecideTitle: 'Decide',
  tryDecideText: 'When the run stops to ask, answer the approval card. It waits for you.',
  tryReplayTitle: 'Replay',
  tryReplayText: 'Open any finished run, fork it from a step, and see what would change.',

  // Default closing CTA section
  ctaHeading: 'Build a run you can take with you.',
  ctaSubheading: 'No sign-up needed. Bring your own model keys whenever you’re ready.',
  ctaLabel: 'Start building',

  // Features-page catalog search (CatalogView)
  catalogSearchLabel: 'Find a feature',
  catalogSearchPlaceholder: 'Search {{count}} features…',
  catalogSearchStatus: 'Showing {{count}} of {{total}}',
  catalogSearchClear: 'Clear search',
  catalogSearchEmpty: 'No features match “{{query}}”.',

  // ADR 0391 (a) — public blog archive + post view
  blogEyebrow: 'Writing',
  blogTitle: 'Blog',
  blogSubscribe: 'RSS feed',
  blogByline: 'By {{author}}',
  blogFilterTag: 'Tagged “{{value}}”',
  blogFilterCategory: 'Category: {{value}}',
  blogFilterAuthor: 'By {{value}}',
  blogFilterAuthorUnknown: 'By this author',
  blogClearFilter: 'Clear filter',
  blogBackToBlog: '← All posts',
  blogEmptyTitle: 'No articles have been published yet',
  blogEmptyBody: 'Start with the guide or explore the platform while this publication takes shape.',
  blogEmptyPrimaryCta: 'Read the quickstart',
  blogEmptySecondaryCta: 'Explore features',
  blogArchiveEmptyTitle: 'Nothing here yet',
  blogArchiveEmptyBody: 'No posts match this filter.',
  blogLoadErrorTitle: 'Couldn’t load the blog',
  blogLoadErrorBody: 'Something went wrong fetching posts. Please try again.',
  postNotFoundTitle: 'Post not found',
  postNotFoundBody: 'This post may have been unpublished or moved.',

  // ROUND 2 (UX_UPGRADE-site R2-G1/G2/G3) — failure honesty: a failed read is
  // not a missing page, and says so with a way to retry.
  postLoadErrorTitle: 'Couldn’t load this post',
  postLoadErrorBody: 'Something went wrong on our end — the post may well still exist.',
  pageNotFoundTitle: 'Page not found',
  pageNotFoundBody: 'This page may have been unpublished or moved.',
  pageLoadErrorTitle: 'Couldn’t load this page',
  pageLoadErrorBody: 'Something went wrong on our end. Please try again.',
  backToHome: 'Go to the home page',
  blogChromeDegraded: 'Some post details (author, date, related posts) couldn’t be loaded right now.',
  pricingWrapperDegraded: 'Part of this page couldn’t be loaded right now — plans below are current.',

  // UX_UPGRADE-site — blog filter (G1), reading time (G2), show-more (G3),
  // related/pager (G4) and copy-link share (G6)
  blogReadingTime: '{{count}} min read',
  blogSearchLabel: 'Filter posts',
  blogSearchPlaceholder: 'Filter {{count}} posts…',
  blogSearchStatus: 'Showing {{count}} of {{total}}',
  blogSearchClear: 'Clear filter',
  blogSearchEmptyTitle: 'No posts match “{{query}}”',
  blogSearchEmptyBody: 'Try a different word, or clear the filter to see everything.',
  blogSearchShowAll: 'Show all posts',
  blogShowMore: 'Show {{count}} more',
  blogShownCount: 'Showing {{count}} of {{total}} posts',
  blogPagerLabel: 'Nearby posts',
  blogOlderPost: 'Older post',
  blogNewerPost: 'Newer post',
  blogRelatedTitle: 'Related reading',
  blogMoreTitle: 'More posts',
  blogCopyLink: 'Copy link',
  blogTocTitle: 'On this page',
  blogShareLabel: 'Share this post',
  blogShareX: 'Share on X',
  blogShareLinkedIn: 'Share on LinkedIn',
  blogShareEmail: 'Email',
  blogSearchShortcutHint: 'Ctrl K',
  blogSearchShortcutHintMac: '⌘K',
  blogCopied: 'Copied',

  // ADR 0391 (b) — public pricing page (bare fallback when no CMS page authored)
  pricingTitle: 'Pricing',
  pricingEyebrow: 'Plans',
  pricingHeading: 'Plans for this deployment',
  pricingBlurb: 'Plan details are configured by this deployment’s operator. Explore what each plan includes, then open the workspace when you’re ready to start.',

  editThisPage: 'Edit this page',
  openApp: 'Open app',
} as const;
