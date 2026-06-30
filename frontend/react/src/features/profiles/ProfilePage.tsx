/**
 * My Profile (host-extension product feature — ADR 0005 / ADR 0025). The
 * signed-in user's orchestration home, mirroring the agent profile's tabs:
 *   - Profile     — identity + email-verified badge, completeness meter, avatar
 *                   upload (media surface), descriptive fields, skills editor.
 *   - My Board    — the human's auto-provisioned personal kanban board (ADR
 *                   0025), the SAME panel a roster agent uses — a human is a
 *                   board-owning orchestration principal on the same rails.
 *   - Connections — per-user external-app credentials (ADR 0024), always shown
 *                   (Connections graduated off its toggle to a permanent surface,
 *                   ADR 0024 § Correction).
 * Always-on: profiles graduated off its feature toggle (§ Correction
 * 2026-06-12) — agent pinning + the per-user surfaces ride on it, so it is
 * permanent substrate. No `useFeatureAccess` gate; the backend serves the
 * surface unconditionally to any signed-in caller.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Tabs, TabPanel } from '../../ui/Tabs.js';
import { Notice } from '../../ui/Notice.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { CheckIcon, ImageIcon, PlusIcon, SaveIcon, TrashIcon, UserIcon } from '../../ui/icons/index.js';
import { AgentBoardPanel } from '../../agents/AgentBoardPanel.js';
import { getPersonalBoard } from '../../kanban/kanbanClient.js';
import { ConnectionsManager } from '../connections/ConnectionsManager.js';
import { useOAuthCallbackToast } from '../connections/useOAuthCallback.js';
import { ProfileWorkflowsTab } from './ProfileWorkflowsTab.js';
import { ProfileSchedulesTab } from './ProfileSchedulesTab.js';
import { ProfileActivityTab } from './ProfileActivityTab.js';
import { ProfileMemoryTab } from '../profile-memory/ProfileMemoryTab.js';
import { ProfileKnowledgeTab } from '../profile-memory/ProfileKnowledgeTab.js';
import { ProfileTwinGrantsTab } from '../twin/ProfileTwinGrantsTab.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { ApprovalsInbox } from '../../notifications/ApprovalsInbox.js';
import {
  assetUrl,
  clearAvatar,
  getMyProfile,
  setAvatar,
  setMySkills,
  updateMyProfile,
  uploadImage,
  type AvailabilityStatus,
  type Profile,
} from './profilesClient.js';
import { updateMyDisplayName } from '../users/usersClient.js';

const STATUSES: AvailabilityStatus[] = ['available', 'busy', 'away'];

const AVAILABILITY_OPTION_KEY = {
  available: 'availabilityAvailable',
  busy: 'availabilityBusy',
  away: 'availabilityAway',
} as const;

type ProfileTab = 'profile' | 'board' | 'workflows' | 'schedules' | 'activity' | 'connections' | 'memory' | 'knowledge' | 'twin';

export function ProfilePage(): JSX.Element {
  const { t } = useTranslation('profiles');
  const f = useFormat();
  // Profiles graduated to always-on (§ Correction 2026-06-12) — no feature gate;
  // the page serves to any signed-in caller. The Connections tab is likewise a
  // permanent surface (ADR 0024 § Correction).
  const [me, setMe] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ADR 0044 Phase 3 — the "Who can recall my memory" tab is shown only when the
  // `twin-recall` toggle is on (the whole twin surface is opt-in per tenant).
  const twinAccess = useFeatureAccess('twin-recall');
  // Deep-link the active tab via `?tab=` — used by the OAuth return path so a
  // connect started from the Connections tab lands back on it.
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<ProfileTab>(() => {
    const t = searchParams.get('tab');
    return t === 'board' || t === 'workflows' || t === 'schedules' || t === 'activity' || t === 'connections' || t === 'memory' || t === 'knowledge' || t === 'twin' ? t : 'profile';
  });
  // Surface + strip the OAuth callback params after returning from consent.
  useOAuthCallbackToast();

  // ADR 0025 — the caller's personal board ("My Board"). Loaded lazily the first
  // time the board tab is opened (keeps the profile's initial load off the
  // per-IP read budget). The server ensures + returns it, so the human is a
  // board-owning orchestration principal exactly like a roster agent.
  const [boardId, setBoardId] = useState<string | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  // Bumped when a "Waiting on me" approval is resolved, so the board re-fetches
  // (an approval may have started a run / moved a card).
  const [boardRefresh, setBoardRefresh] = useState(0);

  // Form state (seeded from the loaded profile).
  const [displayName, setDisplayName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [department, setDepartment] = useState('');
  const [bio, setBio] = useState('');
  const [equipment, setEquipment] = useState('');
  const [interests, setInterests] = useState('');
  const [timezone, setTimezone] = useState('');
  const [hours, setHours] = useState('');
  const [status, setStatus] = useState<AvailabilityStatus | ''>('');
  const [skills, setSkills] = useState<{ name: string; proficiency: number }[]>([]);
  const [savingFields, setSavingFields] = useState(false);
  const [savingSkills, setSavingSkills] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const seed = useCallback((p: Profile) => {
    setMe(p);
    setDisplayName(p.displayName ?? '');
    setJobTitle(p.jobTitle ?? '');
    setDepartment(p.department ?? '');
    setBio(p.bio ?? '');
    setEquipment(p.equipment.join(', '));
    setInterests(p.interests.join(', '));
    setTimezone(p.availability?.timezone ?? '');
    setHours(p.availability?.hoursPerWeek !== undefined ? String(p.availability.hoursPerWeek) : '');
    setStatus(p.availability?.status ?? '');
    setSkills(p.skills.map((s) => ({ name: s.name, proficiency: s.proficiency })));
  }, []);

  const load = useCallback(() => {
    setError(null);
    void getMyProfile()
      .then(seed)
      .catch((err) => setError(err instanceof Error ? err.message : t('loadProfileFailed')));
  }, [seed, t]);

  useEffect(() => {
    load();
  }, [load]);

  // Lazily ensure + resolve the personal board the first time the tab is opened.
  useEffect(() => {
    if (tab !== 'board' || boardId || boardError) return;
    void getPersonalBoard()
      .then((d) => setBoardId(d.board.id))
      .catch((err) => setBoardError(err instanceof Error ? err.message : t('loadBoardFailed')));
  }, [tab, boardId, boardError, t]);

  const splitList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);

  const saveFields = useCallback(async () => {
    // Validate the numeric field up front so a typo doesn't fail the WHOLE save
    // with a generic backend 400 (it would otherwise reject everything).
    const hoursTrimmed = hours.trim();
    const hoursNum = hoursTrimmed ? Number(hoursTrimmed) : undefined;
    if (hoursNum !== undefined && (!Number.isFinite(hoursNum) || hoursNum < 0 || hoursNum > 168)) {
      toast.error(t('hoursRangeError'));
      return;
    }
    setSavingFields(true);
    try {
      // Display name lives on the User (identity), not the descriptive profile —
      // PATCH it first so the profile re-read below surfaces the new name.
      const nameTrimmed = displayName.trim();
      if (nameTrimmed !== (me?.displayName ?? '')) {
        await updateMyDisplayName(nameTrimmed);
      }
      const availabilitySet = timezone.trim() || hoursTrimmed || status;
      const updated = await updateMyProfile({
        jobTitle: jobTitle.trim() || null,
        department: department.trim() || null,
        bio: bio.trim() || null,
        equipment: splitList(equipment),
        interests: splitList(interests),
        availability: availabilitySet
          ? {
              ...(timezone.trim() ? { timezone: timezone.trim() } : {}),
              ...(hoursNum !== undefined ? { hoursPerWeek: hoursNum } : {}),
              ...(status ? { status } : {}),
            }
          : null,
      });
      seed(updated);
      toast.success(t('profileSaved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSavingFields(false);
    }
  }, [displayName, me, jobTitle, department, bio, equipment, interests, timezone, hours, status, seed, t]);

  const saveSkills = useCallback(async () => {
    setSavingSkills(true);
    try {
      const clean = skills.filter((s) => s.name.trim().length > 0).map((s) => ({ name: s.name.trim(), proficiency: s.proficiency }));
      const updated = await setMySkills(clean);
      seed(updated);
      toast.success(t('skillsSaved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveSkillsFailed'));
    } finally {
      setSavingSkills(false);
    }
  }, [skills, seed, t]);

  const onPickAvatar = useCallback(async (file: File) => {
    try {
      if (!file.type.startsWith('image/')) throw new Error(t('avatarMustBeImage'));
      const token = await uploadImage(file);
      seed(await setAvatar(token));
      toast.success(t('avatarUpdated'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('avatarUploadFailed'));
    }
  }, [seed, t]);

  const removeAvatar = useCallback(async () => {
    try {
      seed(await clearAvatar());
      toast.info(t('avatarRemoved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('avatarRemoveFailed'));
    }
  }, [seed, t]);

  const tabs: { key: ProfileTab; label: string }[] = [
    { key: 'profile', label: t('tabProfile') },
    { key: 'board', label: t('tabBoard') },
    { key: 'workflows', label: t('tabWorkflows') },
    { key: 'schedules', label: t('tabSchedules') },
    { key: 'activity', label: t('tabActivity') },
    { key: 'connections', label: t('tabConnections') },
    { key: 'memory', label: t('tabMemory') },
    { key: 'knowledge', label: t('tabKnowledge') },
    ...(twinAccess.enabled ? [{ key: 'twin' as ProfileTab, label: t('tabTwin') }] : []),
  ];

  return (
    <div>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />

      {error ? <Notice variant="error">{error}</Notice> : null}

      {!me ? (
        !error ? <Skeleton /> : null
      ) : (
        <>
          {/* Tabs — the canonical editorial tab strip (DESIGN.md §5 `.tabs`/`.tab`),
              mirroring the agent profile (ADR 0025 user/agent symmetry). */}
          <Tabs
            items={tabs.map((tb) => ({ id: tb.key, label: tb.label }))}
            value={tab}
            onChange={(id) => setTab(id as ProfileTab)}
            idBase="profile"
            className="u-mb-4 u-wrap"
          />

          <TabPanel idBase="profile" tabId={tab}>
          {tab === 'profile' ? (
            <div className="u-grid u-gap-4">
              {/* Identity + completeness */}
              <div className="surface-card">
                <div className="u-flex u-gap-4 u-items-center u-wrap">
                  <div className="profile-avatar">
                    {me.avatarAssetToken ? (
                      <img src={assetUrl(me.avatarAssetToken)} alt={t('avatarAlt')} className="profile-avatar-img" />
                    ) : (
                      <UserIcon />
                    )}
                  </div>
                  <div className="profile-identity-col">
                    <div className="u-flex u-gap-2 u-items-center u-wrap">
                      <strong className="profile-name">{me.displayName ?? t('youFallback')}</strong>
                      {me.emailVerified === true ? (
                        <span className="chip chip--success"><CheckIcon /> {t('verified')}</span>
                      ) : me.emailVerified === false ? (
                        <span className="chip">{t('emailUnverified')}</span>
                      ) : null}
                    </div>
                    <span className="u-label-sm">{t('completenessLabel', { percent: f.percent(me.completeness / 100) })}</span>
                    <div className="profile-meter-track">
                      <div className="profile-meter-fill" style={{ width: `${me.completeness}%` }} />
                    </div>
                  </div>
                  <div className="action-bar u-flex-auto">
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      className="u-hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void onPickAvatar(f);
                        e.target.value = '';
                      }}
                    />
                    <button type="button" className="btn-ghost" onClick={() => fileRef.current?.click()}>
                      <ImageIcon /> {t('upload')}
                    </button>
                    {me.avatarAssetToken ? (
                      <button type="button" className="btn-ghost" onClick={() => void removeAvatar()}>
                        <TrashIcon /> {t('common:remove')}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Descriptive fields */}
              <div className="surface-card u-gap-3">
                <h2 className="u-fs-16 u-m-0">{t('details')}</h2>
                <label className="u-grid u-gap-1">
                  <span className="u-label-sm">{t('yourName')}</span>
                  <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={t('yourNamePlaceholder')} autoComplete="name" />
                </label>
                <div className="profile-grid-220">
                  <label className="u-grid u-gap-1">
                    <span className="u-label-sm">{t('jobTitleLabel')}</span>
                    <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder={t('jobTitlePlaceholder')} />
                  </label>
                  <label className="u-grid u-gap-1">
                    <span className="u-label-sm">{t('departmentLabel')}</span>
                    <input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder={t('departmentPlaceholder')} />
                  </label>
                </div>
                <label className="u-grid u-gap-1">
                  <span className="u-label-sm">{t('bioLabel')}</span>
                  <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} placeholder={t('bioPlaceholder')} />
                </label>
                <label className="u-grid u-gap-1">
                  <span className="u-label-sm">{t('equipmentLabel')}</span>
                  <input value={equipment} onChange={(e) => setEquipment(e.target.value)} placeholder={t('equipmentPlaceholder')} />
                </label>
                <label className="u-grid u-gap-1">
                  <span className="u-label-sm">{t('interestsLabel')}</span>
                  <input value={interests} onChange={(e) => setInterests(e.target.value)} placeholder={t('interestsPlaceholder')} />
                </label>
                <div className="profile-grid-160">
                  <label className="u-grid u-gap-1">
                    <span className="u-label-sm">{t('timezoneLabel')}</span>
                    <input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder={t('timezonePlaceholder')} />
                  </label>
                  <label className="u-grid u-gap-1">
                    <span className="u-label-sm">{t('hoursLabel')}</span>
                    <input value={hours} onChange={(e) => setHours(e.target.value)} inputMode="numeric" placeholder={t('hoursPlaceholder')} />
                  </label>
                  <label className="u-grid u-gap-1">
                    <span className="u-label-sm">{t('availabilityLabel')}</span>
                    <select value={status} onChange={(e) => setStatus(e.target.value as AvailabilityStatus | '')}>
                      <option value="">{t('availabilityNone')}</option>
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>{t(AVAILABILITY_OPTION_KEY[s])}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="action-bar">
                  <button type="button" className="btn-primary" disabled={savingFields} onClick={() => void saveFields()}>
                    <SaveIcon /> {t('saveDetails')}
                  </button>
                </div>
              </div>

              {/* Skills */}
              <div className="surface-card u-gap-3">
                <h2 className="u-fs-16 u-m-0">{t('skills')}</h2>
                <span className="u-label-sm">{t('skillsHint')}</span>
                <div className="u-grid u-gap-2">
                  {skills.map((s, i) => {
                    const endorsed = me.skills.find((x) => x.name.toLowerCase() === s.name.trim().toLowerCase())?.endorsements.length ?? 0;
                    return (
                      <div key={i} className="u-flex u-gap-2 u-items-center u-wrap">
                        <input
                          value={s.name}
                          onChange={(e) => setSkills((cur) => cur.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                          placeholder={t('skillPlaceholder')}
                          className="profile-skill-input"
                        />
                        <select
                          value={s.proficiency}
                          onChange={(e) => setSkills((cur) => cur.map((x, j) => (j === i ? { ...x, proficiency: Number(e.target.value) } : x)))}
                          className="u-w-auto"
                        >
                          {[1, 2, 3, 4, 5].map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                        {endorsed > 0 ? <span className="chip chip--accent">{t('endorsedCount', { count: endorsed })}</span> : null}
                        <button type="button" className="btn-ghost" aria-label={t('removeSkillLabel', { name: s.name || t('skills') })} onClick={() => setSkills((cur) => cur.filter((_, j) => j !== i))}>
                          <TrashIcon />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="action-bar">
                  <button type="button" className="btn-ghost" onClick={() => setSkills((cur) => [...cur, { name: '', proficiency: 3 }])}>
                    <PlusIcon /> {t('addSkill')}
                  </button>
                  <button type="button" className="btn-primary" disabled={savingSkills} onClick={() => void saveSkills()}>
                    <SaveIcon /> {t('saveSkills')}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {tab === 'board' ? (
            <div className="u-grid u-gap-4">
              {/* ADR 0025 §4 "Waiting on me" — the human's approval queue, the
                  same review-mode pending-approval inbox an agent's proposals
                  route through. Approving starts the proposed run. */}
              <ApprovalsInbox onResolved={() => setBoardRefresh((n) => n + 1)} />
              {boardError ? (
                <Notice variant="error">{boardError}</Notice>
              ) : boardId ? (
                <AgentBoardPanel
                  boardId={boardId}
                  persona={me.displayName ?? t('youFallback')}
                  refreshSignal={boardRefresh}
                  intro={
                    <p className="muted u-fs-12 u-m-0">
                      <Trans
                        t={t}
                        i18nKey="boardIntro"
                        components={{ 0: <strong />, 1: <strong />, 2: <strong /> }}
                      />
                    </p>
                  }
                />
              ) : (
                <p className="muted">{t('loadingBoard')}</p>
              )}
            </div>
          ) : null}

          {tab === 'workflows' ? (
            <ProfileWorkflowsTab workflows={me.workflows ?? []} onSaved={seed} />
          ) : null}

          {tab === 'schedules' ? <ProfileSchedulesTab workflows={me.workflows ?? []} /> : null}

          {tab === 'activity' ? <ProfileActivityTab /> : null}

          {tab === 'connections' ? (
            <ConnectionsManager returnPath="/profile?tab=connections" />
          ) : null}

          {tab === 'memory' ? <ProfileMemoryTab /> : null}

          {tab === 'knowledge' ? <ProfileKnowledgeTab /> : null}

          {tab === 'twin' && twinAccess.enabled ? <ProfileTwinGrantsTab /> : null}
          </TabPanel>
        </>
      )}
    </div>
  );
}
