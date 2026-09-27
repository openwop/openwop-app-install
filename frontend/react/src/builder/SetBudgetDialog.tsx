/**
 * ADR 0482 §6 — the Set-budget dialog, opened from the workflow card kebab.
 *
 * A small owner-config modal (the AssignWorkflowModal pattern — shared
 * ui/Modal, never window.prompt): daily USD amount + a hard-cap checkbox +
 * an explicit Remove-budget action when one exists. The card list already
 * carries the current budget, so the dialog opens prefilled without a fetch;
 * a fail-soft `getWorkflowBudget` read adds the "Spent today" context line
 * (ux-14). PUT/clear ride the workflowsClient budget fns and the caller
 * refreshes.
 *
 * Error surfaces (ux-6/7/15): field validation lands on the TextField's
 * error prop (aria-invalid + role=alert) with Save kept enabled so the
 * check is reachable; the Modal-level Notice is reserved for transport
 * failures, with copy branched on the encoded status (400/404 are not
 * "try again in a moment" problems).
 */

import { Button } from '../ui/Button.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal.js';
import { TextField } from '../ui/Field.js';
import { toast } from '../ui/toast.js';
import { formatUsd } from '../i18n/format.js';
import { clearWorkflowBudget, getWorkflowBudget, putWorkflowBudget } from '../workflows/workflowsClient.js';

interface Props {
  workflow: { id: string; name: string; budget?: { dailyUsd: number; hardCap: boolean } };
  /** Called after a successful save/clear so the dashboard re-reads the list. */
  onSaved(): void;
  onClose(): void;
}

/** The budget client throws `Error('budget_<op>_<status>')` — branch the
 *  transport copy on that status (ux-15): a 400/404 is not transient. */
function transportKey(err: unknown): 'budgetSaveFailed400' | 'budgetSaveFailed404' | 'budgetSaveFailed' {
  const m = /budget_(?:get|put|clear)_(\d{3})/.exec(err instanceof Error ? err.message : String(err ?? ''));
  const status = m ? Number(m[1]) : null;
  if (status === 400) return 'budgetSaveFailed400';
  if (status === 404) return 'budgetSaveFailed404';
  return 'budgetSaveFailed';
}

export function SetBudgetDialog({ workflow, onSaved, onClose }: Props): JSX.Element {
  const { t } = useTranslation('builder');
  const [dailyUsd, setDailyUsd] = useState(workflow.budget ? String(workflow.budget.dailyUsd) : '');
  const [hardCap, setHardCap] = useState(workflow.budget?.hardCap ?? false);
  const [submitting, setSubmitting] = useState(false);
  /** Field-level validation message (TextField error → aria-invalid + role=alert). */
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  /** Transport failure (Modal-level Notice). */
  const [transportError, setTransportError] = useState<string | undefined>(undefined);
  // ux-14 — today's spend so the owner sets the number against the actual
  // burn, not from memory. Fail-soft: on a read failure the line just
  // doesn't render (never blocks the dialog).
  const [spentToday, setSpentToday] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    getWorkflowBudget(workflow.id)
      .then((r) => { if (live) setSpentToday(r.spentTodayUsd); })
      .catch(() => { /* context line hidden */ });
    return () => { live = false; };
  }, [workflow.id]);

  async function save(): Promise<void> {
    // ux-7 — validate on submit (Save stays enabled so the check is
    // reachable); the message lands on the field, not the Modal notice.
    const parsed = Number(dailyUsd);
    if (dailyUsd.trim() === '' || !Number.isFinite(parsed) || parsed <= 0) {
      setFieldError(t('budgetInvalidAmount'));
      return;
    }
    setFieldError(undefined);
    setTransportError(undefined);
    setSubmitting(true);
    try {
      await putWorkflowBudget(workflow.id, { dailyUsd: parsed, hardCap });
      toast.success(t('budgetSaved', { name: workflow.name }));
      onSaved();
      onClose();
    } catch (err) {
      setTransportError(t(transportKey(err)));
      setSubmitting(false);
    }
  }

  async function remove(): Promise<void> {
    setFieldError(undefined);
    setTransportError(undefined);
    setSubmitting(true);
    try {
      await clearWorkflowBudget(workflow.id);
      toast.success(t('budgetCleared', { name: workflow.name }));
      onSaved();
      onClose();
    } catch (err) {
      setTransportError(t(transportKey(err)));
      setSubmitting(false);
    }
  }

  return (
    <Modal onClose={onClose} label={t('setBudgetTitle', { name: workflow.name })} {...(transportError ? { error: transportError } : {})}>
      <h2 className="u-fs-16 u-mb-2">{t('setBudgetTitle', { name: workflow.name })}</h2>
      <p className="muted u-mb-3">{t('setBudgetHint')}</p>
      {spentToday !== null ? (
        <p className="muted u-fs-12 u-mb-3">{t('budgetSpentToday', { amount: formatUsd(spentToday) })}</p>
      ) : null}
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="u-flex u-flex-col u-gap-3">
        <TextField
          label={t('budgetDailyLabel')}
          help={t('budgetDailyHelp')}
          {...(fieldError ? { error: fieldError } : {})}
          type="number"
          inputMode="decimal"
          min="0.01"
          step="0.01"
          value={dailyUsd}
          onChange={(e) => { setDailyUsd(e.target.value); setFieldError(undefined); }}
          placeholder={t('budgetDailyPlaceholder')}
          autoFocus
        />
        <label className="u-flex u-items-center u-gap-2 u-fs-13">
          <input type="checkbox" checked={hardCap} onChange={(e) => setHardCap(e.target.checked)} />
          {t('budgetHardCapLabel')}
        </label>
        <p className="muted u-fs-11 u-m-0">{t('budgetHardCapHint')}</p>
        <div className="u-flex u-gap-2 u-mt-2">
          {workflow.budget ? (
            <Button variant="secondary" size="sm" onClick={() => { void remove(); }} disabled={submitting}>
              {t('budgetRemove')}
            </Button>
          ) : null}
          <span className="u-flex-1" aria-hidden="true" />
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            {t('common:cancel')}
          </Button>
          <Button type="submit" variant="accent-solid" disabled={submitting}>
            {submitting ? t('common:saving') : t('budgetSave')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
