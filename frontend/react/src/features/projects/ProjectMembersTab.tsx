/**
 * Project Members tab (ADR 0054 D2/D5) — the project's TEAM (people + agents, with
 * a descriptive role) and its read-visibility (`org` / `private`). Always-on
 * (graduated off the `project-collab` toggle 2026-06-16). WRITE stays org-scoped
 * — membership is a roster + (for `private`) a read-ACL, never authority.
 *
 * `ui/` cohesion: surface-card / surface-form / SelectField / segmented / chip /
 * StateCard / Notice + the `proj-*` row/tile primitives; tokens only.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SelectField } from '../../ui/Field.js';
import { UserIcon, SparklesIcon, TrashIcon, PlusIcon, GlobeIcon, LockIcon } from '../../ui/icons/index.js';
import { listMembers, type OrgMember } from '../../client/accessClient.js';
import { listRoster, type RosterEntry } from '../../agents/rosterClient.js';
import {
  listProjectMembers, addProjectMember, removeProjectMember, setProjectVisibility,
  type Project, type ProjectMember, type ProjectRole, type ProjectVisibility,
} from './projectsClient.js';

const ROLES: ProjectRole[] = ['lead', 'contributor', 'observer'];
const ROLE_LABEL_KEYS: Record<ProjectRole, string> = { lead: 'roleLead', contributor: 'roleContributor', observer: 'roleObserver' };
const isAgent = (ref: string): boolean => ref.startsWith('agent:');

export function ProjectMembersTab({ project, canWrite, onSaved }: { project: Project; canWrite: boolean; onSaved: (p: Project) => void }): JSX.Element {
  const { t } = useTranslation('projects');
  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [visibility, setVisibility] = useState<ProjectVisibility>(project.visibility ?? 'org');
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [addRef, setAddRef] = useState('');
  const [addRole, setAddRole] = useState<ProjectRole>('contributor');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    const [m, om, r] = await Promise.all([
      listProjectMembers(project.id),
      listMembers(project.orgId).catch(() => []),
      listRoster().catch(() => []),
    ]);
    setMembers(m.members); setVisibility(m.visibility); setOrgMembers(om); setRoster(r);
  };
  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : t('membersLoadError')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const nameOf = useMemo(() => (ref: string): string => {
    const [kind, id] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
    if (kind === 'agent') return roster.find((r) => r.rosterId === id)?.persona ?? id;
    return orgMembers.find((m) => m.subject === id)?.displayName ?? id;
  }, [orgMembers, roster]);

  const memberRefs = useMemo(() => new Set((members ?? []).map((m) => m.ref)), [members]);
  const candidates = useMemo(() => [
    ...orgMembers.filter((m) => m.subject).map((m) => ({ ref: `user:${m.subject}`, label: t('personOption', { name: m.displayName }) })),
    ...roster.map((r) => ({ ref: `agent:${r.rosterId}`, label: t('agentOption', { name: r.persona }) })),
  ].filter((c) => !memberRefs.has(c.ref)), [orgMembers, roster, memberRefs, t]);

  // People first, then agents — a stable, readable roster order.
  const ordered = useMemo(() => [...(members ?? [])].sort((a, b) => Number(isAgent(a.ref)) - Number(isAgent(b.ref))), [members]);
  const people = ordered.filter((m) => !isAgent(m.ref)).length;
  const agents = ordered.length - people;

  const run = async (op: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null);
    try { await op(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : t('memberActionError')); }
    finally { setBusy(false); }
  };

  const onSetVisibility = (v: ProjectVisibility): void => void run(async () => { onSaved(await setProjectVisibility(project.id, v)); });

  return (
    <div className="u-flex u-flex-col u-gap-3">
      {error ? <Notice variant="error">{error}</Notice> : null}

      {/* ── Visibility ── */}
      <div className="surface-card u-flex u-flex-col u-gap-2">
        <div className="u-flex u-items-center u-justify-between u-gap-3 u-wrap">
          <span className="u-flex u-items-center u-gap-2">
            {visibility === 'private' ? <LockIcon size={15} /> : <GlobeIcon size={15} />}
            <strong className="u-fs-14">{t('visibilityHeading')}</strong>
          </span>
          <div className="segmented" role="group" aria-label={t('visibilityGroupAria')}>
            <button type="button" aria-pressed={visibility === 'org'} disabled={busy || !canWrite} onClick={() => onSetVisibility('org')}>{t('visibilityOrg')}</button>
            <button type="button" aria-pressed={visibility === 'private'} disabled={busy || !canWrite} onClick={() => onSetVisibility('private')}>{t('visibilityPrivate')}</button>
          </div>
        </div>
        <p className="muted u-fs-12 u-m-0">
          {visibility === 'private' ? t('visibilityPrivateHelp') : t('visibilityOrgHelp')}
          {' '}{t('visibilityEditNote')}
        </p>
      </div>

      {/* ── Add a member (write-gated, ADR 0063) ── */}
      {canWrite ? (
        <div className="surface-card u-flex u-flex-col u-gap-2">
          <span className="proj-eyebrow">{t('addToTeam')}</span>
          <div className="surface-form">
            <SelectField label={t('personOrAgentLabel')} value={addRef} onChange={(e) => setAddRef(e.target.value)}>
              <option value="">{t('chooseOption')}</option>
              {candidates.map((c) => <option key={c.ref} value={c.ref}>{c.label}</option>)}
            </SelectField>
            <SelectField label={t('roleLabel')} value={addRole} onChange={(e) => setAddRole(e.target.value as ProjectRole)}>
              {ROLES.map((r) => <option key={r} value={r}>{t(ROLE_LABEL_KEYS[r])}</option>)}
            </SelectField>
            <button type="button" className="primary" disabled={!addRef || busy} onClick={() => void run(async () => { await addProjectMember(project.id, addRef, addRole); setAddRef(''); })}>
              <PlusIcon size={14} /> {t('addMember')}
            </button>
          </div>
        </div>
      ) : null}

      {/* ── Roster ── */}
      {members === null ? (
        <StateCard icon={<UserIcon size={20} />} title={t('loadingTeam')} loading />
      ) : ordered.length === 0 ? (
        <StateCard icon={<UserIcon size={22} />} title={t('noMembersTitle')} body={t('noMembersBody')} />
      ) : (
        <div className="surface-card u-flex u-flex-col u-gap-1">
          <div className="u-flex u-items-baseline u-gap-2 u-mb-1">
            <span className="proj-eyebrow">{t('teamEyebrow')}</span>
            <span className="muted u-fs-12">{t('teamSummary', { people: t('peopleCount', { count: people }), agents: t('agentCount', { count: agents }) })}</span>
          </div>
          <ul className="u-list-none u-m-0 u-p-0 u-flex u-flex-col">
            {ordered.map((m) => {
              const agent = isAgent(m.ref);
              return (
                <li key={m.ref} className="proj-row">
                  <span className="proj-row__main">
                    <span className={`proj-tile ${agent ? 'proj-tile--agent' : ''}`} aria-hidden="true">{agent ? <SparklesIcon size={15} /> : <UserIcon size={15} />}</span>
                    <span className="u-flex u-flex-col u-minw-0">
                      <strong className="u-fs-14">{nameOf(m.ref)}</strong>
                      <span className="proj-eyebrow">{agent ? t('memberKindAgent') : t('memberKindPerson')}</span>
                    </span>
                    <span className="chip chip--muted">{t(ROLE_LABEL_KEYS[m.role])}</span>
                  </span>
                  {canWrite ? (
                    <button type="button" className="ghost btn-sm" aria-label={t('removeMemberAria', { name: nameOf(m.ref) })} disabled={busy} onClick={() => void run(() => removeProjectMember(project.id, m.ref))}><TrashIcon size={14} /></button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
