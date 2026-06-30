/**
 * ADR 0136 Phase 5 — the intent-ledger ("mission contract") modal body. Default-exported
 * so the chat header LAZY-loads it (only the tiny gate+button is in the entry chunk; the
 * EmbeddedChatPanel/CapabilityScopeModal lazy precedent).
 *
 * Shows the current ledger for the conversation: a DRAFT (review → Approve/Reject), an
 * APPROVED contract (read-only + the authored-vs-completed reckoning + Revoke), or a
 * create-draft form when none exists. Backend is authority (owner-gated; the extractor
 * only ever drafts — approval is this explicit user action).
 *
 * @see docs/adr/0136-intent-ledger.md
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal.js';
import { Notice } from '../ui/Notice.js';
import { toast } from '../ui/toast.js';
import { CheckIcon, XIcon } from '../ui/icons/index.js';
import { confirm } from '../ui/confirm.js';
import { getLedger, draftLedger, draftLedgerFromConversation, decideLedger, getReckoning, type IntentLedger, type LedgerReckoning } from './intentLedgerClient.js';

export default function IntentLedgerPanel({ sessionId, onClose, lastUserMessage }: { sessionId: string; onClose: () => void; lastUserMessage?: string }): JSX.Element {
  const { t } = useTranslation('intentLedger');
  const [ledger, setLedger] = useState<IntentLedger | null>(null);
  const [reckoning, setReckoning] = useState<LedgerReckoning | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [goal, setGoal] = useState('');
  const [criteria, setCriteria] = useState('');

  const load = useCallback(async () => {
    try {
      const l = await getLedger(sessionId);
      setLedger(l); setLoaded(true);
      if (l?.status === 'approved') setReckoning(await getReckoning(sessionId).catch(() => null));
    } catch (e) { setError(e instanceof Error ? e.message : t('loadFailed', { defaultValue: 'Failed to load the mission contract.' })); setLoaded(true); }
  }, [sessionId, t]);
  useEffect(() => { void load(); }, [load]);

  const create = async (): Promise<void> => {
    if (!goal.trim()) { toast.error(t('needGoal', { defaultValue: 'Enter a goal.' })); return; }
    setBusy(true);
    try {
      const sc = criteria.split('\n').map((s) => s.trim()).filter(Boolean);
      setLedger(await draftLedger(sessionId, { goal: goal.trim(), successCriteria: sc }));
      setGoal(''); setCriteria('');
    } catch (e) { toast.error(e instanceof Error ? e.message : t('draftFailed', { defaultValue: 'Failed to draft the mission.' })); } finally { setBusy(false); }
  };
  const autoDraft = async (): Promise<void> => {
    if (!lastUserMessage?.trim()) return;
    setBusy(true);
    try { setLedger(await draftLedgerFromConversation(sessionId, lastUserMessage)); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('autoDraftFailed', { defaultValue: 'Could not draft from this conversation.' })); }
    finally { setBusy(false); }
  };
  const decide = async (d: 'approve' | 'reject'): Promise<void> => {
    setBusy(true);
    try { const l = await decideLedger(sessionId, d); setLedger(l); if (l.status === 'approved') setReckoning(await getReckoning(sessionId).catch(() => null)); toast.success(t(d === 'approve' ? 'approved' : 'rejected', { defaultValue: d })); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('decideFailed', { defaultValue: 'Failed to record your decision.' })); } finally { setBusy(false); }
  };
  const revoke = async (): Promise<void> => {
    if (!(await confirm({ title: t('revokeConfirm', { defaultValue: 'Revoke this mission?' }), danger: true, confirmLabel: t('revoke', { defaultValue: 'Revoke mission' }) }))) return;
    await decide('reject');
  };

  const list = (label: string, items: string[]): JSX.Element | null => items.length === 0 ? null : (
    <div className="u-flex u-flex-wrap u-items-center u-gap-1 u-fs-11">
      <span className="muted">{label}</span>
      {items.map((x) => <span key={x} className="chip chip--muted">{x}</span>)}
    </div>
  );

  return (
    <Modal label={t('title', { defaultValue: 'Mission contract' })} onClose={onClose} className="surface-card" loading={!loaded} error={error ?? undefined}>
      <div className="u-flex u-flex-col u-gap-3">
          <p className="muted u-fs-12">{t('lede', { defaultValue: 'A reviewable contract for what the agent may do in this conversation. Approving it narrows the agent’s tools to the contract until you revoke it.' })}</p>

          {!ledger || ledger.status === 'rejected' || ledger.status === 'expired' ? (
            <section className="u-flex u-flex-col u-gap-2" aria-labelledby="il-new">
              {ledger?.status === 'expired' && <Notice variant="warning">{t('expired', { defaultValue: 'The previous mission expired — draft a new one.' })}</Notice>}
              <h3 id="il-new" className="u-fs-13">{t('createHeading', { defaultValue: 'Draft a mission' })}</h3>
              <input type="text" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t('goalPlaceholder', { defaultValue: 'Goal (what should the agent accomplish?)' })} aria-label={t('goal', { defaultValue: 'Goal' })} className="u-fs-12" />
              <textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder={t('criteriaPlaceholder', { defaultValue: 'Success criteria, one per line (optional)' })} aria-label={t('criteria', { defaultValue: 'Success criteria' })} rows={3} className="u-fs-12" />
              <div className="u-flex u-gap-2">
                <button type="button" className="u-fs-12" disabled={busy} onClick={create}>{t('createDraft', { defaultValue: 'Create draft' })}</button>
                {lastUserMessage?.trim() && (
                  <button type="button" className="secondary u-fs-12" disabled={busy} onClick={autoDraft}>{t('autoDraft', { defaultValue: 'Draft from conversation' })}</button>
                )}
              </div>
            </section>
          ) : (
            <section className="u-flex u-flex-col u-gap-2" aria-labelledby="il-cur">
              <div className="u-flex u-items-center u-justify-between u-gap-2">
                <h3 id="il-cur" className="u-fs-13">{ledger.goal}</h3>
                <span className={`chip u-fs-11 ${ledger.status === 'approved' ? 'chip--accent' : 'chip--warning'}`}>{t(`status_${ledger.status}`, { defaultValue: ledger.status })}</span>
              </div>
              {list(t('allowed', { defaultValue: 'allowed' }), ledger.allowed)}
              {list(t('forbidden', { defaultValue: 'forbidden' }), ledger.forbidden)}
              {list(t('needsApproval', { defaultValue: 'needs approval' }), ledger.requireApproval)}
              {ledger.successCriteria.length > 0 && (
                <ul className="u-fs-11 u-pl-3">{ledger.successCriteria.map((c) => <li key={c}>{c}</li>)}</ul>
              )}

              {ledger.status === 'draft' && (
                <div className="u-flex u-gap-2">
                  <button type="button" className="u-fs-12" disabled={busy} onClick={() => decide('approve')}><CheckIcon size={14} /> {t('approve', { defaultValue: 'Approve' })}</button>
                  <button type="button" className="secondary u-fs-12" disabled={busy} onClick={() => decide('reject')}><XIcon size={14} /> {t('reject', { defaultValue: 'Reject' })}</button>
                </div>
              )}
              {ledger.status === 'approved' && (
                <>
                  <button type="button" className="secondary u-fs-11 u-self-start" disabled={busy} onClick={() => void revoke()}>{t('revoke', { defaultValue: 'Revoke mission' })}</button>
                  {reckoning && (
                    <div className="surface-card u-pad-2 u-flex u-flex-col u-gap-1" aria-labelledby="il-reck">
                      <div className="u-flex u-items-center u-justify-between">
                        <h4 id="il-reck" className="u-fs-12">{t('reckoning', { defaultValue: 'Progress' })}</h4>
                        <span className={`chip u-fs-11 ${reckoning.withinMandate ? 'chip--accent' : 'chip--danger'}`}>{reckoning.withinMandate ? t('inMandate', { defaultValue: 'in mandate' }) : t('outOfMandate', { defaultValue: 'blocked attempts' })}</span>
                      </div>
                      {list(t('used', { defaultValue: 'used' }), reckoning.usedTools)}
                      {list(t('blocked', { defaultValue: 'blocked' }), reckoning.blockedToolAttempts)}
                      {reckoning.successCriteria.length > 0 && (
                        <ul className="u-fs-11 u-pl-3">{reckoning.successCriteria.map((c) => <li key={c.text}>{c.text} <span className="muted">({t('needsReview', { defaultValue: 'needs review' })})</span></li>)}</ul>
                      )}
                    </div>
                  )}
                </>
              )}
            </section>
          )}
      </div>
    </Modal>
  );
}
