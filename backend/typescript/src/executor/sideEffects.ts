/**
 * ADR 0341 (GC-FORK-2) — side-effecting node classification for replay forks.
 *
 * A `replay`-mode fork re-executes the workflow; pure and LLM nodes replay
 * deterministically (LLM calls are invocation-log-served per ADR 0326 P3a/b),
 * but a node whose execution IS an external effect — an HTTP call, an email,
 * an A2A send — must never fire again during a "deterministic" replay. The
 * executor short-circuits nodes this module classifies by reproducing the
 * SOURCE run's recorded outcome for the same (nodeId, attempt) from the
 * source event log; a flagged node the source never reached fails CLOSED
 * (`replay_source_missing`) — a replay never creates a NEW side effect.
 *
 * CLASSIFICATION HAS THREE SOURCES, AND THE DERIVED ONE IS NOW PRIMARY
 * (ADR 0572 P3). In order:
 *
 *   1. `MANIFEST_FAST_PATH_SERVED` — DERIVED from the pack manifests by
 *      `scripts/gen-side-effect-floor.mjs`. This is what `replay.md`
 *      requirement 4 actually asks for: the manifest's `role: "side-effect"`
 *      declaration is binding on the host, and "a host's own classifier is a
 *      floor ABOVE this declaration and never a substitute". A pack `.mjs` node
 *      cannot set the module flag, so before this the ONLY way a pack node got
 *      protection was somebody remembering to add a regex below — which failed
 *      twice on record (ADR 0563's `core.storage.blob-put`, ADR 0533's ten
 *      `core.openwop.http.*` senders). Both times the manifest said so all
 *      along and nothing read it.
 *   2. `NodeModule.sideEffecting` — programmatic registration self-declaring.
 *   3. The typeId pattern list below — for nodes with NO pack manifest (the
 *      in-tree `bootstrap/` conformance nodes) and as the historical record.
 *
 * Deliberately NOT workflow-author config: config could lie a node pure.
 *
 * WHAT THE DERIVED SET DELIBERATELY EXCLUDES, because a blind union is wrong.
 * A classified typeId is NEVER EXECUTED on a replay (`replayServed ?? …`
 * below). For a node whose discharge is the ADR 0326 invocation log — it runs
 * live and the log serves the provider call from the SOURCE run — short-
 * circuiting it would kill the RFC 0041 §B divergence machinery. So the
 * generator subtracts every floor node that reaches a host AI capability, plus
 * the roles whose fast-path semantics are unresolved, plus anything it cannot
 * read. Those stay UNDISCHARGED — safe via the backstop below, and counted by
 * the ADR 0572 served-set ratchet under `docs/steward/` — rather than silently
 * absorbed.
 *
 * CLASSIFICATION IS THE FAST PATH, NOT THE WHOLE GUARANTEE (ADR 0531), and
 * `replay.md` requirement 6 says so normatively: `recorded-outcome` needs BOTH
 * classification (correct) and a default-deny seam guard (safe). So there is a
 * second, structural mechanism behind this: `host/runEffectContext.ts`
 * establishes a run-scoped context around every node execution, and each host
 * effect seam calls `assertEffectAllowed()` before acting. The two are NOT
 * redundant:
 *
 *   - THIS list lets the executor serve the source run's recorded outcome, so
 *     the replay SUCCEEDS with the right observable output.
 *   - The backstop can only THROW, because it fires mid-execution when there
 *     is no outcome left to serve.
 *
 * So a backstop firing is a BUG REPORT about classification — "a node reached
 * a real effect during a replay and was not classified". It logs exactly that.
 * For a manifest node the fix is now the DECLARATION (`role: "side-effect"` in
 * its `pack.json`, which the generator reads); the backstop is what stops the
 * omission from being silent in the meantime.
 */

import { MANIFEST_FAST_PATH_SERVED } from './sideEffectFloor.generated.js';

/**
 * The pre-ADR-0572 hand-maintained list. RETAINED, not superseded, for two
 * reasons that are not sentiment:
 *
 *   - the in-tree conformance nodes (`conformance.effect.emit`,
 *     `core.conformance.side-effect`) have NO pack manifest, so the derived set
 *     cannot see them and RFC 0140's scenario probes them by typeId;
 *   - it is the record of what drifted, and the comments below are the
 *     evidence trail for ADR 0533/0563 and #2871.
 *
 * It is no longer the primary mechanism. A NEW manifest node must be protected
 * by its own `role: "side-effect"` declaration, not by an entry here.
 *
 * v1 families — unambiguous senders/writers only; read verbs stay live.
 */
const SIDE_EFFECTING_TYPE_PATTERNS: readonly RegExp[] = [
  // ADR 0673 D1 — the workflow-author WRITE nodes, SCOPED to the three that may be served.
  // `draft` is deliberately EXCLUDED: it calls `ctx.callAI`, so the generator holds it back
  // as an `ai-invocation-log`, and every arm of `isSideEffectingNode` below is decisive —
  // a pack-wide entry here would OVERRIDE that holdback and fast-path the model call,
  // retiring RFC 0041 §B divergence injection for the one node that needs it.
  /^feature\.workflow-author\.nodes\.(validate|get|persist)$/,
  /^feature\.whatsapp\.nodes\.send$/, // ADR 0394 — a paid BSP message; a fork must reuse the recorded send
  /^core\.openwop\.http\.fetch$/,
  /^core\.openwop\.integration\./, // email-send, sms-send, slack-message, notification-push, voice-call-*
  // ADR 0498 DATA-1 — the in-app notify node. It emits a durable, user-visible
  // notification row, so a replay that re-executes it notifies a second time.
  // This entry is REQUIRED, not belt-and-braces: #2871 retargeted 55 chain nodes
  // off `core.openwop.integration.notification-push` (covered by the pattern
  // above) onto this typeId, which matched nothing — silently dropping all 55 out
  // of ADR 0341 protection while the node's own docblock claimed replay would
  // "read the recorded verdict rather than re-notifying". A pack `.mjs` node
  // cannot self-declare (`NodeModule.sideEffecting` is reachable only by
  // programmatic registration), which is why `feature.whatsapp.nodes.send` above
  // needed the same explicit entry.
  /^feature\.notifications\.nodes\.notify$/,
  // Same family, reached the OTHER way: this node delivers a cohort session's
  // T-minus reminder into the circle conversation through the accountability
  // host surface (`features/kicktodo-accountability/sessionService.ts`, which
  // imports `getNotificationEmitter`), not through its own pack `.mjs`. Found by
  // the grade pass as a live counterexample to the notify entry above — the
  // emitter is reachable from a node in two different ways, and only one of them
  // is visible in pack source.
  /^feature\.kicktodo\.nodes\.session-reminder$/,
  // ADR 0617 D2 — the users lifecycle nodes. Each is a durable status write
  // that ALSO bumps the target's session epoch (ends live sessions) and emits
  // `host.users.user.deactivated` / `.reactivated`, which a tenant binding turns
  // into a workflow run. Re-executing on a `:fork` would emit nothing (the
  // transition guard) but would still be an unrecorded authz + status write
  // against live identity; the fork is served the recorded outcome instead.
  // Same two-leg shape as comments: `"role": "side-effect"` in
  // `packs/feature.users.nodes/pack.json` reaches the derived floor; this entry
  // proves the typeId path independently.
  /^feature\.users\.nodes\.(deactivate|reactivate)$/,
  // ADR 0622 D2 — the org-invitation mint. A re-executed mint is a NEW
  // `inviteId` (a fresh token, a fresh email through the inviter's brokered
  // connection) that supersedes — kills — the link already in the recipient's
  // inbox, and emits a second `host.orgs.invitation.created` a binding would
  // turn into a second run. The fork is served the recorded
  // `{ inviteId, orgId, delivery }` instead. Second leg of the two-leg shape
  // (`"role": "side-effect"` in `packs/feature.orgs.nodes/pack.json`).
  /^feature\.orgs\.nodes\.invite$/,
  // WF-CMNT-1 — the THIRD instance of the family the two entries above were
  // added for, and it reaches the emitter the same invisible way: the node's
  // pack `.mjs` calls `ctx.features.comments.post`, which is
  // `features/comments/surface.ts` → `createComment` (a fresh `cmt:${randomUUID()}`
  // row) → `emitCommentNotification` → `getNotificationEmitter().emit` (an
  // ADDRESSED, user-visible notification). Nothing in pack source names the
  // emitter. Unclassified, a `:fork` posted a SECOND comment under a DIFFERENT
  // `agent:${newRunId}` author — a duplicate no id-keyed eraser reaches as one
  // subject — and notified the recipient again.
  //
  // This entry is HALF of the #2871 two-leg fix and must not be separated from
  // the other half (`"role": "side-effect"` + the `side-effectful` capability in
  // `packs/feature.comments.nodes/pack.json`). A pack `.mjs` node cannot set
  // `module.sideEffecting`, so the manifest declaration alone reaches the
  // DERIVED floor and this entry proves the typeId path independently.
  //
  // `feature.comments.nodes.resolve` is deliberately NOT here. It is a durable
  // write, but re-executing it converges on the SAME terminal state
  // (`status:'resolved'`), mints no row and emits no notification, so a fork
  // duplicates nothing observable — only `updatedAt` moves. Recorded as a
  // judgement rather than left as an omission; revisit if `resolve` ever gains a
  // notification or a `resolvedBy` audit row (`CMNT-10`).
  /^feature\.comments\.nodes\.post$/,
  // WF-JS-1 — the campaign-pass trigger. One execution can SEND real job
  // applications (grant-bounded, but outward); a replay must be served the
  // recorded pass digest, never re-fire one. Pack `.mjs` nodes cannot
  // self-declare `sideEffecting`, so this explicit entry is REQUIRED alongside
  // the pack.json `side-effectful` capability (the #2871 two-leg lesson).
  /^feature\.job-search\.nodes\.run-campaign$/,
  // WF-COS-2/WF-COS-3 — the assistant's two NON-CONVERGENT nodes, and the fourth
  // instance of the family the notify/session-reminder/comments entries above
  // were added for: the emitter is reached through a HOST SURFACE
  // (`features/assistant/surface.ts` → `getNotificationEmitter`), so nothing in
  // pack source names it.
  //
  //  - `compose-briefing` with `config.notify: true` drops a durable
  //    Notifications row + Web Push. Unclassified, a `:fork` of
  //    `assistant.loop.morning-briefing` briefed the principal a SECOND time.
  //  - `enqueue-action` mints `act:${randomUUID()}` PLUS a host PendingApproval
  //    PLUS an "approval needed" notification. A fork re-drafts an outbound
  //    action and asks a human to approve it again.
  //
  // These are HALF of the #2871 two-leg fix and must not be separated from the
  // other half (`"role": "side-effect"` + the `side-effectful` capability in
  // `packs/feature.assistant.nodes/pack.json`). A pack `.mjs` node cannot set
  // `module.sideEffecting`, so the manifest declaration alone reaches the
  // DERIVED floor and these entries prove the typeId path independently.
  //
  // The feature's OTHER graph writers are deliberately NOT here — the
  // `feature.comments.nodes.resolve` judgement. `upsert-commitment`,
  // `ingest-commitments`, `log-decision`, `record-meeting`, `upsert-stakeholder`
  // and `set-commitment-card` derive every id from a tenant-folded content hash,
  // so re-execution converges on the same row and observes nothing new;
  // `populate-board` converges via the commitment's durable `kanbanCardId`
  // back-ref (a human-deleted card is never resurrected) and emits no
  // notification. Recorded as a judgement rather than left as an omission.
  /^feature\.assistant\.nodes\.(compose-briefing|enqueue-action)$/,
  // WF-AKM-1 (ADR 0587 §7) — the agent-knowledge ingest node. One execution
  // chunks, embeds and PERSISTS a KB document under a fresh `randomUUID()`
  // (`features/agent-knowledge/service.ts` → `kbService.ingestDocument`), so a
  // replay that re-executes it writes a SECOND document with a second chunk set
  // and a second embedding pass. It is reachable from an UNTRUSTED webhook (the
  // ADR 0038 §B trigger→workflow auto-ingest chain), which is what makes the
  // duplicate durable and model-recallable rather than merely untidy.
  //
  // Worse than the Comments case: BOTH #2871 legs were missing simultaneously.
  // The manifest declared `role:"action"` — which nothing reads — and five
  // separate docblocks asserted `role:"action"` ⇒ replay-served. It does not:
  // nothing under `src/executor/` compares `role` to the string "action" (a
  // repo-wide grep for that comparison is pinned green by
  // `assistant-node-replay-classification.test.ts`). This entry is
  // the typeId half and must not be separated from the manifest half
  // (`"role": "side-effect"` + the `side-effectful` capability in
  // `packs/feature.agent-knowledge.nodes/pack.json`); a pack `.mjs` node cannot
  // set `module.sideEffecting`, so neither leg substitutes for the other.
  //
  // `feature.agent-knowledge.nodes.retrieve` is deliberately NOT here — it is a
  // pure read and re-executing it observes nothing new.
  /^feature\.agent-knowledge\.nodes\.ingest$/,
  /^core\.openwop\.a2a\.(send|push|cancel|emit|agent-card-publish|server-trigger|multi-turn)/,
  // RFC 0140 — the conformance node that exists solely to perform one real
  // effect (`bootstrap/nodes.ts`, a durable notification through the guarded
  // emitter). Listed here EVEN THOUGH the module also sets
  // `sideEffecting: true`, because the two answer different questions: the flag
  // proves the node self-declares, this entry proves the typeId path works. The
  // scenario's leg 4 asserts the FAST PATH's `replay_source_missing` on a node
  // the source never reached — reachable only via classification.
  /^conformance\.effect\.emit$/,
  // RFC 0140 — the conformance-reserved side-effecting node
  // (`bootstrap/conformanceSideEffectNode.ts`). It emits a real notification,
  // so it belongs here for the same reason `feature.notifications.nodes.notify`
  // does. Listed explicitly even though the module also sets
  // `sideEffecting: true`: the RFC 0140 scenario asserts the FAST PATH serves a
  // recorded outcome / fails closed, and the module flag alone would leave that
  // depending on registration order.
  /^core\.conformance\.side-effect$/,
  // ADR 0563 — `core.storage.blob-put` writes to object storage (a real
  // presigned PUT on the `s3` backend). Its pack manifest already declares
  // `"role": "side-effect"`, but NOTHING READS THAT: `isSideEffectingNode`
  // consults `module.sideEffecting` or this list, and a pack `.mjs` node cannot
  // set the module flag. So the node was classified as pure and the fast path
  // never served its recorded outcome.
  //
  // This entry is HALF of a coupled fix and must not be separated from the
  // other half (the `assertEffectAllowed('blob-write', …)` guard at the blob
  // surface seam). With the guard but no classification, replaying the shipped
  // `starters` chain would hit the BACKSTOP and throw — a backstop firing is a
  // bug report, not a steady state. With classification but no guard, a future
  // blob writer outside this typeId walks straight through again.
  /^core\.storage\.blob-put$/,
  // The `core.openwop.http` senders — the COUPLED classification half of the
  // `ctx.http.safeFetch` seam fix (`host/connectionInjection.ts`), and the same
  // coupling ADR 0563 spelled out for blob-put: with the seam guard alone a
  // replay of these nodes would hit the BACKSTOP and throw, which is a bug
  // report rather than a steady state. Classified here, the fast path serves the
  // source run's recorded outcome and the replay SUCCEEDS.
  //
  // All ten declare `role: "side-effect"` in `packs/core.openwop.http/pack.json`
  // and route through `ctx.http.safeFetch`; only `http.fetch` above was ever
  // listed. Counted from the manifest, not read off the file — the list below is
  // exactly the set the manifest declares and the allowlist did not cover.
  //
  // `graphql-query` is here despite the read verb BECAUSE the manifest says
  // side-effect. That is requirement 4 working as intended: the declaration is
  // binding and the host's judgement about what "query" implies does not get to
  // override it. It is also the verb-not-noun trap in miniature.
  //
  // INTERIM. This is still the hand-maintained mechanism replay.md requirement 4
  // exists to stop us relying on, and the ten entries are the drift it predicts
  // (they sat unclassified for as long as the pack has shipped). The derived
  // manifest floor supersedes this block; it is spelled out here rather than
  // waiting for that change because the defect is live.
  /^core\.openwop\.http\.(openapi-call|graphql-query|graphql-mutation|soap-call|grpc-unary|long-poll|upload-multipart|upload-resumable|retry-rate-limit-aware|circuit-breaker)$/,
];

export function isSideEffectingNode(typeId: string, module?: { sideEffecting?: boolean } | null): boolean {
  // ADR 0572 P3 — the DERIVED manifest set first. Requirement 4's whole point
  // is that a pack's own declaration binds the host without anyone having to
  // remember a regex.
  if (MANIFEST_FAST_PATH_SERVED.has(typeId)) return true;
  if (module?.sideEffecting === true) return true;
  return SIDE_EFFECTING_TYPE_PATTERNS.some((re) => re.test(typeId));
}

/** One node's recorded terminal outcome in the source run's event log. */
export interface SourceNodeOutcome {
  kind: 'completed' | 'failed';
  outputs?: Record<string, unknown>;
  error?: { code: string; message: string };
}

/**
 * Fold a source run's events into `nodeId → ordered terminal outcomes`
 * (a retried node has one entry per attempt — ADR 0326 P3a fidelity: the
 * replay's attempt N reproduces the source's Nth outcome).
 */
export function indexSourceOutcomes(events: ReadonlyArray<{ type: string; nodeId?: string; payload: unknown }>): Map<string, SourceNodeOutcome[]> {
  const byNode = new Map<string, SourceNodeOutcome[]>();
  for (const ev of events) {
    if (!ev.nodeId) continue;
    const p = (ev.payload ?? {}) as { outputs?: unknown; error?: { code?: string; message?: string } };
    if (ev.type === 'node.completed') {
      const list = byNode.get(ev.nodeId) ?? [];
      list.push({
        kind: 'completed',
        outputs: (p.outputs && typeof p.outputs === 'object' && !Array.isArray(p.outputs) ? p.outputs : { output: p.outputs }) as Record<string, unknown>,
      });
      byNode.set(ev.nodeId, list);
    } else if (ev.type === 'node.failed') {
      const list = byNode.get(ev.nodeId) ?? [];
      list.push({
        kind: 'failed',
        error: { code: p.error?.code ?? 'internal_error', message: p.error?.message ?? 'failed in the source run' },
      });
      byNode.set(ev.nodeId, list);
    }
  }
  return byNode;
}
