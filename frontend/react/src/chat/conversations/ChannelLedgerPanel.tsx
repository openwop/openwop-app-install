/**
 * ADR 0852 D5 — the members pane's read-only summary of the team ledger of the
 * project this channel is BOUND to. A pointer to the real ledger (the project's
 * Ledger tab), never an editor: proposing and accepting stay on the project.
 *
 * Renders nothing when the ledger toggle is off, the channel is not bound, or
 * the caller cannot read the project (the summaries route omits it). A failed
 * read is said, not shown as "no ledger".
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { getChannel } from '../../client/channelsClient.js';
import { getLedgerSummaries, type LedgerSummary } from '../../features/projects/teamLedgerClient.js';

type Load = { kind: 'loading' } | { kind: 'none' } | { kind: 'failed' } | { kind: 'ready'; summary: LedgerSummary };

export function ChannelLedgerPanel({ channelId }: { channelId: string }): JSX.Element | null {
  const { t } = useTranslation('chat');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const projectId = (await getChannel(channelId)).channel?.boundProjectId;
        if (!projectId) { if (live) setLoad({ kind: 'none' }); return; }
        const [summary] = await getLedgerSummaries([projectId]);
        if (live) setLoad(summary ? { kind: 'ready', summary } : { kind: 'none' });
      } catch {
        if (live) setLoad({ kind: 'failed' });
      }
    })();
    return () => { live = false; };
  }, [channelId]);

  if (load.kind === 'loading' || load.kind === 'none') return null;
  if (load.kind === 'failed') {
    return <section className="u-p-2 u-border-b" aria-label={t('channelLedgerTitle')}><p className="muted u-fs-12" role="status">{t('channelLedgerFailed')}</p></section>;
  }
  const s = load.summary;
  const href = `/projects/${encodeURIComponent(s.projectId)}?tab=ledger`;
  return (
    <section className="u-p-2 u-border-b" aria-labelledby="channel-ledger-heading">
      <h3 id="channel-ledger-heading" className="u-fs-13 u-mb-1">{t('channelLedgerTitle')}</h3>
      <p className="u-fs-12 u-mb-1">{t('channelLedgerProject', { name: s.name })}</p>
      {s.hasLedger ? (
        <>
          {s.goal ? <p className="u-fs-12 u-mb-1">{s.goal}</p> : null}
          <p className="muted u-fs-12 u-mb-1">
            {t('channelLedgerVersion', { version: s.version })} · {t('channelLedgerOpenQuestions', { count: s.openQuestionCount ?? 0 })}
            {s.pending ? ` · ${t('channelLedgerPending', { count: s.pending })}` : ''}
          </p>
          {s.openQuestions && s.openQuestions.length > 0 ? <ul className="u-fs-12 u-mb-1">{s.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul> : null}
        </>
      ) : <p className="muted u-fs-12 u-mb-1">{t('channelLedgerNone')}</p>}
      <Link className="u-fs-12" to={href}>{t('channelLedgerOpen')}</Link>
    </section>
  );
}
