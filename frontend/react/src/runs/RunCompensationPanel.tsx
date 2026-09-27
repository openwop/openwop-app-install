/**
 * RunCompensationPanel — ADR 0554 P3 boundary row 10: "Operations run detail
 * adds obligation timeline and gated recovery actions".
 *
 * WHY IT LIVES IN `runs/` AND NOT IN THE OPERATIONS HUB. The hub
 * (`features/operations/OperationsHubPage.tsx`) is a CROSS-TENANT superadmin
 * health console — every one of its routes is `requireSuperadmin`. These actions
 * are TENANT-scoped and gated on the three ADR 0554 P3 scopes. Putting a
 * tenant-RBAC control on a superadmin page would mix two authority models on one
 * surface, and a reader could no longer tell which gate any given button is
 * under. Run detail already hosts `RunOpsPanel` ("operations surface for a
 * run"), which is the established home. The ROUTES stay on the Operations
 * feature, per ADR 0554's boundaries table.
 *
 * ── THE THREE THINGS THIS PANEL REFUSES TO IMPLY ─────────────────────────
 *
 * 1. A button is rendered ONLY with its scope, and a FAILED scope read is not
 *    the same as "no permission" — `scopeUnknown` says so out loud rather than
 *    silently hiding the controls (the `ConnectionsManager` house rule).
 * 2. An audit entry with `applied: false` is RECORDED, NOT APPLIED. Showing it
 *    as a completed action would be the panel telling a lie the backend went to
 *    some trouble not to tell.
 * 3. A waive needs a reason, and the form will not submit without one — the same
 *    rule the route enforces, stated where the operator is.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { Notice, StateCard } from '../ui/index.js';
import { toast } from '../ui/toast.js';
import { useEffectiveAccessState } from '../client/useEffectiveAccess.js';
import {
  getRunCompensation,
  postRunCompensationAction,
  OperationsRequestError,
  type CompensationObligationRow,
  type CompensationObligationState,
  type CompensationRecoveryAction,
  type RunCompensation,
} from '../client/operationsClient.js';

interface Props {
  runId: string;
}

/** state -> chip class. The WORD is always rendered beside it: colour alone is
 *  not a status (WCAG 1.4.1), and this panel's states are the difference
 *  between "undone" and "left in place". */
function stateChip(state: CompensationObligationState): string {
  switch (state) {
    case 'completed': return 'chip chip--success';
    case 'failed': return 'chip chip--danger';
    case 'paused':
    case 'manual_intervention_required': return 'chip chip--warning';
    default: return 'chip chip--muted';
  }
}

const ACTION_SCOPE: Record<CompensationRecoveryAction, string> = {
  start: 'host:compensation:start',
  retry: 'host:compensation:retry',
  skip: 'host:compensation:waive',
  substitute: 'host:compensation:waive',
  terminate: 'host:compensation:waive',
};

export function RunCompensationPanel({ runId }: Props) {
  const { t } = useTranslation('runs');
  const { access, resolved } = useEffectiveAccessState();
  const [data, setData] = useState<RunCompensation | null>(null);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Which obligation has its waive form open, and the reason typed so far. */
  const [waiving, setWaiving] = useState<{ id: string; action: CompensationRecoveryAction } | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await getRunCompensation(runId));
      setFailed(false);
      setForbidden(false);
    } catch (err) {
      // 403/404 is "you may not read this run's plan", which is a different
      // statement from "the read broke". Distinguished STRUCTURALLY by status.
      if (err instanceof OperationsRequestError && (err.status === 403 || err.status === 404)) {
        setForbidden(true);
      } else {
        setFailed(true);
      }
    }
  }, [runId]);

  useEffect(() => { void load(); }, [load]);

  const can = (action: CompensationRecoveryAction): boolean =>
    access.scopes.includes(ACTION_SCOPE[action]);

  /** The scope read itself failed — we know NOTHING about this operator's
   *  authority, which is not the same as knowing they have none. */
  const scopeUnknown = resolved && access.basis === 'none';

  async function act(
    o: CompensationObligationRow,
    action: CompensationRecoveryAction,
    withReason?: string,
  ): Promise<void> {
    setBusy(true);
    try {
      await postRunCompensationAction({
        runId,
        obligationId: o.obligationId,
        action,
        // The state the OPERATOR SAW. This is what makes a lost race detectable
        // rather than silently applying twice.
        expectedState: o.state,
        ...(withReason !== undefined ? { reason: withReason } : {}),
      });
      toast.success(t('compActionApplied'));
      setWaiving(null);
      setReason('');
      await load();
    } catch (err) {
      // Branch on the CODE, never the message: `version_conflict` and
      // `approval_required` share a 409 and mean opposite things to an operator.
      const code = err instanceof OperationsRequestError ? err.code : undefined;
      if (code === 'version_conflict') {
        toast.error(t('compConflict'));
        await load();               // re-read so their next attempt is fresh
      } else if (code === 'approval_required') {
        toast.success(t('compApprovalRaised'));
        setWaiving(null);
        setReason('');
        await load();
      } else {
        toast.error(err instanceof Error ? err.message : t('compActionFailed'));
      }
    } finally {
      setBusy(false);
    }
  }

  if (forbidden) {
    return (
      <section className="card" data-testid="run-compensation">
        <h2>{t('compHeading')}</h2>
        <StateCard title={t('compForbiddenTitle')} body={t('compForbiddenBody')} />
      </section>
    );
  }
  if (failed && !data) {
    return (
      <section className="card" data-testid="run-compensation">
        <h2>{t('compHeading')}</h2>
        <StateCard announce title={t('compUnavailableTitle')} body={t('compUnavailableBody')} />
      </section>
    );
  }
  if (!data) {
    return (
      <section className="card" data-testid="run-compensation">
        <h2>{t('compHeading')}</h2>
        <StateCard loading title={t('compLoading')} />
      </section>
    );
  }
  // A run that owed nothing is a REAL, common state and gets its own words —
  // rendering an empty table would read as a failed load.
  if (data.obligations.length === 0) {
    return (
      <section className="card" data-testid="run-compensation">
        <h2>{t('compHeading')}</h2>
        <StateCard title={t('compEmptyTitle')} body={t('compEmptyBody')} />
      </section>
    );
  }

  return (
    <section className="card" data-testid="run-compensation">
      <div className="u-flex u-items-center u-gap-2 u-wrap">
        <h2 className="u-flex-1">{t('compHeading')}</h2>
        <span className="chip chip--muted">{t('compRollup', { status: data.compensationStatus })}</span>
      </div>

      {/* The chain's own verdict. Stated only when it is BAD — a panel that
          announces "audit intact" on every load trains an operator to skim it. */}
      {!data.auditChain.ok ? (
        <Notice variant="error" announce={t('compChainBroken', { seq: data.auditChain.brokenAt ?? 0 })}>
          {t('compChainBroken', { seq: data.auditChain.brokenAt ?? 0 })}
        </Notice>
      ) : null}

      {scopeUnknown ? (
        <Notice variant="warning">{t('compScopeUnknown')}</Notice>
      ) : null}

      <ol className="u-mt-2" data-testid="obligation-timeline">
        {data.obligations.map((o) => (
          <li key={o.obligationId} className="surface-card u-mb-2" data-testid={`obligation-${o.obligationId}`}>
            <div className="u-flex u-items-center u-gap-2 u-wrap">
              <span className={stateChip(o.state)}>{t(`compState_${o.state}`)}</span>
              <strong className="u-flex-1">{o.nodeId ?? t('compUnknownNode')}</strong>
              <span className="muted u-fs-12">{t('compAttempts', { count: o.attempts })}</span>
            </div>

            <p className="muted u-fs-12">
              {t('compMeta', { effectKind: o.effectKind, shape: o.shape, updatedAt: o.updatedAt })}
            </p>
            {o.reason ? <p className="u-fs-12">{t('compReason', { reason: o.reason })}</p> : null}
            {o.startedBy ? <p className="muted u-fs-12">{t('compStartedBy', { actor: o.startedBy })}</p> : null}

            {/* An open waive approval is a REAL pending state, shown as such. */}
            {o.waiveApprovalId ? (
              <Notice variant="warning">{t('compApprovalPending', { approvalId: o.waiveApprovalId })}</Notice>
            ) : null}

            {o.history.length > 0 ? (
              <ul className="u-mt-1" data-testid={`history-${o.obligationId}`}>
                {o.history.map((h) => (
                  <li key={h.seq} className="u-fs-12">
                    {t('compHistoryRow', {
                      action: h.payload.action,
                      actor: h.payload.actor,
                      from: h.payload.priorState,
                      to: h.payload.requestedState,
                      at: h.at,
                    })}
                    {' '}
                    {h.applied
                      ? <span className="chip chip--success">{t('compApplied')}</span>
                      // NOT a styling choice. `applied: false` means the action
                      // was recorded and the ledger never moved.
                      : <span className="chip chip--warning">{t('compRecordedNotApplied')}</span>}
                    {h.payload.reason ? <span className="muted"> — {h.payload.reason}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="action-bar u-mt-1">
              {can('retry') ? (
                <Button variant="secondary" size="sm" disabled={busy}
                  onClick={() => { void act(o, 'retry'); }}>
                  {t('compRetry')}
                </Button>
              ) : null}
              {can('start') ? (
                <Button variant="secondary" size="sm" disabled={busy}
                  onClick={() => { void act(o, 'start'); }}>
                  {t('compStart')}
                </Button>
              ) : null}
              {can('skip') ? (
                <Button variant="secondary" size="sm" disabled={busy}
                  onClick={() => { setWaiving({ id: o.obligationId, action: 'skip' }); setReason(''); }}>
                  {t('compWaive')}
                </Button>
              ) : null}
            </div>

            {waiving?.id === o.obligationId ? (
              <form
                className="u-mt-1"
                data-testid={`waive-form-${o.obligationId}`}
                onSubmit={(e) => { e.preventDefault(); void act(o, waiving.action, reason); }}
              >
                <label className="u-fs-12" htmlFor={`waive-reason-${o.obligationId}`}>
                  {t('compWaiveReasonLabel')}
                </label>
                <textarea
                  id={`waive-reason-${o.obligationId}`}
                  className="u-w-full"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  aria-describedby={`waive-hint-${o.obligationId}`}
                />
                <p id={`waive-hint-${o.obligationId}`} className="muted u-fs-12">
                  {t('compWaiveHint')}
                </p>
                <div className="action-bar">
                  {/* Blocked on a blank reason at the button, so the operator
                      learns the rule here instead of via a 400. `type` must be
                      explicit — `Button` defaults to `"button"`, so the form's
                      onSubmit would never fire. */}
                  <Button type="submit" size="sm" disabled={busy || reason.trim().length === 0}>
                    {t('compWaiveConfirm')}
                  </Button>
                  <Button variant="secondary" size="sm" type="button"
                    onClick={() => { setWaiving(null); setReason(''); }}>
                    {t('compCancel')}
                  </Button>
                </div>
              </form>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
