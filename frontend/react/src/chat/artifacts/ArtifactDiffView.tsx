/**
 * ArtifactDiffView (ADR 0069) — renders a server-computed diff of two immutable
 * artifact revisions. Text/markdown → a line view (add/remove/equal); JSON → a
 * path/op change table. Pure presentational; the diff is authoritative server-side.
 */

import { useTranslation } from 'react-i18next';
import type { ArtifactDiff } from './artifactClient.js';

const OP_GLYPH: Record<string, string> = { add: '+', remove: '−', equal: ' ', change: '~' };
const OP_LABEL_KEY: Record<string, string> = { add: 'diffLineAdded', remove: 'diffLineRemoved', change: 'diffLineChanged' };

export function ArtifactDiffView({ diff }: { diff: ArtifactDiff['diff'] }): JSX.Element {
  const { t } = useTranslation('chat');
  if (diff.format === 'json') {
    if (diff.changes.length === 0) return <p className="artifact-diff__empty">{t('artifactDiffNoStructural')}</p>;
    return (
      <table className="artifact-diff-json">
        <thead>
          <tr><th>{t('artifactDiffPath')}</th><th>{t('artifactDiffChange')}</th><th>{t('artifactDiffBefore')}</th><th>{t('artifactDiffAfter')}</th></tr>
        </thead>
        <tbody>
          {diff.changes.map((c) => (
            <tr key={`${c.path}:${c.op}`} className={`artifact-diff-json__row artifact-diff-json__row--${c.op}`}>
              <td><code>{c.path}</code></td>
              <td><span className="chip chip--muted">{c.op}</span></td>
              <td><code>{c.op === 'add' ? '—' : JSON.stringify(c.before)}</code></td>
              <td><code>{c.op === 'remove' ? '—' : JSON.stringify(c.after)}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (diff.added === 0 && diff.removed === 0) return <p className="artifact-diff__empty">{t('artifactDiffNoChanges')}</p>;
  return (
    <div className="artifact-diff" role="group" aria-label={t('artifactDiffAria', { added: diff.added, removed: diff.removed })}>
      <div className="artifact-diff__summary">
        <span className="chip chip--success">+{diff.added}</span>
        <span className="chip chip--danger">−{diff.removed}</span>
      </div>
      <pre className="artifact-diff__body">
        {diff.lines.map((l, i) => (
          <span key={i} className={`artifact-diff__line artifact-diff__line--${l.op}`}>
            <span className="artifact-diff__gutter" aria-hidden="true">{OP_GLYPH[l.op]}</span>
            {OP_LABEL_KEY[l.op] && <span className="sr-only">{t(OP_LABEL_KEY[l.op]!)}: </span>}
            {l.text || ' '}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  );
}
