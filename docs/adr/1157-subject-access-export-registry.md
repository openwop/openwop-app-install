# ADR 1157 — subject access export registry

Status: Proposed (2026-11-23)
Relates: ADR 0464 (subject-erasure completeness, the registry this mirrors),
ADR 0820 §7 (the workspace feature-data export), ADR 0947 D2 (comment
visibility), ADR 0881 D10 (comments' person-shaped fields), ADR 1031 P2 (feature
host contributions), ADR 0380 (kv age-out). Issue 6184.

Host-internal. Every route this ADR adds sits under `/host/openwop-app/*`; no
run event, capability flag, endpoint contract or `MUST` on the OpenWOP wire
changes, so no RFC (§ RFC gate).

All code citations were read at `d220511e21`.

## Context

**Erasure has a registry; access does not.** A person can have their data
erased in a workspace, and nothing gives that same data back to them.

- The erasure seam: `registerSubjectEraser` (`host/subjectErasure.ts:145`), run
  by `eraseSubject` (`:262`) once per key that the registered
  `SubjectKeyResolver`s return (`:123`, `resolveSubjectKeys` at `:216`). An
  eraser MUST be a named function. Its `fn.name` is its id (`:133`), so an
  anonymous one is refused at boot (`:146`).
- **The registered stores, measured.** `EXPECTED_SUBJECT_ERASERS`
  (`host/subjectEraserManifest.ts:372-534`) holds **141 eraser ids**. They match
  141 `registerSubjectEraser(` call sites in `src`: 40 files under `src/host`
  and files in 77 feature directories. `expectedSubjectErasers()` (`:538`) adds
  the feature-declared `hostContributions.subjectErasers`
  (`host/featureContributions.ts:139`, "KickTodo's three" per the comment at
  `subjectEraserManifest.ts:536`). The store identity is recorded at two
  granularities. Eraser ids are machine-checked at a real boot
  (`test/subject-eraser-manifest.test.ts`, layers 1–3). Store namespaces are
  classified in the coverage tests: the host gate's `ERASED` map has **52
  namespaces** (`test/subject-erasure-coverage.test.ts:50-126`), and the
  feature census derives coverage per feature directory (`ERASING_FEATURES`,
  `test/subject-erasure-feature-stores.test.ts:1090`).
- **How ADR 0464 exempts.** It does not allow a silent third state (ADR 0464
  §2.1). A store is `ERASED`, in shrink-only `RECORDED_DEBT` (empty,
  `subject-erasure-coverage.test.ts:132`), or in `REVIEWED_EXEMPT` with a reason
  string (`:141-336`, 92 entries). `cdp:audit-chain` is exempt as "lawful
  tamper-evident retention" (`:227`). The feature census uses the same pattern
  with a pinned, ceilinged baseline JSON (ADR 0464 §9;
  `SIGNAL_FREE_BASELINE_CEILING`, `subject-erasure-feature-stores.test.ts:1912`).
- **The workspace export exists, but it is not a person's export.**
  `registerFeatureDataExporter(featureId, (tenantId) => sections)`
  (`host/featureDataExport.ts:26-33`, paged form `:48-52`) is served by
  `GET /host/openwop-app/export/features[/:featureId]`
  (`features/portability/routes.ts:113`, `:130`). Its authority is
  `host:billing:manage`, and anonymous tenants are refused first (`:44-49`). The
  output is workspace-wide by contract (`featureDataExport.ts:18-19`). 17 call
  sites register an exporter. `comments` is not one of them, and ADR 0820's
  exporter record lists it under none of done, skipped or "NOT done"
  (ADR 0820, implementation note 2026-10-07).
- **Comments, concretely.** One store,
  `DurableCollection<Comment>('comments:thread', …)`, tenant-indexed
  (`features/comments/commentsService.ts:385`, `rowsForTenant` `:408`). The
  subject-bearing fields are `authorId`, `onBehalfOf`, `mentions`, `resolvedBy`
  and `resolvedOnBehalfOf` (`:76-108`). `commentsEraser` (`:912-913`) deletes
  the rows the subject authored and strips them from other people's `mentions`
  and `resolvedBy` (`deleteSubjectComments`, `:891-910`). Visibility: a reply
  takes its root's mark, and an unmarked thread is internal, readable only by an
  org member (`visibleToAudience`, `:209-213`; ADR 0947 D2; issue 6109).
- **A name already taken.** `host/subjectAccess.ts` is the authorization
  resolver ("may this caller read this subject", `:32`, `:44`). It has nothing
  to do with DSAR access. The new seam must not reuse that name.

## Decision

| # | Decision |
|---|---|
| D1 | **A subject export registry beside the eraser registry**, in a new `host/subjectExport.ts` (not `subjectAccess*`, see Context). `registerSubjectExporter(exporter)` takes a NAMED function and refuses an anonymous one at registration, the same rule as `subjectErasure.ts:145`. Each registration declares `pairs: string[]`, the eraser ids it answers for (from `expectedSubjectErasers()`), and `stores: string[]`, the namespaces it reads. One exporter may pair with several erasers, for example a feature whose two erasers share one read. The export fan-out reuses the erasure lane's identity expansion: `resolveSubjectKeys` (`subjectErasure.ts:216`) is exported from that module, not copied, so export and erasure reach exactly the same keys. |
| D2 | **Parity ratchet: `backend/typescript/test/subject-export-parity.test.ts`.** Rule: every id in `expectedSubjectErasers()` is paired by a registered exporter, OR is in `EXPORT_EXEMPT` with a reason, OR is in `EXPORT_ACKNOWLEDGED_MISSING`. A store with an eraser and no exporter therefore fails the build. The layers mirror `subject-eraser-manifest.test.ts`: (1) a source pin, (2) a real `createApp()` boot pin, so an exporter present in source but never imported fails, and (3) the runtime result names any expected-but-unregistered exporter, so a missing one is a typed gap in the bundle (`missing: [...]`), never a silent omission. A namespace leg also checks that every key of the host `ERASED` map (`subject-erasure-coverage.test.ts:50`) appears in some exporter's `stores` or in an exemption, so the two granularities cannot drift apart. `EXPORT_ACKNOWLEDGED_MISSING` is a pinned JSON baseline with a ceiling that may only shrink, the ADR 0464 §9 mechanism. A stale entry (an id that now has an exporter, or no longer has an eraser) fails the test. |
| D3 | **Exemptions mirror ADR 0464's, with their own reasons.** `EXPORT_EXEMPT: Map<eraserId, reason>`. An erasure exemption does not carry over automatically, because the questions differ. Admitted reasons: (a) the store holds ids or hashes only, and the record that matters is exported elsewhere. Security audit chains are this case: `cdp:audit-chain` is erasure-exempt for lawful retention (`subject-erasure-coverage.test.ts:227`), and its rows are ids and digests, so it is export-exempt as "ids only, no personal content". (b) The eraser only strips the subject from rows that a paired exporter already returns. (c) Capability material, which ADR 0820 already never exports (implementation note 2026-10-07: tokens, sealed secrets, `tokenHash`). Every exemption is reviewed in the PR that adds it. |
| D4 | **The exporter contract.** `(tenantId, subjectKey, page: { cursor?, limit }) => Promise<{ sections: Record<string, readonly unknown[]>; nextCursor?: string; rowCount: number }>`. It is always paged, because the shape of the paged form in `featureDataExport.ts:48-49` is the one that scales. Rules: **read-only**, the same rule as `featureDataExport.ts:12-16`. **Tenant-scoped:** the tenant is the request's, never expanded (the WF-TWIN-3 ruling, `subjectErasure.ts:280-286`). **Subject-scoped:** it returns (i) the rows the subject authored or owns, matched by the same predicate as the paired eraser, and (ii) records about the subject (mentions, assignments, resolutions, cohort membership). **Third parties are minimized:** another person's id becomes the literal `"other"`, and another person's free text is left out, except where D5 rules otherwise. **Deterministic:** rows are sorted by `(createdAt, primary id)` ascending, and the cursor is the last `(createdAt, id)` pair, so a re-run on unchanged data is byte-identical. **Bounded:** `limit` ≤ `EXPORT_PAGE_MAX` (2000, `featureDataExport.ts:73`). **Never capabilities:** D3(c). |
| D5 | **The comments ruling, the worked example for D4.** Section `authored`: every row where `authorId` or `onBehalfOf` is the subject (the same predicate as `deleteSubjectComments`, `commentsService.ts:897`), complete with body, anchor, intent, visibility, status and `parentId`. Internal-visibility rows the subject wrote ARE included, because they are the subject's own speech, even if the subject has since left the org. Section `threadContext`: in a thread the subject wrote in, each other person's comment appears as `{commentId, parentId, createdAt, authorId:"other"}` with no body. That keeps the thread's shape readable without disclosing anyone else's words. Section `aboutYou`: rows that mention the subject or that the subject resolved, as `{commentId, resourceType, resourceId, createdAt, relation: "mentioned" \| "resolved"}`, with no body. **On the self-serve path an `aboutYou` row is listed only if the requester could read it today**: the export calls `visibleToAudience` (`:209-213`) with the requester's own audience, and an internal thread is not listed to a non-member. An export must never widen what a person can see. The assisted path (D7) may include internal rows about the subject after an operator review. |
| D6 | **Self-serve request: one async job per person per workspace.** `POST /host/openwop-app/me/data-export` starts a job, `GET …/me/data-export` returns its status, and `GET …/me/data-export/:jobId/download` returns the bundle. Rules: **Who.** A signed-in caller exporting their OWN subject key in the current tenant. There is no `:subjectKey` parameter, because the key is the caller's identity. An `anon:` tenant is refused first, as at `portability/routes.ts:45`. **Rate.** One live job per (tenant, subject). At most 3 requests per subject per 24 h, refused with 429 and `Retry-After`. **Job.** A `DurableQueue` (`host/durableQueue.ts:26`) item. The worker walks each exporter's pages and writes one JSON bundle: `{exportedAt, tenantId, stores: {<exporterId>: sections}, exempt: [...], missing: [...]}`. A legal hold does not block an export, since an export destroys nothing. **Retention.** The bundle row expires after 7 days through `registerKvAgeOut` (`host/kvAgeOut.ts:161`). The job record keeps only ids. Download is allowed only to the same subject, and the bundle never travels by email. **Audit.** `appendAudit(tenantId, 'subject.export.requested' \| '.completed' \| '.downloaded', {jobId, subject: hashSubjectKey(...)})` (`host/auditChainService.ts:184`; `features/consent/consentService.ts:841`). Ids and hashes only, never an email or a name, the same rule the users erase door follows. **Erasure link.** The job's bundle is itself subject data, so it gets an eraser and an exporter exemption of kind D3(b). |
| D7 | **The assisted path for a verified DSAR.** It reuses the consent DSAR door rather than adding a third one. `POST /host/openwop-app/consent/orgs/:orgId/subjects/:subjectKey/export`, next to the erase route at `features/consent/routes.ts:324`, with the same authority: `dsarAuthz(req, 'workspace:write')` plus `requireRegimeAdmin` (`:330-331`), the ADR 0657 D6 bar. It runs the same job (D6), but the bundle can be downloaded only by the requesting operator, who hands it over outside the app after verifying identity. The operator path sets `audience: 'assisted'`, so the exporters may include the D5 internal `aboutYou` rows. Superadmin acts only through this door, scoped to the tenant like everyone else. There is no cross-tenant export, for the same reason erasure has none. |
| D8 | **Relation to ADR 0820.** The workspace export (admin-class, workspace-wide, plan-lapse portability) and the subject export (person-scoped, rights-based) are different contracts with different authority, and neither replaces the other. They share the paging shape and the read-only rule. A feature's two exporters MAY share one read helper. The comments workspace exporter is P1, because that half of issue 6184 is already a gap under ADR 0820's own rule. |
| D9 | **RFC gate: none.** Every route is a host extension under `/host/openwop-app/*`, which never touches the wire (CLAUDE.md, "A spec change needs an RFC"). Checked: the job emits no run event, adds no capability to `/.well-known/openwop`, touches no executor or replay path, and the audit kinds are host audit-chain entries, not protocol events. |

## Alternatives

- **Workspace export plus erasure is the whole posture (issue 6184's fallback).**
  Rejected. The workspace export is admin-only and workspace-wide, so a member
  cannot use it to see their own data, and an admin cannot give it to a member
  without handing over everyone else's rows.
- **Derive each subject export from the workspace exporters by filtering
  rows.** Rejected. Only 17 features have workspace exporters, and erasure
  reaches 141. The filter would also need every exporter's subject predicate,
  which is what the eraser already holds.
- **One generic exporter that scans every namespace for subject-shaped
  fields.** Rejected. It is the heuristic ADR 0464 §9 refused for erasure. It
  cannot tell authored text from text about someone else, and it would hand
  over third-party data.
- **Key the ratchet only on namespaces.** Rejected as the primary key. The host
  `ERASED` values are prose that nothing checks (`subject-erasure-coverage.test.ts:42-49`,
  TWIN-DEBT-1), and feature coverage is per directory. Eraser ids are the one
  identity a real boot verifies, so they are the key, and namespaces are a
  second leg (D2).
- **A synchronous `GET /me/export`.** Rejected. 141 stores in one request is
  the run-snapshot-scan incident waiting to happen. Cloud Run request time and
  the per-IP read budget both argue for a job.

## Trade-offs

- **Twice the code for each store.** Every eraser gains a sibling. The ratchet
  makes that cost visible rather than optional, and the acknowledged-missing
  baseline spreads it over P3.
- **Redaction loses context.** `threadContext` without bodies is less useful
  than the full thread. It follows Art. 15(4): one person's copy must not
  disclose another person's data. The assisted path is the outlet.
- **"Readable today" can hide data about a person** (internal notes) from the
  self-serve path. That is deliberate (D5), and the assisted path covers it.
  The trade is stated so no one later reads it as a leak fix that went missing.
- **A 7-day bundle is a second copy of personal data.** It is bounded by
  age-out, by same-subject download, and by its own eraser.

## Phases

| Phase | Contents | Witness it needs |
|---|---|---|
| P1 | The comments workspace exporter on the ADR 0820 seam: every `comments:thread` row of the tenant, internal and shared, with anchor, intent, visibility, status, `resolvedBy` and `parentId`. No member filter, because the door is admin-class. It is recorded in ADR 0820's exporter list. | An internal and a shared thread both come back, and so does another org's row in the same tenant (issue 6184 §1). |
| P2 | `host/subjectExport.ts` (D1, D4 types, the fan-out with `missing`), `resolveSubjectKeys` exported, `subject-export-parity.test.ts` (D2), `EXPORT_EXEMPT` (D3), and `test/fixtures/subject-export-missing-baseline.json` listing every current eraser id with ceiling = count. | Sabotage: a new eraser with no exporter fails; an appended baseline entry fails; an exporter that is never imported fails the boot layer; an emptied walk fails the non-vacuity floor. |
| P3 | Exporters in batches, each batch shrinking the baseline: (a) comments (D5) and the identity stores (`userEraser`, `profileEraser`, `identityLinkEraser`); (b) authored content (documents, kb, cms, canvas, chat); (c) CRM, CDP and analytics (records about a person); (d) the rest, by store. | Per exporter: create rows for the subject and for another person, then export, and assert the subject's rows are complete and the other person's are absent or redacted. |
| P4 | `/me/data-export` routes, the job, the bundle with age-out, audit events, rate limits (D6), and a "Download my data" entry in account settings, with four-locale copy. | Job end to end; another person's job id gets 404; the 4th request in 24 h gets 429; the bundle is gone after age-out; the audit payload contains no email. |
| P5 | The assisted DSAR route (D7) and the operator UI in the consent DSAR panel. | Without `requireRegimeAdmin` it refuses; the `assisted` audience includes internal `aboutYou` rows and the self-serve audience does not. |

## Implementation record

| Phase | Commit | Witness test |
|---|---|---|
| P1 | | |
| P2 | | |
| P3 | | |
| P4 | | |
| P5 | | |

## Open questions — answered (2026-11-23)

Each answer names its source. The user's decisions were made in the release
manager's session (openwop-app-14) and relayed from there. The two
recommendations were made by that session at the user's request, and the user
can still overrule them.

- [x] **Bundle retention** — *user decision.* 7 days, with any number of
  downloads in that window (not one-shot). D6 stands as written.
- [x] **Rate limit** — *user decision.* 3 requests per 24 h, per subject, per
  workspace. D6 stands as written.
- [x] **Which workspaces** — *user decision.* The current workspace only; no
  fan-out. A person in N workspaces makes N requests. D6 stands as written.
- [x] **`aboutYou` bodies** — *recommendation (release manager, at the user's
  request; the user may overrule).* The self-service export leaves out the
  body of another person's comment that mentions the subject, and lists that
  the mention exists (where and when, no body). The assisted path (D7) may
  include the body, but only after an admin review that can redact third
  parties: the GDPR Art. 15(4) balancing, recorded case by case. D5's current
  choice matches this for self-service. D7's admin review step is a P5
  requirement.
- [x] **Format** — *recommendation (release manager, at the user's request;
  the user may overrule).* JSON per store now, which meets Art. 20's
  machine-readable requirement. CSV for tabular stores (CRM, commerce orders)
  is a later, optional addition and not in P1–P5.
