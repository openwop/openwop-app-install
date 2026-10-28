/**
 * WF-CONS-2 — the EXPECTED SET of DSAR subject erasers.
 *
 * WHY THIS FILE EXISTS. `eraseSubject` reported `total: erasers.length` — a
 * REGISTRATION-ORDER ARTIFACT — against no expected set, and every caller's
 * success test is `failed === 0`. An eraser whose module was never imported
 * contributes to neither number, so a never-registered feature was
 * INDISTINGUISHABLE from a cleanly-erased one: the subject's data stays, and
 * the operator is told the erasure completed. That is the worst shape a
 * compliance report can take, and it had a LIVE instance —
 * `host/applyGrant.ts` registered at module scope, outside the one explicit
 * host boot list that exists to prevent exactly this, while the ADR 0464
 * coverage ledger claimed the two stores it owns were covered by it.
 *
 * THREE LAYERS, each closing a hole the others cannot see:
 *
 *  1. THIS manifest is pinned against SOURCE by
 *     `test/subject-eraser-manifest.test.ts`, which re-derives the set from
 *     every `registerSubjectEraser(` call site. Adding an eraser without
 *     adding it here fails the build — the manifest cannot drift from source.
 *  2. The same suite boots a REAL `createApp()` and asserts the LIVE registry
 *     equals this manifest. That is the layer source-scanning cannot provide:
 *     an eraser present in source but never IMPORTED fails here. No test
 *     asserted this before.
 *  3. `eraseSubject` returns `missing` at RUNTIME and COUNTS it in `failed`,
 *     so a gap that somehow reaches production is a typed failure on the DSAR
 *     itself rather than a silent success.
 *
 * RE-DERIVE, never hand-edit blind. The command lives in
 * `test/subject-eraser-manifest.test.ts`, which RUNS the same derivation as an
 * assertion (a command in prose is a command nobody runs; the source-pin test
 * is the executable form of it).
 * MEASURED 2026-08-19: 76 distinct ids at first derivation, over 77 call sites —
 * the count of SITES is not the count of IDS, and this keys on ids.
 *
 * THE LEDGER. Every change to the set below is one EDGE with its own reason.
 * A bare count bump is not a justification, and neither is "the gate went red".
 *
 *  76 -> 78 (2026-08-19, on rebase onto `origin/main` 6f938ab63):
 *    + `eraseNotificationSubject` — arrived with the Comments batch (#3383),
 *      installed from `features/notifications/feature.ts` via
 *      `installNotificationSubjectEraser()`. NOT a store this batch touched;
 *      the manifest gate is what surfaced it, which is the gate doing its job
 *      on a peer's merge rather than on my own diff.
 *    + `eraseCdpCollectedEvents` — added by CONS-6 in this batch. The raw
 *      first-party ingest store that self-declares its PII at ingest and had
 *      no eraser at all.
 *
 *  78 -> 79 (2026-08-19, CONS-16):
 *    + `eraseIntentLedgerSubject` — the intent-ledger store carried a written
 *      exemption saying its rows "carry no subject key". True of the KEY, false
 *      of the ROW: `approvedBy` is a `User.userId`. The eraser redacts that
 *      attribution; the `goal` free-text residual is stated in source rather
 *      than closed, with the ordering hazard that blocks the obvious cascade.
 *
 *  79 -> 80 (2026-08-24, ADR 0605 R2 / `KSC-21`):
 *    + `eraseKnowledgeSyncSubject` — ADR 0605 Tier 3 added `SyncSource.createdBy`
 *      as the confused-deputy guard, which made `knowledge-sync:source` an
 *      ACTOR-ATTRIBUTED store the ADR 0464 feature ratchet could see for the first
 *      time, with nothing erasing it. This edge is a store getting COVERED, not a
 *      ledger growing: the alternative on the table was an `ACTOR_ATTRIBUTED_DEBT`
 *      line, and `ACTOR_DEBT_CEILING` correctly refused it — a batch may not raise
 *      the ceiling to pay for a field it introduced in the same batch. The eraser
 *      DISABLES (pause + tombstone `createdBy`) rather than deleting, because this
 *      feature deletes KB documents and because deleting the field would re-open
 *      the very deputy hole it guards; argued in full at the registration site.
 *
 *  85 -> 86 (2026-08-27, SCC-1 / ordinal 207 scheduled-agent-chats):
 *    + `eraseScheduledChatsSubject` — `schedchat:config` carries a `createdBy`
 *      actor and was a tracked `ACTOR_ATTRIBUTED_DEBT` line; the feature never
 *      registered an eraser, so a subject's scheduled chats were orphaned on
 *      erasure. This edge COVERS the store (debt shrinks 22 -> 21), it does not
 *      grow the ledger. The eraser DISABLES (pause the schedule + its
 *      `schedchat-*` job) and tombstones `createdBy` rather than deleting, per the
 *      recorded "erasure disables, it runs on the person's behalf" decision. The
 *      agent-tool `followup:`/`recurring:` jobs carry `ownerSubject:{user}` and
 *      are already covered by the host `eraseSubjectSchedules`; this owns only the
 *      config-created job. (The intervening 80 -> 85 edges predate this change and
 *      were not recorded in this ledger; 86 is the measured live count.)
 *
 *  86 -> 87 (2026-08-29, PROPC-ERASURE-DSAR):
 *    + `eraseSubjectProposals` — the reviewable-learning proposals store
 *      (`features/proposals`) keyed `owner.principal` to the accepting
 *      `user.userId` (the ambient-work-graph `accept` route,
 *      `ambient-work-graph/routes.ts:82`) with NO subject eraser at all.
 *      PROPC-ERASURE-TEARDOWN (the `tenantOf` 4th arg) already covered
 *      whole-tenant deletion, but a single member's DSAR left their
 *      `owner.principal` on every proposal they had accepted. The eraser REDACTS
 *      `owner.principal` -> `erased:subject` and KEEPS the row (a proposal is org
 *      work-content an `apply` can install, the `assistant:commitment`
 *      redact-owner-keep-row precedent); the keyFn uses `owner.tenant`+`id`, not
 *      `principal`, so the row never moves.
 *
 * The same rebase also REPLACED this batch's own fix at
 * `features/sales-commissions/feature.ts`: I had made the eraser an inline
 * named function expression, which `registerSubjectEraser`'s
 * reference-dedupe cannot deduplicate (a new object per `registerRoutes`
 * call, so repeat boots register duplicates). The upstream version — a
 * MODULE-LEVEL named reference — is correct and was kept over mine.
 *
 * An id is `fn.name` — the same string `eraseSubject` already reports in
 * `failedFeatures`, so the operator-facing label and the manifest key are ONE
 * name that cannot disagree. `registerSubjectEraser` throws on an anonymous
 * function for that reason.
 *
 *  87 -> 88 (2026-09-01, RFC 0159 / ADR 0613):
 *    + `eraseSubjectLinkDeny` — the SCIM⟷SAML subject-link deny store
 *      (`auth:subjectLinkDeny`, `host/auth/subjectLinkService.ts`) is keyed on the
 *      opaque `externalId` (== persistent SAML NameID). Its row IS a subject
 *      identifier, so the new store landed with a registered eraser rather than a
 *      debt entry — the row is DELETED (fail-safe: it only ever denied).
 *
 *  88 -> 89 (2026-09-02, ADR 0622 D6 / `ORGINV-8`):
 *    + `eraseOrgInvitationsSubject` — `orgs:invite` held the recipient EMAIL in
 *      plaintext with no eraser (a `RECORDED_DEBT` line since the CRM-2 email
 *      widening). The eraser handles BOTH keys the row carries: the recipient
 *      (email key → row deleted, index first) and the inviter (`createdBy` key →
 *      `createdByName` scrubbed, `createdBy` tombstoned; the invite stays live —
 *      it is the org's pending door, not the inviter's data). Reachability is
 *      the other half of the edge: the users feature now registers a
 *      userId → email `SubjectKeyResolver`, so the users erase route (a userId
 *      key) reaches this email-keyed store too. Reach, stated precisely (review
 *      S3): `resolveSubjectKeys` (`subjectErasure.ts`) is SINGLE-HOP — each
 *      resolver expands the ORIGINAL key only, and the expanded keys are not
 *      fed back through the resolvers. So a by-userId erase now additionally
 *      reaches the erasers that key DIRECTLY on the email: pending invitations
 *      to that address (this eraser) and analytics events keyed by the email.
 *      It does NOT reach CRM contacts — `crm/erasure.ts` keys on `contactId`
 *      (the CRM identity-link resolver maps email → contactId, but that hop
 *      would need the email fed back in, a 2-hop fixpoint this host does not
 *      run and ADR 0622 D6 deliberately does not add). Recorded in ADR 0622 D6.
 *
 *  89 -> 90 (2026-09-11, ADR 0657 D1 / `CNWF-1`, `CNWF-2`):
 *    + `consentSubjectEraser` — the consent feature registered NO eraser: the DSAR
 *      orchestrator tombstoned + deleted the REQUESTED key only, so every
 *      ADR 0381-resolved key's `consent:record` (the raw key, `marketing:true`)
 *      survived untombstoned, and the users erase door (`DELETE /users/:id` →
 *      `eraseSubject` directly) never touched consent at all. The eraser lands the
 *      same pair on every key the fan-out visits; `rowsTouched` counts records
 *      only. The ADR 0464 `REVIEWED_EXEMPT['consent:record']` row (whose
 *      "cannot also be an eraser without recursing" claim was false) moved to
 *      `EXPECTED_COVERED`. The 2-hop closure the entry above says this host does
 *      not run now runs (ADR 0657 D12 / CONS-11, bounded to two hops).
 *
 *  +1 (2026-09-29, ADR 0780 D4 / `CONNWF-4`):
 *    + `eraseSubjectConnections` — `connections:connection` sat in RECORDED_DEBT as
 *      "needs a decision" (delete vs re-attribute, for fear of breaking a shared
 *      integration). That fear applies to org/workspace rows, which carry no
 *      `userId`; a USER-scoped row is only ever selected for its owner, so the
 *      eraser revokes those (and the subject's in-flight grants) in the tenant
 *      the DSAR names. Rows in OTHER shared workspaces are not reached (`CONNWF-16`).
 */
/*
 *  +1 (2026-10-06, ADR 0834 D6):
 *    + `eraseConversationToolApprovalsSubject` — `conversation-tools:approval` names
 *      the approver (`resolvedBy`) and now stores a held call's arguments while it is
 *      pending. The approver is redacted; arguments are cleared on decision and the
 *      rows go with a deleted conversation (a conversation id is not a subject key —
 *      the intent ledger's stated residual applies to a still-pending row).
 */
/*
 *  +1 (2026-10-12, ADR 0879 D6 / S6):
 *    + `eraseSubjectChatPosts` — `chat_messages.author_subject` + `content`. The
 *      conversation eraser anonymized metas only, so an erased member's channel and
 *      DM posts (their words AND their id) survived. The rows are kept (other
 *      people's thread order and counts) as ADR 0195 tombstones with the author
 *      redacted, in one tenant-scoped storage write.
 */
/*
 *  +1 (2026-10-13, ADR 0882 D4):
 *    + `eraseCrmTaskAssignees` — `crm:task.assignee`. CSM plays now write member
 *      subjects there, and no eraser reached the field (the contact-centric CRM
 *      eraser never looked at tasks). The task is kept; the assignee is cleared.
 */
/*
 *  +1 (2026-10-14, ADR 0891 D8):
 *    + `eraseBrandSubject` — `brand:brand` sat on the ADR 0464 actor-attribution
 *      ledger ("re-attribution needs the brand owner"). Brands are org config and
 *      are kept; `createdBy` and the audit `actor` are tombstoned, the person leaves
 *      `allowedEditors` (row and audit diffs), and a font's `attestedBy` is
 *      tombstoned. A `user:` key also reaches the `host:site` app-brand audit.
 */
/*
 *  +1 (2026-10-15, ADR 0893 M5, feature loop row 47):
 *    + `eraseSubjectVoiceSessions` — `voice:session` walkie rows now name their
 *      opener (`subject`) so every walkie route answers only that caller. A session
 *      that is never ended keeps its row, so the eraser deletes the subject's rows
 *      outright (they hold no conversation content, only the binding).
 */
/*
 *  +1 (2026-10-15, ADR 0894 D9, feature loop row 48):
 *    + `eraseComputerUseSubject` — `computer-use:session` was recorded debt in
 *      `subject-erasure-feature-stores`. Rows are kept as the audit of what a
 *      browser agent did; the opener and the apply subject are tombstoned and
 *      every free-text field (task, summaries, descriptions, errors) is dropped.
 */
/*
 *  +1 (2026-10-18, ADR 0930 D5/A1, feature loop row 52):
 *    + `eraseAmbientWorkGraphSubject` — `ambient-work-graph:suggestions` holds a
 *      person's behavioural profile (their repeated tool sequences, goal text and run
 *      ids) and had no eraser. The rows are deleted, not redacted (the profile is the
 *      person's, not org content), and an `erased` suppression row is written FIRST:
 *      run records are exempt from erasure, so without it the next sweep would mine
 *      the same runs back into the same rows.
 */
/*
 *  +1 (2026-10-18, ADR 0921/0922 P0):
 *    + `eraseCampaignOpsSubject` — `campaign-ops:client` and `campaign-ops:asset`
 *      record `createdBy`. The rows are the agency's per-client configuration and
 *      are kept; `createdBy` is tombstoned.
 */
/*
 *  +1 (2026-10-20, ADR 0953 P0):
 *    + `eraseSocialPublishingSubject` — `social:post` records `createdBy` and
 *      `approval.decidedBy`. A post is the client's content and is kept; both
 *      people are tombstoned.

 *  +1 (2026-10-20, ADR 0942 P0):
 *    + `eraseAutonomyPolicySubject` — `autonomy:policy` (`createdBy`) and
 *      `autonomy:binding` (`updatedBy`). The rows are the org's campaign
 *      autonomy configuration and are kept; the actor is tombstoned.
 *  +1 (2026-10-20, ADR 0949 P4):
 *    + `eraseExperimentFirstExposures` — `experiments:first-exposure` rows are
 *      keyed by a hash of the experiment salt and a unit key, and a unit key is a
 *      subject key (session key, contact id). The row is recomputed and deleted.

 *  +1 (2026-10-20, ADR 0952 D2 / P1):
 *    + `eraseCampaignIntelSubject` — `campaign-intel:spend-cap` records `createdBy`.
 *      A cap is the client's spend configuration and is kept; `createdBy` is
 *      tombstoned.
 *  Expanded (ADR 0956 P0/P1):
 *    + `eraseCampaignIntelSubject` — `campaign-intel:utm-policy.updatedBy` and
 *      `campaign-intel:utm-alias.createdBy`. The rows are a client org's UTM
 *      configuration and are kept; the editor is tombstoned.
 *    ADR 0956 P1 widens the same eraser to `campaign-intel:attribution-settings.updatedBy`.
 *    Touch paths add NO eraser: they are computed from analytics events at read
 *    time, so `eraseSubjectAnalytics` (already listed) is their eraser.
 *  +1 (2026-10-20, ADR 0959 P0):
 *    + `eraseCampaignPlaybooksSubject` — playbook drafts (`updatedBy`), versions
 *      (`publishedBy`) and installations (`installedBy`, history `by`). The rows are the
 *      agency's method and per-client configuration and are kept; the person is tombstoned.
 *  +1 (2026-10-20, ADR 0946 P0):
 *    + `eraseCampaignVariantSetSubject` — `campaign-orchestration:variantset`
 *      version rows record `createdBy`. The rows are the org's creative record
 *      (reviews and experiments bind to their hash) and are kept; `createdBy`
 *      is tombstoned, which does not move the hash. The same eraser tombstones
 *      `campaign-orchestration:campaign.createdBy`, which leaves the ADR 0464
 *      actor-attribution debt ledger (the campaign is kept).
 *  +1 (2026-10-20, ADR 0951 P0):
 *    + `eraseSubjectReplays` — `analytics:replay` index rows name a visitor's
 *      consented subject and session key, and each row points at masked blob
 *      chunks of their visit. Both are deleted (blobs first). The same eraser runs
 *      when the visitor withdraws `analytics.replay`.
 *  +1 (2026-10-20, ADR 0958 P0):
 *    + `eraseExternalCollaboratorSubject` — `extcollab:c` holds a collaborator's
 *      email and name, bound to a canonical userId at accept. A person erased in
 *      their HOME tenant loses every binding in every agency (read through the
 *      cross-agency `extcollab:bound` index): the collaborator row is deleted and
 *      its grants revoked. ADR 0958 P5 (2026-10-27) widens the SAME eraser (no
 *      new id): the agency's own records for an email are erased too, and both
 *      paths run the registered collaborator erase hooks first (campaign-ops:
 *      intake rows redacted or deleted, invite link purged).
 *  +1 (2026-10-26, ADR 0986 D6):
 *    + `eraseArenaRaterSubject` — `evals:arena-match.raterSubject` names the
 *      member who cast a verdict, and had no eraser. It is tombstoned to
 *      `erased`; the verdict (workspace data about two models) is kept.
 *  +1 (2026-10-26, ADR 0464 correction DSAR-DBL):
 *    + `eraseManualTestRunsSubject` — `manual-tests:run` holds a tester's verdicts
 *      and free-text notes under their subjectRef and had no eraser; the row is
 *      deleted.
 */
export const EXPECTED_SUBJECT_ERASERS: ReadonlySet<string> = new Set([
  'eraseExperimentFirstExposures',
  'commentsEraser',
  'consentSubjectEraser',
  'emailEraser',
  'eraseAgentDraftStashForSubject',
  'eraseAmbientWorkGraphSubject',
  'eraseApprovalDelegations',
  'eraseApprovalHandoffSubject',
  'eraseApprovals',
  'eraseAutonomyPolicySubject',
  'eraseAssistantSubject',
  'eraseBuilderPairSubject',
  'eraseBrandSubject',
  'eraseCalendarMcpForSubject',
  'eraseCampaignOpsSubject',
  'eraseSocialPublishingSubject', // ADR 0953 P0

  'eraseCampaignIntelSubject', // ADR 0952 D2
  'eraseCampaignPlaybooksSubject',
  'eraseCdpCollectedEvents',
  'eraseCampaignVariantSetSubject',
  'eraseClaudeCodeSubjectKey',
  'eraseDeveloperKeysForSubject',
  'eraseExternalCollaboratorSubject',
  'eraseCmsSubject',
  'eraseCommerce',
  'eraseCommerceConnectSubject',
  'eraseCommunitySubject',
  'eraseCompensation',
  'eraseCampaignConversions', // ADR 0907 D8 (placed here, out of order, to stay clear of a neighbour's line)
  'eraseComputerUseSubject',
  'eraseConversationToolApprovalsSubject',
  'eraseCreatorSubject',
  'eraseCrmSubject',
  'eraseLeadIntelSubject', // ADR0954 P4: frozen qualification text and visitor submissions on closed CRM primaries
  'eraseCrmTaskAssignees',
  'eraseCsmSubject',
  'eraseDashboard',
  'eraseDocumentSubject',
  'eraseEngagementSubject',
  'eraseEntitiesSubject',
  'eraseEnvironmentsSubject',
  'eraseExtractionGrants',
  'eraseFormsSubject',
  // ADR 0908 D7 — a person's standing goals.
  'eraseGoalsForSubject',
  'eraseIntegrationsSubject',
  'eraseIntentLedgerSubject',
  'eraseKbSubject',
  'eraseKnowledgeSyncSubject',
  'eraseMediaSubject',
  'eraseMarketplaceSubject',
  'eraseNavigationSettingsSubject',
  'eraseNotificationSubject',
  'eraseOrgInvitationsSubject',
  'eraseProfileKnowledge',
  'erasePromotions',
  'eraseReviewDecisions',
  'eraseSalesCommissionsSubject',
  'eraseTopicOptOuts', // ADR 0905 D7 — consent topic opt-outs
  'eraseClientChannelGrants', // ADR 0955 Q7 — per-client SMS consent grants
  'eraseScheduledChatsSubject',
  'eraseSharingSubject',
  'eraseSubjectAccessControl',
  // ADR 0910 — `workspace-operator-activation` (host/operatorAccess.ts).
  'eraseSubjectOperatorActivations',
  'eraseSubjectAgentTwinLinks',
  'eraseSubjectAnalytics',
  'eraseSubjectReplays', // ADR 0951 D4 — session recordings (blob chunks + index rows)
  'eraseSubjectAnswers',
  'eraseSubjectApplyGrants',
  'eraseSubjectAttestations',
  'eraseSubjectConnections',
  'eraseSubjectCampaignDays',
  'eraseSubjectCanvas',
  'eraseSubjectChatPosts',
  'eraseSubjectConversations',
  'eraseSubjectDealers',
  'eraseSubjectDebugPins',
  'eraseSubjectDrafts',
  'eraseSubjectEmailPrefs',
  'eraseSubjectEvalRows',
  'eraseSubjectEvalSuites',      // ADR 0889 — agent eval suites (createdBy)
  'eraseSubjectToolBoundary',    // ADR 0889 D9 — captured tool-boundary rows
  'eraseSubjectFeedback',
  'eraseSubjectFollowUps',
  'eraseSubjectKanban',
  'eraseSubjectKnowledge',
  'eraseSubjectLinkDeny',
  // ADR 0693 §4 — the per-subject managed free-tier buckets. Registered the
  // moment metering became per-subject: before that these rows keyed a TENANT
  // and were operator accounting, not personal data.
  'eraseSubjectManagedUsage',
  'eraseSubjectMemory',
  'eraseSubjectParked',
  'eraseSubjectPendingPushes',
  'eraseSubjectPriorityMatrix',
  'eraseSubjectProjects',
  'eraseSubjectPromptEntries',   // ADR 0993 D6 — prompt library (private entries deleted, attribution anonymized)
  'eraseSubjectProposalPolicies',
  'eraseSubjectProposals',
  'eraseSubjectReactions',
  'eraseSubjectReadState',
  'eraseSubjectRunnerDispatches',
  'eraseSubjectSchedules',
  'eraseSubjectSteering',
  'eraseSubjectStrategy',
  'eraseSubjectTerritories',
  'eraseSubjectTickets',
  'eraseSubjectTwinGrants',
  'eraseSubjectUcpPurchases',
  'eraseSubjectWorkflowBudgets',
  // ADR 0684 §7 — the auto-join ledger (workspaceJoinLedger). Subject-keyed, so a
  // DSAR must reach it; see subject-erasure-coverage.test.ts for why erasure wins
  // over §7's durability and why that does not weaken the ban control.
  'eraseSubjectWorkspaceJoins',
  'eraseSubjectWorkflowRevisions',
  'eraseSuggestionSubject',
  'eraseSyncBindingSubject',
  'eraseTeamLedgerSubject',
  'eraseTeamsDelivery',
  'eraseTutorialProgressForSubject',
  'eraseWalkthroughProgressForSubject',
  'eraseWearableLinksForSubject',
  'eraseWearableLivenessForSubject',
  'eraseWhatsAppSubject',
  // ADR 0888 D1 — a person's opt-in to one workspace's profile directory.
  'eraseWorkspaceShare',
  'identityLinkEraser',
  'kicktodoAccountabilityEraser',
  'kicktodoCommerceEraser',
  'kicktodoCoreEraser',
  'profileEraser',
  'userEraser',
  'eraseSubjectVoiceSessions',
  // ADR 0986 D6 — the arena verdict's rater.
  'eraseArenaRaterSubject',
  // ADR 0464 correction 2026-10-26 (DSAR-DBL) — a manual-test run's verdicts + notes.
  'eraseManualTestRunsSubject',
]);
