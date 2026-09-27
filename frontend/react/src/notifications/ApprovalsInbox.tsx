/**
 * Approvals inbox — the DETAILED approval console on ProfilePage (+ the
 * dashboard tile). R2 IB-SP-13 correction: this component was REPLACED on
 * /inbox by NeedsYouInbox (the compact per-persona cards); the old docblock
 * still claimed it was "the ONE approval surface embedded in /inbox" — a
 * past-tense claim outliving the code. Both surfaces now share the same
 * kind discrimination + toast ladder; if they drift again, fold them.
 */

import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { formatCurrencyMinor, formatDateTime } from '../i18n/format.js';
import { DataTable, type DataColumn } from '../ui/DataTable.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { toast } from '../ui/toast.js';
import { ScaleIcon, CheckIcon, XIcon, RotateCwIcon } from '../ui/icons/index.js';
import { ContentReviewContext, ApprovalDecideBar } from './ContentReviewContext.js';
import {
  listApprovals,
  listApprovalsByKind,
  claimApproval,
  rejectApproval,
  editAssistantAction,
  approvalErrorInfo,
  type PendingApproval,
  type AssistantActionView,
} from '../agents/approvalsClient.js';
import { workflowName } from '../agents/roleTemplates.js';
import { relativeTime } from '../agents/agentViewModel.js';
import { Avatar } from '../ui/Avatar.js';
import { loadOrgMembers } from '../orgs/orgMembers.js';

const isAssistantAction = (a: PendingApproval): boolean => a.kind === 'assistant-action' || !!a.actionId;
const isContentPublish = (a: PendingApproval): boolean => a.kind === 'content-publish';
const isCampaignSpend = (a: PendingApproval): boolean => a.kind === 'campaign-spend';
/** R2 UCP-P2-B1 — commerce-spend (an agent purchase) fell into the catch-all RUN
 *  table, which renders "run workflow «name»" from a `workflowId` these rows leave
 *  EMPTY. The one screen that authorizes an agent to spend money rendered it as a
 *  malformed workflow row. */
const isCommerceSpend = (a: PendingApproval): boolean => a.kind === 'commerce-spend';

/** CMPUX-19: humanize the ad-platform id (`google`/`google_ads` → "Google Ads",
 *  `meta` → "Meta Ads", …) by reusing campaign-intel's existing `platform_*`
 *  labels (no new i18n keys — the shared i18n chunk is at its budget ceiling).
 *  Falls back to the raw id for an unknown platform so nothing is ever dropped. */
function platformLabel(t: ReturnType<typeof useTranslation>['t'], raw: string): string {
  const key = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const norm = key === 'google_ads' ? 'google' : key;
  return t(`platform_${norm}`, { ns: 'campaign-intel', defaultValue: raw });
}
const isStrategyActivation = (a: PendingApproval): boolean => a.kind === 'strategy-activation';
// PMXU-2 (ADR 0590) — agent-proposed Priority-Matrix scenarios get their own
// group (they fell into the run-proposal catch-all, whose chrome + approved
// toast — "{{persona}} is running it now" — are wrong for a row that runs
// nothing: approve adopts the scenario as plan of record).
const isScenarioSelect = (a: PendingApproval): boolean => a.kind === 'pm-scenario-select';

/** SECURITY — source URLs come from provider-derived (explicitly untrusted)
 *  content; only http(s) schemes may bind to an href (a `javascript:` URL
 *  would execute on click). Anything else renders as plain text. */
const safeHref = (u?: string): string | undefined => (u && /^https?:\/\//i.test(u) ? u : undefined);

function destinationOf(action: AssistantActionView): string | null {
  const to = action.payload?.to;
  if (Array.isArray(to)) return to.filter((x): x is string => typeof x === 'string').join(', ');
  return typeof to === 'string' ? to : null;
}

/**
 * Rich action card (ADR 0023 §12 T4): kind + destination, risk tier, taint
 * banner, draft preview, recipient diff, why-recommended, source citations —
 * everything an approver needs to decide an outbound action with confidence.
 */
function ActionCard({ approval, busy, onApprove, onReject, onSaveEdit }: {
  approval: PendingApproval;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onSaveEdit: (draft: string) => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation('notifications');
  const action = approval.action;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(action?.draft ?? '');

  // The action vanished between list and render (rare race) — fall back to the
  // approval's one-line summary so the row is still actionable.
  if (!action) {
    return (
      <article className="surface-card u-grid u-gap-2">
        <header className="u-flex u-items-center u-gap-2">
          <strong>{approval.persona}</strong>
          <span className="muted u-fs-12">{approval.proposal}</span>
        </header>
        <span className="action-bar">
          <Button variant="primary" size="sm" disabled={busy} onClick={onApprove}>
            <CheckIcon size={13} /> {t('approveLabel')}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onReject}>
            <XIcon size={13} /> {t('rejectLabel')}
          </Button>
        </span>
      </article>
    );
  }

  const destination = destinationOf(action);
  return (
    <article className="surface-card u-grid u-gap-2">
      <header className="u-flex u-items-center u-gap-2">
        <strong>{approval.persona}</strong>
        <span className="chip">{action.kind}</span>
        {action.riskLevel ? (
          // Severity rides the functional-token axis with a visible label
          // (DESIGN.md §5.3) — chips, not run-state strings: high reads danger,
          // medium warning, low neutral (never success-green).
          <span className={`chip ${action.riskLevel === 'high' ? 'chip--danger' : action.riskLevel === 'medium' ? 'chip--warning' : 'chip--muted'}`}>
            {t('riskChip', { level: action.riskLevel })}
          </span>
        ) : null}
        {action.derivedFromUntrusted ? <span className="chip chip--muted">{t('derivedFromUntrusted')}</span> : null}
        {action.editedAt ? <span className="chip chip--muted">{t('editedAt', { when: formatDateTime(action.editedAt) })}</span> : null}
      </header>
      {destination ? <p className="muted u-m-0">{t('destinationTo', { destination })}</p> : null}
      {editing ? (
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} aria-label={t('editDraftLabel')} />
      ) : (
        <p className="u-m-0">{action.draft}</p>
      )}
      {action.recipientDiff ? (
        <p className="muted u-m-0">
          {t('recipientsPrefix')}{action.recipientDiff.before.join(', ') || t('recipientsEmpty')} → <strong>{action.recipientDiff.after.join(', ') || t('recipientsEmpty')}</strong>
        </p>
      ) : null}
      {action.reason ? <p className="muted u-m-0">{t('whyPrefix', { reason: action.reason })}</p> : null}
      {action.sourceRefs && action.sourceRefs.length > 0 ? (
        <p className="muted u-m-0">
          {t('sourcesPrefix')}
          {action.sourceRefs.map((s, i) => (
            <span key={`${s.externalId}-${i}`}>
              {i > 0 ? ' · ' : ''}
              {safeHref(s.url) ? <a href={safeHref(s.url)} target="_blank" rel="noreferrer">{s.kind}</a> : s.kind}
            </span>
          ))}
        </p>
      ) : null}
      <span className="action-bar">
        {editing ? (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => { void onSaveEdit(draft).then(() => setEditing(false)); }}>{t('saveEdit')}</Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => { setDraft(action.draft); setEditing(false); }}>{t('common:cancel')}</Button>
          </>
        ) : (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={onApprove}>
              <CheckIcon size={13} /> {t('approveLabel')}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={onReject}>
              <XIcon size={13} /> {t('rejectLabel')}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(true)}>{t('common:edit')}</Button>
          </>
        )}
      </span>
    </article>
  );
}

/**
 * SGU-1 — one decided strategy-activation row's accountability line: an avatar +
 * "Approved/Rejected by {name} on {date}". `decidedBy` is an opaque principal;
 * it is name-resolved by the caller (`memberName`) and, when unresolvable, falls
 * back to a neutral label — never the raw `user:<hash>`. When there is no
 * recorded decider (system/agent-resolved), the name is dropped entirely.
 */
function DecidedRow({ a, memberName, t }: {
  a: PendingApproval;
  memberName: ReadonlyMap<string, string>;
  t: ReturnType<typeof useTranslation>['t'];
}): JSX.Element {
  const approved = a.status === 'approved';
  const when = formatDateTime(a.resolvedAt ?? a.createdAt);
  const resolvedName = a.decidedBy ? memberName.get(a.decidedBy) : undefined;
  // decidedBy present but unresolved ⇒ neutral label (never the hash); absent ⇒ no actor.
  const name = a.decidedBy ? (resolvedName ?? t('approvalsDecidedByUnknown')) : null;
  const line = name
    ? t(approved ? 'approvedByOn' : 'rejectedByOn', { name, date: when })
    : t(approved ? 'approvedOn' : 'rejectedOn', { date: when });
  return (
    <article className="surface-card u-grid u-gap-2">
      <div className="u-flex u-items-center u-gap-2">
        <span className="u-flex-1">{a.proposal}</span>
        <span className={`chip ${approved ? 'chip--success' : 'chip--muted'}`}>
          {t(approved ? 'approvalsDecidedApproved' : 'approvalsDecidedRejected')}
        </span>
      </div>
      <div className="u-flex u-items-center u-gap-2 muted u-fs-12">
        {resolvedName ? <Avatar name={resolvedName} hueKey={a.decidedBy} size={20} /> : null}
        <span>{line}</span>
      </div>
    </article>
  );
}

export function ApprovalsInbox({ onResolved }: { onResolved?: () => void }): JSX.Element {
  const { t } = useTranslation('notifications');
  const nav = useNavigate();
  const [items, setItems] = useState<PendingApproval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // SGU-1 (ADR 0230 §B3) — recently-DECIDED strategy-activation rows + a
  // subject→displayName map so a governance decision shows WHO signed it off and
  // WHEN. Kept separate from `items` (the live pending queue) so the action
  // groups never render a decided row with live approve/reject buttons.
  const [decided, setDecided] = useState<PendingApproval[] | null>(null);
  const [memberName, setMemberName] = useState<ReadonlyMap<string, string>>(new Map());

  const refresh = useCallback(async () => {
    try {
      setItems(await listApprovals('pending'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Load resolved strategy-activation decisions (a single unfiltered read, then
  // client-side narrowed to this kind) and resolve each decider's opaque
  // principal id to a display name via the org-member cache — NEVER render the
  // raw `user:<hash>` (and never the member email — the RTCC-4 PII lesson).
  const refreshDecided = useCallback(async () => {
    try {
      // BOUNDED read (review finding 1): only this kind's most-recent rows,
      // server-filtered + capped — never the tenant's whole approval history.
      const recent = await listApprovalsByKind('strategy-activation', { limit: 10 });
      const rows = recent
        .filter((a) => a.status !== 'pending' && !!a.resolvedAt)
        .sort((a, b) => (a.resolvedAt! < b.resolvedAt! ? 1 : -1))
        .slice(0, 5);
      setDecided(rows);
      // Per-org name resolution is a SECONDARY read feeding a display name: it may
      // fail soft (an unresolvable org just leaves those subjects to the neutral
      // "a workspace member" label — never the raw hash), so a failure here is
      // swallowed per-org WITHOUT minting an empty list for the whole group (the
      // failed-read-as-empty family this repo ratchets — check-failed-read-sentinels).
      const orgIds = [...new Set(rows.map((r) => r.orgId).filter((id): id is string => !!id))];
      const map = new Map<string, string>();
      for (const id of orgIds) {
        try {
          for (const m of await loadOrgMembers(id)) if (m.subject) map.set(m.subject, m.displayName);
        } catch { /* best-effort: an unresolved org falls back to the neutral label */ }
      }
      setMemberName(map);
    } catch {
      // Provenance is a best-effort enhancement over the live pending queue. The
      // decided-history group's render is guarded on `decided.length > 0`, so a
      // failed read simply leaves the group ABSENT — it never claims "no recent
      // decisions" (the LIST-level failed-read-as-empty this repo tracks). Leave
      // `decided` untouched (null on first load, or the prior value on refresh).
    }
  }, []);

  useEffect(() => { void refresh(); void refreshDecided(); }, [refresh, refreshDecided]);

  // ADR 0593 D3 (CMSAU-2) — ONE mapper for decide failures, so this surface and
  // the CMS header render the SAME localized sentence for the same backend
  // state. The stale-review 409 used to arrive here as `claimApproval returned
  // 409` — the gate's most important safeguard, shown as a dev string.
  const decideError = useCallback((err: unknown, fallbackKey: string): string => {
    const info = approvalErrorInfo(err);
    if (info) return t(info.key, info.options ?? {});
    return err instanceof Error && err.message ? err.message : t(fallbackKey);
  }, [t]);

  const claim = useCallback(async (a: PendingApproval) => {
    setBusy(a.approvalId);
    try {
      const { runId } = await claimApproval(a.approvalId);
      toast.success(
        isContentPublish(a)
          ? t('toastApprovedPublished')
          : isStrategyActivation(a)
            ? t('toastApprovedActivated')
            // PMXU-2 (ADR 0590) — a scenario approve runs nothing: it adopts
            // the plan of record. The catch-all "running it now" toast lied.
            : isScenarioSelect(a)
              ? t('toastApprovedScenario')
            : isAssistantAction(a)
              ? t('toastApprovedCarry', { persona: a.persona })
              // R2 UCP-P2-B1 (review M-6) — commerce-spend fell to "Approved — {{persona}}
              // is running it now", with an EMPTY persona, on rows where nothing runs:
              // the human still has to place the purchase. Say what actually happens.
              : isCommerceSpend(a)
                ? t('toastApprovedSpend')
                : t('toastApprovedRunning', { persona: a.persona }),
      );
      await refresh();
      if (isStrategyActivation(a)) void refreshDecided(); // surface the fresh decision's provenance
      onResolved?.();
      // Only a run-proposal yields a run to navigate to; an assistant-action
      // returns { actionId } and has no run page (it decides the draft in place).
      if (runId) nav(`/runs/${encodeURIComponent(runId)}`);
    } catch (err) {
      toast.error(decideError(err, 'toastCouldNotClaim'));
    } finally {
      setBusy(null);
    }
  }, [refresh, refreshDecided, onResolved, nav, t, decideError]);

  // ADR 0593 D4 (CMSAU-5) — `note` is the reviewer's REASON. Rejection used to
  // notify nobody and record nothing: the submitter's page silently read
  // `draft`, indistinguishable from never-submitted, while `note` rode the wire
  // with no writer on this surface and no reader anywhere.
  const reject = useCallback(async (a: PendingApproval, note?: string): Promise<boolean> => {
    setBusy(a.approvalId);
    try {
      await rejectApproval(a.approvalId, note);
      // R2 IB-SP-4's honesty ladder reached APPROVE only; reject stayed
      // kind-blind ("Proposal dismissed.") for a decision that returns a page to
      // draft and fires a rejection event.
      // SGU-3 — say what actually happened. Rejecting a strategy activation leaves the
      // strategy in `draft` and it can be resubmitted (verified in
      // `features/strategy/activationApproval.ts`: "reject leaves it draft"); the
      // kind-blind "Proposal dismissed." read as terminal.
      toast.info(
        isContentPublish(a) ? t('toastRejectedToDraft')
          : isStrategyActivation(a) ? t('toastStrategyRejectedToDraft')
            : t('toastProposalDismissed'),
      );
      await refresh();
      if (isStrategyActivation(a)) void refreshDecided(); // surface the fresh decision's provenance
      onResolved?.();
      return true;
    } catch (err) {
      // F7(5) — report the failure so the reason step stays open with the
      // typed text intact, instead of vanishing under its own error toast.
      toast.error(decideError(err, 'toastCouldNotReject'));
      return false;
    } finally {
      setBusy(null);
    }
  }, [refresh, refreshDecided, onResolved, t, decideError]);

  const saveEdit = useCallback(async (a: PendingApproval, draft: string) => {
    if (!a.actionId) return;
    setBusy(a.approvalId);
    try {
      await editAssistantAction(a.actionId, { draft });
      toast.success(t('toastDraftUpdated'));
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastEditFailed'));
      throw err;
    } finally {
      setBusy(null);
    }
  }, [refresh, t]);

  const columns: DataColumn<PendingApproval>[] = [
    {
      key: 'persona',
      header: t('approvalsColAgent'),
      width: '140px',
      render: (a) => <strong>{a.persona}</strong>,
      sortValue: (a) => a.persona,
    },
    {
      key: 'proposal',
      header: t('approvalsColProposes'),
      width: '1fr',
      render: (a) => (
        <div>
          <div><Trans t={t} i18nKey="approvalsRunWorkflow" values={{ name: workflowName(a.workflowId) }} components={{ 1: <strong /> }} /></div>
          {a.cardTitle && <div className="muted u-fs-12">{t('approvalsOnCard', { title: a.cardTitle })}</div>}
        </div>
      ),
    },
    {
      key: 'createdAt',
      header: t('approvalsColProposed'),
      width: '120px',
      cellClassName: 'muted',
      render: (a) => relativeTime(a.createdAt),
      sortValue: (a) => a.createdAt,
    },
    {
      key: 'actions',
      header: '',
      width: '200px',
      align: 'right',
      render: (a) => (
        <div className="action-bar u-justify-end">
          <Button variant="accent-solid" size="sm" onClick={() => void claim(a)} disabled={busy === a.approvalId}>
            <CheckIcon size={13} /> {t('approveAndRun')}
          </Button>
          <Button variant="secondary" onClick={() => void reject(a)} disabled={busy === a.approvalId}>
            <XIcon size={13} /> {t('rejectLabel')}
          </Button>
        </div>
      ),
    },
  ];

  // Empty + settled: collapse to a single discoverable line rather than a full
  // card, so the inbox isn't dominated by an empty section for users who never
  // enable review mode. SGU-1: do NOT collapse when there are recent decisions
  // to account for — the decided-history group must survive an empty queue.
  if (items !== null && items.length === 0 && !error && (decided === null || decided.length === 0)) {
    return (
      <div className="card u-flex u-items-center u-gap-2 u-fs-12">
        <ScaleIcon size={14} />
        <span className="muted">
          {t('approvalsEmpty')}
        </span>
      </div>
    );
  }

  const actions = items?.filter(isAssistantAction) ?? [];
  const contentPublish = items?.filter(isContentPublish) ?? [];
  const campaignSpend = items?.filter(isCampaignSpend) ?? [];
  const strategyActivation = items?.filter(isStrategyActivation) ?? [];
  const scenarioSelect = items?.filter(isScenarioSelect) ?? [];
  const commerceSpend = items?.filter(isCommerceSpend) ?? [];
  const runs = items?.filter((a) => !isAssistantAction(a) && !isContentPublish(a) && !isCampaignSpend(a) && !isCommerceSpend(a) && !isStrategyActivation(a) && !isScenarioSelect(a)) ?? [];

  return (
    <div className="card">
      <div className="u-flex u-items-center u-gap-2 u-mb-2">
        <ScaleIcon size={16} />
        <h2 className="u-flex-1 u-m-0">{t('approvalsTitle')}</h2>
        {items && items.length > 0 && <span className="chip chip--warning">{t('approvalsPending', { count: items.length })}</span>}
      </div>
      <p className="muted approvals-lede">
        {t('approvalsLede')}
      </p>

      {/* AST-UX-3: a failed FIRST load must not render as a permanent skeleton.
          When the read failed and nothing came back (items still null), show an
          announced failure state with Retry — not a skeleton that never resolves.
          A failure on REFRESH (items already shown) keeps the assertive Notice,
          because that is an action-initiated error, not a load. */}
      {error && items !== null && <Notice variant="error" announce={error}>{error}</Notice>}
      {items === null ? (
        error ? (
          <StateCard
            icon={<ScaleIcon size={26} />}
            title={t('approvalsLoadFailedTitle')}
            body={error}
            announce
            action={
              <Button variant="secondary" onClick={() => void refresh()}>
                <RotateCwIcon size={16} /> {t('approvalsRetry')}
              </Button>
            }
          />
        ) : (
          <SkeletonRows rows={2} columns={['140px', '1fr', '120px', '200px']} />
        )
      ) : (
        <div className="u-grid u-gap-3">
          {contentPublish.length > 0 && (
            <div className="u-grid u-gap-2">
              <h3 className="u-m-0 u-fs-12 muted">{t('approvalsContentGroup')}</h3>
              {contentPublish.map((a) => (
                // u-grid stacks the action-bar below the proposal so the row
                // degrades gracefully on narrow viewports (matches ActionCard).
                <article key={a.approvalId} className="surface-card u-grid u-gap-2">
                  <div className="u-flex u-items-center u-gap-2">
                    <span className="u-flex-1">{a.proposal}</span>
                    <span className="muted u-fs-12">{relativeTime(a.createdAt)}</span>
                  </div>
                  {/* ADR 0593 D4 (CMSAU-1/-4/-18) — the reviewer's context: the
                      page they are signing off, the version it is pinned to, and
                      any machine-drafted overlays. */}
                  <ContentReviewContext a={a} />
                  <ApprovalDecideBar
                    busy={busy === a.approvalId}
                    onApprove={() => void claim(a)}
                    onReject={(note) => reject(a, note)}
                  />
                </article>
              ))}
            </div>
          )}
          {strategyActivation.length > 0 && (
            <div className="u-grid u-gap-2">
              <h3 className="u-m-0 u-fs-12 muted">{t('approvalsStrategyGroup')}</h3>
              {strategyActivation.map((a) => (
                // Strategy activation sign-off (ADR 0230 §B3): approving
                // transitions the strategy draft→active; rejecting leaves it
                // draft. Same card shape as the content-publish group.
                <article key={a.approvalId} className="surface-card u-grid u-gap-2">
                  <div className="u-flex u-items-center u-gap-2">
                    <span className="u-flex-1">{a.proposal}</span>
                    <span className="muted u-fs-12">{relativeTime(a.createdAt)}</span>
                  </div>
                  {/* SGU-2 — the SAME decide bar the content group uses. Rejecting an
                      activation sends a strategy back to draft, which is a decision its
                      author will want a reason for; the bare buttons here also lacked the
                      focus-restore and keep-the-text-on-failure behaviour that bar earned
                      through two bugs. Same inbox, same consequence, same affordance. */}
                  <ApprovalDecideBar
                    busy={busy === a.approvalId}
                    onApprove={() => void claim(a)}
                    onReject={(note) => reject(a, note)}
                  />
                </article>
              ))}
            </div>
          )}
          {/* SGU-1 (ADR 0230 §B3) — recently-decided strategy activations with
              on-screen accountability: who signed it off, and when. A governance
              gate with zero visible provenance was the ord-225 Blocker. */}
          {decided && decided.length > 0 && (
            <div className="u-grid u-gap-2">
              <h3 className="u-m-0 u-fs-12 muted">{t('approvalsStrategyDecidedGroup')}</h3>
              {decided.map((a) => (
                <DecidedRow key={a.approvalId} a={a} memberName={memberName} t={t} />
              ))}
            </div>
          )}
          {scenarioSelect.length > 0 && (
            <div className="u-grid u-gap-2">
              <h3 className="u-m-0 u-fs-12 muted">{t('approvalsScenarioGroup')}</h3>
              {scenarioSelect.map((a) => (
                // PMXU-2 (ADR 0590) — agent-proposed scenario adoption (approve
                // ⇒ plan of record; reject ⇒ left un-adopted). The structured
                // scenarioSelect context (name) renders beside the prose so the
                // reviewer sees WHAT they are deciding, not only a sentence.
                <article key={a.approvalId} className="surface-card u-grid u-gap-2">
                  <div className="u-flex u-items-center u-gap-2 u-wrap">
                    <span className="u-flex-1">{a.proposal}</span>
                    {a.scenarioSelect?.scenarioName ? <span className="chip chip--muted u-fs-11">{a.scenarioSelect.scenarioName}</span> : null}
                    <span className="muted u-fs-12">{relativeTime(a.createdAt)}</span>
                  </div>
                  <span className="action-bar">
                    <Button variant="primary" size="sm" disabled={busy === a.approvalId} onClick={() => void claim(a)}>
                      <CheckIcon size={13} /> {t('approveLabel')}
                    </Button>
                    <Button variant="secondary" size="sm" disabled={busy === a.approvalId} onClick={() => void reject(a)}>
                      <XIcon size={13} /> {t('rejectLabel')}
                    </Button>
                  </span>
                </article>
              ))}
            </div>
          )}
          {campaignSpend.length > 0 && (
            <div className="u-grid u-gap-2">
              <h3 className="u-m-0 u-fs-12 muted">{t('approvalsSpendGroup')}</h3>
              {campaignSpend.map((a) => (
                // Ad-spend sign-off (campaign gap plan §5B B3): approving opens the
                // adapter's spend gate — the dispatch itself re-runs from the
                // campaign flow (nothing launches from here; PAUSED stays the floor).
                <article key={a.approvalId} className="surface-card u-grid u-gap-2">
                  <div className="u-flex u-items-center u-gap-2">
                    <span className="u-flex-1">{a.proposal}</span>
                    {/* platform is neutral metadata → muted, not the brand-clay accent (grade-ux) */}
                    {a.platform ? <span className="chip chip--muted">{platformLabel(t, a.platform)}</span> : null}
                    <span className="muted u-fs-12">{relativeTime(a.createdAt)}</span>
                  </div>
                  <span className="action-bar">
                    <Button variant="primary" size="sm" disabled={busy === a.approvalId} aria-busy={busy === a.approvalId} onClick={() => void claim(a)}>
                      <CheckIcon size={13} /> {t('approveLabel')}
                    </Button>
                    <Button variant="secondary" size="sm" disabled={busy === a.approvalId} aria-busy={busy === a.approvalId} onClick={() => void reject(a)}>
                      <XIcon size={13} /> {t('rejectLabel')}
                    </Button>
                  </span>
                </article>
              ))}
            </div>
          )}
          {actions.length > 0 && (
            <div className="u-grid u-gap-2">
              {actions.map((a) => (
                <ActionCard
                  key={a.approvalId}
                  approval={a}
                  busy={busy === a.approvalId}
                  onApprove={() => void claim(a)}
                  onReject={() => void reject(a)}
                  onSaveEdit={(draft) => saveEdit(a, draft)}
                />
              ))}
            </div>
          )}
          {commerceSpend.length > 0 && (
            <div className="u-grid u-gap-2">
              <h3 className="u-m-0 u-fs-12 muted">{t('approvalsCommerceSpendGroup')}</h3>
              {commerceSpend.map((a) => (
                <article key={a.approvalId} className="surface-card u-grid u-gap-2">
                  <div className="u-flex u-items-center u-gap-2">
                    <span className="u-flex-1">{a.proposal}</span>
                    {/* The structured figure, formatted from minor units with the
                        currency's own exponent — the prose can no longer be the only
                        number a human sees before authorizing a spend. */}
                    {a.amountMinor !== undefined && a.amountCurrency ? (
                      <strong className="u-tabular">{formatCurrencyMinor(a.amountMinor, a.amountCurrency)}</strong>
                    ) : null}
                    <span className="muted u-fs-12">{relativeTime(a.createdAt)}</span>
                  </div>
                  <span className="action-bar">
                    <Button variant="primary" size="sm" disabled={busy === a.approvalId} aria-busy={busy === a.approvalId} onClick={() => void claim(a)}>
                      <CheckIcon size={13} /> {t('approveLabel')}
                    </Button>
                    <Button variant="secondary" size="sm" disabled={busy === a.approvalId} aria-busy={busy === a.approvalId} onClick={() => void reject(a)}>
                      <XIcon size={13} /> {t('rejectLabel')}
                    </Button>
                  </span>
                </article>
              ))}
            </div>
          )}
          {runs.length > 0 && (
            <DataTable
              columns={columns}
              rows={runs}
              rowKey={(a) => a.approvalId}
              density="compact"
              caption={t('approvalsTableCaption')}
            />
          )}
        </div>
      )}
    </div>
  );
}
