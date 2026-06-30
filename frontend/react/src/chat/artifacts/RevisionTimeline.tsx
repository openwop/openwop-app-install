/**
 * RevisionTimeline (ADR 0069) — the immutable revision history of an artifact.
 * Selecting two revisions drives the diff view; the latest is marked. Newest-first.
 */

import { formatDate } from '../../i18n/format.js';
import { useTranslation } from 'react-i18next';
import { BotIcon, UserIcon, ZapIcon } from '../../ui/icons/index.js';
import type { ArtifactRevision } from './artifactClient.js';

interface Props {
  revisions: readonly ArtifactRevision[];
  latestRevisionId: string | undefined;
  /** The (from, to) selected for comparison. */
  compare: { from?: string; to?: string };
  onToggleCompare: (revisionId: string) => void;
}

function ByIcon({ kind }: { kind: string }): JSX.Element {
  if (kind === 'agent') return <BotIcon size={13} />;
  if (kind === 'run') return <ZapIcon size={13} />;
  return <UserIcon size={13} />;
}

export function RevisionTimeline({ revisions, latestRevisionId, compare, onToggleCompare }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  if (revisions.length === 0) return <p className="artifact-revisions__empty">{t('artifactRevisionsEmpty')}</p>;
  return (
    <ol className="artifact-revisions" aria-label={t('artifactRevisionsLabel')}>
      {revisions.map((r) => {
        const selected = compare.from === r.revisionId || compare.to === r.revisionId;
        return (
          <li key={r.revisionId} className={`artifact-revisions__item${selected ? ' is-selected' : ''}`}>
            <label className="artifact-revisions__pick">
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onToggleCompare(r.revisionId)}
                aria-label={t('artifactCompareRevisionAria', { version: r.version })}
              />
              <span className="artifact-revisions__ver">v{r.version}</span>
              {r.revisionId === latestRevisionId ? <span className="chip chip--accent">{t('artifactRevisionLatest')}</span> : null}
            </label>
            <div className="artifact-revisions__meta">
              {r.summary ? <span className="artifact-revisions__summary">{r.summary}</span> : null}
              <span className="artifact-revisions__by"><ByIcon kind={r.createdBy.kind} /> {r.createdBy.id}</span>
              <time dateTime={r.createdAt}>{formatDate(r.createdAt)}</time>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
