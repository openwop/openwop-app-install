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
 * ADR 0896 D8 — a decision names the version rendered here; if the mission changed
 * since (the chat agent redrafted it), the server refuses and this reloads and says
 * so, so nobody approves text they did not see. Controls render only for a viewer the
 * server would honour, and the page states what approving means (no allowed tools ⇒
 * talk only; the time limit).
 *
 * @see docs/adr/0136-intent-ledger.md
 */
import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../ui/Modal.js';
import { Notice } from '../ui/Notice.js';
import { TextField, TextareaField } from '../ui/Field.js';
import { toast } from '../ui/toast.js';
import { CheckIcon, XIcon } from '../ui/icons/index.js';
import { confirm } from '../ui/confirm.js';
import { stageComposerDraft } from '../chat/composerSeed.js';
import { getLedger, getPrefill, draftLedger, decideLedger, getReckoning, LedgerChangedError, MissionNotFoundError, type IntentLedger, type LedgerReckoning, type MissionPrefill, type MissionViewer } from './intentLedgerClient.js';

/** A relative TTL in the viewer's locale, in the largest whole unit (minutes ≥ 1). */
function formatTtl(ms: number, locale: string): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const [value, unit] = minutes % 1440 === 0 ? [minutes / 1440, 'day'] : minutes % 60 === 0 ? [minutes / 60, 'hour'] : [minutes, 'minute'];
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(value);
}

// The existing governance agent (its allowlist carries intent-ledger.get +
// intent-ledger.draft-contract). "Capability at core, not a named agent" — this is
// just the deep-link target, not new behavior.
const CHIEF_OF_STAFF_AGENT_ID = 'vendor.openwop-app.assistant.agents.chief-of-staff';

export default function IntentLedgerPanel({ sessionId, onClose, lastUserMessage }: { sessionId: string; onClose: () => void; lastUserMessage?: string }): JSX.Element {
  const { t, i18n } = useTranslation('intentLedger');
  const navigate = useNavigate();
  const [ledger, setLedger] = useState<IntentLedger | null>(null);
  const [viewer, setViewer] = useState<MissionViewer>({ mayEdit: false, mayDecide: false });
  // ADR 0896 D8 — set when a decision was refused because the mission changed.
  const [changed, setChanged] = useState(false);
  const [reckoning, setReckoning] = useState<LedgerReckoning | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [goal, setGoal] = useState('');
  const [goalError, setGoalError] = useState(false);
  const [criteria, setCriteria] = useState('');
  // ADR 0856 D2 — in a project's conversation a new draft starts from the team ledger.
  const [prefill, setPrefill] = useState<MissionPrefill | null>(null);
  // A failed read is its own state, never "nothing inherited" (the server still applies it).
  const [prefillFailed, setPrefillFailed] = useState(false);
  // IL2UX-3 — a decision removes the control that had focus; focus moves to the heading
  // of whatever the modal now shows (or the "changed" notice), never to <body>.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const focusAfterUpdate = useRef(false);

  const load = useCallback(async () => {
    try {
      const { ledger: l, viewer: v } = await getLedger(sessionId);
      setLedger(l); setViewer(v); setLoaded(true); setError(null);
      if (l?.status === 'approved' || l?.status === 'expired') setReckoning(await getReckoning(sessionId).catch(() => null));
      if (!l || l.status === 'rejected' || l.status === 'expired') {
        try {
          const p = await getPrefill(sessionId);
          setPrefill(p);
          if (p?.goal) setGoal((g) => g || p.goal!);
        } catch { setPrefillFailed(true); }
      }
    } catch (e) {
      setError(e instanceof MissionNotFoundError
        ? t('notFound', { defaultValue: 'This conversation has no mission yet. Send a message first, then set one.' })
        : t('loadFailed', { defaultValue: 'Failed to load the mission contract.' }));
      setLoaded(true);
    }
  }, [sessionId, t]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!focusAfterUpdate.current) return;
    focusAfterUpdate.current = false;
    headingRef.current?.focus();
  }, [ledger?.status, ledger?.revision, changed]);

  const create = async (): Promise<void> => {
    if (!goal.trim()) { setGoalError(true); return; }
    setBusy(true);
    try {
      const sc = criteria.split('\n').map((s) => s.trim()).filter(Boolean);
      focusAfterUpdate.current = true;
      setLedger(await draftLedger(sessionId, { goal: goal.trim(), successCriteria: sc }));
      setGoal(''); setCriteria(''); setChanged(false);
    } catch (e) { focusAfterUpdate.current = false; toast.error(e instanceof Error ? e.message : t('draftFailed', { defaultValue: 'Failed to draft the mission.' })); } finally { setBusy(false); }
  };
  // CFP A13 — chat-first drafting: hand the ONE chat a seeded prompt and scope THIS
  // conversation to the governance agent, whose intent-ledger.draft-contract tool
  // authors the draft for the owner to Approve here. IL2UX-2: the deep-link names the
  // conversation, so the multi-tab deck scopes this tab instead of opening a new one
  // (a new tab would draft the mission onto a different conversation).
  const draftWithAssistant = (): void => {
    stageComposerDraft(t('draftWithAssistantSeed', { defaultValue: 'Draft a mission contract for this conversation — I will review and approve it before it takes effect.' }));
    onClose();
    navigate(`/chat?conversation=${encodeURIComponent(sessionId)}&agent=${encodeURIComponent(CHIEF_OF_STAFF_AGENT_ID)}`);
  };
  const decide = async (d: 'approve' | 'reject', revoking = false): Promise<void> => {
    if (!ledger) return;
    setBusy(true);
    try {
      const l = await decideLedger(sessionId, d, ledger);
      focusAfterUpdate.current = true;
      setLedger(l); setChanged(false);
      if (l.status === 'approved') setReckoning(await getReckoning(sessionId).catch(() => null));
      toast.success(revoking ? t('revoked', { defaultValue: 'Mission revoked' }) : t(d === 'approve' ? 'approved' : 'rejected', { defaultValue: d }));
    } catch (e) {
      if (e instanceof LedgerChangedError) { focusAfterUpdate.current = true; setChanged(true); await load(); }
      else toast.error(e instanceof Error ? e.message : t('decideFailed', { defaultValue: 'Failed to record your decision.' }));
    } finally { setBusy(false); }
  };
  const revoke = async (): Promise<void> => {
    if (!(await confirm({
      title: t('revokeConfirm', { defaultValue: 'Revoke this mission?' }),
      body: t('revokeConfirmBody', { defaultValue: 'The agent gets back the tools this mission restricted. You can draft a new mission afterwards.' }),
      danger: true, confirmLabel: t('revoke', { defaultValue: 'Revoke mission' }),
    }))) return;
    await decide('reject', true);
  };

  const list = (label: string, items: string[]): JSX.Element | null => items.length === 0 ? null : (
    <div className="u-flex u-flex-wrap u-items-center u-gap-1 u-fs-11">
      <span className="muted">{label}</span>
      {items.map((x) => <span key={x} className="chip chip--muted">{x}</span>)}
    </div>
  );
  // ADR 0896 D8 — worded by what the reloaded mission now is.
  const changedText = !ledger || ledger.status === 'draft'
    ? t('changedSinceViewed', { defaultValue: 'This mission changed since you opened it. Review the version below before you decide.' })
    : t('changedNowStatus', { defaultValue: 'This mission changed since you opened it — it is now {{status}}.', status: t(`status_${ledger.status}`, { defaultValue: ledger.status }) });
  const reckoningBlock = reckoning && (
    <div role="region" className="surface-card u-pad-2 u-flex u-flex-col u-gap-1" aria-labelledby="il-reck">
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
  );

  return (
    <Modal label={t('title', { defaultValue: 'Mission contract' })} onClose={onClose} className="surface-card" loading={!loaded} error={error ?? undefined} errorAnnounce={error ?? undefined} showClose describedBy="il-lede">
      {!error && (
      <div className="u-flex u-flex-col u-gap-3">
          <h2 className="u-fs-14">{t('title', { defaultValue: 'Mission contract' })}</h2>
          <p id="il-lede" className="muted u-fs-12">{viewer.mayDecide
            ? t('lede', { defaultValue: 'A reviewable contract for what the agent may do in this conversation. Approving it narrows the agent’s tools to the contract until you revoke it.' })
            : t('ledeViewer', { defaultValue: 'A reviewable contract for what the agent may do in this conversation. While approved, it narrows the agent’s tools to the contract.' })}</p>
          {changed && <Notice variant="warning" announce={changedText}>{changedText}</Notice>}

          {!ledger || ledger.status === 'rejected' || ledger.status === 'expired' ? (
            <section className="u-flex u-flex-col u-gap-2" aria-labelledby="il-new">
              {ledger?.status === 'expired' && <Notice variant="warning">{t('expired', { defaultValue: 'The previous mission expired — draft a new one.' })}</Notice>}
              {ledger?.status === 'expired' && reckoningBlock}
              <h3 id="il-new" ref={headingRef} tabIndex={-1} className="u-fs-13">{t('createHeading', { defaultValue: 'Draft a mission' })}</h3>
              {prefillFailed && <Notice variant="warning" announce={t('prefillFailed', { defaultValue: 'Could not load the team ledger’s defaults. Any restrictions it sets still apply.' })}>{t('prefillFailed', { defaultValue: 'Could not load the team ledger’s defaults. Any restrictions it sets still apply.' })}</Notice>}
              {prefill && (
                <div role="region" aria-label={t('inheritedRegion', { defaultValue: 'From the team ledger' })} className="surface-card u-pad-2 u-flex u-flex-col u-gap-1">
                  {prefill.sources.map((src) => (
                    <div key={src.id} className="u-flex u-flex-col u-gap-1">
                      <span className="u-fs-12">{t('inheritedFrom', { defaultValue: 'From the team ledger of {{project}}', project: src.name })}</span>
                      {src.inScope.length > 0 && <ul className="u-fs-11 u-pl-3">{src.inScope.map((x) => <li key={`in:${x}`}><span className="muted">{t('inScope', { defaultValue: 'in scope' })}:</span> {x}</li>)}</ul>}
                      {src.outOfScope.length > 0 && <ul className="u-fs-11 u-pl-3">{src.outOfScope.map((x) => <li key={`out:${x}`}><span className="muted">{t('outOfScope', { defaultValue: 'out of scope' })}:</span> {x}</li>)}</ul>}
                    </div>
                  ))}
                  {list(t('forbidden', { defaultValue: 'forbidden' }), prefill.forbidden)}
                  {list(t('needsApproval', { defaultValue: 'needs approval' }), prefill.requireApproval)}
                  {(prefill.forbidden.length > 0 || prefill.requireApproval.length > 0) && (
                    <p className="muted u-fs-11">{t('inheritedNote', { defaultValue: 'The mission keeps these restrictions. You can add to them, not remove them.' })}</p>
                  )}
                </div>
              )}
              {!viewer.mayEdit ? (
                <p className="muted u-fs-12">{t('readOnly', { defaultValue: 'Only the conversation’s owner can draft its mission.' })}</p>
              ) : (<>
              <TextField
                label={t('goal', { defaultValue: 'Goal' })}
                value={goal}
                onChange={(e) => { setGoal(e.target.value); if (goalError) setGoalError(false); }}
                placeholder={t('goalPlaceholder', { defaultValue: 'Goal (what should the agent accomplish?)' })}
                error={goalError ? t('needGoal', { defaultValue: 'Enter a goal.' }) : undefined}
                required
                className="u-fs-12"
              />
              <TextareaField
                label={t('criteria', { defaultValue: 'Success criteria' })}
                value={criteria}
                onChange={(e) => setCriteria(e.target.value)}
                placeholder={t('criteriaPlaceholder', { defaultValue: 'Success criteria, one per line (optional)' })}
                rows={3}
                className="u-fs-12"
              />
              {/* IL2UX-5 — say what the form makes BEFORE it is made (it has no tool picker). */}
              <p className="muted u-fs-11">{t('formNoTools', { defaultValue: 'A mission drafted here lists no allowed tools, so approving it stops the agent from acting. To let it act within limits, ask the assistant to draft it.' })}</p>
              <div className="u-flex u-gap-2">
                <Button variant="primary" className="u-fs-12" disabled={busy} onClick={create}>{t('createDraft', { defaultValue: 'Create draft' })}</Button>
                {lastUserMessage?.trim() && (
                  <Button variant="secondary" className="u-fs-12" disabled={busy} onClick={draftWithAssistant}>{t('draftWithAssistant', { defaultValue: 'Draft with the assistant' })}</Button>
                )}
              </div>
              </>)}
            </section>
          ) : (
            <section className="u-flex u-flex-col u-gap-2" aria-labelledby="il-cur">
              <div className="u-flex u-items-center u-justify-between u-gap-2">
                <h3 id="il-cur" ref={headingRef} tabIndex={-1} className="u-fs-13">{ledger.goal}</h3>
                <span className={`chip u-fs-11 ${ledger.status === 'approved' ? 'chip--accent' : 'chip--warning'}`}>{t(`status_${ledger.status}`, { defaultValue: ledger.status })}</span>
              </div>
              {list(t('allowed', { defaultValue: 'allowed' }), ledger.allowed)}
              {ledger.allowed.length === 0 && <p className="muted u-fs-11">{t('noAllowedTools', { defaultValue: 'No tools are listed as allowed — while this mission is approved, the agent can talk but not act.' })}</p>}
              {list(t('forbidden', { defaultValue: 'forbidden' }), ledger.forbidden)}
              {list(t('needsApproval', { defaultValue: 'needs approval' }), ledger.requireApproval)}
              {ledger.expiresAtRelMs !== undefined && <p className="muted u-fs-11">{t('expiresAfter', { defaultValue: 'Ends {{duration}} after the agent starts working under it.', duration: formatTtl(ledger.expiresAtRelMs, i18n.language) })}</p>}
              {ledger.successCriteria.length > 0 && (
                <ul className="u-fs-11 u-pl-3">{ledger.successCriteria.map((c) => <li key={c}>{c}</li>)}</ul>
              )}

              {!viewer.mayDecide && (
                <p className="muted u-fs-11">{t('notDecider', { defaultValue: 'Only the conversation’s owner — or a workspace admin, if it has no owner — can approve or revoke this mission.' })}</p>
              )}
              {viewer.mayDecide && ledger.status === 'draft' && (
                <div className="u-flex u-gap-2">
                  <Button variant="primary" className="u-fs-12" disabled={busy} onClick={() => decide('approve')}><CheckIcon size={14} /> {t('approve', { defaultValue: 'Approve' })}</Button>
                  <Button variant="secondary" className="u-fs-12" disabled={busy} onClick={() => decide('reject')}><XIcon size={14} /> {t('reject', { defaultValue: 'Reject' })}</Button>
                </div>
              )}
              {ledger.status === 'approved' && (
                <>
                  {viewer.mayDecide && <Button variant="secondary" className="u-fs-11 u-self-start" disabled={busy} onClick={() => void revoke()}>{t('revoke', { defaultValue: 'Revoke mission' })}</Button>}
                  {reckoningBlock}
                </>
              )}
            </section>
          )}
      </div>
      )}
    </Modal>
  );
}
