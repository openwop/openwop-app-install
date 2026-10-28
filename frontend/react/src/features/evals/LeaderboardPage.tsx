/**
 * Model quality leaderboard (ADR 0123 Phase 4b, ADR 0986 D7).
 *
 * Two server-computed rankings for the selected org's workspace:
 *  - "From chat ratings": thumbs on real chat replies, each attributed by the
 *    SERVER to the model that answered, ranked by the Wilson lower bound
 *    (a confidence-aware win rate), with how many people rated;
 *  - "Arena": head-to-head verdicts on two real runs, as a Bradley–Terry rating.
 * A notice says how many ratings could not be attributed, so an empty table is
 * never mistaken for "nobody rated". No PII — models, counts and scores only.
 *
 * The arena link renders in the Models console too (EV2-UX-1): the console is
 * this page's only nav entry, and the embedded page drops its header.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useFormat } from '../../i18n/useFormat.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { useHub } from '../../chrome/hubContext.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { SelectField } from '../../ui/Field.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { ActivityIcon } from '../../ui/icons/index.js';
import { fetchEvalsBoard, listOrgs, type ArenaStanding, type EvalsBoard, type LeaderboardRow, type Org } from '../../client/evalsClient.js';

function ModelCell({ model, provider, managed, simulated }: { model: string; provider: string; managed?: true | undefined; simulated?: true | undefined }): JSX.Element {
  const { t } = useTranslation('evals');
  return (
    <span className="u-flex u-items-center u-gap-2 u-flex-wrap">
      <span>{model}</span>
      <span className="muted u-fs-12">{provider}</span>
      {managed ? <span className="chip chip--muted">{t('managedChip')}</span> : null}
      {simulated ? <span className="chip chip--muted">{t('simulatedChip')}</span> : null}
    </span>
  );
}

export function LeaderboardPage(): JSX.Element {
  const { t } = useTranslation('evals');
  const f = useFormat();
  const { embedded } = useHub(); // a tab inside the Models console → drop our own header
  const access = useFeatureAccess('evals');

  // The shared org read: `orgs` stays null on failure, and `OrgSelectionState`
  // owns the zero-org and failed branches (a page with no org must terminate).
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs, access.enabled);
  const [board, setBoard] = useState<EvalsBoard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((id: string) => {
    setBoard(null);
    setError(null);
    void fetchEvalsBoard(id).then(setBoard).catch(() => setError(t('loadError')));
  }, [t]);

  useEffect(() => { if (access.enabled && orgId) load(orgId); }, [access.enabled, orgId, load]);

  const ratingColumns = useMemo<DataColumn<LeaderboardRow>[]>(() => [
    { key: 'model', header: t('colModel'), sortValue: (r) => r.key, render: (r) => <ModelCell model={r.model} provider={r.provider} managed={r.managed} simulated={r.simulated} /> },
    { key: 'up', header: t('colUp'), align: 'right', width: '72px', cellClassName: 'u-tabular', sortValue: (r) => r.up, render: (r) => f.number(r.up) },
    { key: 'down', header: t('colDown'), align: 'right', width: '72px', cellClassName: 'u-tabular', sortValue: (r) => r.down, render: (r) => f.number(r.down) },
    { key: 'raters', header: t('colRaters'), align: 'right', width: '80px', cellClassName: 'u-tabular', sortValue: (r) => r.raters, render: (r) => f.number(r.raters) },
    { key: 'winRate', header: t('colWinRate'), align: 'right', width: '96px', cellClassName: 'u-tabular', sortValue: (r) => r.winRate, render: (r) => f.percent(r.winRate) },
    { key: 'score', header: t('colScore'), headerTitle: t('colScoreTitle'), align: 'right', width: '110px', cellClassName: 'u-tabular', sortValue: (r) => r.score, render: (r) => f.percent(r.score) },
  ], [t, f]);

  const arenaColumns = useMemo<DataColumn<ArenaStanding>[]>(() => [
    { key: 'model', header: t('colModel'), sortValue: (r) => r.key, render: (r) => <ModelCell model={r.model} provider={r.provider} managed={r.managed} /> },
    { key: 'rating', header: t('colArenaRating'), align: 'right', width: '96px', cellClassName: 'u-tabular', sortValue: (r) => r.rating, render: (r) => f.number(Math.round(r.rating)) },
    { key: 'record', header: t('colRecord'), align: 'right', width: '110px', cellClassName: 'u-tabular', sortValue: (r) => r.matches, render: (r) => t('record', { w: f.number(r.wins), l: f.number(r.losses), t: f.number(r.ties) }) },
  ], [t, f]);

  const arenaLink = <Link className="btn-ghost btn-sm" to="/leaderboard/arena">{t('openArena')}</Link>;

  if (access.loading) return <SkeletonRows rows={5} columns={['1fr', '72px', '72px', '80px', '96px', '110px']} />;
  if (!access.enabled) {
    return (
      <>
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <StateCard icon={<ActivityIcon />} title={t('disabled')} />
      </>
    );
  }

  return (
    <>
      {embedded
        ? <div className="action-bar u-flex u-gap-2 u-justify-end u-mb-3">{arenaLink}</div>
        : <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={arenaLink} />}
      {orgs && orgs.length > 1 && (
        <SelectField label={t('ui:orgPickerLabel')} className="u-w-auto" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
      )}
      <OrgSelectionState
        orgs={orgs}
        orgsFailed={orgsFailed}
        retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')}
        failedBody={t('orgsFailedClause')}
        icon={<ActivityIcon />}
      >
      {error ? (
        // ONLY the error: falling through to the tables would also show their
        // empty states, and "no rated turns yet" under a failed read is false.
        <>
          <Notice variant="error">{error}</Notice>
          <div><Button variant="quiet" size="sm" onClick={() => orgId && load(orgId)}>{t('retry')}</Button></div>
        </>
      ) : board === null ? (
        <SkeletonRows rows={5} columns={['1fr', '72px', '72px', '80px', '96px', '110px']} />
      ) : (
        <>
          {board.coverage.unattributed > 0 ? (
            <Notice variant="info">{t('unattributedNotice', { count: board.coverage.unattributed })}</Notice>
          ) : null}
          <section className="u-mt-3" aria-labelledby="evals-ratings-h">
            <h2 id="evals-ratings-h" className="u-fs-13">{t('ratingsHeading')}</h2>
            <p className="muted u-fs-12 u-mb-1-5">{t('confidenceExplainer')}</p>
            {board.leaderboard.some((r) => r.managed) || board.arena.some((r) => r.managed) ? <p className="muted u-fs-12 u-mb-1-5">{t('managedChipTitle')}</p> : null}
            {board.leaderboard.some((r) => r.simulated) ? <p className="muted u-fs-12 u-mb-1-5">{t('simulatedChipTitle')}</p> : null}
            <DataTable
              stack
              columns={ratingColumns}
              rows={board.leaderboard}
              rowKey={(r) => r.key}
              caption={t('ratingsHeading')}
              initialSort={{ key: 'score', dir: 'desc' }}
              empty={<StateCard icon={<ActivityIcon />} title={t('empty')} body={t('emptyHint')} />}
            />
          </section>
          <section className="u-mt-4" aria-labelledby="evals-arena-h">
            <h2 id="evals-arena-h" className="u-fs-13">{t('arenaHeading')}</h2>
            <DataTable
              stack
              columns={arenaColumns}
              rows={board.arena}
              rowKey={(r) => r.key}
              caption={t('arenaHeading')}
              initialSort={{ key: 'rating', dir: 'desc' }}
              empty={<StateCard icon={<ActivityIcon />} title={t('arenaEmpty')} body={t('arenaEmptyHint')} action={arenaLink} />}
            />
          </section>
        </>
      )}
      </OrgSelectionState>
    </>
  );
}
