/**
 * Borrowed-recall resolver (ADR 0044 Phase 2, amended by ADR 0589) — the twin
 * feature's implementation of the host `BorrowedRecallResolver` seam. For a
 * dispatching agent, it is the LIVE authorization gate + the owner-corpus
 * composition:
 *
 *   1. toggle `twin-recall` on for the tenant?            (fail-closed)
 *   2. is the agent LINKED to a user?                     (`twinService.getTwinLink`)
 *   3. is the ACTING CALLER that user?                    (ADR 0589 §D2 — audience)
 *   4. is there an ACTIVE grant from that user?           (`twinService.getActiveGrant`)
 *   5. compose the owner's granted scopes via the SHARED `resolveSubjectKnowledgeRetrieve`
 *      (ADR 0042) over `user:<ownerId>` — memory notes and/or bound KB docs, read
 *      in the OWNER'S HOME TENANT (ADR 0589 §D1b).
 *
 * The returned retriever RE-CHECKS the grant on every call (ADR 0589 / TWIN-3: the
 * consent copy promises revocation is immediate "including on any run already in
 * flight", and a grant captured once into the closure could not deliver that) and
 * audits actual use. Dispatch fences everything it returns (`borrowedRetrieve`),
 * so the owner's content is cited-as-data, never followed as instructions.
 *
 * NO RUN STAMP, deliberately — recall is a live read never frozen into the event
 * log, which is WHY revocation survives a `:fork`. Do not introduce one.
 *
 * Boundary: this reads the owner's `Profile.knowledge` from the profiles feature
 * and the owner's home tenant from the users feature — feature→feature reads, the
 * same pattern `agent-knowledge` uses to read `kb`. Everything else is host-owned.
 *
 * @see docs/adr/0044-twin-cross-subject-recall.md
 * @see docs/adr/0589-twin-tenancy-and-recall-audience.md
 */

import { resolveOne } from '../../host/featureToggles/service.js';
import { getTwinLink, getActiveGrant } from '../../host/twinService.js';
import { getProfile } from '../profiles/profilesService.js';
import { getUser } from '../users/usersService.js';
import { createSubjectMemoryPort, subjectMemoryScope } from '../../host/subjectMemory.js';
import { resolveSubjectKnowledgeRetrieve, type SubjectKnowledgeBinding } from '../../host/agentKnowledgeComposition.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import type { BorrowedRecallContext, BorrowedRecallSource } from '../../host/twinRecallSurface.js';

const TOGGLE_ID = 'twin-recall';
const log = createLogger('feature.twin.borrowedRecall');

/** Why the gate closed. TWIN-6 — `undefined` used to collapse several distinct
 *  states into one silent value, so "why isn't my twin recalling?" was
 *  undiagnosable in production while the sibling knowledge path shipped
 *  `diagnoseAgentKnowledgeRetrieve` for exactly this. */
type BorrowedRecallClosed =
  | 'toggle-off'
  | 'toggle-unreadable'
  | 'not-linked'
  | 'audience-no-caller'
  | 'audience-not-owner'
  | 'no-active-grant'
  | 'owner-unresolvable'
  | 'nothing-granted';

// RCL-5 — closures must be visible at the DEFAULT log level, but this resolver
// runs for EVERY agent on EVERY lane's turn ('toggle-off'/'not-linked' fire for
// every ordinary non-twin agent), so a bare per-call `info` would flood prod.
// Windowed dedupe per (tenant, agent, reason) — the chatContext persona-miss
// pattern: the FIRST occurrence in each window logs at `info` (diagnosable in
// default config), repeats within the window stay `debug`.
const CLOSED_WARN_WINDOW_MS = 10 * 60_000;
const closedLogAt = new Map<string, number>();
function shouldInfoLogClosure(key: string): boolean {
  const nowTs = Date.now();
  if (closedLogAt.size > 500) {
    for (const [k, at] of closedLogAt) if (nowTs - at >= CLOSED_WARN_WINDOW_MS) closedLogAt.delete(k);
  }
  const last = closedLogAt.get(key);
  if (last !== undefined && nowTs - last < CLOSED_WARN_WINDOW_MS) return false;
  closedLogAt.set(key, nowTs);
  return true;
}

// PR #3409 review fold-in (F3) — DENIED rows are rate-bounded per
// (tenant, agent, prober), mirroring the `shouldInfoLogClosure` window above
// (the same flood shape, one layer down): an unbounded per-deny durable write
// was the flood primitive — an innocent teammate's 50-message chat wrote 50
// rows, and a malicious member could both defeat the newest-N replay guard and
// truncate every grantor's reader for free. The FIRST deny in each window
// writes a row; repeats within the window are COUNTED in memory and folded
// into the NEXT row for the same key as `attempts` (that row's own deny plus
// everything suppressed since the last durable row), so the grantor's
// "denied attempts" line still counts honestly — an aggregated count, not N
// rows. Best-effort across restarts (a process recycle drops an unflushed
// tail count), same trade the log window makes; every deny still logs.
const DENIED_ROW_WINDOW_MS = 10 * 60_000;
const deniedRowState = new Map<string, { at: number; suppressed: number }>();
function claimDeniedRowWrite(key: string): { write: boolean; attempts: number } {
  const nowTs = Date.now();
  if (deniedRowState.size > 500) {
    for (const [k, s] of deniedRowState) if (nowTs - s.at >= DENIED_ROW_WINDOW_MS) deniedRowState.delete(k);
  }
  const prior = deniedRowState.get(key);
  if (prior && nowTs - prior.at < DENIED_ROW_WINDOW_MS) {
    prior.suppressed += 1;
    return { write: false, attempts: 0 };
  }
  deniedRowState.set(key, { at: nowTs, suppressed: 0 });
  return { write: true, attempts: 1 + (prior?.suppressed ?? 0) };
}

function closed(reason: BorrowedRecallClosed, tenantId: string, agentId: string): undefined {
  // RCL-5 — the default prod log level is `info` (`observability/logger.ts`),
  // so at `debug` the four commonest closure reasons (toggle-off / not-linked /
  // no-active-grant / nothing-granted) — the states behind every ordinary
  // "why isn't my twin recalling?" — emitted NOTHING in default config,
  // leaving only the audience/owner warns visible.
  if (shouldInfoLogClosure(`${tenantId}|${agentId}|${reason}`)) {
    log.info('twin_recall_closed', { reason, tenantId, agentId });
  } else {
    log.debug('twin_recall_closed', { reason, tenantId, agentId });
  }
  return undefined;
}

export async function resolveBorrowedRecall(
  tenantId: string,
  agentId: string,
  ctx?: BorrowedRecallContext,
): Promise<BorrowedRecallSource | undefined> {
  // 1. toggle — fail-closed on any resolution error. TWIN-18: pass the acting
  // user as well as the tenant, so a `status:'beta'` cohort keyed on a user id
  // resolves the same subject the ROUTE gate resolves (`featureRoute.ts:26-30`).
  // Without it the link/grant UI could be ON while recall was silently OFF.
  // ADR 0666 D3 — a faulted toggle read is NOT the same fact as "the feature is off", and
  // collapsing them was the empty-as-success family this lane's own sentinel forbids
  // (`host/agentRunnerNode.ts`: "a faulted authorization read must never present as 'not
  // granted'"). It stayed fail-closed on CONTENT either way — the defect was silence: the
  // closure reason is log-only and never crosses the seam, so no lane could tell a tenant that
  // opted out from a config store that was down.
  //
  // A clean `false` still closes silently: there is nothing to disclose about a feature the
  // tenant never enabled. A FAULT falls through to the link + grant reads below, which are
  // themselves fail-closed authorization reads, and discloses only if this person actually has
  // an active grant — so the notice is true whenever it appears, and a tenant with the feature
  // genuinely off never sees a spurious one.
  let on = false;
  let toggleUnreadable = false;
  try {
    on = (await resolveOne(TOGGLE_ID, { tenantId, ...(ctx?.callerUserId ? { userId: ctx.callerUserId } : {}) }))?.enabled ?? false;
  } catch (err) {
    toggleUnreadable = true;
    log.warn('twin_recall_toggle_unreadable', {
      tenantId, agentId, error: err instanceof Error ? err.message : String(err),
    });
  }
  if (toggleUnreadable) {
    // CORRECTED after the it.17 grade-code pass — my first draft of D3 let the unreadable case
    // fall through into the MAIN path, and that WIDENED a fabrication instead of closing one.
    //
    // The outage that makes `resolveOne` throw is usually the same store `getTwinLink` reads, so
    // the link read throws too — and that throw escaped this resolver into the two callers'
    // fault sentinels, which push "your owner's shared corpus" into the model's degradation
    // notice. Result: every ordinary agent in a tenant that has NEVER enabled twin-recall would
    // have told the model its owner's corpus could not be read. Pre-D3 that was unreachable,
    // because a toggle fault returned here before any other read. My own comment claimed "a
    // tenant with the feature genuinely off never sees a spurious one" — true of the guarded
    // path I wrote, false of the throw path I opened.
    //
    // So the unreadable case is handled ENTIRELY here and the main path below is untouched:
    // disclose ONLY on positive evidence of a grant, and treat any failure to establish that
    // evidence as silence. A failed link read says nothing about whether this person granted
    // anything, and a notice about an owner who does not exist is the same fabrication family
    // this decision exists to close.
    try {
      const faultLink = await getTwinLink(tenantId, agentId);
      if (!faultLink) return closed('not-linked', tenantId, agentId);
      const [faultGrant, faultOwner] = await Promise.all([
        getActiveGrant(tenantId, agentId, faultLink.userId),
        getUser(faultLink.userId),
      ]);
      if (!faultGrant) return closed('no-active-grant', tenantId, agentId);
      // Positive evidence: this person holds a live grant, so silence would be the dishonest
      // answer. Reuses the fault SENTINEL shape `host/agentRunnerNode.ts` already ships, so
      // every lane's existing `onSourceError` path fires and no seam changes.
      log.warn('twin_recall_degraded_toggle_unreadable', { tenantId, agentId, ownerUserId: faultLink.userId });
      const faultOwnerName = faultOwner?.displayName?.trim();
      return {
        retrieve: async (_query, onSourceError) => { onSourceError?.('kb'); return []; },
        ownerUserId: faultLink.userId,
        ...(faultOwnerName ? { ownerName: faultOwnerName } : {}),
      };
    } catch (err) {
      // Could not establish a grant ⇒ SILENCE, the pre-D3 behaviour. Logged so the outage is
      // diagnosable, using the reason the union already declares for it.
      log.warn('twin_recall_toggle_unreadable_unverifiable', {
        tenantId, agentId, error: err instanceof Error ? err.message : String(err),
      });
      return closed('toggle-unreadable', tenantId, agentId);
    }
  }
  if (!on) return closed('toggle-off', tenantId, agentId);

  // 2. live LINK, in the DISPATCH (active) tenant — the tenant the agent lives in
  // and the tenant the grant is now filed under (ADR 0589 §D1).
  const link = await getTwinLink(tenantId, agentId);
  if (!link) return closed('not-linked', tenantId, agentId);

  // 3. AUDIENCE (ADR 0589 §D2). Borrowed recall had no per-caller authorization
  // at all: every member of the tenant who could address a granted twin received
  // answers grounded in one named person's private memory, while the sibling leg
  // in the SAME `Promise.all` (`chatContext.ts:197-200`) re-resolved the caller.
  // The consent UI never discloses an audience ("Allow {{persona}} to recall your
  // memory"), so a workspace-wide audience was never consented to. Deny by
  // default — including when NO caller can be identified, because an unattributed
  // dispatch lands in a workspace-visible run record: the same exposure with less
  // information about it.
  const caller = ctx?.callerUserId;
  if (!caller) {
    log.warn('twin_recall_denied_audience', { reason: 'no_caller', tenantId, agentId, ...(ctx?.runId ? { runId: ctx.runId } : {}) });
    return closed('audience-no-caller', tenantId, agentId);
  }
  if (caller !== link.userId) {
    log.warn('twin_recall_denied_audience', { reason: 'not_owner', tenantId, agentId, ...(ctx?.runId ? { runId: ctx.runId } : {}) });
    // RCL-3(a) / WF-RCL-3 — the DENY a grantor most wants to see: a different
    // person probing their granted twin. Durable, not log-only (ADR 0044 §5:
    // "EVERY cross-subject recall emits an audit row" — an attempt is a recall
    // event even when it yields nothing). Only THIS deny reason writes rows (a
    // real identified person probing), never the toggle-off / not-linked /
    // no-grant closures every ordinary turn hits — and even this reason is
    // RATE-BOUNDED per (tenant, agent, prober): reason-scoping bounds WHO can
    // write, not HOW OFTEN, and per-deny rows were the flood primitive (F3).
    // `attempts` carries the window's aggregate so nothing is undercounted.
    // Best-effort with the named failure event (never blocks the deny).
    const denyClaim = claimDeniedRowWrite(`${tenantId}|${agentId}|${caller}`);
    if (denyClaim.write) {
      try {
        await hostExtStorage().appendAudit({
          timestamp: new Date().toISOString(),
          principalId: caller,
          action: 'twin.recall',
          resource: `user:${link.userId}`,
          outcome: 'denied',
          payload: {
            agentId,
            tenantId, // RCL-UX-8 — without this the governance viewer withholds the row from tenant-scoped superadmins (fail-closed)
            reason: 'audience-not-owner',
            // 1 = this deny; >1 folds in denies suppressed since this
            // prober's last durable row (the F3 window aggregate).
            attempts: denyClaim.attempts,
            ...(ctx?.runId ? { runId: ctx.runId } : {}),
          },
        });
      } catch (err) {
        log.error('twin_recall_audit_failed', {
          tenantId, agentId, ownerId: link.userId,
          ...(ctx?.runId ? { runId: ctx.runId } : {}),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return closed('audience-not-owner', tenantId, agentId);
  }

  // 4. active GRANT — read CONCURRENTLY with the owner-user row (RCL-8): the
  // two are independent (both keyed off the link), and this resolver sits on
  // the per-turn hot path of every lane; serializing them was one free
  // round-trip per twin turn. The user read is only CONSUMED after the grant
  // check below, so authorization semantics are unchanged.
  const [grant, ownerUser] = await Promise.all([
    getActiveGrant(tenantId, agentId, link.userId),
    getUser(link.userId),
  ]);
  if (!grant) return closed('no-active-grant', tenantId, agentId);


  // 5. compose the owner's granted scopes (memory notes + bound KB docs).
  //
  // ADR 0589 §D1b — the CORPUS is read in the OWNER'S HOME TENANT, not the
  // dispatch tenant. A person's memory notes and their `Profile` row (which holds
  // `knowledge.collectionIds`) live under their home tenant BY DESIGN (ADR 0042 /
  // GC-7 — and `Profile` is keyed by `userId` ALONE, so it exists in exactly ONE
  // tenant). Reading them under the dispatch tenant returned zero chunks, no error
  // and no degradation notice in every shared workspace — the fabrication shape.
  // The read is authorized by the owner's own grant, resolved above in the
  // dispatch tenant. NOTE this uses the READ-ONLY `profilesService.getProfile`; it
  // must never be switched to `profileKnowledgeService.getProfileKnowledge`, whose
  // prune-on-read would turn a widened tenant into a data-loss machine (GC-7).
  // D1b review fold-in — DENY when the owner's home tenant cannot be resolved.
  // This was `?? tenantId`: a missing `getUser` row silently pointed the corpus
  // read at the DISPATCH tenant, where the owner's notes/profile do not live, so
  // every source returned zero chunks with no error — empty-as-success, the exact
  // shape D1b exists to kill, reintroduced by its own fallback.
  const ownerHome = ownerUser?.tenantId;
  if (!ownerHome) {
    log.warn('twin_recall_owner_unresolvable', { tenantId, agentId, ownerId: link.userId, ...(ctx?.runId ? { runId: ctx.runId } : {}) });
    return closed('owner-unresolvable', tenantId, agentId);
  }
  const wantKnowledge = grant.scopes.includes('knowledge');
  const wantMemory = grant.scopes.includes('memory');
  const sources: ('kb' | 'memory')[] = [...(wantKnowledge ? (['kb'] as const) : []), ...(wantMemory ? (['memory'] as const) : [])];
  const ownerProfile = wantKnowledge ? await getProfile(ownerHome, link.userId) : null;
  const binding: SubjectKnowledgeBinding = {
    collectionIds: wantKnowledge ? (ownerProfile?.knowledge?.collectionIds ?? []) : [],
    retrieval: { sources },
  };
  const memory = createSubjectMemoryPort(ownerHome);
  // The memory scope mirrors the WRITER's convention exactly: the profile-memory
  // routes scope by the full `User.userId` (`features/profile-memory/routes.ts:33`).
  const retrieve = resolveSubjectKnowledgeRetrieve(ownerHome, binding, memory, subjectMemoryScope({ kind: 'user', id: link.userId }));
  if (!retrieve) return closed('nothing-granted', tenantId, agentId);

  const ownerId = link.userId;
  // RCL-3(c) — the scopes the ROW must record are the RESOLVE-TIME ones: the
  // retriever composed above reads the sources derived from THIS grant object,
  // and the per-retrieval re-read below is an EXISTENCE check (revocation),
  // not a re-composition. Recording the live re-read's scopes misattributed a
  // mid-turn narrowing re-grant — the ledger claimed less was read than was.
  const grantedScopes = grant.scopes;
  const grantedVersion = grant.version;
  // RCL-3 (design verdict) — ONE row per resolver-grant-success DISPATCH, not
  // per retrieval (bounds volume; a multi-retrieval turn is one consent event).
  let audited = false;
  // WF-TWIN-2 / TWIN-4 — the wrapper MUST declare and forward `onSourceError`. A
  // 1-ary function is assignable to the 2-ary `AgentKnowledgeRetrieve` type, so a
  // narrower wrapper silently swallowed the sink with ZERO compile signal, and a
  // FAULTED read of another human's corpus was presented to the model as "your
  // owner has nothing on record." Do not re-narrow this arity.
  const wrapped = async (query: string, onSourceError?: (source: 'kb' | 'memory') => void) => {
    // TWIN-3 — RE-READ the grant per retrieval. The four locales promise
    // revocation is effective "immediately — including on any run already in
    // flight"; a grant captured once into this closure served every retrieve for
    // the rest of the turn, so the turn in flight was NOT cut off. This is the
    // cheapest way to make the copy true, and it introduces no run stamp (the
    // no-stamp design is why revocation already survives a `:fork`).
    const live = await getActiveGrant(tenantId, agentId, ownerId);
    if (!live) {
      log.info('twin_recall_revoked_mid_turn', { tenantId, agentId, ...(ctx?.runId ? { runId: ctx.runId } : {}) });
      return [];
    }
    const chunks = await retrieve(query, onSourceError);
    // RCL-3(a) — AUDIT THE ATTEMPT, not the hit. This used to be gated on
    // `chunks.length > 0`, while ADR 0044 §5 says "EVERY cross-subject recall
    // emits an audit row": a zero-match query still READ the owner's corpus.
    // The row means "the corpus was read under this grant on this dispatch" —
    // its `chunks` count is the first retrieval's yield.
    if (!audited) {
      audited = true;
      try {
        // WF-TWIN-6 — ADR 0044 §5 keys the row by {runId, agentId, twin.userId,
        // grantVersion}; `principalId` is the HUMAN who asked, never the agent.
        //
        // RCL-3(d), rekeyed by the PR #3409 review (F1) — the replay guard: a
        // re-execution of the SAME DISPATCH (crash-resume replay re-runs the
        // node under the run's own id; a retried exchange recomputes the same
        // turn index) must not duplicate the row. Checked durably (the closure
        // flag above only covers one dispatch's lifetime). The identity is
        // (runId, dispatchId, agentId, owner) — bare (runId, agentId, owner)
        // suppressed every chat turn after the first (one conversation = ONE
        // run) and every later agent node in a multi-node run: the consent
        // ledger undercounted by design on the primary lane. A `:fork` mints a
        // NEW runId and its node re-execution REALLY re-reads the corpus live
        // (the no-stamp design), so a fresh row under the fork's runId is an
        // honest record of a real read — deliberately NOT deduped.
        const dup = ctx?.runId ? await recallRowExists(ctx.runId, ctx.dispatchId, agentId, ownerId) : false;
        if (!dup) {
          await hostExtStorage().appendAudit({
            timestamp: new Date().toISOString(),
            principalId: caller,
            action: 'twin.recall',
            resource: `user:${ownerId}`,
            outcome: 'ok',
            payload: {
              agentId,
              tenantId, // RCL-UX-8 — the governance viewer's tenant filter withholds unstamped rows fail-closed
              scopes: grantedScopes,
              grantVersion: grantedVersion,
              chunks: chunks.length,
              ...(ctx?.runId ? { runId: ctx.runId } : {}),
              ...(ctx?.dispatchId ? { dispatchId: ctx.dispatchId } : {}),
            },
          });
        }
      } catch (err) {
        // WF-TWIN-7 — a bare `catch {}` on a privacy surface loses the deliverable
        // silently: the audit row IS what makes consent reviewable. Still
        // best-effort (never block the turn), but never invisible.
        log.error('twin_recall_audit_failed', {
          tenantId, agentId, ownerId,
          ...(ctx?.runId ? { runId: ctx.runId } : {}),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return chunks;
  };
  // RCL-6 / WF-RCL-5 — return the OWNER'S IDENTITY with the retriever, so the
  // composition sites can name whose shared memory the fenced items came from
  // (already consented disclosure — the link UI names the owner, and post-D2
  // the acting caller IS the owner).
  const ownerName = ownerUser?.displayName?.trim();
  return { retrieve: wrapped, ownerUserId: ownerId, ...(ownerName ? { ownerName } : {}) };
}

/** RCL-3(d) / F1+F2a — does an `ok` recall row for this (runId, dispatchId,
 *  agentId, owner) already exist? The read is SUBJECT-PUSHED-DOWN
 *  (`resource: user:<ownerId>`, indexed): the previous host-global
 *  newest-200 window failed OPEN once 200 unrelated `twin.recall` rows
 *  landed between a dispatch and its replay — review-probed with a duplicate
 *  ok row at 205 rows of noise. The remaining window is over the OWNER'S OWN
 *  rows only, where a replayed dispatch's prior row is by construction
 *  recent. `dispatchId` matching is exact INCLUDING absence: a row written
 *  without one (pre-fold-in rows, the ad-hoc lane) only dedupes a context
 *  without one — never a genuinely new turn/node dispatch.
 *  Best-effort by placement (called inside the audit `try`): a failed check
 *  falls through to the normal best-effort write path. */
async function recallRowExists(runId: string, dispatchId: string | undefined, agentId: string, ownerId: string): Promise<boolean> {
  const rows = await hostExtStorage().listAudit({ actionPrefix: 'twin.recall', resource: `user:${ownerId}`, limit: 200 });
  return rows.some((r) => {
    if (r.resource !== `user:${ownerId}` || r.outcome !== 'ok') return false;
    const p = r.payload as { runId?: unknown; agentId?: unknown; dispatchId?: unknown } | undefined;
    return p?.runId === runId && p?.agentId === agentId && (p?.dispatchId ?? undefined) === dispatchId;
  });
}
