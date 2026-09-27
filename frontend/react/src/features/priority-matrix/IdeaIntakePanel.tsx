/**
 * Idea intake & evidence panel (ADR 0232 §P4) — a modal over one idea: intake
 * fields (requester / source / estimated value / notes), evidence pointers
 * (document / kb / url — never copies), merge-a-duplicate, and
 * promote-to-project. Promote-to-initiative rides the strategy feature's own
 * surface (the alignment control / chat), preserving the ADR 0079 direction.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { Notice } from '../../ui/Notice.js';
import { confirm } from '../../ui/confirm.js';
import { TextField, TextareaField, SelectField } from '../../ui/Field.js';
import { PlusIcon, TrashIcon, LinkIcon } from '../../ui/icons/index.js';
import { formatNumber } from '../../i18n/format.js';
import {
  getIdeaIntake, patchIdeaIntake, addIdeaEvidence, removeIdeaEvidence, mergeIdea, promoteIdeaToProject, getIdeaScoreHistory,
  type IdeaIntake, type IdeaEvidence, type IntakeSourceChannel, type RankedIdea,
} from './priorityMatrixClient.js';

const SOURCE_CHANNELS: IntakeSourceChannel[] = ['form', 'chat', 'api', 'manual'];
const EVIDENCE_KINDS = ['url', 'document', 'kb'] as const;

export function IdeaIntakePanel(props: {
  listId: string;
  idea: RankedIdea;
  /** The list's other ideas (merge candidates). */
  others: RankedIdea[];
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}): JSX.Element {
  const { listId, idea, others, onClose, onChanged } = props;
  const { t } = useTranslation('priority-matrix');
  const [intake, setIntake] = useState<IdeaIntake | null>(null);
  const [evidence, setEvidence] = useState<IdeaEvidence[]>([]);
  const [loaded, setLoaded] = useState(false);
  // PMXU-3 (ADR 0590) — errors render INSIDE the modal (the shared Modal's
  // `error`/`errorAnnounce` region), never on the page banner the modal's own
  // overlay hides ("shows the error INSIDE the modal … rather than a
  // page-level Notice hidden behind the overlay" — the house's own words two
  // files away). The former page-level `onError` prop is GONE (F5): every
  // failure this panel can produce happens while it is open.
  const [modalError, setModalError] = useState<string | null>(null);
  /** A FAILED initial load — distinct from "still loading": renders a retry,
   *  never the perpetual "Loading…". */
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requester, setRequester] = useState('');
  const [channel, setChannel] = useState('');
  const [estValue, setEstValue] = useState('');
  const [estUnit, setEstUnit] = useState('');
  const [notes, setNotes] = useState('');
  const [evKind, setEvKind] = useState<(typeof EVIDENCE_KINDS)[number]>('url');
  const [evRef, setEvRef] = useState('');
  const [evLabel, setEvLabel] = useState('');
  const [mergeFrom, setMergeFrom] = useState('');

  // Field-init is one-shot (a ref, not `loaded` state) so it can't sit in the
  // fetch deps — else flipping `loaded` re-fires the effect and double-fetches
  // on every open (grade-code FE#1, on the rate-limited read path). `mounted`
  // guards setState after the modal closes mid-flight (FE#2).
  const mountedRef = useRef(true);
  const initedRef = useRef(false);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const refresh = useCallback(async () => {
    try {
      setLoadFailed(false);
      const r = await getIdeaIntake(listId, idea.card.id);
      if (!mountedRef.current) return;
      setIntake(r.intake);
      setEvidence(r.evidence);
      if (!initedRef.current) {
        initedRef.current = true;
        setRequester(r.intake?.requester ?? '');
        setChannel(r.intake?.sourceChannel ?? '');
        setEstValue(r.intake?.estimatedValue !== undefined ? String(r.intake.estimatedValue) : '');
        setEstUnit(r.intake?.estimatedValueUnit ?? '');
        setNotes(r.intake?.notes ?? '');
        setLoaded(true);
      }
    } catch (e) {
      if (!mountedRef.current) return;
      // PMXU-3 — inside the modal; a failed INITIAL load gets a retry state
      // instead of the perpetual "Loading…".
      setModalError(e instanceof Error ? e.message : t('intakeLoadFailed'));
      if (!initedRef.current) setLoadFailed(true);
    }
  }, [listId, idea.card.id, t]);
  useEffect(() => { void refresh(); }, [refresh]);

  const saveIntake = async (): Promise<void> => {
    const value = estValue.trim() === '' ? undefined : Number(estValue);
    if (value !== undefined && !Number.isFinite(value)) { setModalError(t('intakeValueInvalid')); return; }
    setBusy(true);
    setModalError(null);
    try {
      // '' / null CLEAR a field server-side (cleanString('') deletes; null deletes).
      await patchIdeaIntake(listId, idea.card.id, {
        requester: requester.trim(),
        sourceChannel: channel === '' ? null : (channel as IntakeSourceChannel),
        estimatedValue: value === undefined ? null : value,
        estimatedValueUnit: estUnit.trim(),
        notes: notes.trim(),
      });
      await refresh();
    } catch (e) { setModalError(e instanceof Error ? e.message : t('intakeSaveFailed')); }
    finally { setBusy(false); }
  };

  const addEvidence = async (): Promise<void> => {
    if (!evRef.trim()) return;
    setBusy(true);
    setModalError(null);
    try {
      await addIdeaEvidence(listId, idea.card.id, { kind: evKind, ref: evRef.trim(), ...(evLabel.trim() ? { label: evLabel.trim() } : {}) });
      setEvRef(''); setEvLabel('');
      await refresh();
    } catch (e) { setModalError(e instanceof Error ? e.message : t('evidenceAddFailed')); }
    finally { setBusy(false); }
  };

  const doMerge = async (): Promise<void> => {
    if (!mergeFrom) return;
    // PMXU-8 (ADR 0590) — merge irreversibly unions overlays onto the canonical
    // and moves the duplicate to Won't Do: the one action here that rewrites
    // TWO ideas fired on a single click while idea/list/peer DELETION confirmed.
    const dupTitle = others.find((o) => o.card.id === mergeFrom)?.card.title ?? mergeFrom;
    if (!(await confirm({ title: t('mergeConfirmTitle', { title: dupTitle }), body: t('mergeConfirmBody'), confirmLabel: t('mergeAction'), danger: true }))) return;
    setBusy(true);
    setModalError(null);
    try { await mergeIdea(listId, idea.card.id, mergeFrom); setMergeFrom(''); await refresh(); await onChanged(); }
    catch (e) { setModalError(e instanceof Error ? e.message : t('mergeFailed')); }
    finally { setBusy(false); }
  };

  const doPromote = async (): Promise<void> => {
    setBusy(true);
    setModalError(null);
    try {
      const r = await promoteIdeaToProject(listId, idea.card.id);
      // PMX-2 (ADR 0590) — the project minted + promotion stamped, but the card
      // could not be moved to the completion lane: say so instead of silently
      // claiming the full promotion.
      if (!r.moved) setModalError(t('promoteMoveFailed'));
      await refresh(); await onChanged();
    }
    catch (e) { setModalError(e instanceof Error ? e.message : t('promoteFailed')); }
    finally { setBusy(false); }
  };

  return (
    <Modal
      label={t('intakeModalLabel', { title: idea.card.title })}
      onClose={onClose}
      error={modalError}
      errorAnnounce={modalError ?? undefined}
    >
      <h3 className="u-mt-0 u-mb-2">{idea.card.title}</h3>
      {intake?.promotedTo ? (
        <Notice variant="info">{t('intakePromoted', { kind: t(`promoteKind_${intake.promotedTo.kind}`) })}</Notice>
      ) : null}
      {intake?.mergedInto ? <Notice variant="info">{t('intakeMerged')}</Notice> : null}

      {!loaded && loadFailed ? (
        // PMXU-3 (ADR 0590) — a failed initial load is a RETRYABLE state, not a
        // perpetual "Loading…" (the modalError above names the failure).
        <div className="action-bar">
          <Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('common:retry')}</Button>
        </div>
      ) : !loaded ? (
        // Designed loading state (grade-ux STRATUX-2): the fields initialize
        // FROM the fetch — rendering them editable earlier lets a fast typist's
        // input be clobbered when the load lands.
        <p className="muted u-fs-12 u-m-0" role="status">{t('common:loading')}</p>
      ) : (
      <div className="u-flex u-flex-col u-gap-3">
        <section aria-label={t('intakeSectionLabel')} className="u-flex u-flex-col u-gap-2">
          <h4 className="u-m-0 u-fs-12 muted">{t('intakeSectionLabel')}</h4>
          <div className="u-flex u-gap-2 u-flex-wrap">
            <TextField label={t('intakeRequester')} value={requester} onChange={(e) => setRequester(e.target.value)} className="u-flex-1" />
            <SelectField label={t('intakeChannel')} value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="">{t('intakeChannelNone')}</option>
              {SOURCE_CHANNELS.map((c) => <option key={c} value={c}>{t(`channel_${c}`)}</option>)}
            </SelectField>
          </div>
          <div className="u-flex u-gap-2 u-flex-wrap">
            <TextField label={t('intakeEstValue')} value={estValue} onChange={(e) => setEstValue(e.target.value)} inputMode="decimal" />
            <TextField label={t('intakeEstUnit')} value={estUnit} onChange={(e) => setEstUnit(e.target.value)} />
          </div>
          <TextareaField label={t('intakeNotes')} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          <div className="action-bar">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void saveIntake()}>{busy ? t('common:saving') : t('common:save')}</Button>
          </div>
        </section>

        <section aria-label={t('evidenceSectionLabel')} className="u-flex u-flex-col u-gap-2">
          <h4 className="u-m-0 u-fs-12 muted">{t('evidenceSectionLabel')}</h4>
          {evidence.length === 0 ? <p className="muted u-fs-12 u-m-0">{t('evidenceEmpty')}</p> : (
            <ul className="u-flex u-flex-col u-gap-1 u-list-none u-p-0 u-m-0">
              {evidence.map((ev) => (
                <li key={ev.evidenceId} className="u-flex u-items-center u-gap-2">
                  <LinkIcon size={12} />
                  <span className="chip chip--muted u-fs-11">{t(`evidenceKind_${ev.kind}`)}</span>
                  <span className="u-fs-12 u-flex-1">{ev.label ?? ev.ref}</span>
                  <Button variant="quiet" size="sm" aria-label={t('evidenceRemove')} onClick={() => { void removeIdeaEvidence(listId, idea.card.id, ev.evidenceId).then(refresh).catch((e) => setModalError(e instanceof Error ? e.message : t('evidenceRemoveFailed'))); }}><TrashIcon size={12} /></Button>
                </li>
              ))}
            </ul>
          )}
          <div className="surface-form">
            <SelectField label={t('evidenceKind')} value={evKind} onChange={(e) => setEvKind(e.target.value as (typeof EVIDENCE_KINDS)[number])}>
              {EVIDENCE_KINDS.map((k) => <option key={k} value={k}>{t(`evidenceKind_${k}`)}</option>)}
            </SelectField>
            <TextField label={t('evidenceRef')} value={evRef} onChange={(e) => setEvRef(e.target.value)} className="u-flex-1" />
            <TextField label={t('evidenceLabel')} value={evLabel} onChange={(e) => setEvLabel(e.target.value)} />
            <Button variant="quiet" size="sm" disabled={busy || !evRef.trim()} onClick={() => void addEvidence()}><PlusIcon size={13} /> {t('evidenceAdd')}</Button>
          </div>
        </section>

        <section aria-label={t('actionsSectionLabel')} className="u-flex u-flex-col u-gap-2">
          <h4 className="u-m-0 u-fs-12 muted">{t('actionsSectionLabel')}</h4>
          <div className="surface-form">
            <SelectField label={t('mergeSelect')} value={mergeFrom} onChange={(e) => setMergeFrom(e.target.value)} className="u-flex-1">
              <option value="">{t('mergeSelectNone')}</option>
              {others.map((o) => <option key={o.card.id} value={o.card.id}>{o.card.title} (#{formatNumber(o.rank)})</option>)}
            </SelectField>
            <Button variant="quiet" size="sm" disabled={busy || !mergeFrom} onClick={() => void doMerge()}>{t('mergeAction')}</Button>
          </div>
          <p className="muted u-fs-12 u-m-0">{t('mergeHint')}</p>
          <div className="action-bar">
            <Button variant="primary" size="sm" disabled={busy || Boolean(intake?.promotedTo)} onClick={() => void doPromote()}>{t('promoteToProject')}</Button>
          </div>
        </section>

        <ScoreHistorySection listId={listId} cardId={idea.card.id} />
      </div>
      )}
    </Modal>
  );
}

/**
 * ADR 0234 §C7 (STRAT-FE2) — "why ranked here" + the score-change trail. One
 * fetch on mount, fail-soft (renders nothing on error/empty rather than a
 * broken section — the panel's other sections stand alone).
 */
function ScoreHistorySection({ listId, cardId }: { listId: string; cardId: string }): JSX.Element | null {
  const { t } = useTranslation('priority-matrix');
  const [data, setData] = useState<Awaited<ReturnType<typeof getIdeaScoreHistory>> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    // Truly fail-soft: this optional "why-ranked" trail renders nothing on error
    // and does NOT raise the page-level banner (grade-code FE#5; a transient 500
    // on a non-essential section shouldn't alarm the whole modal — matches the
    // CheckInsPanel silent-swallow convention).
    getIdeaScoreHistory(listId, cardId).then((d) => { if (live) setData(d); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [listId, cardId]);
  if (failed || !data) return null;
  const scored = data.breakdown.filter((b) => b.score !== undefined);

  return (
    <section aria-label={t('scoreHistoryTitle')} className="u-flex u-flex-col u-gap-2">
      <h4 className="u-m-0 u-fs-12 muted">{t('scoreHistoryTitle')}</h4>
      {scored.length === 0 ? (
        <p className="muted u-fs-12 u-m-0">{t('scoreHistoryUnscored')}</p>
      ) : (
        <>
          <p className="muted u-fs-12 u-m-0">{t('scoreWhyRanked', { priority: formatNumber(data.computedPriority ?? 0), rank: formatNumber(data.rank ?? 0) })}</p>
          <ul className="u-flex u-flex-col u-gap-1 u-list-none u-p-0 u-m-0">
            {scored.map((b) => (
              <li key={b.criterionId} className="u-flex u-items-center u-gap-2">
                <span className="u-fs-12 u-flex-1">{b.name}</span>
                <span className="chip chip--muted u-fs-11">{t('scoreComponent', { score: formatNumber(b.score ?? 0), weight: formatNumber(b.weight) })}</span>
                <span className="chip chip--accent u-fs-11">{formatNumber(b.weighted ?? 0)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {data.history.length > 0 ? (
        <p className="muted u-fs-12 u-m-0">{t('scoreHistoryCount', { count: data.history.length, formattedCount: formatNumber(data.history.length) })}</p>
      ) : null}
    </section>
  );
}
