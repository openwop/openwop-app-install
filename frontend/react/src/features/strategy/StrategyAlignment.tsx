/**
 * StrategyAlignment (ADR 0079 Phase 3) — the strategy-OWNED embeddable that other
 * feature surfaces (Priority Matrix today) render to show + edit a card's strategy
 * alignment. Keeps the alignment logic inside the strategy package; the host
 * surface renders one component and passes the already-resolved chips.
 *
 * The import edge stays one-directional (consumer → strategy); the strategy
 * package never imports the consumer (no feature cycle — ADR 0079 §Correction).
 *
 * Reads are RBAC-bounded server-side (the chip `refs` come from
 * `GET /strategy/context`, which omits unreadable strategies); a write to a
 * read-only strategy 403s on `replaceLinks` and surfaces a clean notice.
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { Notice } from '../../ui/Notice.js';
import { CheckboxField } from '../../ui/Field.js';
import { InlineState } from '../../ui/InlineState.js';
import { FlagIcon } from '../../ui/icons/index.js';
import {
  listStrategies, getStrategy, replaceLinks, getStrategyContext, FeatureDisabledError,
  type Strategy, type StrategyLink, type StrategyContextEntry,
} from './strategyClient.js';

export interface StrategyRefLite { id: string; title: string }

/**
 * Read-only strategy-alignment chips for a PROJECT (ADR 0079 Phase 4) — a
 * strategy-OWNED embeddable the project overview renders. Self-fetches via
 * `GET /strategy/context?projectId` (RBAC already omits unreadable strategies);
 * renders nothing when the toggle is off or no strategy is aligned.
 */
export function ProjectStrategyChips({ projectId }: { projectId: string }): JSX.Element | null {
  const { t } = useTranslation('strategy');
  const [entries, setEntries] = useState<StrategyContextEntry[] | null>(null);
  // SPU-7 (= code `SPC-12`(A)) — the catch used to collapse BOTH causes onto
  // `setEntries([])`, and the docblock stated that as the intent. The two are not
  // equivalent, and `strategyClient.ts:107` already distinguishes them:
  //
  //  - toggle OFF (`FeatureDisabledError`) ⇒ there IS no strategy surface here,
  //    so rendering nothing is the correct and complete answer;
  //  - a TRANSIENT failure (a 429 — a documented hazard for pages that fan out
  //    reads on load) ⇒ rendering nothing CLAIMS "this project is aligned to no
  //    strategy". A PM reads that, re-links the project, and creates a duplicate.
  //
  // The compact `InlineState kind="failed"` is the documented primitive for an
  // embedded region (DESIGN.md:461); `announcePolite` because this fires on LOAD,
  // not on an action the user just took.
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setFailed(false);
    void getStrategyContext({ projectId })
      .then((e) => { if (live) setEntries(e); })
      .catch((e) => {
        if (!live) return;
        if (e instanceof FeatureDisabledError) { setEntries([]); return; }
        setFailed(true);
      });
    return () => { live = false; };
  }, [projectId, tick]);

  if (failed) {
    return (
      <div className="proj-section">
        <span className="proj-eyebrow">{t('projectAlignmentHeading')}</span>
        <InlineState
          kind="failed"
          message={t('chipsLoadFailed')}
          announce={t('chipsLoadFailed')}
          announcePolite
          action={<Button variant="link" size="sm" onClick={() => setTick((v) => v + 1)}>{t('common:retry')}</Button>}
        />
      </div>
    );
  }
  if (!entries || entries.length === 0) return null;
  return (
    <div className="proj-section">
      <span className="proj-eyebrow">{t('projectAlignmentHeading')}</span>
      <div className="u-flex u-gap-2 u-flex-wrap u-mt-1">
        {entries.map((e) => (
          <span key={e.id} className="chip chip--accent"><FlagIcon size={11} /> {e.title} <span className="muted u-fs-11">{t(`status_${e.status}`)}</span></span>
        ))}
      </div>
    </div>
  );
}

const isIdeaLink = (l: StrategyLink, listId: string, cardId: string): boolean =>
  l.kind === 'priority-idea' && l.listId === listId && l.cardId === cardId;

export function StrategyAlignment({ listId, cardId, refs, onChanged, onError }: {
  listId: string;
  cardId: string;
  /** Strategies already aligned to this card (resolved from the strategy context). */
  refs: StrategyRefLite[];
  onChanged: () => void | Promise<void>;
  onError: (m: string) => void;
}): JSX.Element {
  const { t } = useTranslation('strategy');
  const [open, setOpen] = useState(false);

  return (
    <div className="u-flex u-items-center u-gap-1 u-flex-wrap">
      {refs.map((r) => <span key={r.id} className="chip chip--accent u-fs-11"><FlagIcon size={11} /> {r.title}</span>)}
      <Button variant="quiet" size="sm" onClick={() => setOpen(true)} aria-label={t('alignButtonLabel')}>
        {refs.length ? t('alignEdit') : t('alignButton')}
      </Button>
      {open ? (
        <AlignModal listId={listId} cardId={cardId} onClose={() => setOpen(false)} onChanged={onChanged} onError={onError} t={t} />
      ) : null}
    </div>
  );
}

function AlignModal({ listId, cardId, onClose, onChanged, onError, t }: {
  listId: string; cardId: string;
  onClose: () => void; onChanged: () => void | Promise<void>; onError: (m: string) => void;
  t: ReturnType<typeof useTranslation>['t'];
}): JSX.Element {
  const [strategies, setStrategies] = useState<Strategy[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // R3 (the R2 deferral) — a failed read used to setStrategies([]), so the modal
  // claimed "no strategies to align" after the toast faded. Failure is its own
  // state now, with a retry that re-runs the read.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadTick, setLoadTick] = useState(0);

  // Lazy-load readable strategies when the modal mounts (onError/t are stable).
  useEffect(() => {
    let live = true;
    setLoadFailed(false);
    void listStrategies()
      .then((s) => { if (live) setStrategies(s.filter((x) => x.status !== 'archived')); })
      .catch(() => { if (live) { setStrategies(null); setLoadFailed(true); } });
    return () => { live = false; };
  }, [loadTick]);

  const toggle = async (s: Strategy, aligned: boolean): Promise<void> => {
    setBusyId(s.id);
    try {
      const fresh = await getStrategy(s.id);
      const links = aligned
        ? fresh.links.filter((l) => !isIdeaLink(l, listId, cardId))
        : [...fresh.links, { kind: 'priority-idea', listId, cardId } as StrategyLink];
      const updated = await replaceLinks(s.id, links);
      setStrategies((prev) => (prev ?? []).map((x) => (x.id === s.id ? updated : x)));
      await onChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('alignFailed');
      onError(/forbidden|cannot/i.test(msg) ? t('alignReadOnly') : msg);
    } finally { setBusyId(null); }
  };

  return (
    <Modal label={t('alignModalLabel')} onClose={onClose}>
      <h2 className="u-mt-0">{t('alignModalHeading')}</h2>
      <p className="muted u-fs-12">{t('alignHint')}</p>
      {loadFailed ? (
        /* SPU-5 — five sibling failure notices in this feature pass `announce`
           and this one did not; the modal is a focus trap, so an unannounced
           failure here is a dialog whose entire content is silent. */
        <Notice variant="error" announce={t('alignLoadFailed')}>
          {t('alignLoadFailed')}{' '}
          <Button variant="secondary" size="sm" onClick={() => setLoadTick((v) => v + 1)}>{t('alignRetry')}</Button>
        </Notice>
      ) : strategies === null ? (
        <p className="muted">{t('common:loading')}</p>
      ) : strategies.length === 0 ? (
        <Notice variant="info">{t('alignNoStrategies')}</Notice>
      ) : (
        <ul className="u-flex u-flex-col u-gap-2 u-list-none u-p-0">
          {strategies.map((s) => {
            const aligned = s.links.some((l) => isIdeaLink(l, listId, cardId));
            return (
              <li key={s.id}>
                <CheckboxField
                  label={<span>{s.title} <span className="chip chip--muted u-fs-11">{t(`scope_${s.scope}`)}</span></span>}
                  checked={aligned}
                  disabled={busyId === s.id}
                  onChange={() => void toggle(s, aligned)}
                />
              </li>
            );
          })}
        </ul>
      )}
      <div className="action-bar u-mt-3 u-justify-end"><Button variant="secondary" onClick={onClose}>{t('common:close')}</Button></div>
    </Modal>
  );
}
