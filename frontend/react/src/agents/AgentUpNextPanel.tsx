/**
 * ADR 0534 P5 — "Up next": the order the agent will actually work in.
 *
 * WHY THIS SHAPE, and not rank badges on the cards themselves: the board's own
 * order is the human's (insertion order, drag-and-drop). The agent's order is
 * DERIVED. Stamping ranks onto the cards would imply the board *is* the queue
 * and quietly overload one surface with two different orderings — the confusion
 * ADR 0534 OQ-3 names. Keeping the derived order in its own short list makes it
 * explicit, answerable ("why that one?"), and impossible to mistake for the
 * board's own arrangement.
 *
 * Read-only, and deliberately not a weights editor (the weights are a server
 * constant with no editor — ADR 0963 D7). This panel explains a decision; it
 * never makes one.
 *
 * ADR 0963 D3 — cards HELD after a stopped or failed run are listed separately:
 * the agent will not take them again on its own, and the release is the card's
 * own note, so the panel says where to go rather than offering a second control.
 *
 * Renders nothing at all when the feature is off for the workspace — an off
 * feature is not an empty state, and showing "nothing queued" would be a lie
 * about why the list is absent.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { getBoardRanking, type RankedCard, type RankingResult } from './workSelectionClient.js';
import { Notice } from '../ui/Notice.js';

/** Bring a board card into view and focus it, so "release it on the card"
 *  is one click away. A card that is not rendered (another tab) is a no-op. */
function showCard(cardId: string): void {
  const el = document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(cardId)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.focus({ preventScroll: true });
}

/** Numbering is real information here — it is the agent's actual sequence, not
 *  decoration — so the rank is rendered as the row's leading element. */
function RankRow({ card, expanded, onToggle }: {
  card: RankedCard;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const { t } = useTranslation('agents');
  const isNext = card.rank === 1;
  // Associate the disclosure with the region it reveals, so a screen reader can
  // navigate to the explanation rather than only being told one exists.
  const whyId = `upnext-why-${card.cardId}`;
  return (
    <li className="u-grid u-gap-1">
      <Button
        variant="quiet"
        size="sm"
        fullWidth
        className="upnext-row"
        aria-expanded={expanded}
        aria-controls={whyId}
        onClick={onToggle}
      >
        <span className={`chip ${isNext ? 'chip--success' : ''}`}>{card.rank}</span>
        <span className="upnext-title">{card.title}</span>
        {isNext ? <span className="muted u-fs-13">{t('upNextNow')}</span> : null}
      </Button>
      {expanded ? (
        <dl className="upnext-why" id={whyId}>
          {card.why.map((r) => (
            <div key={r.criterionId} className="upnext-why-row">
              <dt className="muted u-fs-13">{r.criterion}</dt>
              <dd className="u-m-0 u-fs-13">{r.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}

export function AgentUpNextPanel({ boardId, refreshSignal }: {
  boardId: string;
  refreshSignal?: number | undefined;
}): JSX.Element | null {
  const { t } = useTranslation('agents');
  const [result, setResult] = useState<RankingResult | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // The board panel polls, so a slow read must not stack up requests behind it.
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setResult(await getBoardRanking(boardId));
    } finally {
      inFlight.current = false;
    }
  }, [boardId]);

  useEffect(() => { void refresh(); }, [refresh, refreshSignal]);

  // UPN-1 — hold the space while the first read is in flight, so the board below
  // does not shift when the panel appears.
  if (result === null) {
    return (
      <section className="surface-card u-grid u-gap-2" aria-labelledby="upnext-heading">
        <h3 id="upnext-heading" className="u-m-0 u-fs-15">{t('upNextTitle')}</h3>
        <SkeletonRows rows={2} columns={['100%']} />
      </section>
    );
  }
  // A DISABLED feature renders nothing: it is not an empty state, and saying
  // "nothing queued" would misreport why the list is absent.
  if (result.kind === 'disabled') return null;
  // A FAILED read is different — staying silent there made a broken route
  // invisible to the user (UPN-2). Say so, quietly.
  if (result.kind === 'error') {
    return (
      <section className="surface-card u-grid u-gap-2" aria-labelledby="upnext-heading">
        <h3 id="upnext-heading" className="u-m-0 u-fs-15">{t('upNextTitle')}</h3>
        <Notice variant="warning">{t('upNextUnavailable')}</Notice>
      </section>
    );
  }
  const { ranked, held } = result;
  if (ranked.length === 0 && held.length === 0) return null;

  return (
    <section className="surface-card u-grid u-gap-2" aria-labelledby="upnext-heading">
      <h3 id="upnext-heading" className="u-m-0 u-fs-15">{t('upNextTitle')}</h3>
      {ranked.length > 0 ? (
        <>
          <p className="muted u-m-0 u-fs-13">{t('upNextCount', { count: ranked.length })} {t('upNextHelp')}</p>
          <ol className="upnext-list u-grid u-gap-2">
            {ranked.map((card) => (
              <RankRow
                key={card.cardId}
                card={card}
                expanded={openId === card.cardId}
                onToggle={() => setOpenId(openId === card.cardId ? null : card.cardId)}
              />
            ))}
          </ol>
        </>
      ) : null}
      {held.length > 0 ? (
        <div className="u-grid u-gap-1" role="group" aria-labelledby="upnext-held-heading">
          <h4 id="upnext-held-heading" className="u-m-0 u-fs-13">{t('upNextHeldTitle')}</h4>
          <p className="muted u-m-0 u-fs-13">{t('upNextHeldHelp')}</p>
          <ul className="upnext-list u-grid u-gap-1">
            {held.map((card) => (
              <li key={card.cardId}>
                {/* The release is on the card itself (ADR 0963 D3) — take the
                    person there rather than offering a second control here. */}
                <Button variant="quiet" size="sm" onClick={() => showCard(card.cardId)}>{card.title}</Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
