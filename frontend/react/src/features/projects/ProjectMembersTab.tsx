/**
 * Project Members tab (ADR 0054 D2/D5) — the project's TEAM (people + agents, with
 * a descriptive role) and its read-visibility (`org` / `private`). Always-on
 * (graduated off the `project-collab` toggle 2026-06-16). WRITE stays org-scoped
 * — membership is a roster + (for `private`) a read-ACL, never authority.
 *
 * `ui/` cohesion: surface-card / surface-form / SelectField / segmented / chip /
 * StateCard / Notice + the `proj-*` row/tile primitives; tokens only.
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SelectField } from '../../ui/Field.js';
import { UserIcon, SparklesIcon, TrashIcon, PlusIcon, GlobeIcon, LockIcon } from '../../ui/icons/index.js';
import { loadErrorMessage } from '../../client/loadErrorMessage.js';
import { confirm } from '../../ui/confirm.js';
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
  /** ADR 0608 D8 (`CPU-1`) — the success half. A write with no acknowledgement is
   *  indistinguishable from one that silently failed. */
  const [ok, setOk] = useState<string | null>(null);
  /** The read FAILED — distinct from `null` (loading) and `[]` (genuinely none).
   *  #2596: the resolution depends on what the EMPTY state says; here it is
   *  an access claim — "No one's on this project yet" — plus an invitation to add people who may already be there. */
  const [membersFailed, setMembersFailed] = useState(false);
  // R2 PRJ2-B1 — round 1 used ONE flag for TWO independent reads, and the only reset
  // lived in the OTHER read's success path: whichever settled last won. A roster failure
  // that resolved before a slower `listMembers` success had its own warning erased, so
  // every `agent:` member rendered as a raw rosterId with nothing said — the exact defect
  // PRJ-G1 closed, reachable again by ordering alone. Round 1's test could not see it
  // because it mocked both with ALREADY-SETTLED promises, so the callbacks ran in
  // `Promise.all` array order (false, then true) — an ordering the network never
  // guarantees. Two reads, two facts, and the copy now says WHICH one is missing.
  const [orgMembersFailed, setOrgMembersFailed] = useState(false);
  const [rosterFailed, setRosterFailed] = useState(false);
  const directoryFailed = orgMembersFailed || rosterFailed;
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    // PRJ-G1 — these two directory reads are what turn a member REF into a name
    // and populate the add-picker. Swallowed into `[]`, a failure made existing
    // members render as raw ids (`user:abc…`) on the very tab whose job is
    // saying who is on the team, and left an add-picker offering nobody.
    // Each read reports its OWN outcome, and it does so in its OWN handler — so
    // the flag depends on nothing but that read.
    //
    // TWO defects live here, and closing one by hand naturally reopens the other:
    //  - Round 1 used ONE flag for both directory reads with the reset in the
    //    other read's success path, so whichever settled LAST won (PRJ2-B1).
    //  - The first fix for that hoisted both setters to AFTER `await
    //    Promise.all([...])` — which rejects the instant `listProjectMembers`
    //    rejects, so in a correlated outage (one backend, three 503s: by far
    //    the likeliest failure) NEITHER setter ran. The add-picker then offered
    //    nobody with zero disclosure: verbatim PRJ-G1, the defect round 1
    //    existed to close.
    // Per-read handlers satisfy both: no shared flag, and no shared gate.
    const [m, om, r] = await Promise.all([
      listProjectMembers(project.id),
      listMembers(project.orgId)
        .then((x) => { setOrgMembersFailed(false); return x; })
        .catch(() => { setOrgMembersFailed(true); return [] as Awaited<ReturnType<typeof listMembers>>; }),
      listRoster()
        .then((x) => { setRosterFailed(false); return x; })
        .catch(() => { setRosterFailed(true); return [] as Awaited<ReturnType<typeof listRoster>>; }),
    ]);
    setMembersFailed(false);
    setMembers(m.members); setVisibility(m.visibility); setOrgMembers(om); setRoster(r);
  };
  useEffect(() => {
    void load().catch((e) => {
      // PROJ-UX-1 — the localized classification, never the raw dev-string
      // (`listProjectMembers failed (503)`) this used to render in all four locales.
      setError(e instanceof Error ? loadErrorMessage(t, e) : t('membersLoadError'));
        setMembersFailed(true);
    });
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
    // PROJ-UX-1 — localized classification (a 403 reads as the `common:` forbidden
    // sentence, not `addProjectMember failed (403)`).
    catch (e) { setError(e instanceof Error ? loadErrorMessage(t, e) : t('memberActionError')); }
    finally { setBusy(false); }
  };

  /**
   * ADR 0608 D8 (`CPU-1`) — a scope NARROWING now confirms, and a completed one
   * says so.
   *
   * One click on a `variant="primary"` segmented button used to fire the write
   * immediately: no confirm (in a feature that already owns two confirm flows), no
   * success Notice, no `announce` — the only post-state signal was a swapped
   * Lock/Globe glyph. `org` -> `private` removes read access from every org reader
   * who is not a member, across ten tabs.
   *
   * Only the NARROWING direction confirms. Widening back to `org` is the recovery
   * path, and a confirm on the exit is a tax on undoing the scary thing.
   */
  const onSetVisibility = (v: ProjectVisibility): void => {
    void (async () => {
      if (v === 'private' && visibility !== 'private') {
        const ok = await confirm({
          title: t('visibilityConfirmTitle'),
          body: t('visibilityConfirmBody'),
          confirmLabel: t('visibilityConfirmAction'),
        });
        if (!ok) return;
      }
      setOk(null);
      await run(async () => {
        onSaved(await setProjectVisibility(project.id, v));
        setOk(t(v === 'private' ? 'visibilityNowPrivate' : 'visibilityNowOrg'));
      });
    })();
  };

  return (
    <div className="u-flex u-flex-col u-gap-3">
      {/* ADR 0608 D8 (`CPU-10` slice) — these action-errors never announced, while
          siblings in the same file do. `announce` takes the TEXT to speak, not a
          boolean, because `children` is a ReactNode with no reliable text. */}
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      {ok ? <Notice variant="success" announce={ok}>{ok}</Notice> : null}

      {/* ── Visibility ── */}
      <div className="surface-card u-flex u-flex-col u-gap-2">
        <div className="u-flex u-items-center u-justify-between u-gap-3 u-wrap">
          <span className="u-flex u-items-center u-gap-2">
            {visibility === 'private' ? <LockIcon size={15} /> : <GlobeIcon size={15} />}
            <strong className="u-fs-14">{t('visibilityHeading')}</strong>
          </span>
          <div className="segmented" role="group" aria-label={t('visibilityGroupAria')}>
            <Button variant="primary" aria-pressed={visibility === 'org'} disabled={busy || !canWrite} onClick={() => onSetVisibility('org')}>{t('visibilityOrg')}</Button>
            <Button variant="primary" aria-pressed={visibility === 'private'} disabled={busy || !canWrite} onClick={() => onSetVisibility('private')}>{t('visibilityPrivate')}</Button>
          </div>
        </div>
        <p className="muted u-fs-12 u-m-0">
          {/* ADR 0608 D8 (`CPU-1`) — the disclosure enumerates every tab a private
              project governs. CPU-2 CLOSED the last exception: podcast episode reads
              now route through the notebook's `resolveProjectAccess`
              (`podcasts/routes.ts`), so "podcasts" is named in the list like every
              other surface and the standalone caveat that used to state the exception
              is gone (it would now be false in the other direction). */}
          {visibility === 'private' ? t('visibilityPrivateHelp') : t('visibilityOrgHelp')}
          {' '}{t('visibilityEditNote')}
        </p>
      </div>

      {/* ── Add a member (write-gated, ADR 0063) ── */}
      {canWrite ? (
        <div className="surface-card u-flex u-flex-col u-gap-2">
          <span className="proj-eyebrow">{t('addToTeam')}</span>
          <div className="surface-form">
            <SelectField
              label={t('personOrAgentLabel')}
              value={addRef}
              onChange={(e) => setAddRef(e.target.value)}
              {...(directoryFailed ? { error: t('directoryLoadFailed') } : {})}
            >
              <option value="">{directoryFailed ? t('directoryUnavailable') : t('chooseOption')}</option>
              {candidates.map((c) => <option key={c.ref} value={c.ref}>{c.label}</option>)}
            </SelectField>
            <SelectField label={t('roleLabel')} value={addRole} onChange={(e) => setAddRole(e.target.value as ProjectRole)}>
              {ROLES.map((r) => <option key={r} value={r}>{t(ROLE_LABEL_KEYS[r])}</option>)}
            </SelectField>
            <Button variant="primary" disabled={!addRef || busy} onClick={() => void run(async () => { await addProjectMember(project.id, addRef, addRole); setAddRef(''); })}>
              <PlusIcon size={14} /> {t('addMember')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* R2 PRJ2-B1 — the copy said "nobody can be added right now", which is only true
          when the ORG-MEMBER read failed. When just the roster failed the picker still
          offers every person and only agent NAMES are missing — the old sentence
          overstated in one direction while vanishing in the other. */}
      {orgMembersFailed ? <Notice variant="warning" announce={t('directoryNamesFallback')}>{t('directoryNamesFallback')}</Notice> : null}
      {rosterFailed && !orgMembersFailed ? <Notice variant="warning" announce={t('rosterNamesFallback')}>{t('rosterNamesFallback')}</Notice> : null}

      {/* ── Roster ── */}
      {members === null && membersFailed ? (
        // NOT an empty list: the empty state reads "No one's on this project yet"
        // — a MEMBERSHIP claim — and invites adding people who may already be
        // there. Ordered above the loading branch or the spinner wins.
        <StateCard announce icon={<UserIcon size={22} />} title={t('membersLoadFailedTitle')} body={t('membersLoadFailedBody')} />
      ) : members === null ? (
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
                    <Button variant="quiet" size="sm" aria-label={t('removeMemberAria', { name: nameOf(m.ref) })} disabled={busy} onClick={() => void run(() => removeProjectMember(project.id, m.ref))}><TrashIcon size={14} /></Button>
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
