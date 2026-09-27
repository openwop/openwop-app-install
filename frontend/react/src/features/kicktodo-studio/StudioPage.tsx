/**
 * Creator Studio overview (ADR 0437 §6.2, UX-2.0/2.1) — the decision-first
 * operating surface over the ADR 0415 Challenge Factory. It leads with a "Needs
 * you" queue (candidates the creator must advance), then the portfolio as a
 * faceted collection. All gates stay server-side; this page only shows + requests
 * — and it shows honestly: candidate ids are mono provenance, risk-tier reasoning
 * is visible (not hidden), and the deep candidate workspace + gate center are
 * deferred until KTFULL-TD1 (candidate lifecycle) and B7 (gate contract) land —
 * never a bypassable "publish" affordance or a green matrix the server can't back.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WandIcon } from '../../ui/icons/index.js';
import { StateCard } from '../../ui/StateCard.js';
import { Notice } from '../../ui/Notice.js';
import { PageHeader } from '../../ui/PageHeader.js';
// ADR 0461 P2 — the ONE chat embedded in place (ADR 0073). kicktodo-studio is
// not imported by chat/, so a static import is sanctioned (the commerce
// precedent; only builder/ must lazy-import).
import { EmbeddedChatPanel } from '../../chat/EmbeddedChatPanel.js';
import { ChallengeAuthorWelcome } from './ChallengeAuthorWelcome.js';
import { pubStateLabel } from './publicationLabels.js';
import {
  listCandidates,
  getPublication,
  getChallengeAuthor,
  getNeedsYou,
  type ChallengeAuthorProfile,
  type FactoryCandidate,
  type NeedsYouRow,
  type PublicationState,
} from '../../client/kicktodoStudioClient.js';

import { CHALLENGE_AUTHOR_AGENT_ID } from './challengeAuthor.js';

const TERMINAL = new Set(['published', 'killed', 'retired', 'withdrawn']);

function stateChipClass(state: string): string {
  if (state === 'published') return 'chip chip--success';
  if (TERMINAL.has(state)) return 'chip chip--muted';
  return 'chip';
}

/** KTUX-9 (grade-ux, DESIGN.md §4.5 rule 13) — a raw backend enum in a chip is an
 *  i18n defect. Map the known candidate states to localized labels; an unknown
 *  state falls back to its raw value rather than a wrong label. Literal keys keep
 *  `check-i18n` able to see them. */
function stateLabel(state: string, t: (k: string) => string): string {
  switch (state) {
    case 'intake': return t('state_intake');
    case 'researched': return t('state_researched');
    case 'approved': return t('state_approved');
    case 'published': return t('state_published');
    case 'withdrawn': return t('state_withdrawn');
    case 'blocked': return t('state_blocked');
    case 'killed': return t('state_killed');
    case 'retired': return t('state_retired');
    default: return state;
  }
}

export function StudioPage() {
  const { t } = useTranslation('kicktodo-studio');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [candidates, setCandidates] = useState<FactoryCandidate[]>([]);
  const [publications, setPublications] = useState<Record<string, PublicationState | null>>({});
  const [statusFilter, setStatusFilter] = useState<'all' | 'in-progress' | 'published' | 'retired'>('all');
  const [query, setQuery] = useState('');
  // ADR 0461 — the Challenge Author profile (roster truth) behind the embedded
  // chat's welcome. null = read failed; the welcome renders without a portfolio.
  const [author, setAuthor] = useState<ChallengeAuthorProfile | null>(null);
  // §4.2 precision — the store-backed "Needs you" rows. null = the read failed;
  // the section then states the failure (never silently falls back to the old
  // client-side state filter, which painted imprecise status).
  const [needsYou, setNeedsYou] = useState<NeedsYouRow[] | null | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      setError(false);
      const [cs, profile] = await Promise.all([listCandidates(), getChallengeAuthor()]);
      setCandidates(cs);
      setAuthor(profile);
      void getNeedsYou().then(setNeedsYou).catch(() => setNeedsYou(null));
      // KTEXP-3 (grade-code): publication state only matters for candidates still
      // in play — fetch it for the non-terminal set only, so an unbounded portfolio
      // of published/retired candidates can't blow the per-IP read budget on load.
      const pubs: Record<string, PublicationState | null> = {};
      await Promise.all(cs.filter((c) => !TERMINAL.has(c.state)).map(async (c) => {
        pubs[c.id] = await getPublication(c.id).catch(() => null);
      }));
      setPublications(pubs);
    } catch {
      setError(true);
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const portfolio = useMemo(() => {
    const q = query.trim().toLowerCase();
    return candidates.filter((c) => {
      const okStatus = statusFilter === 'all'
        ? true
        : statusFilter === 'in-progress' ? !TERMINAL.has(c.state)
        : statusFilter === 'published' ? c.state === 'published'
        : c.state === 'retired' || c.state === 'killed' || c.state === 'withdrawn';
      const okQuery = !q || `${c.topic} ${c.audience}`.toLowerCase().includes(q);
      return okStatus && okQuery;
    });
  }, [candidates, statusFilter, query]);

  /** Per-state next step — the row says WHAT it needs (literal keys). States
   *  the creator can't act on render no next-step line (honest, not padded). */
  const nextStepKey = (state: string): string | null => {
    switch (state) {
      case 'intake': return 'next_intake';
      case 'researched': return 'next_researched';
      case 'planned': return 'next_planned';
      default: return null;
    }
  };

  const CandidateRow = ({ c }: { c: FactoryCandidate }) => {
    const pub = publications[c.id];
    return (
      <li className="list-row">
        <div>
          {/* UX-2.2 — open the candidate workspace (provenance spine + research + gate). */}
          <Link className="title-link" to={`/kicktodo/studio/candidates/${encodeURIComponent(c.id)}`}><strong>{c.topic}</strong></Link>
          {c.audience && <span className="muted"> · {c.audience}</span>}
          <div className="action-bar">
            <span className={stateChipClass(c.state)}>{stateLabel(c.state, t)}</span>
            <span className="chip chip--muted">{t('riskTier', { tier: c.riskTier })}</span>
            {pub?.state && <span className="chip">{t('publication', { state: pubStateLabel(pub.state, t) })}</span>}
            <span className="studio-id" title={c.id}>{c.id}</span>
          </div>
          {c.riskSignals.length > 0 && <p className="muted u-fs-13">{t('riskSignals', { signals: c.riskSignals.join(', ') })}</p>}
          {nextStepKey(c.state) && <p className="muted u-fs-13">{t(nextStepKey(c.state) as string)}</p>}
        </div>
      </li>
    );
  };

  return (
    <div className="page" data-walkthrough="kicktodo-studio.page">
      <PageHeader
        title={t('title')}
        lede={t('lede')}
        actions={<Link className="btn-ghost btn-sm" to="/kicktodo/studio/insights">{t('openInsights')}</Link>}
      />

      {error && <Notice variant="error">{t('loadError')}</Notice>}
      {!loaded && !error && <StateCard loading title={t('title')} />}

      {loaded && candidates.length === 0 && !error && (
        <>
          {/* First candidate: the conversation IS the empty state's action. */}
          <section className="surface-card studio-author-panel" aria-label={t('intakeHeading')}>
            <div className="action-bar">
              <h2 className="kt-eyebrow">{t('intakeHeading')}</h2>
              <Link className="btn-ghost btn-sm u-ms-auto" to={`/?agent=${CHALLENGE_AUTHOR_AGENT_ID}`}>
                {t('openFullChat')}
              </Link>
            </div>
            <EmbeddedChatPanel
              agentId={CHALLENGE_AUTHOR_AGENT_ID}
              renderEmptyState={(onPick) => (
                <ChallengeAuthorWelcome onPick={onPick} workflows={author?.workflows ?? []}
                  {...(author?.autonomyLevel !== undefined ? { autonomyLevel: author.autonomyLevel } : {})} />
              )}
            />
          </section>
          <StateCard icon={<WandIcon aria-hidden />} title={t('emptyTitle')} body={t('emptyBody')} />
        </>
      )}

      {loaded && candidates.length > 0 && (
        <>
          <section className="studio-queue surface-card studio-console" aria-label={t('needsYouHeading')}>
            <h2 className="kt-eyebrow">{t('needsYouHeading')}</h2>
            {/* §4.2 precision — STORE-BACKED rows (returned-with-feedback /
                enforced-gates-open / broken-sources), each deep-linking its
                candidate workspace. detail is the server's verbatim text. */}
            {needsYou === undefined && <p className="muted u-m-0">{t('needsYouLoading')}</p>}
            {needsYou === null && <p className="muted u-m-0">{t('needsYouUnavailable')}</p>}
            {needsYou !== undefined && needsYou !== null && (needsYou.length === 0
              ? <p className="muted u-m-0">{t('needsYouEmpty')}</p>
              : (
                <ul role="list" className="list-plain">
                  {needsYou.map((r) => (
                    <li key={`${r.candidateId}:${r.kind}`} className="list-row">
                      <div>
                        <Link className="title-link" to={`/kicktodo/studio/candidates/${encodeURIComponent(r.candidateId)}`}>
                          <strong>{r.topic}</strong>
                        </Link>
                        <div className="action-bar">
                          <span className={r.kind === 'returned' ? 'chip chip--warning' : 'chip'}>
                            {r.kind === 'returned' ? t('needsYouReturned')
                              : r.kind === 'gates-open' ? t('needsYouGatesOpen', { count: r.count ?? 0 })
                              : t('needsYouBrokenSources', { count: r.count ?? 0 })}
                          </span>
                        </div>
                        {r.detail && <p className="muted u-fs-13">{r.detail}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              ))}
          </section>

          <section className="surface-card studio-author-panel" aria-label={t('intakeHeading')}>
          {/* ADR 0458 P4 — intake IS a conversation. ADR 0461 P2 — that
              conversation now happens IN PLACE: the ONE chat embedded here,
              scoped to the Challenge Author (never a second chat system). The
              full-chat deep-link survives as the durable-thread escape hatch —
              this embed is task-scoped and unpersisted (ADR 0073). */}
          <div className="action-bar">
            <h2 className="kt-eyebrow">{t('intakeHeading')}</h2>
            <Link className="btn-ghost btn-sm u-ms-auto" to={`/?agent=${CHALLENGE_AUTHOR_AGENT_ID}`}>
              {t('openFullChat')}
            </Link>
          </div>
          <EmbeddedChatPanel
            agentId={CHALLENGE_AUTHOR_AGENT_ID}
            renderEmptyState={(onPick) => (
              <ChallengeAuthorWelcome onPick={onPick} workflows={author?.workflows ?? []}
                {...(author?.autonomyLevel !== undefined ? { autonomyLevel: author.autonomyLevel } : {})} />
            )}
          />
          </section>

          <section aria-label={t('portfolioHeading')}>
            <div className="action-bar">
              <h2 className="kt-eyebrow">{t('portfolioHeading')}</h2>
              {/* KTUX-12 (§4.5 rule 13): search/filter appear only once the collection is big enough to need them. */}
              {candidates.length > 4 && (
                <>
                  <input type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('searchPlaceholder')} aria-label={t('searchPlaceholder')} />
                  <label htmlFor="studio-status" className="u-fs-13 muted">{t('statusFilterLabel')}</label>
                  <select id="studio-status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
                    <option value="all">{t('statusAll')}</option>
                    <option value="in-progress">{t('statusInProgress')}</option>
                    <option value="published">{t('statusPublished')}</option>
                    <option value="retired">{t('statusRetired')}</option>
                  </select>
                </>
              )}
            </div>
            {portfolio.length === 0
              ? <StateCard title={t('noMatchTitle')} body={t('noMatchBody')}
                  action={<Button variant="quiet" size="sm" onClick={() => { setQuery(''); setStatusFilter('all'); }}>{t('clearSearch')}</Button>} />
              : <ul role="list" className="surface-card list-plain">{portfolio.map((c) => <CandidateRow key={c.id} c={c} />)}</ul>}
          </section>
        </>
      )}
    </div>
  );
}
