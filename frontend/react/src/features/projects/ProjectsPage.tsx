/**
 * Projects page (ADR 0046) — the `kind:'project'` Subject surface. Lists the
 * workspace's projects (the ones the caller can read) + a create form; each card
 * links to the project detail (board + memory). Uses the shared `ui/` primitives.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { FolderIcon, PlusIcon } from '../../ui/icons/index.js';
import { getEffectiveAccess } from '../../client/accessClient.js';
import { listProjects, createProject, listOrgs, type Project, type Org } from './projectsClient.js';
import { ProjectCard, ProjectRow } from './ProjectViews.js';

export function ProjectsPage(): JSX.Element {
  const { t } = useTranslation('projects');
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [orgId, setOrgId] = useState('');
  // ADR 0063 — only offer "Create project" to a caller who can actually write
  // somewhere in this workspace (createProject needs `workspace:write` in the
  // chosen org), so a read-only member doesn't get a form that 403s on submit.
  // This is the active-workspace write union; a multi-org caller with mixed
  // scopes still picks the org, and the backend re-checks per-org, fail-closed.
  const [canCreate, setCanCreate] = useState(false);
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useViewMode('projects', 'grid');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects ?? [];
    return (projects ?? []).filter(
      (p) => p.name.toLowerCase().includes(q) || (p.charter?.goal?.toLowerCase().includes(q) ?? false),
    );
  }, [projects, query]);

  const refresh = useCallback(async () => {
    try { setProjects(await listProjects()); }
    catch (e) { setError(e instanceof Error ? e.message : t('loadProjectsError')); }
  }, [t]);

  useEffect(() => {
    void refresh();
    void listOrgs().then(setOrgs).catch(() => {});
    void getEffectiveAccess().then((a) => setCanCreate(a.scopes.includes('workspace:write'))).catch(() => setCanCreate(false));
  }, [refresh]);

  const effectiveOrg = orgId || orgs[0]?.orgId || '';

  const onCreate = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!effectiveOrg || !name.trim() || busy) return;
    setBusy(true); setError(null);
    try { await createProject(effectiveOrg, name.trim()); setName(''); await refresh(); }
    catch (er) { setError(er instanceof Error ? er.message : t('createProjectError')); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <PageHeader eyebrow={t('listEyebrow')} title={t('listTitle')} lede={t('listLede')} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {canCreate ? (
        <form className="surface-card surface-form u-mb-4" onSubmit={(e) => void onCreate(e)}>
          <SelectField label={t('workspaceLabel')} value={effectiveOrg} onChange={(e) => setOrgId(e.target.value)}>
            {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </SelectField>
          <TextField label={t('newProjectNameLabel')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('newProjectNamePlaceholder')} />
          <button type="submit" className="btn-primary" disabled={!effectiveOrg || !name.trim() || busy}><PlusIcon size={14} /> {t('createProject')}</button>
        </form>
      ) : null}

      {projects === null ? (
        <StateCard icon={<FolderIcon size={20} />} title={t('loadingProjects')} loading />
      ) : projects.length === 0 ? (
        <StateCard icon={<FolderIcon size={20} />} title={t('noProjectsTitle')} body={t('noProjectsBody')} />
      ) : (
        <>
          <div className="filterbar" role="group" aria-label={t('filterGroup')}>
            {projects.length > 3 ? (
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('filterPlaceholder')}
                aria-label={t('filterAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            ) : null}
            <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" />
          </div>

          {visible.length === 0 ? (
            <StateCard
              icon={<FolderIcon size={20} />}
              title={t('noMatchTitle')}
              body={t('noMatchBody')}
              action={<button type="button" className="secondary" onClick={() => setQuery('')}>{t('clearSearch')}</button>}
            />
          ) : viewMode === 'grid' ? (
            <div className="card-grid">
              {visible.map((p) => <ProjectCard key={p.id} project={p} />)}
            </div>
          ) : (
            <div className="surface-card list-view">
              {visible.map((p) => <ProjectRow key={p.id} project={p} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
