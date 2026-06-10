/**
 * My Profile (host-extension product feature — ADR 0005). Self-service editor
 * for the signed-in user's own profile: identity-surfaced name + email-verified
 * badge, a completeness meter, avatar upload (media surface), the descriptive
 * fields, and a skills editor. Gates on useFeatureAccess('profiles') — off ⇒ the
 * nav entry is hidden and this shows a disabled state (the backend also 404s).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { CheckIcon, ImageIcon, LockIcon, PlusIcon, SaveIcon, TrashIcon, UserIcon } from '../../ui/icons/index.js';
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

const STATUSES: AvailabilityStatus[] = ['available', 'busy', 'away'];

export function ProfilePage(): JSX.Element {
  const access = useFeatureAccess('profiles');
  const [me, setMe] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form state (seeded from the loaded profile).
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
    if (access.enabled) load();
  }, [access.enabled, load]);

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
  }, [jobTitle, department, bio, equipment, interests, timezone, hours, status, seed]);

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

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title="Profiles is not enabled" body="Ask an administrator to enable the Profiles feature for this tenant." />;
  }

  return (
    <div>
      <PageHeader eyebrow="Platform" title="My Profile" lede="Your self-service profile. Visible to your team in the directory." />

      {error ? <Notice variant="error">{error}</Notice> : null}

      {me ? (
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
      ) : !error ? (
        <Skeleton />
      ) : null}
    </div>
  );
}
