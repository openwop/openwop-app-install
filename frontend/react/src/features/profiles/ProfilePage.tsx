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
import { PageHeader } from '../../ui/PageHeader.js';
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

type ProfileTab = 'profile' | 'board' | 'workflows' | 'schedules' | 'activity' | 'connections';

export function ProfilePage(): JSX.Element {
  // Profiles graduated to always-on (§ Correction 2026-06-12) — no feature gate;
  // the page serves to any signed-in caller. The Connections tab is likewise a
  // permanent surface (ADR 0024 § Correction).
  const [me, setMe] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Deep-link the active tab via `?tab=` — used by the OAuth return path so a
  // connect started from the Connections tab lands back on it.
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<ProfileTab>(() => {
    const t = searchParams.get('tab');
    return t === 'board' || t === 'workflows' || t === 'schedules' || t === 'activity' || t === 'connections' ? t : 'profile';
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
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load your profile.'));
  }, [seed]);

  useEffect(() => {
    load();
  }, [load]);

  // Lazily ensure + resolve the personal board the first time the tab is opened.
  useEffect(() => {
    if (tab !== 'board' || boardId || boardError) return;
    void getPersonalBoard()
      .then((d) => setBoardId(d.board.id))
      .catch((err) => setBoardError(err instanceof Error ? err.message : 'Failed to load your board.'));
  }, [tab, boardId, boardError]);

  const splitList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);

  const saveFields = useCallback(async () => {
    // Validate the numeric field up front so a typo doesn't fail the WHOLE save
    // with a generic backend 400 (it would otherwise reject everything).
    const hoursTrimmed = hours.trim();
    const hoursNum = hoursTrimmed ? Number(hoursTrimmed) : undefined;
    if (hoursNum !== undefined && (!Number.isFinite(hoursNum) || hoursNum < 0 || hoursNum > 168)) {
      toast.error('Hours / week must be a number between 0 and 168.');
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
      toast.success('Profile saved.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSavingFields(false);
    }
  }, [displayName, me, jobTitle, department, bio, equipment, interests, timezone, hours, status, seed]);

  const saveSkills = useCallback(async () => {
    setSavingSkills(true);
    try {
      const clean = skills.filter((s) => s.name.trim().length > 0).map((s) => ({ name: s.name.trim(), proficiency: s.proficiency }));
      const updated = await setMySkills(clean);
      seed(updated);
      toast.success('Skills saved.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Saving skills failed.');
    } finally {
      setSavingSkills(false);
    }
  }, [skills, seed]);

  const onPickAvatar = useCallback(async (file: File) => {
    try {
      if (!file.type.startsWith('image/')) throw new Error('Avatar must be an image.');
      const token = await uploadImage(file);
      seed(await setAvatar(token));
      toast.success('Avatar updated.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Avatar upload failed.');
    }
  }, [seed]);

  const removeAvatar = useCallback(async () => {
    try {
      seed(await clearAvatar());
      toast.info('Avatar removed.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove avatar.');
    }
  }, [seed]);

  const tabs: { key: ProfileTab; label: string }[] = [
    { key: 'profile', label: 'Profile' },
    { key: 'board', label: 'My Board' },
    { key: 'workflows', label: 'Assigned workflows' },
    { key: 'schedules', label: 'Schedules' },
    { key: 'activity', label: 'Activity' },
    { key: 'connections', label: 'Connections' },
  ];

  return (
    <div>
      <PageHeader eyebrow="Platform" title="My Profile" lede="Your self-service profile. Visible to your team in the directory." />

      {error ? <Notice variant="error">{error}</Notice> : null}

      {!me ? (
        !error ? <Skeleton /> : null
      ) : (
        <>
          {/* Tabs — the canonical editorial tab strip (DESIGN.md §5 `.tabs`/`.tab`),
              mirroring the agent profile (ADR 0025 user/agent symmetry). */}
          <div className="tabs u-mb-4 u-wrap" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                className="tab"
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'profile' ? (
            <div className="u-grid u-gap-4">
              {/* Identity + completeness */}
              <div className="surface-card">
                <div className="u-flex u-gap-4 u-items-center u-wrap">
                  <div className="profile-avatar">
                    {me.avatarAssetToken ? (
                      <img src={assetUrl(me.avatarAssetToken)} alt="avatar" className="profile-avatar-img" />
                    ) : (
                      <UserIcon />
                    )}
                  </div>
                  <div className="profile-identity-col">
                    <div className="u-flex u-gap-2 u-items-center u-wrap">
                      <strong className="profile-name">{me.displayName ?? 'You'}</strong>
                      {me.emailVerified === true ? (
                        <span className="chip chip--success"><CheckIcon /> Verified</span>
                      ) : me.emailVerified === false ? (
                        <span className="chip">Email unverified</span>
                      ) : null}
                    </div>
                    <span className="u-label-sm">Profile completeness: {me.completeness}%</span>
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
                      <ImageIcon /> Upload
                    </button>
                    {me.avatarAssetToken ? (
                      <button type="button" className="btn-ghost" onClick={() => void removeAvatar()}>
                        <TrashIcon /> Remove
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Descriptive fields */}
              <div className="surface-card u-gap-3">
                <strong>Details</strong>
                <label className="u-grid u-gap-1">
                  <span className="u-label-sm">Your name</span>
                  <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Jordan Rivera" autoComplete="name" />
                </label>
                <div className="profile-grid-220">
                  <label className="u-grid u-gap-1">
                    <span className="u-label-sm">Job title</span>
                    <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="Staff Engineer" />
                  </label>
                  <label className="u-grid u-gap-1">
                    <span className="u-label-sm">Department</span>
                    <input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Platform" />
                  </label>
                </div>
                <label className="u-grid u-gap-1">
                  <span className="u-label-sm">Bio</span>
                  <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} placeholder="A short bio…" />
                </label>
                <label className="u-grid u-gap-1">
                  <span className="u-label-sm">Equipment (comma-separated)</span>
                  <input value={equipment} onChange={(e) => setEquipment(e.target.value)} placeholder="laptop, camera" />
                </label>
                <label className="u-grid u-gap-1">
                  <span className="u-label-sm">Interests (comma-separated)</span>
                  <input value={interests} onChange={(e) => setInterests(e.target.value)} placeholder="protocols, distributed systems" />
                </label>
                <div className="profile-grid-160">
                  <label className="u-grid u-gap-1">
                    <span className="u-label-sm">Timezone</span>
                    <input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/New_York" />
                  </label>
                  <label className="u-grid u-gap-1">
                    <span className="u-label-sm">Hours / week</span>
                    <input value={hours} onChange={(e) => setHours(e.target.value)} inputMode="numeric" placeholder="40" />
                  </label>
                  <label className="u-grid u-gap-1">
                    <span className="u-label-sm">Availability</span>
                    <select value={status} onChange={(e) => setStatus(e.target.value as AvailabilityStatus | '')}>
                      <option value="">—</option>
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="action-bar">
                  <button type="button" className="btn-primary" disabled={savingFields} onClick={() => void saveFields()}>
                    <SaveIcon /> Save details
                  </button>
                </div>
              </div>

              {/* Skills */}
              <div className="surface-card u-gap-3">
                <strong>Skills</strong>
                <span className="u-label-sm">Endorsements from teammates are preserved when you edit a skill you keep.</span>
                <div className="u-grid u-gap-2">
                  {skills.map((s, i) => {
                    const endorsed = me.skills.find((x) => x.name.toLowerCase() === s.name.trim().toLowerCase())?.endorsements.length ?? 0;
                    return (
                      <div key={i} className="u-flex u-gap-2 u-items-center u-wrap">
                        <input
                          value={s.name}
                          onChange={(e) => setSkills((cur) => cur.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                          placeholder="Skill"
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
                        {endorsed > 0 ? <span className="chip chip--accent">{endorsed} endorsed</span> : null}
                        <button type="button" className="btn-ghost" onClick={() => setSkills((cur) => cur.filter((_, j) => j !== i))}>
                          <TrashIcon />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="action-bar">
                  <button type="button" className="btn-ghost" onClick={() => setSkills((cur) => [...cur, { name: '', proficiency: 3 }])}>
                    <PlusIcon /> Add skill
                  </button>
                  <button type="button" className="btn-primary" disabled={savingSkills} onClick={() => void saveSkills()}>
                    <SaveIcon /> Save skills
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
                  persona={me.displayName ?? 'You'}
                  refreshSignal={boardRefresh}
                  intro={
                    <p className="muted u-fs-12 u-m-0">
                      <strong>Your board.</strong> New work arrives in <strong>To Do</strong>. <strong>Drag a card</strong> between
                      lanes to move it along — dropping a card into a trigger lane runs its workflow on your behalf.
                    </p>
                  }
                />
              ) : (
                <p className="muted">Loading your board…</p>
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
        </>
      )}
    </div>
  );
}
