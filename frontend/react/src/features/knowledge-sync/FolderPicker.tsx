/**
 * Folder picker (ADR 0107 follow-on) — a drill-in browser over the knowledge-sync
 * `/browse` API, so a user picks a Drive/OneDrive/Dropbox/Box folder instead of
 * pasting a raw id. Breadcrumb to navigate up; "Use this folder" selects the current
 * one. SharePoint isn't browsable yet (the panel keeps a raw-id input for it).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '../../ui/Skeleton.js';
import { FolderIcon, ChevronRightIcon } from '../../ui/icons/index.js';
import { browseFolders, type BrowseFolder } from './knowledgeSyncClient.js';

export function FolderPicker({ orgId, connectionId, onSelect }: { orgId: string; connectionId: string; onSelect: (folderId: string) => void }): JSX.Element {
  const { t } = useTranslation('knowledge-sync');
  const [trail, setTrail] = useState<BrowseFolder[]>([{ id: 'root', name: t('rootFolder') }]);
  const [folders, setFolders] = useState<BrowseFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = trail[trail.length - 1]!;

  const load = useCallback((folderId: string) => {
    setFolders(null);
    setError(null);
    void browseFolders(orgId, connectionId, folderId === 'root' ? undefined : folderId)
      .then(setFolders)
      .catch((e) => setError(e instanceof Error ? e.message : t('browseFailed')));
  }, [orgId, connectionId, t]);

  useEffect(() => { load(current.id); }, [load, current.id]);

  return (
    <div className="surface-card u-gap-1">
      {/* breadcrumb */}
      <div className="u-flex u-gap-1 u-items-center u-flex-wrap u-label-sm">
        {trail.map((c, i) => (
          <span key={c.id} className="u-flex u-gap-1 u-items-center">
            {i > 0 ? <ChevronRightIcon size={12} aria-hidden="true" /> : null}
            <button type="button" className="btn-ghost u-p-0" disabled={i === trail.length - 1} onClick={() => setTrail((tr) => tr.slice(0, i + 1))}>{c.name}</button>
          </span>
        ))}
      </div>

      {error ? <span className="chip chip--danger">{error}</span>
        : !folders ? <Skeleton />
        : folders.length === 0 ? <span className="u-label-sm">{t('noSubfolders')}</span>
        : (
          <div className="u-grid u-gap-1">
            {folders.map((f) => (
              <button key={f.id} type="button" className="btn-ghost u-justify-start" onClick={() => setTrail((tr) => [...tr, f])}>
                <FolderIcon size={14} /> {f.name}
              </button>
            ))}
          </div>
        )}

      <div className="action-bar">
        <button type="button" className="btn-primary" onClick={() => onSelect(current.id)}>{t('useThisFolder', { name: current.name })}</button>
      </div>
    </div>
  );
}
