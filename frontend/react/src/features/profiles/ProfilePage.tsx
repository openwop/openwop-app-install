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
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Tabs, TabPanel, useUrlTab } from '../../ui/Tabs.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { StateCard } from '../../ui/StateCard.js';
import { SelectField, TextareaField, TextField } from '../../ui/Field.js';
import { useUnsavedChangesWarning } from '../../ui/useUnsavedChangesWarning.js';
import { toast } from '../../ui/toast.js';
import { MAX_UPLOAD_MB, withinUploadCap } from '../../client/fileToBase64.js';
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
import { useAllFeatureAccess, useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { ApprovalsInbox } from '../../notifications/ApprovalsInbox.js';
import {
  addPortfolio,
  assetUrl,
  clearAvatar,
  getMyProfile,
  removePortfolio,
  setAvatar,
  setMySkills,
  updateMyProfile,
  uploadImage,
  type AvailabilityStatus,
  type CompletenessFieldId,
  type Profile,
} from './profilesClient.js';
import { updateMyDisplayName } from '../users/usersClient.js';

const STATUSES: AvailabilityStatus[] = ['available', 'busy', 'away'];

const AVAILABILITY_OPTION_KEY = {
  available: 'availabilityAvailable',
  busy: 'availabilityBusy',
  away: 'availabilityAway',
} as const;

/** PROF-UX-2 — the 1–5 proficiency scale, named (what "3" claims to teammates). */
const PROFICIENCY_LEVEL_KEY = {
  1: 'proficiencyLevel1',
  2: 'proficiencyLevel2',
  3: 'proficiencyLevel3',
  4: 'proficiencyLevel4',
  5: 'proficiencyLevel5',
} as const;

/**
 * PROF-UX-14 — `completenessMissing[].field` (ADR 0624 D4; one of the NINE ids
 * in the backend's weights table, mirrored as `COMPLETENESS_FIELD_IDS`) → the
 * label this page already uses for that field. Typed against the id union so a
 * contract change is a compile error here, not a raw id in the caption. The
 * form labels are reused where they read well in a sentence; `equipment` /
 * `interests` carry "(comma-separated)" as form hints, so the caption uses the
 * bare nouns (`fieldEquipment` / `fieldInterests`).
 */
export const COMPLETENESS_FIELD_KEY: Record<CompletenessFieldId, string> = {
  avatar: 'fieldAvatar',
  bio: 'bioLabel',
  skills: 'skills',
  jobTitle: 'jobTitleLabel',
  department: 'departmentLabel',
  availability: 'availabilityLabel',
  interests: 'fieldInterests',
  portfolio: 'portfolioTitle',
  equipment: 'fieldEquipment',
};

/** The caption label for a missing-field id. LAST-RESORT fallback only: an id a
 *  NEWER backend adds ahead of this SPA renders as itself rather than being
 *  dropped (an honest raw id beats a silently shorter list); every id in the
 *  current contract resolves through the map above. */
function completenessFieldLabel(field: string, t: (key: string) => string): string {
  const key = (COMPLETENESS_FIELD_KEY as Record<string, string | undefined>)[field];
  return key ? t(key) : field;
}

/** PROF-UX-18 — a skill row keyed by a STABLE id (never the array index), so a
 *  removal does not re-key its neighbours and "the row just added" is addressable
 *  for focus. */
interface SkillRow { id: number; name: string; proficiency: number }

/** PROF-UX-19 — the details + skills form state as ONE comparable string, so
 *  "dirty" is a comparison against the seeded snapshot, not a per-field flag. */
function formSnapshot(f: {
  displayName: string; preferredName: string; jobTitle: string; department: string; bio: string;
  equipment: string; interests: string; timezone: string; hours: string; status: string;
  skills: readonly SkillRow[];
}): string {
  return JSON.stringify([
    f.displayName, f.preferredName, f.jobTitle, f.department, f.bio, f.equipment, f.interests,
    f.timezone, f.hours, f.status, f.skills.map((s) => [s.name, s.proficiency]),
  ]);
}

type ProfileTab = 'profile' | 'board' | 'workflows' | 'schedules' | 'activity' | 'connections' | 'memory' | 'knowledge' | 'twin';
const PROFILE_TABS: readonly ProfileTab[] = ['profile', 'board', 'workflows', 'schedules', 'activity', 'connections', 'memory', 'knowledge', 'twin'];

/**
 * TWIN-UX-1 — the ONE list that decides whether a tab exists.
 *
 * `PROFILE_TABS` (what `useUrlTab` will ACCEPT from `?tab=`) and `tabs` (what the
 * strip RENDERS) were two independent lists, and `tabs` alone dropped `twin` when
 * the toggle read false. `?tab=twin` therefore left `tab === 'twin'` with no
 * matching tab, which is three simultaneous defects, not one:
 *   - `ui/Tabs.tsx:65` gives every tab `tabIndex={-1}` when none is selected — a
 *     roving-tabindex tablist with NO tabbable member (WCAG 2.1.1);
 *   - `<TabPanel>` emits `aria-labelledby` pointing at an element that does not
 *     exist (`ui/Tabs.tsx:90`);
 *   - every panel conditional is false, so the region renders EMPTY.
 * Deriving the accepted set FROM the rendered set makes the mismatch unwritable.
 */
function visibleProfileTabs(twinVisible: boolean): readonly ProfileTab[] {
  return PROFILE_TABS.filter((k) => k !== 'twin' || twinVisible);
}

export function ProfilePage(): JSX.Element {
  const { t } = useTranslation('profiles');
  const f = useFormat();
  // Profiles graduated to always-on (§ Correction 2026-06-12) — no feature gate;
  // the page serves to any signed-in caller. The Connections tab is likewise a
  // permanent surface (ADR 0024 § Correction).
  const [me, setMe] = useState<Profile | null>(null);
  /** The profile read FAILED — distinct from "still loading" (PROF-UX-3). */
  const [loadFailed, setLoadFailed] = useState(false);
  // ADR 0044 Phase 3 — the "Who can recall my memory" tab is shown only when the
  // `twin-recall` toggle is on (the whole twin surface is opt-in per tenant).
  const twinAccess = useFeatureAccess('twin-recall');
  // TWIN-UX-1 (failed-read leg) — the retry on the twin tab's "couldn't check"
  // state re-resolves assignments through the context's ONE reload path.
  const { reload: reloadFeatureAccess } = useAllFeatureAccess();
  // PROF-UX-5 — the active tab is BOUND to `?tab=` (read-write, replaceState via
  // `useUrlTab`), so refresh/share/back keep the tab; the OAuth return path rides
  // the same param.
  // The Twin tab is RENDERED while the toggle is resolving as well as when it is
  // on. `useFeatureAccess` returns `{enabled:false}` for anything it has not
  // resolved yet — which is true transiently on EVERY page load — so gating on
  // `enabled` alone made a consent dashboard disappear without a word. That is
  // the exact reasoning `ProfileMemoryTab.tsx:72-88` writes down for its sibling
  // control. `resolutionFailed` keeps the tab present after a FAILED assignments
  // fetch too (TWIN-UX-1's third leg): a failed read is "unknown", not "off", and
  // without it `?tab=twin` silently bounced to the profile tab.
  const twinVisible = twinAccess.enabled || twinAccess.loading || twinAccess.resolutionFailed;
  const twinTabs = visibleProfileTabs(twinVisible);
  const [tab, setTab] = useUrlTab<ProfileTab>('tab', twinTabs, 'profile');
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
  const [preferredName, setPreferredName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [department, setDepartment] = useState('');
  const [bio, setBio] = useState('');
  const [equipment, setEquipment] = useState('');
  const [interests, setInterests] = useState('');
  const [timezone, setTimezone] = useState('');
  const [hours, setHours] = useState('');
  const [status, setStatus] = useState<AvailabilityStatus | ''>('');
  const [skills, setSkills] = useState<SkillRow[]>([]);
  // PROF-UX-12 — the hours-range error is a FIELD error (aria-invalid +
  // aria-describedby + focus), not a toast the user has to map back to a field.
  const [hoursError, setHoursError] = useState<string | null>(null);
  const hoursRef = useRef<HTMLInputElement | null>(null);
  // PROF-UX-18 — stable row ids + "focus the row just added".
  const nextSkillId = useRef(0);
  const [focusSkillId, setFocusSkillId] = useState<number | null>(null);
  const skillInputRefs = useRef(new Map<number, HTMLInputElement>());
  // PROF-UX-19 — the snapshot the form was seeded from; dirty = differs from it.
  const [seededSnapshot, setSeededSnapshot] = useState('');
  const [savingFields, setSavingFields] = useState(false);
  const [savingSkills, setSavingSkills] = useState(false);
  // PROF-UX-6 — the avatar upload spans two requests; disable + announce busy so
  // a slow network can't double-fire it.
  const [avatarBusy, setAvatarBusy] = useState(false);
  // PROF-1 (render honesty) — a stored token whose asset is GONE renders the
  // empty-avatar state, never a broken <img>. Keyed by token so a fresh upload
  // clears the flag.
  const [brokenAvatarToken, setBrokenAvatarToken] = useState<string | null>(null);
  // PROF-UX-4 — portfolio add/remove busy + dead-image tracking.
  const [portfolioBusy, setPortfolioBusy] = useState(false);
  const [deadPortfolioTokens, setDeadPortfolioTokens] = useState<ReadonlySet<string>>(new Set());
  const fileRef = useRef<HTMLInputElement | null>(null);
  const portfolioFileRef = useRef<HTMLInputElement | null>(null);

  const seed = useCallback((p: Profile) => {
    setMe(p);
    setDisplayName(p.displayName ?? '');
    setPreferredName(p.preferredName ?? '');
    setJobTitle(p.jobTitle ?? '');
    setDepartment(p.department ?? '');
    setBio(p.bio ?? '');
    setEquipment(p.equipment.join(', '));
    setInterests(p.interests.join(', '));
    setTimezone(p.availability?.timezone ?? '');
    const hoursStr = p.availability?.hoursPerWeek !== undefined ? String(p.availability.hoursPerWeek) : '';
    setHours(hoursStr);
    setHoursError(null);
    setStatus(p.availability?.status ?? '');
    const rows: SkillRow[] = p.skills.map((s) => ({ id: nextSkillId.current++, name: s.name, proficiency: s.proficiency }));
    setSkills(rows);
    setSeededSnapshot(formSnapshot({
      displayName: p.displayName ?? '', preferredName: p.preferredName ?? '', jobTitle: p.jobTitle ?? '',
      department: p.department ?? '', bio: p.bio ?? '', equipment: p.equipment.join(', '),
      interests: p.interests.join(', '), timezone: p.availability?.timezone ?? '', hours: hoursStr,
      status: p.availability?.status ?? '', skills: rows,
    }));
  }, []);

  // PROF-UX-19 — tab-close / reload with unsaved edits gets the native "Leave
  // site?" prompt (the ui/ hook; in-app links are not blocked — see its docblock).
  const dirty = me !== null && formSnapshot({
    displayName, preferredName, jobTitle, department, bio, equipment, interests, timezone, hours, status, skills,
  }) !== seededSnapshot;
  useUnsavedChangesWarning(dirty);

  // PROF-UX-18 — after "Add skill", focus lands in the new row's name input (its
  // accessible name "Skill name" is what gets announced — no separate live text).
  useEffect(() => {
    if (focusSkillId === null) return;
    skillInputRefs.current.get(focusSkillId)?.focus();
    setFocusSkillId(null);
  }, [focusSkillId, skills]);

  const load = useCallback(() => {
    setLoadFailed(false);
    void getMyProfile()
      .then(seed)
      // PROF-UX-3 — no raw err.message on the page; the designed failed-read
      // state below (announced StateCard + retry) carries the honest copy.
      .catch(() => setLoadFailed(true));
  }, [seed]);

  useEffect(() => {
    load();
  }, [load]);

  // Lazily ensure + resolve the personal board the first time the tab is opened.
  useEffect(() => {
    if (tab !== 'board' || boardId || boardError) return;
    void getPersonalBoard()
      .then((d) => setBoardId(d.board.id))
      // PROF-UX-3 — a failure FLAG, not raw err.message; the StateCard below
      // renders the designed copy + retry (clearing the flag re-runs this effect).
      .catch(() => setBoardError('failed'));
  }, [tab, boardId, boardError]);

  const splitList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);

  const saveFields = useCallback(async () => {
    // Validate the numeric field up front so a typo doesn't fail the WHOLE save
    // with a generic backend 400 (it would otherwise reject everything).
    const hoursTrimmed = hours.trim();
    const hoursNum = hoursTrimmed ? Number(hoursTrimmed) : undefined;
    if (hoursNum !== undefined && (!Number.isFinite(hoursNum) || hoursNum < 0 || hoursNum > 168)) {
      // PROF-UX-12 — attached to the field (aria-invalid + aria-describedby via
      // `TextField error`) and focus moves there, so the user learns WHICH field
      // failed. Not a toast: one mechanism per message.
      setHoursError(t('hoursRangeError'));
      hoursRef.current?.focus();
      return;
    }
    setHoursError(null);
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
        preferredName: preferredName.trim() || null,
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
  }, [displayName, preferredName, me, jobTitle, department, bio, equipment, interests, timezone, hours, status, seed, t]);

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
    setAvatarBusy(true);
    try {
      if (!file.type.startsWith('image/')) throw new Error(t('avatarMustBeImage'));
      // PROF-UX-13 (same class as the portfolio path) — refuse an oversize file
      // HERE, localized, instead of base64-inflating it and surfacing the
      // server's English 413 prose. See `onAddPortfolio` for the limit's provenance.
      if (!withinUploadCap(file)) throw new Error(t('imageTooLarge', { mib: MAX_UPLOAD_MB }));
      const token = await uploadImage(file);
      seed(await setAvatar(token));
      setBrokenAvatarToken(null);
      toast.success(t('avatarUpdated'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('avatarUploadFailed'));
    } finally {
      setAvatarBusy(false);
    }
  }, [seed, t]);

  const removeAvatar = useCallback(async () => {
    setAvatarBusy(true);
    try {
      seed(await clearAvatar());
      toast.info(t('avatarRemoved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('avatarRemoveFailed'));
    } finally {
      setAvatarBusy(false);
    }
  }, [seed, t]);

  // PROF-UX-4 — portfolio add/remove, riding the existing endpoints (the tokens
  // land on the PROF-1 durable lane server-side).
  const onAddPortfolio = useCallback(async (file: File) => {
    setPortfolioBusy(true);
    try {
      // PROF-UX-13 — its own refusal copy (this used to say "Avatar must be an
      // image" on the portfolio path), plus a client-side size pre-check. The
      // served limit is NOT on the wire: the backend's cap is a module constant
      // (`media/routes.ts` `MAX_DECODED_BYTES`, default 32 MiB, operator-overridable
      // via `OPENWOP_MAX_UPLOAD_DECODED_BYTES`) and the SPA mirrors the DEFAULT in
      // `client/fileToBase64.ts` (the KB + notebooks precedent). An operator who
      // raises the server cap still gets a 32 MiB client refusal; one who lowers it
      // still gets the server's 413 for files between the two. Exposing the cap
      // over the wire is a backend unit, not this one.
      if (!file.type.startsWith('image/')) throw new Error(t('portfolioMustBeImage'));
      if (!withinUploadCap(file)) throw new Error(t('imageTooLarge', { mib: MAX_UPLOAD_MB }));
      const token = await uploadImage(file);
      seed(await addPortfolio(token));
      toast.success(t('portfolioAdded'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('portfolioAddFailed'));
    } finally {
      setPortfolioBusy(false);
    }
  }, [seed, t]);

  const onRemovePortfolio = useCallback(async (token: string) => {
    setPortfolioBusy(true);
    try {
      seed(await removePortfolio(token));
      toast.info(t('portfolioRemoved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('portfolioRemoveFailed'));
    } finally {
      setPortfolioBusy(false);
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
    ...(twinVisible ? [{ key: 'twin' as ProfileTab, label: t('tabTwin') }] : []),
  ];

  return (
    <div>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />

      {!me ? (
        // PROF-UX-3 — the /team bar: a failed read is an ANNOUNCED, retryable
        // designed state (never a raw err.message), distinct from loading.
        loadFailed ? (
          <StateCard announce icon={<UserIcon />} title={t('profileFailedTitle')} body={t('profileFailedBody')}
            action={<Button variant="secondary" onClick={load}>{t('retry')}</Button>} />
        ) : <Skeleton />
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
            // PROF-UX-8 — the tablist had no accessible name.
            label={t('profileTabsAria')}
          />

          <TabPanel idBase="profile" tabId={tab}>
          {tab === 'profile' ? (
            <div className="u-grid u-gap-4">
              {/* Identity + completeness */}
              <div className="surface-card">
                <div className="u-flex u-gap-4 u-items-center u-wrap">
                  <div className="profile-avatar">
                    {me.avatarAssetToken && me.avatarAssetToken !== brokenAvatarToken ? (
                      // PROF-1 (render honesty): a stored token whose asset is
                      // gone falls back to the empty-avatar state, never a
                      // broken <img>.
                      // onError is a resource-load failure hook (the designed broken-media
                      // fallback), not a user interaction (AssetPreview precedent).
                      // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
                      <img
                        src={assetUrl(me.avatarAssetToken)}
                        alt={t('avatarAlt')}
                        className="profile-avatar-img"
                        onError={() => setBrokenAvatarToken(me.avatarAssetToken ?? null)}
                      />
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
                    {/* PROF-UX-7 — same labeled progressbar semantics as the /team self card. */}
                    <div
                      className="profile-meter-track"
                      role="progressbar"
                      aria-valuenow={me.completeness}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={t('completenessAria')}
                    >
                      <div className="profile-meter-fill" style={{ width: `${me.completeness}%` }} />
                    </div>
                    {/* PROF-UX-14 — "what to do next". Reads the ADR 0624 D4
                        `completenessMissing[]` (weight-desc, served on the `/me` lane)
                        and shows the top two; renders NOTHING when absent (a meter with
                        no caption is honest, an invented "next step" is not). */}
                    {me.completenessMissing && me.completenessMissing.length > 0 ? (
                      <span className="u-fs-12 muted" data-testid="profile-completeness-next">
                        {t('completenessNext', {
                          items: f.list(me.completenessMissing.slice(0, 2).map((m) => completenessFieldLabel(m.field, t))),
                        })}
                      </span>
                    ) : null}
                  </div>
                  <div className="action-bar u-flex-auto" aria-busy={avatarBusy}>
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
                    {/* PROF-UX-6 — busy across the two-request round-trip (no double-fire). */}
                    <Button variant="quiet" disabled={avatarBusy} onClick={() => fileRef.current?.click()}>
                      <ImageIcon /> {avatarBusy ? t('uploading') : t('upload')}
                    </Button>
                    {me.avatarAssetToken ? (
                      <Button variant="quiet" disabled={avatarBusy} onClick={() => void removeAvatar()}>
                        <TrashIcon /> {t('common:remove')}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Descriptive fields */}
              <div className="surface-card u-gap-3">
                <h2 className="u-fs-16 u-m-0">{t('details')}</h2>
                {/* PROF-UX-12 — the shared `ui/Field` primitives: explicit label↔control
                    association, `help` wired via aria-describedby (the preferred-name
                    hint used to sit INSIDE the label, so it became part of the accessible
                    NAME), and `error` on the hours field (aria-invalid + describedby).
                    `u-mb-0`: the card's own gap spaces the fields. */}
                <TextField label={t('yourName')} className="u-mb-0" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={t('yourNamePlaceholder')} autoComplete="name" />
                <TextField label={t('preferredNameLabel')} help={t('preferredNameHint')} className="u-mb-0" value={preferredName} onChange={(e) => setPreferredName(e.target.value)} placeholder={t('preferredNamePlaceholder')} autoComplete="nickname" />
                <div className="profile-grid-220">
                  <TextField label={t('jobTitleLabel')} className="u-mb-0" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder={t('jobTitlePlaceholder')} />
                  <TextField label={t('departmentLabel')} className="u-mb-0" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder={t('departmentPlaceholder')} />
                </div>
                <TextareaField label={t('bioLabel')} className="u-mb-0" value={bio} onChange={(e) => setBio(e.target.value)} rows={3} placeholder={t('bioPlaceholder')} />
                <TextField label={t('equipmentLabel')} className="u-mb-0" value={equipment} onChange={(e) => setEquipment(e.target.value)} placeholder={t('equipmentPlaceholder')} />
                <TextField label={t('interestsLabel')} className="u-mb-0" value={interests} onChange={(e) => setInterests(e.target.value)} placeholder={t('interestsPlaceholder')} />
                <div className="profile-grid-160">
                  <TextField label={t('timezoneLabel')} className="u-mb-0" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder={t('timezonePlaceholder')} />
                  <TextField
                    ref={hoursRef}
                    label={t('hoursLabel')}
                    className="u-mb-0"
                    error={hoursError}
                    value={hours}
                    onChange={(e) => { setHours(e.target.value); if (hoursError) setHoursError(null); }}
                    inputMode="numeric"
                    placeholder={t('hoursPlaceholder')}
                  />
                  <SelectField label={t('availabilityLabel')} className="u-mb-0" value={status} onChange={(e) => setStatus(e.target.value as AvailabilityStatus | '')}>
                    <option value="">{t('availabilityNone')}</option>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>{t(AVAILABILITY_OPTION_KEY[s])}</option>
                    ))}
                  </SelectField>
                </div>
                <div className="action-bar">
                  <Button variant="primary" disabled={savingFields} onClick={() => void saveFields()}>
                    <SaveIcon /> {t('saveDetails')}
                  </Button>
                </div>
              </div>

              {/* Skills */}
              <div className="surface-card u-gap-3">
                <h2 className="u-fs-16 u-m-0">{t('skills')}</h2>
                <span className="u-label-sm">{t('skillsHint')}</span>
                <div className="u-grid u-gap-2">
                  {skills.map((s) => {
                    const endorsed = me.skills.find((x) => x.name.toLowerCase() === s.name.trim().toLowerCase())?.endorsements.count ?? 0;
                    return (
                      // PROF-UX-18 — keyed by the row's stable id, not its index.
                      <div key={s.id} className="u-flex u-gap-2 u-items-center u-wrap">
                        {/* PROF-UX-1 — both fields carry accessible names (the
                            placeholder is a hint, not a name; the select had NONE). */}
                        <input
                          ref={(el) => { if (el) skillInputRefs.current.set(s.id, el); else skillInputRefs.current.delete(s.id); }}
                          value={s.name}
                          onChange={(e) => setSkills((cur) => cur.map((x) => (x.id === s.id ? { ...x, name: e.target.value } : x)))}
                          placeholder={t('skillPlaceholder')}
                          aria-label={t('skillNameAria')}
                          className="profile-skill-input"
                        />
                        <select
                          value={s.proficiency}
                          onChange={(e) => setSkills((cur) => cur.map((x) => (x.id === s.id ? { ...x, proficiency: Number(e.target.value) } : x)))}
                          aria-label={t('proficiencyAria')}
                          className="u-w-auto"
                        >
                          {/* PROF-UX-2 — the 1–5 scale carries named levels, not bare numbers. */}
                          {([1, 2, 3, 4, 5] as const).map((n) => (
                            <option key={n} value={n}>{t(PROFICIENCY_LEVEL_KEY[n])}</option>
                          ))}
                        </select>
                        {endorsed > 0 ? <span className="chip chip--accent">{t('endorsedCount', { count: endorsed })}</span> : null}
                        <Button variant="quiet" aria-label={t('removeSkillLabel', { name: s.name || t('skills') })} onClick={() => setSkills((cur) => cur.filter((x) => x.id !== s.id))}>
                          <TrashIcon />
                        </Button>
                      </div>
                    );
                  })}
                </div>
                <div className="action-bar">
                  {/* PROF-UX-18 — mint a stable id and move focus into the new row. */}
                  <Button variant="quiet" onClick={() => { const id = nextSkillId.current++; setSkills((cur) => [...cur, { id, name: '', proficiency: 3 }]); setFocusSkillId(id); }}>
                    <PlusIcon /> {t('addSkill')}
                  </Button>
                  <Button variant="primary" disabled={savingSkills} onClick={() => void saveSkills()}>
                    <SaveIcon /> {t('saveSkills')}
                  </Button>
                </div>
              </div>

              {/* Portfolio (PROF-UX-4) — the API-complete surface finally gets a UI:
                  add/remove images on the existing endpoints; server promotes the
                  tokens to the durable media lane (PROF-1). */}
              <div className="surface-card u-gap-3">
                <h2 className="u-fs-16 u-m-0">{t('portfolioTitle')}</h2>
                <span className="u-label-sm">{t('portfolioHint')}</span>
                {me.portfolioAssetTokens.length > 0 ? (
                  <div className="profile-portfolio-grid">
                    {me.portfolioAssetTokens.map((token, i) => (
                      <figure key={token} className="profile-portfolio-item">
                        {deadPortfolioTokens.has(token) ? (
                          // PROF-1 (render honesty) — a dead asset shows a designed
                          // placeholder, never a broken <img>; remove stays offered.
                          <span className="muted" title={t('portfolioImageUnavailable')} role="img" aria-label={t('portfolioImageUnavailable')}>
                            <ImageIcon />
                          </span>
                        ) : (
                          // onError is a resource-load failure hook (the designed broken-media
                          // fallback), not a user interaction (AssetPreview precedent).
                          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
                          <img
                            src={assetUrl(token)}
                            alt={t('portfolioImageAlt')}
                            className="profile-portfolio-img"
                            loading="lazy"
                            onError={() => setDeadPortfolioTokens((cur) => new Set(cur).add(token))}
                          />
                        )}
                        <span className="profile-portfolio-remove">
                          {/* F8 — per-item accessible name (the removeSkillLabel pattern). */}
                          <Button variant="quiet" disabled={portfolioBusy} aria-label={t('removePortfolioImageN', { index: i + 1 })} onClick={() => void onRemovePortfolio(token)}>
                            <TrashIcon />
                          </Button>
                        </span>
                      </figure>
                    ))}
                  </div>
                ) : (
                  <span className="u-label-sm muted">{t('portfolioEmpty')}</span>
                )}
                <div className="action-bar" aria-busy={portfolioBusy}>
                  <input
                    ref={portfolioFileRef}
                    type="file"
                    accept="image/*"
                    className="u-hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void onAddPortfolio(file);
                      e.target.value = '';
                    }}
                  />
                  <Button variant="quiet" disabled={portfolioBusy} onClick={() => portfolioFileRef.current?.click()}>
                    <ImageIcon /> {portfolioBusy ? t('uploading') : t('addPortfolioImage')}
                  </Button>
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
                // PROF-UX-3 — announced, retryable failed-read state (clearing
                // the flag re-runs the lazy-load effect).
                <StateCard announce icon={<UserIcon />} title={t('boardFailedTitle')} body={t('boardFailedBody')}
                  action={<Button variant="secondary" onClick={() => setBoardError(null)}>{t('retry')}</Button>} />
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
                <Skeleton />
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

          {/* TWIN-UX-1 — a resolving toggle renders the LOADING state and a
              FAILED assignments read renders an announced error state with retry:
              "we don't know yet", "we couldn't check", and "nothing has access to
              you" are three different answers, and only the last may be implied
              by an empty dashboard. (A toggle that RESOLVED off never reaches
              here — `visibleProfileTabs` drops the tab and `useUrlTab` bounces
              `?tab=twin` to the default, so there is no resolved-OFF branch.) */}
          {tab === 'twin'
            ? (twinAccess.enabled
                ? <ProfileTwinGrantsTab />
                : twinAccess.resolutionFailed
                  ? <StateCard announce icon={<UserIcon />}
                      title={t('twin:toggleReadFailedTitle')}
                      body={t('twin:toggleReadFailedBody')}
                      action={<Button variant="secondary" size="sm" onClick={reloadFeatureAccess}>{t('twin:twinRetry')}</Button>} />
                  : <StateCard icon={<UserIcon />} title={t('twin:loading')} loading />)
            : null}
          </TabPanel>
        </>
      )}
    </div>
  );
}
