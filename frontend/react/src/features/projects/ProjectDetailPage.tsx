/**
 * Project detail (ADR 0046) — the `kind:'project'` Subject's surfaces: a Board tab
 * (the project's kanban board, embedded via the shared `<AgentBoardPanel>` board
 * renderer), a Memory tab (the `project:<id>` scope, via the shared
 * `<MemoryBrowser>`), and a Knowledge tab (cited documents over the generic subject
 * binding, via the shared `<SubjectKnowledgePanel>`). Reuses the existing renderers
 * — no bespoke board/memory/knowledge UI.
 */

import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';

import { confirm } from '../../ui/confirm.js';import { Tabs, TabPanel } from '../../ui/Tabs.js';
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
import { classifyHttpError } from '../../client/classifyHttpError.js';
import { loadErrorMessage } from '../../client/loadErrorMessage.js';
import { toast } from '../../ui/toast.js';
import { formatNumber } from '../../i18n/format.js';
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
  /** UX_UPGRADE-projects R2 (PRJ2-M3) — the LOAD failure, which legitimately
   *  replaces the page: with no project there is nothing to render. Kept
   *  strictly separate from `actionError` below, because one `error` state
   *  meant a failed DELETE — an action that changed NOTHING — unmounted the
   *  whole project. The user's tabs, their place, and every unsaved edit in
   *  them went with it, and the surviving screen was a bare error notice with
   *  no way back: the project still existed, but the app now behaved as if it
   *  had never loaded. */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** An ACTION failed (delete). The project is intact and stays on screen. */
  const [actionError, setActionError] = useState<string | null>(null);
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
  // PROJ-UX-2 — the charter editor (Overview tab) reports its dirty state here,
  // and the ONE `setTab` seam intercepts a tab click that would unmount it: the
  // tab bar sits directly above the editor, so a stray click used to destroy an
  // entire drafted charter with no prompt. A ref, not state: the guard is read
  // inside the click handler only — re-rendering the page per keystroke of the
  // charter brief would be waste.
  const charterDirtyRef = useRef(false);
  const onCharterDirtyChange = useCallback((d: boolean): void => { charterDirtyRef.current = d; }, []);
  const setTab = (next: Tab): void => {
    void (async () => {
      if (next !== tab && charterDirtyRef.current) {
        const ok = await confirm({
          title: t('ui:unsavedLeaveTitle'),
          body: t('ui:unsavedLeaveBody'),
          danger: true,
          confirmLabel: t('ui:unsavedLeaveConfirm'),
        });
        if (!ok) return; // stay — the draft survives
        charterDirtyRef.current = false; // discarded with the unmounting editor
      }
      setSearchParams((p) => { const n = new URLSearchParams(p); n.set('tab', next); return n; }, { replace: true });
    })();
  };

  useEffect(() => {
    let cancelled = false;
    void getProject(projectId)
      .then((p) => { if (!cancelled) setProject(p); })
      // A 404 is the one status with a domain meaning here (the project is
      // gone, not the request); everything else falls through to the shared
      // localized classification rather than the raw `getProject failed (503)`.
      .catch((e) => {
        if (cancelled) return;
        setLoadError(classifyHttpError(e).kind === 'not-found' ? t('projectNotFound') : loadErrorMessage(t, e));
      });
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
    // PROJ-UX-5 — the confirm NAMES the blast radius (board, memory, schedules,
    // the chat's full history — and, when the delete will erase one, the whole
    // ingested source corpus) instead of the generic "cannot be undone".
    //
    // ADR 0601 § Corrections (HIGH-2) — this used to ask `facet === 'notebook'`,
    // which is a DIFFERENT question from the one the backend answers when it
    // decides whether to erase the corpus. `ensureNotebookForProject` — what
    // opening the Sources tab calls — provisions a corpus and never stamps
    // `facet`, so that whole population got the generic warning and found out its
    // sources were gone from the SUCCESS TOAST afterwards. `deletesCorpus` is
    // computed by the server from the SAME predicate the eraser acts on, so the
    // consent and the consequence cannot drift apart again.
    const cascade = project?.deletesCorpus === true ? t('deleteCascadeBodyNotebook') : t('deleteCascadeBody');
    if (!(await confirm({ title: t('deleteProjectConfirm', { name: project?.name ?? projectId }), body: `${cascade} ${t('common:cannotBeUndone')}`, danger: true, confirmLabel: t('common:delete') }))) return;
    setActionError(null);
    try {
      // PROJ-UX-5 — the backend's receipt finally gets a reader: surface the
      // counts as a toast (it survives the navigation — Toaster is at the shell).
      const receipt = await deleteProject(projectId);
      const summary = t('deleteReceipt', {
        conversations: formatNumber(receipt.conversationsDeleted ?? 0),
        memory: formatNumber(receipt.memoryEntriesCleared ?? 0),
        schedules: formatNumber(receipt.schedulesCleared ?? 0),
      });
      toast.success(receipt.notebookCorpusDeleted ? `${summary} ${t('deleteReceiptCorpus')}` : summary);
      navigate('/projects');
    }
    catch (e) { setActionError(`${t('deleteProjectError')} ${loadErrorMessage(t, e)}`); }
  };

  if (loadError) return <Notice variant="error" announce={loadError}>{loadError}</Notice>;
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
        actions={canWrite ? <Button variant="danger" onClick={() => void onDelete()}><TrashIcon size={14} /> {t('common:delete')}</Button> : undefined}
      />

      {/* PRJ2-M3 — an action that failed is reported IN the page it failed on,
          and announced. The project below it is untouched. */}
      {actionError ? <Notice variant="error" announce={actionError}>{actionError}</Notice> : null}

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
          <ProjectOverviewTab project={project} canWrite={canWrite} onSaved={setProject} onDirtyChange={onCharterDirtyChange} />
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
            // `PRJWF-3` — the slot exists precisely for this lane (its docblock names the
            // project case first) and only the personal tab was passing it.
            createAudience: t('knowledgeAudience'),
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
