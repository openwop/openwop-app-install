/**
 * ProjectLedgerTab — ADR 0831 P4. The project's team intent ledger: what the
 * project is for at the current version (the charter's goal and objectives plus
 * scope, open questions and decisions), what changed since you last looked, the
 * owner's queue of proposed changes, and a form to propose one with a reason.
 *
 * Goal and objectives are edited on the Overview tab (the charter is their only
 * home); a direct charter edit shows up here as a version. Every write is
 * re-checked server-side; `canWrite` and "is owner" only pre-gate controls.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { InlineState } from '../../ui/InlineState.js';
import { confirm } from '../../ui/confirm.js';
import { BookOpenIcon } from '../../ui/icons/index.js';
import { useBackendSession } from '../../auth/backendSession.js';
import { loadOrgMembers } from '../../orgs/orgMembers.js';
import { formatRelativeTime } from '../../i18n/format.js';
import type { Project } from './projectsClient.js';
import { DecisionSuggestionsSection } from './DecisionSuggestionsSection.js';
import {
  acceptLedgerChange, createTeamLedger, getTeamLedger, listLedgerDeltas, markSeen, takeLegacySeenVersion,
  proposeLedgerChange, rejectLedgerChange, type LedgerDelta, type LedgerPatch, type LedgerState, type TeamLedger,
} from './teamLedgerClient.js';

type Load = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; ledger: TeamLedger | null; state: LedgerState | null; deltas: LedgerDelta[]; seen: number | null };

const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const statusOf = (err: unknown): number | undefined => (err as { status?: number } | undefined)?.status;

export function ProjectLedgerTab({ project, canWrite }: { project: Project; canWrite: boolean }): JSX.Element {
  const { t } = useTranslation('projects');
  const me = useBackendSession().user?.userId;
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // People are shown by name, never by subject id; an unresolved id falls back to itself.
  const [names, setNames] = useState<Record<string, string>>({});
  // A failed directory read is SAID, not swallowed: every id below would otherwise
  // read as though it were the person's name (the PRJ-G1 class the Members tab fixed).
  const [namesFailed, setNamesFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadOrgMembers(project.orgId)
      .then((ms) => { if (live) { setNamesFailed(false); setNames(Object.fromEntries(ms.filter((m) => m.subject).map((m) => [m.subject as string, m.displayName]))); } })
      .catch(() => { if (live) setNamesFailed(true); });
    return () => { live = false; };
  }, [project.orgId]);
  const nameOf = (subject: string): string => names[subject] ?? subject;
  const fieldLabel = (k: string): string => ({
    goal: t('ledgerGoal'), objectives: t('ledgerObjectives'), inScope: t('ledgerInScope'),
    outOfScope: t('ledgerOutOfScope'), openQuestions: t('ledgerOpenQuestions'), decisionDocumentIds: t('ledgerDecisions'),
  } as Record<string, string>)[k] ?? k;

  const refresh = useCallback(async () => {
    try {
      const { ledger, state, seenVersion } = await getTeamLedger(project.id);
      const deltas = ledger ? await listLedgerDeltas(project.id) : [];
      let seen = seenVersion ?? null;
      // ADR 0831 D1 — carry a pre-server, per-browser "last seen" up once.
      const legacy = takeLegacySeenVersion(project.id);
      if (ledger && seen === null && legacy !== null) {
        seen = await markSeen(project.id, Math.min(legacy, ledger.version)).catch(() => legacy);
      }
      setLoad({ kind: 'ready', ledger, state, deltas, seen });
    } catch {
      setLoad({ kind: 'failed' });
    }
  }, [project.id]);
  useEffect(() => { void refresh(); }, [refresh]);

  /** Resolves `true` only when the action landed — a caller that clears its input on
   *  success must not clear it on a failure the person still has to retry. */
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true); setError(null);
    try { await fn(); await refresh(); return true; } catch (err) {
      setError(statusOf(err) === 403 ? t('ledgerErrForbidden') : t('ledgerErrGeneric'));
      return false;
    } finally { setBusy(false); }
  };

  if (load.kind === 'loading') return <InlineState kind="loading" message={t('ledgerLoading')} />;
  if (load.kind === 'failed') {
    return <InlineState kind="failed" announce={t('ledgerLoadFailed')} announcePolite message={t('ledgerLoadFailed')} action={<Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('ledgerRetry')}</Button>} />;
  }
  if (!load.ledger || !load.state) {
    return (
      <StateCard
        icon={<BookOpenIcon size={20} />}
        title={t('ledgerEmptyTitle')}
        body={t('ledgerEmptyBody')}
        action={canWrite ? <Button variant="accent-solid" size="sm" disabled={busy} onClick={() => void act(() => createTeamLedger(project.id))}>{t('ledgerStart')}</Button> : undefined}
      />
    );
  }

  const { ledger, state, deltas } = load;
  const isOwner = !!me && me === ledger.ownerSubject;
  const seen = load.seen;
  const changedSince = seen !== null && seen < ledger.version
    ? deltas.filter((d) => d.status === 'accepted' && (d.resultVersion ?? 0) > seen)
    : [];
  const pending = deltas.filter((d) => d.status === 'proposed');

  const accept = (d: LedgerDelta): Promise<boolean> => act(async () => {
    try { await acceptLedgerChange(project.id, d.deltaId); } catch (err) {
      if (statusOf(err) !== 409) throw err;
      // The ledger moved since this was proposed: say so, then accept on purpose.
      const ok = await confirm({ title: t('ledgerStaleTitle'), body: t('ledgerStaleBody', { from: d.baseVersion, to: ledger.version }), confirmLabel: t('ledgerAcceptAnyway') });
      if (ok) await acceptLedgerChange(project.id, d.deltaId, true);
    }
  });

  const pendingSection = (
    <>
      <section className="surface-card" aria-labelledby="ledger-pending">
        <h2 id="ledger-pending" className="u-fs-14">{t('ledgerPendingTitle', { count: pending.length })}</h2>
        {pending.length === 0 ? <p className="muted">{t('ledgerPendingEmpty')}</p> : (
          <ul className="u-list-none u-p-0">
            {pending.map((d) => (
              <li key={d.deltaId} className="u-mb-3">
                <div>{d.why}</div>
                <div className="muted u-fs-12">
                  {t(d.author.kind === 'agent' ? 'ledgerByAgent' : 'ledgerByPerson', { who: d.author.kind === 'agent' ? d.author.id : nameOf(d.author.id) })} · {formatRelativeTime(d.createdAt)} · {t('ledgerFields', { fields: Object.keys(d.patch).map(fieldLabel).join(', ') })}
                  {d.baseVersion < ledger.version ? ` · ${t('ledgerStaleChip', { version: d.baseVersion })}` : ''}
                </div>
                {isOwner ? (
                  <div className="action-bar u-mt-1">
                    <Button variant="accent-solid" size="sm" disabled={busy} onClick={() => void accept(d)}>{t('ledgerAccept')}</Button>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void act(() => rejectLedgerChange(project.id, d.deltaId))}>{t('ledgerReject')}</Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {!isOwner && pending.length > 0 ? <p className="muted u-fs-12">{t('ledgerOwnerDecides')}</p> : null}
      </section>

    </>
  );
  // DESIGN §4.5 rule 1 — decision-first: the owner's waiting queue leads.
  const queueFirst = isOwner && pending.length > 0;

  return (
    <div className="page-stack">
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      {namesFailed ? <Notice variant="warning" announce={t('ledgerNamesFallback')}>{t('ledgerNamesFallback')}</Notice> : null}

      {queueFirst ? pendingSection : null}

      {/* ADR 0853 D1 — possible decisions from chat, inbound, approvals, meetings, drift. */}
      <DecisionSuggestionsSection projectId={project.id} canWrite={canWrite} isOwner={isOwner} onRecorded={() => void refresh()} />

      {changedSince.length > 0 ? (
        <section className="surface-card" aria-labelledby="ledger-changed">
          <h2 id="ledger-changed" className="u-fs-14">{t('ledgerChangedSince', { version: seen })}</h2>
          <ul>{changedSince.map((d) => <li key={d.deltaId}>{d.why} <span className="muted">— v{d.resultVersion} · {formatRelativeTime(d.createdAt)}</span></li>)}</ul>
          <Button variant="secondary" size="sm" onClick={() => void act(() => markSeen(project.id, ledger.version))}>{t('ledgerMarkSeen')}</Button>
        </section>
      ) : null}

      <section className="surface-card" aria-labelledby="ledger-now">
        <div className="u-flex u-wrap u-items-center u-gap-2">
          <h2 id="ledger-now" className="u-fs-14 u-flex-1">{t('ledgerNowTitle')}</h2>
          <span className="chip chip--muted">{t('ledgerVersion', { version: ledger.version })}</span>
          <span className="chip chip--muted">{isOwner ? t('ledgerOwnerYou') : t('ledgerOwner', { owner: nameOf(ledger.ownerSubject) })}</span>
        </div>
        <LedgerList label={t('ledgerGoal')} items={state.goal ? [state.goal] : []} empty={t('ledgerGoalEmpty')} />
        <LedgerList label={t('ledgerObjectives')} items={state.objectives} empty={t('ledgerNone')} />
        <LedgerList label={t('ledgerInScope')} items={state.inScope} empty={t('ledgerNone')} />
        <LedgerList label={t('ledgerOutOfScope')} items={state.outOfScope} empty={t('ledgerNone')} />
        <LedgerList label={t('ledgerOpenQuestions')} items={state.openQuestions} empty={t('ledgerNone')} />
        {/* ADR 0856 — the tool policy for this project's chats (shown when set). */}
        {state.toolPolicy?.forbidden.length ? <LedgerList label={t('ledgerToolsForbidden')} items={state.toolPolicy.forbidden} empty={t('ledgerNone')} /> : null}
        {state.toolPolicy?.requireApproval.length ? <LedgerList label={t('ledgerToolsApproval')} items={state.toolPolicy.requireApproval} empty={t('ledgerNone')} /> : null}
        <p className="muted u-fs-12">{t('ledgerDecisionsCount', { count: state.decisionDocumentIds.length })} {t('ledgerGoalHint')}</p>
        {seen === null || seen < ledger.version ? (
          changedSince.length === 0 ? <Button variant="quiet" size="sm" onClick={() => void act(() => markSeen(project.id, ledger.version))}>{t('ledgerMarkSeen')}</Button> : null
        ) : null}
      </section>

      {queueFirst ? null : pendingSection}

      {canWrite ? <ProposeForm state={state} busy={busy} onPropose={(patch, why) => act(() => proposeLedgerChange(project.id, patch, why, ledger.version))} /> : null}
    </div>
  );
}

function LedgerList({ label, items, empty }: { label: string; items: readonly string[]; empty: string }): JSX.Element {
  return (
    <div className="u-mt-2">
      <h3 className="u-fs-12 muted">{label}</h3>
      {items.length === 0 ? <p className="muted u-fs-12">{empty}</p> : <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>}
    </div>
  );
}

/** Propose replacement lists for scope and open questions; only changed lists are sent. */
function ProposeForm({ state, busy, onPropose }: { state: LedgerState; busy: boolean; onPropose: (patch: LedgerPatch, why: string) => Promise<boolean> }): JSX.Element {
  const { t } = useTranslation('projects');
  const [inScope, setInScope] = useState(state.inScope.join('\n'));
  const [outOfScope, setOutOfScope] = useState(state.outOfScope.join('\n'));
  const [openQuestions, setOpenQuestions] = useState(state.openQuestions.join('\n'));
  const [forbidden, setForbidden] = useState((state.toolPolicy?.forbidden ?? []).join('\n'));
  const [approval, setApproval] = useState((state.toolPolicy?.requireApproval ?? []).join('\n'));
  const [why, setWhy] = useState('');
  // ADR 0856 — the tool policy is replaced whole when either list changed.
  const policyChanged = !sameList(lines(forbidden), state.toolPolicy?.forbidden ?? []) || !sameList(lines(approval), state.toolPolicy?.requireApproval ?? []);
  const patch: LedgerPatch = {
    ...(sameList(lines(inScope), state.inScope) ? {} : { inScope: lines(inScope) }),
    ...(sameList(lines(outOfScope), state.outOfScope) ? {} : { outOfScope: lines(outOfScope) }),
    ...(sameList(lines(openQuestions), state.openQuestions) ? {} : { openQuestions: lines(openQuestions) }),
    ...(policyChanged ? { toolPolicy: { forbidden: lines(forbidden), requireApproval: lines(approval) } } : {}),
  };
  const changed = Object.keys(patch).length > 0;
  return (
    <form className="surface-card" aria-labelledby="ledger-propose" onSubmit={(e) => { e.preventDefault(); if (changed && why.trim()) void onPropose(patch, why.trim()).then((ok) => { if (ok) setWhy(''); }); }}>
      <h2 id="ledger-propose" className="u-fs-14">{t('ledgerProposeTitle')}</h2>
      <p className="muted u-fs-12">{t('ledgerProposeHint')}</p>
      <label className="hire-label" htmlFor="ledger-in">{t('ledgerInScope')}</label>
      <textarea id="ledger-in" className="ui-input" rows={3} value={inScope} onChange={(e) => setInScope(e.target.value)} />
      <label className="hire-label" htmlFor="ledger-out">{t('ledgerOutOfScope')}</label>
      <textarea id="ledger-out" className="ui-input" rows={3} value={outOfScope} onChange={(e) => setOutOfScope(e.target.value)} />
      <label className="hire-label" htmlFor="ledger-q">{t('ledgerOpenQuestions')}</label>
      <textarea id="ledger-q" className="ui-input" rows={3} value={openQuestions} onChange={(e) => setOpenQuestions(e.target.value)} />
      <label className="hire-label" htmlFor="ledger-tools-forbidden">{t('ledgerToolsForbidden')}</label>
      <textarea id="ledger-tools-forbidden" className="ui-input" rows={2} value={forbidden} onChange={(e) => setForbidden(e.target.value)} />
      <label className="hire-label" htmlFor="ledger-tools-approval">{t('ledgerToolsApproval')}</label>
      <textarea id="ledger-tools-approval" className="ui-input" rows={2} value={approval} onChange={(e) => setApproval(e.target.value)} />
      <p className="muted u-fs-12">{t('ledgerToolsHint')}</p>
      <label className="hire-label" htmlFor="ledger-why">{t('ledgerWhy')}</label>
      <input id="ledger-why" className="ui-input" maxLength={500} value={why} onChange={(e) => setWhy(e.target.value)} />
      <div className="action-bar u-mt-2">
        <Button type="submit" variant="accent-solid" size="sm" disabled={busy || !changed || !why.trim()}>{t('ledgerProposeSubmit')}</Button>
      </div>
    </form>
  );
}
