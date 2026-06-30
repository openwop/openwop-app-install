/**
 * RunComparePage — `/compare?a=<runId>&b=<runId>`.
 *
 * Client-side side-by-side of two runs: terminal status + the node-keyed
 * timeline for each. The honest 80% of run-diffing achievable on shipped
 * protocol today (fork creates a new run from any seq — RFC 0011), so a
 * run and its fork can be visually compared. A deterministic structured
 * diff endpoint (`GET /v1/runs/{a}/diff/{b}`) is future work (RFC 0054,
 * not yet filed) — this does not attempt a semantic diff.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import type { RunSnapshot, RunEventDoc } from '@openwop/openwop';
import { getRun, pollEvents } from '../client/runsClient.js';
import { PageHeader } from '../ui/PageHeader.js';
import { StatusBadge } from '../ui/StatusBadge.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { Skeleton } from '../ui/Skeleton.js';
import { ColumnsIcon } from '../ui/icons/index.js';
import { RunTimeline } from './RunTimeline.js';

interface Side {
  snapshot: RunSnapshot | null;
  events: RunEventDoc[];
  error: string | null;
}

const EMPTY: Side = { snapshot: null, events: [], error: null };

function useRunData(runId: string): Side {
  const [side, setSide] = useState<Side>(EMPTY);
  useEffect(() => {
    if (!runId) { setSide(EMPTY); return; }
    let cancelled = false;
    setSide(EMPTY);
    (async () => {
      try {
        const [snap, polled] = await Promise.all([getRun(runId), pollEvents(runId, 0)]);
        if (!cancelled) setSide({ snapshot: snap, events: [...polled.events], error: null });
      } catch (err) {
        if (!cancelled) setSide({ snapshot: null, events: [], error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => { cancelled = true; };
  }, [runId]);
  return side;
}

export function RunComparePage() {
  const { t } = useTranslation('runs');
  const [params, setParams] = useSearchParams();
  const a = params.get('a') ?? '';
  const b = params.get('b') ?? '';
  const [aIn, setAIn] = useState(a);
  const [bIn, setBIn] = useState(b);

  const sideA = useRunData(a);
  const sideB = useRunData(b);

  return (
    <section>
      <PageHeader eyebrow={t('runsEyebrow')} title={t('compareRunsTitle')} lede={t('compareLede')} />
      <div className="surface-card">
        <form
          className="button-row"
          onSubmit={(e) => { e.preventDefault(); setParams({ a: aIn.trim(), b: bIn.trim() }); }}
        >
          <input value={aIn} onChange={(e) => setAIn(e.target.value)} placeholder={t('runIdAPlaceholder')} aria-label={t('runIdAPlaceholder')} className="u-flex-1" />
          <input value={bIn} onChange={(e) => setBIn(e.target.value)} placeholder={t('runIdBPlaceholder')} aria-label={t('runIdBPlaceholder')} className="u-flex-1" />
          <button type="submit">{t('compare')}</button>
        </form>
      </div>

      <div className="run-compare-grid">
        <CompareColumn runId={a} side={sideA} />
        <CompareColumn runId={b} side={sideB} />
      </div>
    </section>
  );
}

function CompareColumn({ runId, side }: { runId: string; side: Side }) {
  const { t } = useTranslation('runs');
  return (
    <div className="surface-card">
      {!runId ? (
        <StateCard
          icon={<ColumnsIcon size={20} />}
          title={t('noRunSelected')}
          body={t('noRunSelectedBody')}
        />
      ) : (
        <>
          <div className="u-flex u-items-center u-gap-2 u-mb-2">
            <code>{runId.slice(0, 16)}</code>
            {side.snapshot && <StatusBadge status={side.snapshot.status} />}
            <span className="muted u-fs-12 u-ml-auto">{t('eventCount', { count: side.events.length })}</span>
          </div>
          {side.error && <Notice variant="error">{side.error}</Notice>}
          {!side.snapshot && !side.error && (
            <div aria-busy="true" aria-label={t('common:loading')} className="u-grid u-gap-2">
              <Skeleton width="60%" />
              <Skeleton width="85%" />
              <Skeleton width="70%" />
            </div>
          )}
          {side.events.length > 0 && <RunTimeline events={side.events} />}
        </>
      )}
    </div>
  );
}
