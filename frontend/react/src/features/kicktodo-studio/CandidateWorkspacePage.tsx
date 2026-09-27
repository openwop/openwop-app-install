/**
 * Candidate workspace (ADR 0437 UX-2.2 + read-side of UX-2.3/2.6) — the creator's
 * single view of one Challenge-Factory candidate, built over the EXISTING
 * `kicktodo-creator` reads (`GET /candidates/:id` + `/publication` + `/monitor`);
 * no new backend, no wire.
 *
 * The spine is the honesty device: each lifecycle stage renders ONLY the state the
 * server can back. Research shows the real dossier (sources/claims) and flags
 * unsupported claims rather than hiding them; the publication gate shows the
 * server's verdict and is NEVER a bypassable green. The gate ACTIONS are not on
 * this page BY DECISION, not by deferral (ADR 0458 P4): submission is the
 * factory's terminal `submit-publication` step driven from the embedded chat,
 * and the separation-of-duties approval is decided in the reviews inbox — a
 * bespoke submit/approve button here would duplicate a first-class primitive.
 * Read-first: this page requests + shows; its one mutation is the kill switch.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { toast } from '../../ui/toast.js';
import { CheckIcon, XIcon, InfoIcon } from '../../ui/icons/index.js';
import { confirm } from '../../ui/confirm.js';
import { pubStateLabel } from './publicationLabels.js';
// ADR 0461 P3 — the ONE chat embedded candidate-scoped (ADR 0073; static
// import is sanctioned — chat/ does not import kicktodo-studio back).
import { EmbeddedChatPanel } from '../../chat/EmbeddedChatPanel.js';
import { CandidateChatWelcome } from './CandidateChatWelcome.js';
import { CHALLENGE_AUTHOR_AGENT_ID } from './challengeAuthor.js';
import {
  getCandidate,
  getPublication,
  getMonitorReport,
  getGateStatus,
  getSimulationVerdicts,
  getLessonStatus,
  killCandidate,
  ensureOutlineCanvas,
  applyOutline,
  type FactoryCandidate,
  type PublicationState,
  type MonitorReport,
  type GateRow,
  type SimulationVerdicts,
  type LessonDayStatus,
  type OutlineApplyResult,
} from '../../client/kicktodoStudioClient.js';

export type StageStatus = 'done' | 'current' | 'pending' | 'blocked';

/** The five lifecycle stages of a candidate, derived from the record's `state`
 *  (+ publication) — the §5.3 Provenance Spine. Each maps to what the server backs.
 *  Exported for the unit test that pins the honesty invariants (a `withdrawn`
 *  candidate never shows a green publication; a submitted-but-not-completed
 *  publication is `current`, not `done`). */
export function spineStatus(state: string, hasDossier: boolean, pub: PublicationState | null): Record<string, StageStatus> {
  const withdrawn = state === 'withdrawn';
  // The candidate `state` is the PAST-TENSE completion of a stage: `researched`
  // ⇒ research is done and plan is the active stage, and so on. `withdrawn` gives
  // no forward rank (the kill switch can fire at various points) — render the
  // gate as blocked and defer to the dossier for what earlier work exists.
  const rank: Record<string, number> = { intake: 0, researched: 1, planned: 2, published: 3 };
  // UNKNOWN states fail CLOSED like withdrawn (no forward rank): a future
  // terminal state must never render a live "in progress" spine (screen-polish
  // honesty hardening — the server vocabulary is the rank map's keys).
  const known = withdrawn || state in rank;
  const r = withdrawn || !known ? -1 : (rank[state] ?? 0);
  const publicationDone = pub?.state === 'completed' || state === 'published';
  return {
    intake: 'done',
    research: hasDossier || r >= 1 ? 'done' : (withdrawn || !known) ? 'blocked' : 'current',
    plan: r >= 2 ? 'done' : (withdrawn || !known) ? 'blocked' : r >= 1 ? 'current' : 'pending',
    publication: publicationDone ? 'done'
      : pub?.state === 'submitted' ? 'current'
      : (withdrawn || !known) ? 'blocked'
      : r >= 2 ? 'current' : 'pending',
    monitor: state === 'published' ? 'current' : 'pending',
  };
}

export function CandidateWorkspacePage() {
  const { t } = useTranslation('kicktodo-studio');
  const navigate = useNavigate();
  const { candidateId = '' } = useParams();
  const [candidate, setCandidate] = useState<FactoryCandidate | null | undefined>(undefined);
  // ADR 0461 P3 — the embedded chat is CLOSED by default (dense page); the
  // chat stack mounts only when opened.
  const [chatOpen, setChatOpen] = useState(false);
  const [publication, setPublication] = useState<PublicationState | null>(null);
  const [monitor, setMonitor] = useState<MonitorReport | null>(null);
  // ADR 0460 Phase 1 — the three honesty reads (display-only; `undefined` = still
  // loading, `null` = the server has nothing to back this yet → honest empty state).
  const [gates, setGates] = useState<GateRow[] | null | undefined>(undefined);
  const [simulation, setSimulation] = useState<SimulationVerdicts | null | undefined>(undefined);
  const [lessons, setLessons] = useState<LessonDayStatus[] | null | undefined>(undefined);
  const [error, setError] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [retireError, setRetireError] = useState(false);

  const reload = useCallback(async () => {
    try {
      setError(false);
      const [c, p, m, g, s, l] = await Promise.all([
        getCandidate(candidateId),
        getPublication(candidateId).catch(() => null),
        getMonitorReport(candidateId).catch(() => null),
        getGateStatus(candidateId).catch(() => null),
        getSimulationVerdicts(candidateId).catch(() => null),
        getLessonStatus(candidateId).catch(() => null),
      ]);
      setCandidate(c);
      setPublication(p);
      setMonitor(m);
      setGates(g);
      setSimulation(s);
      setLessons(l);
    } catch { setError(true); }
  }, [candidateId]);
  useEffect(() => { void reload(); }, [reload]);

  // UX-2.6 kill switch — retire the published challenge + withdraw the candidate.
  // Destructive + irreversible, so it rides the canonical confirm dialog (never
  // window.confirm) with a REQUIRED reason (the server also enforces + audits it).
  const onRetire = async () => {
    const trimmed = reason.trim();
    if (!trimmed) return;
    const ok = await confirm({
      title: t('retireConfirmTitle'),
      body: t('retireConfirmBody'),
      confirmLabel: t('retireConfirmCta'),
      danger: true,
    });
    if (!ok) return;
    setBusy(true); setRetireError(false);
    try { await killCandidate(candidateId, trimmed); setReason(''); await reload(); }
    catch { setRetireError(true); }
    finally { setBusy(false); }
  };


  // ADR 0458 §2.3 — the structured outline canvas. "Open" ensures the
  // per-candidate canvas then navigates to the editor; "Apply" runs the plan
  // validator server-side and persists a new revision only on zero defects —
  // the defect list is rendered VERBATIM (the participant-facing honesty of
  // validatePlan), never softened.
  const [outlineBusy, setOutlineBusy] = useState<'open' | 'apply' | null>(null);
  const [outlineError, setOutlineError] = useState(false);
  const [applyResult, setApplyResult] = useState<OutlineApplyResult | null>(null);
  const onOpenOutline = async () => {
    setOutlineBusy('open'); setOutlineError(false);
    try {
      const { canvasId, seededFrom } = await ensureOutlineCanvas(candidateId);
      // Honest about provenance: a 'skeleton' seed is the intake targets with
      // EMPTY days, NOT a generated plan — say so before the editor opens.
      if (seededFrom === 'skeleton') toast.info(t('outlineSkeletonSeed'));
      navigate(`/challenge-outline/${encodeURIComponent(canvasId)}`);
    } catch { setOutlineError(true); setOutlineBusy(null); }
  };
  const onApplyOutline = async () => {
    setOutlineBusy('apply'); setOutlineError(false); setApplyResult(null);
    try {
      const res = await applyOutline(candidateId);
      setApplyResult(res);
      if (res.applied) await reload();
    } catch { setOutlineError(true); }
    finally { setOutlineBusy(null); }
  };

  const dossier = candidate?.dossier;
  const spine = useMemo(
    () => spineStatus(candidate?.state ?? 'intake', !!dossier, publication),
    [candidate?.state, dossier, publication],
  );

  const statusChip = (s: StageStatus): string =>
    s === 'done' ? 'chip chip--success'
      : s === 'blocked' ? 'chip chip--danger'
      : s === 'current' ? 'chip'
      : 'chip chip--muted';
  const statusLabel = (s: StageStatus): string =>
    s === 'done' ? t('stageDone') : s === 'blocked' ? t('stageBlocked') : s === 'current' ? t('stageCurrent') : t('stagePending');

  // anchor = the section each stage OWNS (the spine is the nav, §5.3/§4.4).
  const STAGES: { key: string; labelKey: string; anchor?: string }[] = [
    { key: 'intake', labelKey: 'stageIntake' },
    { key: 'research', labelKey: 'stageResearch', anchor: 'cwp-research' },
    { key: 'plan', labelKey: 'stagePlan', anchor: 'cwp-plan' },
    { key: 'publication', labelKey: 'stagePublication', anchor: 'cwp-publication' },
    { key: 'monitor', labelKey: 'stageMonitor', anchor: 'cwp-monitor' },
  ];

  const claimSupport = (claimId: string): boolean => !(dossier?.unsupportedClaimIds ?? []).includes(claimId);

  // ADR 0460 Phase 1 — gate-matrix + simulation grammar. Status is conveyed by
  // SHAPE (glyph) + LABEL, never colour alone (DESIGN.md §11 a11y). The `rights`
  // row is INFORMATIONAL — a disclosure, not a pass/fail the engine enforces — so
  // it renders with the info glyph + a muted chip, visually distinct from the
  // enforced gates (the /architect honesty correction).
  const gateGlyph = (g: GateRow) =>
    g.informational ? <InfoIcon size={13} aria-hidden />
      : g.state === 'pass' ? <CheckIcon size={13} aria-hidden />
      : <XIcon size={13} aria-hidden />;
  const gateChip = (g: GateRow): string =>
    g.informational ? 'chip chip--muted'
      : g.state === 'pass' ? 'chip chip--success'
      : 'chip chip--danger';
  const gateStateLabel = (g: GateRow): string =>
    g.informational ? t('gateInfo') : g.state === 'pass' ? t('gatePass') : t('gateOpen');
  const verdictChip = (v: 'pass' | 'flag' | 'block'): string =>
    v === 'pass' ? 'chip chip--success' : v === 'flag' ? 'chip chip--warning' : 'chip chip--danger';

  return (
    <div className="page">
      <div className="action-bar">
        <Link className="btn-ghost btn-sm" to="/kicktodo/studio">{t('backToStudio')}</Link>
      </div>

      {error && <Notice variant="error">{t('loadError')}</Notice>}
      {candidate === undefined && !error && <StateCard loading title={t('workspaceTitle')} />}
      {candidate === null && !error && (
        <StateCard title={t('candidateNotFoundTitle')} body={t('candidateNotFoundBody')}
          action={<Link className="btn-accent-solid" to="/kicktodo/studio">{t('backToStudio')}</Link>} />
      )}

      {candidate && (
        <>
          <header className="page-header">
            {/* One-pager pass — the candidate strip: mono provenance line + the
                awaiting-approver pill (separation of duties made visible where
                the work happens, not only down in the gate section). */}
            <p className="kt-candidate-strip">
              <span className="studio-id">{t('candidateEyebrow')} · {candidate.id}</span>
              {publication?.state === 'submitted' && (
                <span className="chip chip--warning">{t('awaitingApproverPill')}</span>
              )}
            </p>
            <h1 className="page-header__title">{candidate.topic}</h1>
            {candidate.audience && <p className="page-header__lede">{candidate.audience}</p>}
            <div className="action-bar">
              <span className="chip chip--muted">{t('riskTier', { tier: candidate.riskTier })}</span>
              {candidate.durationDaysTarget > 0 && <span className="chip">{t('daysTarget', { count: candidate.durationDaysTarget })}</span>}
              {candidate.dailyMinutesTarget > 0 && <span className="chip">{t('minutesTarget', { count: candidate.dailyMinutesTarget })}</span>}
              <span className="studio-id">{candidate.id}</span>
            </div>
            {candidate.riskSignals.length > 0 && (
              <p className="muted u-fs-13">{t('riskSignals', { signals: candidate.riskSignals.join(', ') })}</p>
            )}
            {candidate.transformation && <p>{candidate.transformation}</p>}
          </header>

          {/* Screen-polish STRUCTURAL fix (ADR 0437 §5.3/§4.4): the spine is
              simultaneously the workspace's NAVIGATION and its status readout —
              a sticky rail whose stages anchor their sections; the 11-card wall
              becomes a mapped two-column workspace. */}
          <div className="cwp-layout">
          <aside className="cwp-rail">
          <section className="surface-card studio-console" aria-label={t('spineHeading')}>
            <h2 className="u-fs-13 muted">{t('spineHeading')}</h2>
            <ol role="list" className="kt-spine list-plain">
              {STAGES.map((st) => {
                const status = spine[st.key] ?? 'pending';
                const meta =
                  st.key === 'research' && dossier ? `${t('sourcesCount', { count: dossier.sources.length })} · ${t('claimsCount', { count: dossier.claims.length })}`
                  : st.key === 'plan' && candidate.draft ? t('spineDraftMeta', { version: candidate.draft.challengeVersion })
                  : st.key === 'publication' && publication?.submittedBy ? t('submittedBy', { who: publication.submittedBy })
                  : st.key === 'monitor' && monitor ? (monitor.broken > 0 ? t('monitorBroken', { count: monitor.broken }) : t('monitorHealthy'))
                  : null;
                return (
                  <li key={st.key} className={`kt-spine__stage kt-spine__stage--${status}`}>
                    <span className="kt-spine__dot" aria-hidden>
                      {status === 'done' && <CheckIcon size={10} aria-hidden />}
                    </span>
                    <div className="kt-spine__body">
                      <strong className="kt-spine__name">
                        {st.anchor ? <a className="kt-spine__link" href={`#${st.anchor}`}>{t(st.labelKey)}</a> : t(st.labelKey)}
                      </strong>
                      <span className={statusChip(status)}>{statusLabel(status)}</span>
                      {meta && <span className="kt-spine__meta">{meta}</span>}
                    </div>
                  </li>
                );
              })}
              <li className={candidate.state === 'published' ? 'kt-spine__seal kt-spine__seal--earned' : 'kt-spine__seal'}>
                <span className="kt-spine__seal-glyph" aria-hidden />
                <span className="kt-spine__meta">
                  {candidate.state === 'published' ? t('sealEarned') : t('sealPending')}
                </span>
              </li>
            </ol>
          </section>
          </aside>

          <div className="cwp-main">
          {/* Research dossier (read side of UX-2.3) — claims-first, unsupported flagged. */}
          <section id="cwp-research" className="surface-card" aria-label={t('researchHeading')}>
            <h2 className="u-fs-13 muted">{t('researchHeading')}</h2>
            {!dossier ? (
              <p className="muted u-fs-13">{t('researchEmpty')}</p>
            ) : (
              <>
                <div className="action-bar">
                  <span className="chip">{t('sourcesCount', { count: dossier.sources.length })}</span>
                  <span className="chip">{t('claimsCount', { count: dossier.claims.length })}</span>
                  {dossier.unsupportedClaimIds.length > 0 && (
                    <span className="chip chip--danger">{t('unsupportedCount', { count: dossier.unsupportedClaimIds.length })}</span>
                  )}
                  {dossier.engines.length > 0 && <span className="chip chip--muted">{t('enginesLabel', { engines: dossier.engines.join(', ') })}</span>}
                </div>
                {dossier.claims.length > 0 && (
                  <ul role="list" className="list-plain">
                    {dossier.claims.map((c) => (
                      <li key={c.claimId} className="list-row">
                        <div>
                          {c.text}
                          {claimSupport(c.claimId)
                            ? <span className="muted u-fs-13"> · {t('claimSupportedN', { count: c.sourceHashes.length })}</span>
                            : <span className="chip chip--danger"> {t('claimUnsupported')}</span>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {dossier.sources.length > 0 && (
                  <>
                    <h3 className="u-fs-13 muted">{t('sourcesHeading')}</h3>
                    <ul role="list" className="list-plain">
                      {dossier.sources.map((s) => (
                        <li key={s.hash} className="list-row">
                          <div>
                            <a href={s.url} target="_blank" rel="noreferrer noopener">{s.title || s.domain}</a>
                            <span className="muted u-fs-13"> · {s.domain} · {t('sourceEngine', { engine: s.engine })}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </section>

          {/* Publication gate (UX-2.6) — the server's verdict + the submit/approve
              actions. The server re-checks the hard gates on submit and enforces a
              distinct approver on complete; the FE never presents either as bypassable. */}
          <section id="cwp-publication" className="surface-card" aria-label={t('publicationHeading')}>
            <h2 className="u-fs-13 muted">{t('publicationHeading')}</h2>
            {publication && (
              <div className="action-bar">
                <span className={publication.state === 'completed' ? 'chip chip--success' : 'chip'}>
                  {t('publicationState', { state: pubStateLabel(publication.state, t) })}
                </span>
                {publication.submittedBy && <span className="chip chip--muted">{t('submittedBy', { who: publication.submittedBy })}</span>}
                {publication.completedBy && <span className="chip chip--muted">{t('completedBy', { who: publication.completedBy })}</span>}
              </div>
            )}

            {/* ADR 0458 P4 — the gate ACTIONS live in the shared reviews machinery,
                not on the author's own page: submission is the factory's terminal
                submit-publication step (driven from the chat), and the
                separation-of-duties decision is made in the reviews inbox. This
                section only STATES where things stand — a bespoke approve button
                here would duplicate a first-class primitive (the audit's finding). */}
            {candidate.state !== 'withdrawn' && candidate.state !== 'published' && (
              <>
                {!publication && !candidate.draft && (
                  <p className="muted u-fs-13">{t('publicationNeedsDraft')}</p>
                )}
                {!publication && candidate.draft && (
                  <p className="muted u-fs-13">{t('publicationViaFactoryNote')}</p>
                )}
                {publication?.state === 'submitted' && (
                  <div className="action-bar">
                    <span className="muted u-fs-13">{t('publicationAwaitingApproverNote')}</span>
                    <Link className="btn-ghost btn-sm" to="/chat?rail=reviews">{t('openReviewsInbox')}</Link>
                  </div>
                )}
              </>
            )}
          </section>

          {/* ADR 0460 Phase 1 — the honest 5-gate matrix. Re-derived SERVER-SIDE
              from the same predicates the publish path enforces, so it can never
              paint an all-green it can't back. `evidence/claims/safety/simulation`
              are the enforced gates; `rights` is an informational disclosure row. */}
          <section className="surface-card" aria-label={t('gateMatrixHeading')}>
            <h2 className="u-fs-13 muted">{t('gateMatrixHeading')}</h2>
            {gates === undefined ? <StateCard loading title={t('gateMatrixHeading')} />
              : gates === null ? <p className="muted u-fs-13">{t('gateMatrixEmpty')}</p>
              : (
                <ul role="list" className="list-plain">
                  {gates.map((g) => (
                    <li key={g.gate} className="list-row">
                      <div>
                        <div className="action-bar">
                          <span aria-hidden>{gateGlyph(g)}</span>
                          <strong>{t(`gate_${g.gate}`)}</strong>
                          <span className={gateChip(g)}>{gateStateLabel(g)}</span>
                        </div>
                        {g.detail && <span className="muted u-fs-13">{g.detail}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
          </section>

          {/* ADR 0460 Phase 1 — the three-persona simulation verdicts, VERBATIM
              (findings never softened). Absent ⇒ "not simulated", never a faked pass. */}
          <section className="surface-card" aria-label={t('simHeading')}>
            <h2 className="u-fs-13 muted">{t('simHeading')}</h2>
            {simulation === undefined ? <StateCard loading title={t('simHeading')} />
              : !simulation || simulation.verdicts.length === 0 ? (
                <p className="muted u-fs-13">{t('simEmpty')}</p>
              ) : (
                <ul role="list" className="list-plain list-nested">
                  {simulation.verdicts.map((v) => (
                    <li key={v.sim} className="list-row">
                      <div>
                        <div className="action-bar">
                          <strong>{t(`persona_${v.sim}`)}</strong>
                          <span className={verdictChip(v.verdict)}>{t(`verdict_${v.verdict}`)}</span>
                        </div>
                        {v.personaSummary && <p className="u-fs-13">{v.personaSummary}</p>}
                        {v.findings.length > 0 && (
                          <ul role="list" className="list-plain">
                            {v.findings.map((f, i) => (
                              <li key={`${v.sim}-${i}`} className="muted u-fs-13">
                                <span className={f.severity === 'block' ? 'chip chip--danger' : f.severity === 'flag' ? 'chip chip--warning' : 'chip chip--muted'}>
                                  {t(`severity_${f.severity}`)}
                                </span>{' '}
                                {f.text}{typeof f.day === 'number' ? ` · ${t('simFindingDay', { day: f.day })}` : ''}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
          </section>

          {/* Post-publication monitoring (read side) — a broken source opens a review
              finding server-side; it never rewrites content. Screen-polish: the
              section never VANISHES — "not monitored yet" is a designed state,
              not an absence. */}
          <section id="cwp-monitor" className="surface-card" aria-label={t('monitorHeading')}>
            <h2 className="u-fs-13 muted">{t('monitorHeading')}</h2>
            {monitor ? (
              <div className="action-bar">
                <span className={monitor.broken > 0 ? 'chip chip--danger' : 'chip chip--success'}>
                  {monitor.broken > 0 ? t('monitorBroken', { count: monitor.broken }) : t('monitorHealthy')}
                </span>
                <span className="chip chip--muted">{t('monitorChecked', { count: monitor.findings.length })}</span>
              </div>
            ) : (
              <p className="muted u-fs-13">{t('monitorNotYet')}</p>
            )}
          </section>

          {/* UX-2.6 kill switch — only meaningful once the candidate is published
              (it retires the live challenge). Reason is required + audited. */}
          {candidate.state === 'published' && (
            <section className="surface-card" aria-label={t('retireHeading')}>
              <h2 className="u-fs-13 muted">{t('retireHeading')}</h2>
              <p className="muted u-fs-13">{t('retireDescription')}</p>
              <label htmlFor="kt-retire-reason" className="u-fs-13 muted">{t('retireReasonLabel')}</label>
              <textarea id="kt-retire-reason" value={reason} maxLength={500}
                onChange={(e) => setReason(e.target.value)} aria-label={t('retireReasonLabel')} />
              <div className="action-bar">
                {/* Quiet trigger — the destructive emphasis + the "can't be undone"
                    gate live on the confirm dialog's danger button, not here. */}
                <Button variant="quiet" size="sm" disabled={busy || !reason.trim()}
                  onClick={() => void onRetire()}>
                  {busy ? t('retiring') : t('retireCta')}
                </Button>
              </div>
              {retireError && <Notice variant="error">{t('retireError')}</Notice>}
            </section>
          )}

          {/* ADR 0458 §2.3 — the structured outline canvas: a working DRAFT the
              creator refines between chat turns. The candidate's validated plan
              revision stays the only truth; "Apply" runs the plan validator and
              persists a new revision only on zero defects. */}
          {candidate.state !== 'withdrawn' && (
            <section id="cwp-plan" className="surface-card" aria-label={t('outlineHeading')}>
              <h2 className="u-fs-13 muted">{t('outlineHeading')}</h2>
              <p className="muted u-fs-13">{t('outlineDescription')}</p>
              <div className="action-bar">
                <Button variant="accent-solid" disabled={outlineBusy !== null} onClick={() => void onOpenOutline()}>
                  {outlineBusy === 'open' ? t('openingOutline') : t('openOutlineCta')}
                </Button>
                <Button variant="quiet" size="sm" disabled={outlineBusy !== null} onClick={() => void onApplyOutline()}>
                  {outlineBusy === 'apply' ? t('applyingOutline') : t('applyOutlineCta')}
                </Button>
                <span className="muted u-fs-13">{t('applyOutlineHint')}</span>
              </div>
              {outlineError && <Notice variant="error">{t('outlineError')}</Notice>}
              {applyResult?.applied && (
                <Notice variant="success" announce={t('applyOutlineOk', { version: applyResult.challengeVersion ?? '' })}>{t('applyOutlineOk', { version: applyResult.challengeVersion ?? '' })}</Notice>
              )}
              {applyResult?.publishedConflict && (
                <Notice variant="error">{t('applyPublishedConflict')}</Notice>
              )}
              {applyResult && !applyResult.applied && applyResult.defects.length > 0 && (
                <div className="surface-card" role="alert">
                  <h3 className="u-fs-13">{t('applyDefectsHeading', { count: applyResult.defects.length })}</h3>
                  <ul role="list" className="list-plain">
                    {applyResult.defects.map((d, i) => (
                      <li key={`${d.code}-${i}`} className="list-row">
                        <div>
                          <span className="chip chip--danger">{d.code}</span> {d.message}
                          {d.ref && <span className="muted u-fs-13"> · {d.ref}</span>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/* ADR 0460 Phase 1 — the per-day build strip. Durable signals ONLY:
              a day is `planned` (present in the validated plan revision) and may
              have media (a real media pointer). There is NO "enriched" claim — the
              rich lesson body is ephemeral node output with no host SSoT, so the
              strip never asserts a body it can't back. */}
          <section className="surface-card" aria-label={t('dayStripHeading')}>
            <h2 className="u-fs-13 muted">{t('dayStripHeading')}</h2>
            {lessons === undefined ? <StateCard loading title={t('dayStripHeading')} />
              : !lessons || lessons.length === 0 ? (
                <p className="muted u-fs-13">{t('dayStripEmpty')}</p>
              ) : (
                <>
                  <p className="muted u-fs-13">
                    {t('dayStripSummary', { days: lessons.length, withMedia: lessons.filter((l) => l.hasMedia).length })}
                  </p>
                  {/* Compact day dots (the participant surfaces' grammar) — 30
                      chips restating "no media" were noise; the summary line
                      above carries the counts, each dot carries its day via
                      title/aria-label, media days fill with the focus hue. */}
                  <div className="kt-rhythm__dots cwp-daydots" role="list" aria-label={t('dayStripHeading')}>
                    {lessons.map((l) => (
                      <span key={l.day} role="listitem"
                        className={l.hasMedia ? 'kt-rhythm__dot kt-rhythm__dot--milestone' : 'kt-rhythm__dot'}
                        title={`${t('dayStripDay', { day: l.day })} · ${l.hasMedia ? t(`mediaKind_${l.mediaKind}`) : t('dayNoMedia')}`}
                        aria-label={`${t('dayStripDay', { day: l.day })} · ${l.hasMedia ? t(`mediaKind_${l.mediaKind}`) : t('dayNoMedia')}`} />
                    ))}
                  </div>
                </>
              )}
          </section>

          {/* UX-2.3/2.4/2.5 — plan authoring, research, and simulation are AI-driven
              pipeline steps. Per the ADR 0058 chat-drivability pattern + CLAUDE.md
              "reuse the chat, never recreate", they run through the ONE chat —
              ADR 0461 P3: embedded HERE, candidate-scoped, collapsed by default
              (the page is a dense provenance shell; the chat stack mounts only
              when opened). The full-chat deep-link stays as the durable-thread
              escape hatch. */}
          <section className="surface-card" aria-label={t('aiAuthorHeading')}>
            {/* Heading ABOVE the bar — every sibling section's register
                (terminal-grade UX-T8); the toggle is the section's one accent-
                weight affordance. CONSTANT label + aria-expanded per the APG
                disclosure pattern (UX-T9) with aria-controls (F-11). */}
            <h2 className="u-fs-13 muted">{t('aiAuthorHeading')}</h2>
            <p className="muted u-fs-13">{t('aiAuthorDescription')}</p>
            <div className="action-bar">
              <Button variant="accent" size="sm" aria-expanded={chatOpen}
                aria-controls="candidate-chat-panel"
                onClick={() => setChatOpen((v) => !v)}>
                {t('candChatOpen')}
              </Button>
              <Link className="btn-ghost btn-sm" to={`/?agent=${CHALLENGE_AUTHOR_AGENT_ID}`}>{t('workWithChallengeAuthor')}</Link>
            </div>
            {chatOpen && (
              /* key: a candidate→candidate navigation must never carry A's
                 in-flight ephemeral thread under B's shell (F-9/UX-T10). */
              <div className="studio-author-panel" id="candidate-chat-panel" key={candidate.id}>
                <EmbeddedChatPanel
                  agentId={CHALLENGE_AUTHOR_AGENT_ID}
                  renderEmptyState={(onPick) => (
                    <CandidateChatWelcome onPick={onPick} candidateId={candidate.id} topic={candidate.topic} />
                  )}
                />
              </div>
            )}
          </section>

          <Notice variant="info">{t('workspaceDeferredActions')}</Notice>
          </div>
          </div>
        </>
      )}
    </div>
  );
}
