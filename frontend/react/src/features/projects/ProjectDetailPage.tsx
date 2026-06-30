/**
 * Project detail (ADR 0046) — the `kind:'project'` Subject's surfaces: a Board tab
 * (the project's kanban board, embedded via the shared `<AgentBoardPanel>` board
 * renderer), a Memory tab (the `project:<id>` scope, via the shared
 * `<MemoryBrowser>`), and a Knowledge tab (cited documents over the generic subject
 * binding, via the shared `<SubjectKnowledgePanel>`). Reuses the existing renderers
 * — no bespoke board/memory/knowledge UI.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { Tabs, TabPanel } from '../../ui/Tabs.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { FolderIcon, TrashIcon } from '../../ui/icons/index.js';
import { AgentBoardPanel } from '../../agents/AgentBoardPanel.js';
import { MemoryBrowser } from '../../memory/MemoryBrowser.js';
import { SubjectKnowledgePanel, type SubjectKnowledgeClient } from '../../knowledge/SubjectKnowledgePanel.js';
import { ProjectSchedulesTab } from './ProjectSchedulesTab.js';
import { ProjectWorkflowsTab } from './ProjectWorkflowsTab.js';
import { ProjectOverviewTab } from './ProjectOverviewTab.js';
// ADR 0079 Phase 4 — strategy alignment is composed from the strategy feature
// (one-directional import; the strategy package never imports projects).
import { ProjectStrategyChips } from '../strategy/StrategyAlignment.js';
import { ProjectMembersTab } from './ProjectMembersTab.js';
import { ProjectChatTab } from './ProjectChatTab.js';
// ADR 0084 correction — notebooks (Sources) + podcasts as project tabs, not standalone.
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { ProjectSourcesPanel } from '../notebooks/NotebooksPage.js';
import { ProjectPodcastPanel } from '../podcasts/PodcastStudioPage.js';
import { getProject, deleteProject, listMemory, addMemory, deleteMemory, type Project } from './projectsClient.js';
import {
  getProjectKnowledge, listOrgs, createCollection, unbindCollection, ingestText, deleteDocument, retrieve,
} from './projectKnowledgeClient.js';

type Tab = 'overview' | 'members' | 'chat' | 'board' | 'memory' | 'knowledge' | 'sources' | 'podcast' | 'workflows' | 'schedules';

const TAB_LABEL_KEYS: Record<Tab, string> = {
  overview: 'tabOverview',
  members: 'tabMembers',
  chat: 'tabChat',
  board: 'tabBoard',
  memory: 'tabMemory',
  knowledge: 'tabKnowledge',
  // ADR 0084 correction — notebooks (Sources) + podcasts surfaced as project tabs.
  sources: 'tabSources',
  podcast: 'tabPodcast',
  workflows: 'tabWorkflows',
  schedules: 'tabSchedules',
};

export function ProjectDetailPage(): JSX.Element {
  const { t } = useTranslation('projects');
  const { projectId = '' } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  // ADR 0054 — Members (membership + visibility) and Chat are always-on
  // (graduated off the `project-collab` toggle 2026-06-16). ADR 0084 correction —
  // Sources (notebooks) + Podcast appear as project tabs ONLY when their toggle is
  // enabled for the tenant (notebooks/podcasts default OFF).
  const notebooksEnabled = useFeatureAccess('notebooks').enabled;
  const podcastsEnabled = useFeatureAccess('podcasts').enabled;
  const TABS: readonly Tab[] = [
    'overview', 'members', 'chat', 'board', 'memory', 'knowledge',
    ...(notebooksEnabled ? ['sources' as const] : []),
    ...(podcastsEnabled ? ['podcast' as const] : []),
    'workflows', 'schedules',
  ];
  const tabParam = searchParams.get('tab');
  const tab: Tab = TABS.some((id) => id === tabParam) ? (tabParam as Tab) : 'overview';
  const setTab = (next: Tab): void => setSearchParams((p) => { const n = new URLSearchParams(p); n.set('tab', next); return n; }, { replace: true });

  useEffect(() => {
    let cancelled = false;
    void getProject(projectId)
      .then((p) => { if (!cancelled) setProject(p); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t('projectNotFound')); });
    return () => { cancelled = true; };
  }, [projectId, t]);

  const list = useCallback(() => listMemory(projectId), [projectId]);
  const add = useCallback((content: string) => addMemory(projectId, content), [projectId]);
  const remove = useCallback((noteId: string) => deleteMemory(projectId, noteId), [projectId]);

  const knowledgeClient = useMemo<SubjectKnowledgeClient>(() => ({
    getKnowledge: () => getProjectKnowledge(projectId),
    listOrgs: () => listOrgs(),
    createCollection: (orgId, name) => createCollection(projectId, orgId, name),
    unbindCollection: (collectionId) => unbindCollection(projectId, collectionId),
    ingestText: (orgId, collectionId, title, text) => ingestText(projectId, orgId, collectionId, title, text),
    deleteDocument: (orgId, collectionId, documentId) => deleteDocument(projectId, orgId, collectionId, documentId),
    retrieve: (query) => retrieve(projectId, query),
  }), [projectId]);

  const onDelete = async (): Promise<void> => {
    try { await deleteProject(projectId); navigate('/projects'); }
    catch (e) { setError(e instanceof Error ? e.message : t('deleteProjectError')); }
  };

  if (error) return <Notice variant="error">{error}</Notice>;
  if (!project) return <StateCard icon={<FolderIcon size={20} />} title={t('loadingProject')} loading />;

  // ADR 0063 — the caller's effective write access, projected by the read.
  // Fail-closed: a response without the field (or `false`) is treated as no-write,
  // so write affordances are hidden rather than shown-then-403. The backend
  // remains the authority on every write route.
  const canWrite = project.canWrite === true;

  return (
    <div>
      <PageHeader
        eyebrow={t('detailEyebrow')}
        title={project.name}
        lede={t('detailLede')}
        actions={canWrite ? <button type="button" className="secondary u-text-danger" onClick={() => void onDelete()}><TrashIcon size={14} /> {t('common:delete')}</button> : undefined}
      />

      {!canWrite ? (
        <Notice variant="info"><Trans i18nKey="readOnlyNotice" ns="projects" components={{ 0: <code /> }} /></Notice>
      ) : null}

      <Tabs
        items={TABS.map((tabId) => ({ id: tabId, label: t(TAB_LABEL_KEYS[tabId]) }))}
        value={tab}
        onChange={(id) => setTab(id as Tab)}
        label={t('tablistLabel')}
        idBase="project"
        className="u-mb-4"
      />

      <TabPanel idBase="project" tabId={tab}>
      {tab === 'overview' ? (
        <>
          <ProjectOverviewTab project={project} canWrite={canWrite} onSaved={setProject} />
          {/* ADR 0079 Phase 4 — strategies this project is aligned to (strategy-owned,
              toggle-gated; renders nothing when off or unaligned). */}
          <ProjectStrategyChips projectId={project.id} />
        </>
      ) : tab === 'members' ? (
        <ProjectMembersTab project={project} canWrite={canWrite} onSaved={setProject} />
      ) : tab === 'chat' ? (
        <ProjectChatTab project={project} canWrite={canWrite} onSaved={setProject} />
      ) : tab === 'board' ? (
        <AgentBoardPanel boardId={project.boardId} persona={project.name} />
      ) : tab === 'memory' ? (
        <MemoryBrowser
          list={list}
          add={add}
          remove={remove}
          readOnly={!canWrite}
          addPlaceholder={t('memoryAddPlaceholder')}
          emptyBody={t('memoryEmptyBody')}
        />
      ) : tab === 'knowledge' ? (
        <SubjectKnowledgePanel
          client={knowledgeClient}
          readOnly={!canWrite}
          copy={{
            intro: <Trans i18nKey="knowledgeIntro" ns="projects" components={{ 0: <strong /> }} />,
            emptyBody: t('knowledgeEmptyBody'),
            searchTitle: t('knowledgeSearchTitle'),
            searchPlaceholder: t('knowledgeSearchPlaceholder'),
          }}
        />
      ) : tab === 'sources' ? (
        // ADR 0084 correction — the notebook surface (sources, context levels,
        // audio/YouTube ingest, transformations, grounded Ask) scoped to this project.
        <ProjectSourcesPanel projectId={projectId} />
      ) : tab === 'podcast' ? (
        // ADR 0086 — generate a multi-speaker audio overview of THIS project.
        <ProjectPodcastPanel orgId={project.orgId} projectId={projectId} />
      ) : tab === 'workflows' ? (
        <ProjectWorkflowsTab projectId={projectId} workflows={project.workflows} canWrite={canWrite} onSaved={setProject} />
      ) : (
        <ProjectSchedulesTab projectId={projectId} workflows={project.workflows} canWrite={canWrite} />
      )}
      </TabPanel>
    </div>
  );
}
