/**
 * Workbench — ADR 0768 P2, the chat's right-hand pane ("talk left, work
 * right"). Hosts what a turn PRODUCES so the thread stays readable:
 *
 *   - Run      — the existing WorkflowProgressPanel (moved from the left rail)
 *   - Artifact — the existing ArtifactWorkbench, docked instead of modal
 *
 * Both are the existing components, not re-implementations. Shared by both
 * chat shells (ChatSidebar + the multi-tab TabChatDeck). Below the mobile
 * breakpoint it overlays the thread full-width, like the left rail does.
 */

import { lazy, Suspense, type ComponentProps, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { XIcon } from '../../ui/icons/index.js';
import { WorkflowProgressPanel } from '../workflowProgress/WorkflowProgressPanel.js';
import type { WorkbenchArtifact, WorkbenchTab } from './useWorkbench.js';
import { SourcesPanel } from './SourcesPanel.js';
import { EMPTY_SOURCES, sourceCount, type ConversationSources } from './sources.js';

// Lazy, as it was when it mounted as a modal: the artifact viewer + its renderer
// registry must stay out of the chat entry chunk (bundle budget).
const ArtifactWorkbench = lazy(() => import('../artifacts/ArtifactWorkbench.js').then((m) => ({ default: m.ArtifactWorkbench })));

interface Props {
  tab: WorkbenchTab | null;
  onSelectTab: (tab: WorkbenchTab) => void;
  onClose: () => void;
  isMobile: boolean;
  runProps: Omit<ComponentProps<typeof WorkflowProgressPanel>, 'onClose' | 'hideHeader'>;
  artifact: WorkbenchArtifact | null;
  onCloseArtifact: () => void;
  /** ADR 0768 B4 — what the active conversation drew on. The tab appears only
   *  when there is something to list (or it is the selected tab). */
  sources?: ConversationSources;
}

export function Workbench({ tab, onSelectTab, onClose, isMobile, runProps, artifact, onCloseArtifact, sources = EMPTY_SOURCES }: Props): JSX.Element | null {
  const { t } = useTranslation('chat');
  if (tab === null) return null;

  const tabs: ReadonlyArray<{ id: WorkbenchTab; label: string; badge?: number }> = [
    { id: 'run', label: t('workbenchTabRun'), badge: runProps.workflowRunMessages.length },
    ...(artifact ? [{ id: 'artifact' as const, label: t('workbenchTabArtifact') }] : []),
    ...(sourceCount(sources) > 0 || tab === 'sources' ? [{ id: 'sources' as const, label: t('workbenchTabSources'), badge: sourceCount(sources) }] : []),
  ];

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const i = tabs.findIndex((x) => x.id === tab);
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else return;
    e.preventDefault();
    const target = tabs[next];
    if (target) {
      onSelectTab(target.id);
      document.getElementById(`workbench-tab-${target.id}`)?.focus();
    }
  };

  return (
    <aside aria-label={t('workbenchAria')} className={`workbench-aside${isMobile ? ' workbench-aside--mobile' : ''}`}>
      <div className="workbench-head">
        <span className="workbench-eyebrow" aria-hidden="true">{t('workbenchEyebrow')}</span>
        <div role="tablist" aria-label={t('workbenchAria')} className="workbench-tabs" onKeyDown={onKeyDown}>
          {tabs.map((x) => (
            <Button
              key={x.id}
              variant="quiet"
              id={`workbench-tab-${x.id}`}
              role="tab"
              aria-selected={tab === x.id}
              aria-controls="workbench-panel"
              tabIndex={tab === x.id ? 0 : -1}
              className={`workbench-tab${tab === x.id ? ' is-active' : ''}`}
              onClick={() => onSelectTab(x.id)}
            >
              {x.label}
              {x.badge ? <span className="workbench-tab-badge">{x.badge}</span> : null}
            </Button>
          ))}
        </div>
        <Button variant="quiet" className="workbench-close" onClick={onClose} aria-label={t('workbenchClose')}>
          <XIcon size={14} />
        </Button>
      </div>
      <div id="workbench-panel" role="tabpanel" aria-labelledby={`workbench-tab-${tab}`} className="workbench-body">
        {tab === 'run' ? <WorkflowProgressPanel {...runProps} onClose={onClose} hideHeader /> : null}
        {tab === 'sources' ? <SourcesPanel sources={sources} /> : null}
        {tab === 'artifact' && artifact ? (
          <Suspense fallback={null}>
          <ArtifactWorkbench
            key={`${artifact.artifactId}:${artifact.revisionId ?? ''}`}
            docked
            artifactId={artifact.artifactId}
            {...(artifact.revisionId ? { revisionId: artifact.revisionId } : {})}
            onClose={onCloseArtifact}
          />
          </Suspense>
        ) : null}
      </div>
    </aside>
  );
}
