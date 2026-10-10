/**
 * ADR 0768 follow-up B4 — the Workbench "Sources" tab: what this conversation
 * drew on (see `sources.ts`). Links open in a new tab; a file with no host URL
 * is listed by name only. An empty conversation says so plainly.
 */
import { useTranslation } from 'react-i18next';
import { FileTextIcon, GlobeIcon } from '../../ui/icons/index.js';
import type { ConversationSources } from './sources.js';

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export function SourcesPanel({ sources }: { sources: ConversationSources }): JSX.Element {
  const { t } = useTranslation('chat');
  if (sources.web.length === 0 && sources.files.length === 0) {
    return <p className="workbench-sources-empty">{t('sourcesEmpty')}</p>;
  }
  return (
    <div className="workbench-sources">
      {sources.web.length > 0 ? (
        <section aria-labelledby="sources-web-h">
          <h3 id="sources-web-h" className="workbench-sources-h">{t('sourcesWeb', { count: sources.web.length })}</h3>
          <ul className="workbench-sources-list">
            {sources.web.map((w) => (
              <li key={w.url} className="workbench-source">
                <GlobeIcon size={14} />
                <span className="workbench-source-text">
                  <a href={w.url} target="_blank" rel="noopener noreferrer" className="workbench-source-title">{w.title || hostOf(w.url)}</a>
                  <span className="workbench-source-meta">{hostOf(w.url)} · {t('sourcesCitedIn', { count: w.turns })}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {sources.files.length > 0 ? (
        <section aria-labelledby="sources-files-h">
          <h3 id="sources-files-h" className="workbench-sources-h">{t('sourcesFiles', { count: sources.files.length })}</h3>
          <ul className="workbench-sources-list">
            {sources.files.map((f) => (
              <li key={`${f.name}@${f.url ?? ''}`} className="workbench-source">
                <FileTextIcon size={14} />
                <span className="workbench-source-text">
                  {f.url
                    ? <a href={f.url} target="_blank" rel="noopener noreferrer" className="workbench-source-title">{f.name || t('sourcesUnnamedFile')}</a>
                    : <span className="workbench-source-title">{f.name || t('sourcesUnnamedFile')}</span>}
                  <span className="workbench-source-meta">{f.mimeType}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
