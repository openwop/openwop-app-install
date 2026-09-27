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
 */
export const EXPECTED_SUBJECT_ERASERS: ReadonlySet<string> = new Set([
  'commentsEraser',
  'consentSubjectEraser',
  'emailEraser',
  'eraseAgentDraftStashForSubject',
  'eraseApprovalDelegations',
  'eraseApprovals',
  'eraseAssistantSubject',
  'eraseCalendarMcpForSubject',
  'eraseCdpCollectedEvents',
  'eraseCmsSubject',
  'eraseCommerce',
  'eraseCommerceConnectSubject',
  'eraseCommunitySubject',
  'eraseCompensation',
  'eraseCreatorSubject',
  'eraseCrmSubject',
  'eraseCsmSubject',
  'eraseDashboard',
  'eraseDocumentSubject',
  'eraseEngagementSubject',
  'eraseEntitiesSubject',
  'eraseEnvironmentsSubject',
  'eraseExtractionGrants',
  'eraseFormsSubject',
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
  'eraseScheduledChatsSubject',
  'eraseSharingSubject',
  'eraseSubjectAccessControl',
  'eraseSubjectAgentTwinLinks',
  'eraseSubjectAnalytics',
  'eraseSubjectAnswers',
  'eraseSubjectApplyGrants',
  'eraseSubjectAttestations',
  'eraseSubjectCampaignDays',
  'eraseSubjectCanvas',
  'eraseSubjectConversations',
  'eraseSubjectDealers',
  'eraseSubjectDebugPins',
  'eraseSubjectDrafts',
  'eraseSubjectEmailPrefs',
  'eraseSubjectEvalRows',
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
  'eraseSyncBindingSubject',
  'eraseTeamsDelivery',
  'eraseTutorialProgressForSubject',
  'eraseWalkthroughProgressForSubject',
  'eraseWearableLinksForSubject',
  'eraseWearableLivenessForSubject',
  'eraseWhatsAppSubject',
  'identityLinkEraser',
  'kicktodoAccountabilityEraser',
  'kicktodoCommerceEraser',
  'kicktodoCoreEraser',
  'profileEraser',
  'userEraser',
]);
