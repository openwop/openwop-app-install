/**
 * ADR 0464 — the subject-erasure COVERAGE tripwire (ADR 0448 precedent).
 *
 * A structural cure for a recorded defect CLASS: host-owned durable stores that
 * record a subject identifier OUTSIDE the subject-erasure seam. Two incidents in
 * two days (canvas `capturedBy` snapshots; approval-payload free text) proved the
 * class; this test makes a new subject-bearing HOST store fail the build the day
 * it is written, instead of being found by an adversarial audit after shipping.
 *
 * The denominator is FIXED and derived from source: every `new DurableCollection`
 * namespace declared in `src/host/**`, EXCLUDING the `demo*Seed.ts` seeders (which
 * only RE-OPEN feature-owned namespaces — the owning declaration is under
 * `src/features/`, and the feature owns erasure; ADR 0464 §3 audit verified each).
 * Parametric factories (`obligationLedger.ts`'s `config.ns`, `durableQueue.ts`'s
 * `` `queue:${name}` ``) pass no string literal, so they are not host-literals here;
 * money-truth obligation ledgers are reasoned separately in ADR 0464 §4.
 *
 * Every enumerated namespace MUST land in EXACTLY ONE registry below:
 *  - ERASED        — fully claimed by a registered host `SubjectEraser`/redactor.
 *                    EMPTY today (see the note on the map): the only existing host
 *                    redaction is the kind-local `kicktodo-plan-proposal` path in
 *                    approvalService, which does NOT graduate the `approval`
 *                    namespace out of debt. The integrator MOVES a namespace here
 *                    once a peer lands + REPORTS a store-level eraser (ADR 0464 §6).
 *  - RECORDED_DEBT — shrink-only: audited subject-bearing stores with no eraser yet.
 *                    A new entry is a promise to cover, never a parking spot.
 *  - REVIEWED_EXEMPT — a lawful-retention / technical / no-subject-data justification
 *                    (each carries its reason string). ADR 0464 §2.1: "there is no
 *                    third state" — debt is the acknowledged TRANSITIONAL state.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOST_ROOT = join(__dirname, '..', 'src', 'host');

// ── The three registries ────────────────────────────────────────────────────

/** Fully covered by a registered host eraser/redactor — every entry cites the
 *  eraser that covers it. All 17 registrations are wired through the ONE explicit
 *  boot list `registerHostSubjectErasers()` (src/host/hostSubjectErasers.ts). */
const ERASED = new Map<string, string>([
  ['workspace-join:record', 'eraseSubjectWorkspaceJoins — the record is DELETED (workspaceJoinLedger, ADR 0684 §7). It is subject-keyed and says where a person has been, so a DSAR must reach it. That CONFLICTS with §7, which wants the record durable so a removed participant is never silently re-joined: erasing it lets a removed user be auto-joined again on next sign-in. Erasure still wins, because membership removal is NOT the ban control — `authRoutes.ts` refuses a non-active ACCOUNT with a 403 before auto-join runs, and no data-subject right reaches that. §7 protects the ordinary case (an operator tidying a roster); a genuine ban is enforced one layer up. An operator who bans by removing membership alone has always had a weaker control than they thought, which is worth stating rather than hiding behind an exemption.'],
  ['job-search:apply-grant', 'eraseSubjectApplyGrants — the grant is DELETED, not redacted (ADR 0541): it is standing authority to act on a named person\'s behalf, and a tombstone that still authorises anything is worse than useless. Matches on subjectId AND grantedBy, since the authoriser is also a person who must not be left named on a live authority record.'],
  ['job-search:submission-claim', 'eraseSubjectApplyGrants — DELETED. A claim exists only to stop a duplicate application for a subject; once that subject is erased here it has nothing left to protect.'],
  ['approval', 'store-level eraser walks pending+resolved rows applying the ADR 0464 §2.3 per-kind redactor registry (approvalService.eraseApprovalSubject); kicktodo-plan-proposal migrated onto it'],
  ['compensation:obligation', 'eraseCompensationSubject — the free-text `reason` is REDACTED, the row is KEPT (compensationLedger). Deleting it would erase the audit fact RFC 0151 §E requires, and worse: removing an UNRESOLVED obligation makes compensationStatusForRun report `completed` for a run whose unwind never finished. `reason` is the only subject-bearing field — the rest are ids, one-way digests, ordinals and enums. Tenant-scoped, since an obligation belongs to a run and a run belongs to a tenant, not to a user.'],
  ['approval:delegation', 'eraseDelegationsForSubject — fromSubject/toSubject/createdBy/reason redacted (approvalDelegations)'],
  ['approval:teams-delivery', 'eraseTeamsDeliveryForSubject — userId/chatId delivery rows deleted (teamsApprovalDelivery)'],
  ['review:decision', 'eraseReviewDecisionsForSubject — reviewerRef/actedBy/reason redacted; tenantId added to rows (frozen keyRef documented) so the eraser can reach them (reviewDecisionLedger)'],
  // ADR 0666 D2 — this value said only "subject-authored notes DELETED for the subject", which
  // became incomplete the moment erasure started purging the recall NAMESPACE: dispatch
  // turn-summaries live in the same namespace and are NOT subject-authored notes, and they were
  // previously unreachable (their ids come from no durable row). Updated deliberately — this
  // file's own TWIN-DEBT-1 note records that these values are never asserted against source and
  // that one of them once described the wrong disposal, so leaving it stale would be that exact
  // defect committed knowingly.
  ['subject-memory:note', 'subject-authored notes DELETED for the subject, AND the whole vector recall namespace purged for every key form — including dispatch turn-summaries, which carry no durable note row and so were never reachable by id (subjectMemory eraser + purgeNamespaceVectors, ADR 0666 D2)'],
  ['kanban:card', 'createdBy/assigneeId/description/blockerNote redacted via board-scoped walk (kanbanService eraser)'],
  ['kanban:board', 'ownerUserId/ownerSubject redacted (kanbanService eraser)'],
  ['scheduler:job', 'ownerUserId/ownerSubject anonymized + job disabled (enabled:false) so an ownerless job cannot keep firing (schedulingService eraser)'],
  ['canvas', 'ownerSubject anonymized (canvasSurface eraser)'],
  ['canvas:version', 'capturedBy → [erased] across all snapshots (ADR 0464 §1 incident 1; canvasSurface eraser)'],
  ['chat:conversation', 'ownerUserId/ownerSubject/participants redacted (conversationStore eraser)'],
  ['chat:message-feedback', 'subjectRef + reason rows deleted (messageFeedbackStore eraser)'],
  ['chat:read-state', 'subjectRef read markers deleted (conversationReadState eraser)'],
  ['chat:message-reactions', 'subjectRef reaction rows deleted (messageReactionsStore eraser)'],
  // ADR 0592 §8 — CLASSIFICATION MOVE (disclosed): this row lived in
  // REVIEWED_EXEMPT as "no-subject: locale config; updatedBy is operator
  // attribution" — but operator attribution IS a subject identifier (the
  // CMSL-4 finding), so the exemption reasoning was wrong, not the store
  // shape. The cms feature's eraser now anonymizes `updatedBy`
  // (eraseContentLanguageSettingsSubject, invoked from eraseCmsSubject —
  // feature-registered, not a host eraser; the store is host-DECLARED for the
  // cms/entities parity seam but cms-owned for lifecycle).
  ['cms:langsettings', 'eraseCmsSubject → eraseContentLanguageSettingsSubject — updatedBy anonymized in place; the locale config itself is org data and is kept'],
  ['access-members', 'email/displayName redacted in place; opaque subject key + role retained for org integrity (accessControlService eraser)'],
  ['access-orgs', 'createdBy anonymized (accessControlService eraser)'],
  // TWIN-DEBT-1 — this row said "grantedByUserId anonymized"; the eraser
  // DELETES the row (`twinService.eraseSubjectTwinGrants` → `grants.delete`).
  // The map's values are never asserted against source (`:283` checks only key
  // presence), so the string was unpoliced prose in the file an auditor reads to
  // decide whether a store is covered — and it described the wrong disposal.
  ['twin-grant', 'grant rows DELETED outright — a twin grant is the subject\'s OWN consent record and carries no one else\'s personal data (twinService eraser); agent-profile twin.userId/linkedBy covered by agentProfileService eraser'],
  ['subject-knowledge', 'subject-scoped binding rows deleted (subjectKnowledge eraser)'],
  ['workflow-proposal-autoapprove', 'createdBy-owned auto-approve policies DELETED on erasure (the pair reverts to manual — fail-safe; workflowProposalPolicy eraser, ADR 0473 store)'],
  ['runner-dispatch-result', 'subject-owned dispatch dedup rows DELETED via subject-scoped walk — the store has no tenant dimension (RFC 0122 wire carries none); deletes only the erased subject\'s own residue (selfHostedRunner eraser)'],
  ['workflow:revision', 'createdBy → [erased] across the tenant\'s revision rows; the definition content is tenant work-product so redaction, not deletion, preserves history (workflowRevisions eraser, ADR 0474 store)'],
  ['workflow:debug-pin', 'subject-created pins DELETED — the pinned OUTPUT may itself quote the subject, so createdBy-only redaction would under-erase; pins are disposable debug state (workflowDebugPins eraser, ADR 0475 store)'],
  ['workflow:eval-set', 'createdBy → [erased] AND fixture payloads (cases[].pins/inputs — run-output content users paste) deep-scrubbed of subject-key forms (grade-data H3); suite STRUCTURE is tenant work-product (workflowEvalSets eraser, ADR 0477 store)'],
  ['workflow:eval-result', 'startedBy → [erased] AND assertion details (run-output excerpts) deep-scrubbed of subject-key forms (grade-data H3); result rows are tenant test-history (workflowEvalSets eraser, ADR 0477 store)'],
  ['notify:email-approval-pref', 'rows DELETED — the pref row IS the subject\'s email address (emailApprovalDelivery eraser, ADR 0478 store)'],
  ['workflow:budget', 'updatedBy → [erased] across the tenant\'s budget rows; the budget itself is tenant config (workflowBudgets eraser, ADR 0482 store — the workflow:revision createdBy precedent)'],
  ['auth:subjectLinkDeny', 'rows DELETED — the deny row IS the subject: its key is the opaque externalId (== persistent SAML NameID, RFC 0159). A lingering row is fail-safe (only ever denies, never grants) but is still a subject identifier, so it is removed. Matched via subjectKeyForms + a saml:/scim: prefix strip so a bare-externalId or principal-scoped DSAR key both reach it (subjectLinkService eraser, ADR 0613 store)'],
]);

/** Shrink-only. Audited subject-bearing host stores awaiting a `SubjectEraser`.
 *  EMPTY as of ADR 0464 Phase 2 — every audited GAP store now has a registered
 *  eraser (see ERASED) or a reviewed exemption. New debt may only be added with
 *  an ADR-recorded justification, and the count can only shrink back to zero. */
const RECORDED_DEBT = new Map<string, string>([]);

type Exemption = { reason: string; tenantTeardownClaim?: true };

/** Reviewed & cleared. A store either records NO subject data, or its subject
 *  attribution is retained under a lawful/technical justification. `tenantTeardownClaim`
 *  marks a coverage story that leans on the ADR 0284 tenant-teardown purge — which the
 *  HONESTY assertion below requires an actual `tenantId` field to back (a purge keyed by
 *  tenantId can never reach a row that has none). */
const REVIEWED_EXEMPT = new Map<string, Exemption>([
  // Named exemptions (ADR 0464 §4 rulings + the lead's audit).
  ['workflow:eval-online', { reason: 'ADR 0480 online-eval daily buckets — aggregate counts + OPAQUE run references (runId + failed assertion KINDS only; no output, no detail strings, no subject identifiers); purged on ADR 0284 tenant teardown', tenantTeardownClaim: true }],
  ['workflow:eval-online-judgecap', { reason: 'ADR 0480 per-tenant-day judge spend counter — a single integer per (tenant, day); no subject data; purged on ADR 0284 tenant teardown', tenantTeardownClaim: true }],
  ['workflow:spend-day', { reason: 'ADR 0482 per-(tenant, workflow, day) spend counter — counts + alert flags only, no subject content; purged on ADR 0284 tenant teardown', tenantTeardownClaim: true }],
  // ADR 0738 P2 — core Kanban's executable projection stores only tenant-scoped
  // work identity, opaque source/workflow references, state and delivery facts.
  // It has no subject/actor/assignee field; person-authored card fields remain
  // in the existing `kanban:card` owner and are redacted by eraseSubjectKanban.
  // The opaque workflow input never crosses the board-read boundary and is
  // governed by its source/workflow lifecycle rather than a second Kanban copy.
  ['kanban:work-item', { reason: 'ADR 0738 core WorkItem aggregate — tenant-scoped scope/source/workflow references, dependency ids and execution state; no subject/actor/assignee identifier. Person-authored presentation remains on kanban:card (covered by eraseSubjectKanban); opaque workflow input is never projected and follows its source/workflow lifecycle.', tenantTeardownClaim: true }],
  ['kanban:work-item-audit', { reason: 'ADR 0738 content-minimal WorkItem audit — tenant/board/work ids, closed event type, timestamp and bounded operational metadata; no subject identifier. Purged with the WorkItem on board/card deletion and on tenant teardown.', tenantTeardownClaim: true }],
  ['kanban:work-item-outbox', { reason: 'ADR 0738 durable WorkItem delivery intent — tenant/board/work ids, closed queue state, lease and retry timestamps only; no subject identifier. Purged with the WorkItem on board/card deletion and on tenant teardown.', tenantTeardownClaim: true }],
  ['kanban:work-item-run', { reason: 'ADR 0738 point index between a normal workflow run and a tenant WorkItem; run/work ids only, no subject identifier. Purged with the WorkItem and reaches tenant teardown through its denormalized tenantId.', tenantTeardownClaim: true }],
  ['kanban:operation-receipt', { reason: 'ADR 0738 durable idempotency receipt — tenant/operation plus hashes and a canonical operational result only; no plaintext idempotency key or subject identifier. Purged explicitly by purgeTenantKanban and bounded by 14-day retention.', tenantTeardownClaim: true }],
  // ADR 0485 (#2499) shipped this store without a classification, which failed
  // this gate on main. It is a single host-global row — `{ id: 'seed'; version }`
  // — recording which seed version of the comparison page has been ensured at
  // boot. No subject field, no tenant scope, no user content.
  ['brand:asset-slot', { reason: 'ADR 0511 host-global brand-asset slot map — at most five { slot, token } rows binding each published-app-logo slot to its host:brand storage copy; host identity, no tenant scope, no subject data of any kind' }],
  ['comparison-page-seed', { reason: 'ADR 0485 host-global seed-version marker — a single { id, version } row recording which comparison-page seed has been ensured at boot; no subject data of any kind' }],
  // ADR 0486 follow-up (#2549) shipped the About + Roadmap seeder with the same
  // omission the comparison page had, so this gate went red on main again. Same
  // ruling, same shape: `{ id: <page slug>, version }` host-global rows recording
  // which built-in copy has been ensured at boot. The PAGES themselves are CMS
  // rows under the system site and are covered by the cms eraser; this marker
  // holds no subject field, no tenant scope and no user content.
  ['marketing-content-pages-seed', { reason: 'ADR 0486 follow-up host-global seed-version marker — { id: page slug, version } rows recording which built-in About/Roadmap copy has been ensured at boot; no subject data of any kind (the pages themselves are cms rows, covered by the cms eraser)' }],
  ['cdp:audit-chain', { reason: 'lawful tamper-evident retention — the audit trail must survive the erasure (SEC-4); ADR 0464 §4' }],
  ['runartifact', { reason: 'run-retention lifecycle (ADR 0371 / size ADR 0380) + deleteRun cascade; erased at run granularity, not field redaction' }],
  ['media:bytes', { reason: 'ephemeral TTL media bytes (expiresAtMs); no durable subject identifier' }],
  ['media:asset', { reason: 'ephemeral TTL media bytes (legacy alias); no durable subject identifier' }],
  ['chat:ui-state', { reason: 'id-only (subjectRef) UI state; PII forbidden in value by policy; ADR 0284 tenant-teardown covered', tenantTeardownClaim: true }],
  ['agent-toolallowlist-override', { reason: 'operator audit attribution (updatedBy); purged on ADR 0284 tenant teardown', tenantTeardownClaim: true }],
  ['governance:policy', { reason: 'operator audit attribution (updatedByUserId); purged on ADR 0284 tenant teardown', tenantTeardownClaim: true }],
  ['workspaces:active-pref', { reason: 'membership-lifecycle covered — the active-workspace pref is cleaned when membership ends; no durable PII beyond the subject key' }],
  // ADR 0464 Phase 2 reconciliation — reviewed with the eraser work, not gaps:
  ['access-groups', { reason: 'Group.memberIds are OPAQUE subject keys, not PII; the member rows they point at are redacted in place by the access-members eraser, so group refs stay valid and PII-free' }],
  // ADR 0684 phase 5. The heuristic reports "no obvious subject field" because the
  // subject sits in the KEY (`${workspaceId}::${subject}`), not a named column — so
  // this is an EXEMPTION on the same grounds as access-members, NOT a no-subject one.
  ['access-member-index', { reason: 'ADR 0684 §6a point-read mirror of access-members. It holds the OPAQUE subject key the members eraser deliberately RETAINS ("subject + roles kept, ACL structure must not change"), and nothing else — no name, no email, no free text. Erasing it while the membership survives would make isWorkspaceMember stop answering for a member who still exists: an availability break, not a privacy gain. It is deleted with the membership by deleteMember/rekey, so it never outlives what it mirrors.' }],
  ['collab:snapshot', { reason: 'base64 CRDT state bytes; row carries NO subject-identifier field (canvasId/state/updatedAt only) — subject attribution lives in canvas/canvas:version, which the canvasSurface eraser redacts; rows are canvas-lifecycle-scoped' }],
  ['collab:update', { reason: 'base64 CRDT edit bytes; row carries NO subject-identifier field (updateId/canvasId/update/createdAt) — same ruling as collab:snapshot' }],
  ['canvas:idem', { reason: 'ephemeral idempotency retry cache (IdemRow); result mirrors canvas rows whose subject fields the canvasSurface eraser redacts at source; purged on ADR 0284 tenant teardown', tenantTeardownClaim: true }],
  // Operator-attribution config artifacts (same shape as governance:policy — AUDIT extension of the lead's ruling).
  ['custom-domains:domain', { reason: 'operator audit attribution (createdBy) on a tenant domain config; purged on ADR 0284 tenant teardown — AUDIT extension', tenantTeardownClaim: true }],
  ['hostevent:binding', { reason: 'operator audit attribution (createdBy) on a tenant automation binding; purged on ADR 0284 tenant teardown — AUDIT extension', tenantTeardownClaim: true }],
  ['approval:sla-policy', { reason: 'operator audit attribution (updatedBy) on a tenant SLA config (ADR 0478); purged on ADR 0284 tenant teardown', tenantTeardownClaim: true }],
  ['approval:sla-ladder', { reason: 'no-subject: per-approval rung-fire bookkeeping (approvalId + firedRungs); no subject identifier (ADR 0478)' }],
  // NO-SUBJECT-DATA — config / agent-identity / pointer-index / hash-only / audit-head / seed rows.
  // UPDATED 2026-08-16 (ADR 0552 P2) — the row grew `tenantId`/`principalId`/
  // `protocolVersion`, so the old reason ("taskId/runId/state") no longer
  // describes it. `principalId` is a REMOTE PEER principal — a cross-host agent
  // identity, not a data subject of this host — and the row is now
  // tenant-bound, which is what makes the teardown claim true.
  ['a2a:task', { reason: 'no-subject: agent-to-agent task state (taskId/runId/state + the remote PEER principal and protocol version, ADR 0552 P2); the peer principal is a cross-host machine identity, not a data subject; tenant-bound and purged on ADR 0284 tenant teardown', tenantTeardownClaim: true }],
  ['a2a:msgclaim', { reason: 'no-subject: RFC 0150 §A idempotency claim binding (tenant, remote peer principal, A2A messageId) to the task it opened — no content, no human subject; the peer principal is a cross-host machine identity. `tenantId` is denormalized onto the row precisely so ADR 0284 tenant teardown reaches it (ADR 0552 P2)', tenantTeardownClaim: true }],
  ['access-teams', { reason: 'no-subject: org-structure config (team name/description); no subject identifier' }],
  ['access-custom-roles', { reason: 'no-subject: role definition (name/description/scopes); no subject identifier' }],
  ['cdp:audit-head', { reason: 'no-subject: audit-chain head pointer (hash-only); part of the tamper-evident log' }],
  ['codeexec:budget', { reason: 'no-subject: per-tenant execution counters' }],
  ['collab:lease', { reason: 'no-subject: ephemeral collab lock (instanceId/expiresAt)' }],
  ['ignition', { reason: 'no-subject: 5-minute windowed workflow-ignition dedup claims (tenant-prefixed key, runId/claimedAt only — CFP Phase 1 ignitionGuard); no subject identifier' }],
  ['collab:seedclaim', { reason: 'no-subject: seed-once claim marker (instance-scoped)' }],
  ['compat:endpoint', { reason: 'no-subject: compat endpoint config; credentialRef is a BYOK ref, not subject data' }],
  ['chat:exchange-idem', { reason: 'no-subject: exchange idempotency claims (pointers/status)' }],
  ['custom-domains:meta', { reason: 'no-subject: singleton meta/version row (__meta)' }],
  ['egress-rules', { reason: 'no-subject: network egress policy config' }],
  // EM-4c CORRECTION (2026-08-18) — the old reason read "no-subject: send-dedup
  // ledger (provider/messageId keys); no recipient PII stored", and the second
  // clause was FALSE. It holds only for the HASHED fallback branch
  // (`emailAdapter.ts` derives a sha256 key when no `idempotencyKey` is
  // supplied). The CAMPAIGN branch supplies an explicit contact-bearing key, so
  // the row key literally is `<tenant>:cmp:<campaignId>:g<generation>:<contactId>`
  // — a contactId in plaintext, in the key, for a store nothing erases. An
  // exemption resting on a premise that is false for the feature's main path is
  // how a store stays unclassified while reading green.
  //
  // Still exempt, on the TRUE reason: the ledger is a bounded-lifetime dispatch
  // dedup record swept by `sweepExpiredEmailSent` on the webhook-worker tick
  // (`OPENWOP_EMAIL_LEDGER_TTL_DAYS`, default 30 days), it stores no name, no
  // address and no body — only `(key, tenantId, provider, messageId, createdAt)`
  // — and it is HOST-owned, so `features/email`'s eraser is structurally the
  // wrong place for it. Erasing it early would also un-dedup an in-flight
  // campaign generation and could DOUBLE-SEND to the person requesting erasure.
  ['email:sent', { reason: 'bounded-lifetime dispatch dedup: TTL-swept within OPENWOP_EMAIL_LEDGER_TTL_DAYS (default 30d) by sweepExpiredEmailSent; stores no name/address/body. The campaign-path KEY does embed a contactId (`<tenant>:cmp:<campaignId>:g<gen>:<contactId>`) — the previous "no recipient PII stored" reason was false for that branch and is corrected here — but early deletion would un-dedup a live send generation and risk double-delivery to the very subject requesting erasure, so the TTL is the right reclaim.' }],
  // ADR 0619 — the SMS/push sibling of email:sent, classified EXEMPT by the SAME
  // reasoning. Key is `<tenant>:<channel>:<idempotencyKey>` where idempotencyKey is
  // a SHA-256 over (runId, nodeId, recipient, content) — the phone/device-token is
  // HASHED in, never persisted plaintext (unlike email's campaign-path contactId,
  // this stores no subject identifier at all). Row = (key, tenantId, channel,
  // provider, providerRef, createdAt). Early deletion would un-dedup a live send and
  // risk double-delivery to the very subject requesting erasure, so the TTL reclaims it.
  ['egress:sent', { reason: 'ADR 0619 — bounded-lifetime SMS/push dispatch dedup (egressSentLedger), the sibling of email:sent: TTL-swept within OPENWOP_EGRESS_LEDGER_TTL_DAYS (default 30d) by sweepExpiredEgressSent; stores no name/address/body — the recipient phone/device-token is HASHED into the caller idempotencyKey, never persisted. Early deletion would un-dedup a live send generation and risk double-delivery to the very subject requesting erasure, so the TTL is the right reclaim.' }],
  ['example:widget', { reason: 'no-subject: host/examples reference surface; demo widget rows' }],
  ['features-page-seed', { reason: 'no-subject: seed version marker' }],
  ['feature-toggle', { reason: 'no-subject: feature-toggle config; updatedBy operator attribution' }],
  ['host:chatByokConfig', { reason: 'no-subject: per-tenant active chat binding (provider/model/credentialRef); deliberately carries NO actor field, unlike its headlessAiDefault sibling — the row is workspace config, so there is no subject to erase' }],
  ['host:headlessAiDefault', { reason: 'no-subject: per-tenant AI default config (provider/model/credentialRef)' }],
  ['migration', { reason: 'no-subject: migration journey config (workforceId/target/manifest)' }],
  ['orgchart', { reason: 'no-subject: grouping of RFC 0086 ROSTER (agent) members into departments; agent identity, not human subject' }],
  ['pack-tombstone', { reason: 'no-subject: pack lifecycle tombstone; tombstonedBy operator attribution' }],
  // ADR 0555 P0. Shape matches pack-tombstone (host-global, no tenant scope,
  // operator attribution in `revokedBy`), but the retention argument is
  // stronger and closer to cdp:audit-chain: a revocation is a SAFETY CONTROL,
  // and erasing the row would re-permit execution of code believed
  // compromised. So this must survive erasure, not merely be exempt from it.
  // No tenantTeardownClaim — the row is host-global and has no tenantId for a
  // tenant-keyed purge to match on.
  ['pack-revocation', { reason: 'lawful/technical retention — an ADR 0555 pack revocation must SURVIVE erasure (deleting it would re-enable code believed compromised); host-global, no tenant scope, no subject content beyond revokedBy operator attribution' }],
  ['roster', { reason: 'no-subject: agent roster identity (rosterId/persona/agentRef) — excluded agent identity' }],
  ['retention-hold', { reason: 'no-subject: operational retention-hold metadata (reason = why a run is held)' }],
  ['site-config', { reason: 'no-subject: global site config singleton; updatedBy operator attribution' }],
  ['system-site-seed', { reason: 'no-subject: seed version marker' }],
  ['systemsite:docs-seed', { reason: 'no-subject: seed version marker' }],
  ['triggerbridge:sub', { reason: 'no-subject: webhook subscription config (source/secretFingerprint)' }],
  ['triggerbridge:delivery', { reason: 'no-subject: delivery-attempt records (outcome/runId)' }],
  ['triggerbridge:dedup', { reason: 'no-subject: delivery dedup keys' }],
  ['workflow:ownership', { reason: 'no-subject: tenant↔workflow ownership (key `${tenantId}:${workflowId}`); the owner is the TENANT' }],
  ['workforce', { reason: 'no-subject: agent workforce config (agents = agent roster) — agent identity' }],
  ['ads:dispatch', { reason: 'no-subject: ad-platform dispatch records (external campaign/ad ids)' }],
  ['ads:spend-approval', { reason: 'no-subject: spend-approval pointer (spendKey→approvalId)' }],
  ['agent-profile', { reason: 'agent profile/identity config — excluded agent identity; the ONE subject-bearing corner (twin.userId/linkedBy) is redacted by the agentProfileService eraser' }],
  ['approval:by-tenant-status', { reason: 'no-subject: approval index rows (ixId→approvalId pointers)' }],
]);

/**
 * The subject-identifier discriminator (ADR 0464 design input). Fires on a row
 * type that names a subject-bearing field or free-text field, or embeds a `user:`
 * key shape. Agent-identity fields (rosterId/persona/agentId/packId) are NOT listed,
 * so agent-only rows do not trip it. Used ONLY to add a SEVERITY HINT to an
 * UNCLASSIFIED namespace (assertion 2) — classified rows are governed by their
 * registry, so a config row whose free-text `description` trips this is not an error.
 */
const SUBJECT_FIELD =
  /\b(subject|subjectRef|ownerSubject|ownerUserId|\w*UserId|capturedBy|submittedBy|completedBy|decidedBy|reviewerRef|actedBy|fromSubject|toSubject|payeeSubject|coachSubject|assigneeId|grantee|createdBy|note|reason|content|proposal|description)\b|user:/;

// ── Source enumeration ──────────────────────────────────────────────────────

/** A demo seeder RE-OPENS feature-owned namespaces (owner is under src/features/). */
const isSeeder = (file: string) => /(^|[\\/])demo.*Seed\.ts$/.test(file);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes('__tests__')) out.push(p);
  }
  return out;
}

/** `new DurableCollection<RowType>('namespace'` → { ns, typeName }. Matches a
 *  QUOTED literal only (backtick template namespaces + `config.ns` variables are
 *  parametric and deliberately not enumerated). `>\s*\(` anchors past nested
 *  generics; `\s*` before the literal covers multi-line declarations. The
 *  generic is OPTIONAL so an untyped `new DurableCollection('ns', …)` cannot
 *  silently escape enumeration (grade hardening — the tripwire is the ADR's
 *  structural cure, so its denominator must be regex-gap-free). */
const STORE_RE = /new DurableCollection(?:<([\s\S]*?)>)?\s*\(\s*['"]([^'"]+)['"]/g;

type Decl = { file: string; typeName: string };

function enumerateHostStores(): Map<string, Decl> {
  const found = new Map<string, Decl>();
  for (const file of walk(HOST_ROOT)) {
    if (isSeeder(file)) continue;
    const src = readFileSync(file, 'utf8');
    const rel = file.slice(HOST_ROOT.length + 1).split('\\').join('/');
    for (const m of src.matchAll(STORE_RE)) {
      const typeName = (m[1] ?? '').trim();
      const ns = m[2]!;
      if (!found.has(ns)) found.set(ns, { file: rel, typeName });
    }
  }
  return found;
}

/** Best-effort: the `{...}` body of `interface Name {` / `type Name = {` in a file
 *  (balanced-brace scan from the first `{`). '' when the type is imported/not found. */
function rowTypeBody(fileRel: string, typeName: string): string {
  const bare = typeName.replace(/<.*$/, '').trim(); // strip generics like Foo<Bar>
  if (!/^[A-Za-z_]\w*$/.test(bare)) return ''; // inline/anonymous type
  const src = readFileSync(join(HOST_ROOT, fileRel), 'utf8');
  const decl = new RegExp(`\\b(?:interface|type)\\s+${bare}\\b`).exec(src);
  if (!decl) return '';
  const open = src.indexOf('{', decl.index);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return '';
}

// ── The tripwire ────────────────────────────────────────────────────────────

describe('subject-erasure coverage (ADR 0464)', () => {
  const stores = enumerateHostStores();

  it('the three registries are pairwise disjoint', () => {
    const overlaps: string[] = [];
    for (const ns of ERASED.keys()) {
      if (RECORDED_DEBT.has(ns)) overlaps.push(`${ns} (ERASED ∩ DEBT)`);
      if (REVIEWED_EXEMPT.has(ns)) overlaps.push(`${ns} (ERASED ∩ EXEMPT)`);
    }
    for (const ns of RECORDED_DEBT.keys()) {
      if (REVIEWED_EXEMPT.has(ns)) overlaps.push(`${ns} (DEBT ∩ EXEMPT)`);
    }
    expect(overlaps, 'A namespace must live in EXACTLY ONE registry').toEqual([]);
  });

  it('every host-owned durable store is classified — a new subject-bearing store fails here', () => {
    const unclassified: string[] = [];
    for (const [ns, decl] of stores) {
      if (ERASED.has(ns) || RECORDED_DEBT.has(ns) || REVIEWED_EXEMPT.has(ns)) continue;
      // Assertion 2 — severity hint: does the row type look subject-bearing?
      const body = rowTypeBody(decl.file, decl.typeName);
      const hint = SUBJECT_FIELD.test(body)
        ? 'LIKELY SUBJECT-BEARING — register a SubjectEraser (ADR 0464 §2.1), do NOT just exempt'
        : 'no obvious subject field — classify as REVIEWED_EXEMPT with a no-subject reason, or add a SubjectEraser';
      unclassified.push(`${ns} (${decl.file} : ${decl.typeName}) — ${hint}`);
    }
    expect(
      unclassified,
      'Unclassified host durable store(s). Every subject-bearing store needs a registered SubjectEraser or a documented exemption (ADR 0464 §2.1).',
    ).toEqual([]);
  });

  it('registry entries are not stale — every classified namespace still exists in source', () => {
    const stale: string[] = [];
    for (const ns of [...ERASED.keys(), ...RECORDED_DEBT.keys(), ...REVIEWED_EXEMPT.keys()]) {
      if (!stores.has(ns)) stale.push(ns);
    }
    expect(
      stale,
      'Registry entries whose namespace no longer exists in src/host/** are stale — remove them so the list stays honest (shrink-only).',
    ).toEqual([]);
  });

  it('HONESTY: a tenant-teardown coverage claim requires a tenantId field to back it', () => {
    // A coverage story that leans on the ADR 0284 tenant purge is a LIE for a row
    // with no tenantId (the purge keys by tenantId and can never reach it). This is
    // why review:decision is DEBT with 'unreachable — no tenantId', NOT a teardown
    // claim: it would FAIL this assertion today. Peers add the field; this is the signal.
    const dishonest: string[] = [];
    for (const [ns, ex] of REVIEWED_EXEMPT) {
      if (!ex.tenantTeardownClaim) continue;
      const decl = stores.get(ns);
      if (!decl) continue; // caught by the stale-entry test
      const body = rowTypeBody(decl.file, decl.typeName);
      if (!/\btenantId\b/.test(body)) dishonest.push(`${ns} (${decl.file} : ${decl.typeName})`);
    }
    expect(
      dishonest,
      'Entry claims ADR 0284 tenant-teardown coverage but its row type has no tenantId — the purge cannot reach it. Add tenantId or drop the claim.',
    ).toEqual([]);
  });
});
