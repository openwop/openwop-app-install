/**
 * Team directory (host-extension product feature — ADR 0005). A read view of
 * every profile in the tenant, with a per-skill endorse affordance. Endorsing is
 * fail-closed on the backend (not your own skill, one per endorser); the UI
 * mirrors that by disabling self-endorsement. Gates on
 * useFeatureAccess('profiles').
 */
import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { CheckIcon, LockIcon, ThumbsUpIcon, UserIcon } from '../../ui/icons/index.js';
import { assetUrl, endorseSkill, getMyProfile, listProfiles, unendorseSkill, type Profile } from './profilesClient.js';

export function TeamPage(): JSX.Element {
  const access = useFeatureAccess('profiles');
  const [rows, setRows] = useState<Profile[] | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    void getMyProfile().then((p) => setMyId(p.userId)).catch(() => setMyId(null));
    void listProfiles()
      .then(setRows)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load the directory.'));
  }, []);

  useEffect(() => {
    if (access.enabled) load();
  }, [access.enabled, load]);

  const replace = useCallback((updated: Profile) => {
    setRows((cur) => (cur ? cur.map((p) => (p.userId === updated.userId ? updated : p)) : cur));
  }, []);

  const toggleEndorse = useCallback(
    async (target: Profile, skill: string, endorsed: boolean) => {
      try {
        const updated = endorsed ? await unendorseSkill(target.userId, skill) : await endorseSkill(target.userId, skill);
        replace(updated);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Endorsement failed.');
      }
    },
    [replace],
  );

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title="Profiles is not enabled" body="Ask an administrator to enable the Profiles feature for this tenant." />;
  }

  return (
    <div>
      <PageHeader eyebrow="Platform" title="Team directory" lede="Everyone's profile in this tenant. Endorse a teammate's skill." />
      {error ? <Notice variant="error">{error}</Notice> : null}
      {!rows ? (
        <Skeleton />
      ) : rows.length === 0 ? (
        <StateCard icon={<UserIcon />} title="No profiles yet" body="Profiles appear here as teammates fill them in." />
      ) : (
        <div className="teampage-grid">
          {rows.map((p) => (
            <div key={p.userId} className="surface-card u-gap-3">
              <div className="u-flex u-gap-3 u-items-center">
                <div className="teampage-avatar">
                  {p.avatarAssetToken ? (
                    <img src={assetUrl(p.avatarAssetToken)} alt="avatar" className="teampage-avatar-img" />
                  ) : (
                    <UserIcon />
                  )}
                </div>
                <div className="u-grid u-gap-0-5 u-minw-0">
                  <div className="u-flex u-gap-1 u-items-center">
                    <strong className="u-truncate">{p.displayName ?? p.userId}</strong>
                    {p.emailVerified === true ? <span className="chip chip--success"><CheckIcon /></span> : null}
                  </div>
                  <span className="u-label-sm">
                    {[p.jobTitle, p.department].filter(Boolean).join(' · ') || 'No title set'}
                  </span>
                </div>
              </div>

              {p.bio ? <p className="u-label-sm u-m-0">{p.bio}</p> : null}

              {p.skills.length > 0 ? (
                <div className="u-flex u-wrap u-gap-1">
                  {p.skills.map((s) => {
                    const isSelf = p.userId === myId;
                    const endorsed = myId ? s.endorsements.includes(myId) : false;
                    return (
                      <button
                        key={s.name}
                        type="button"
                        className={`${endorsed ? 'chip chip--accent' : 'chip'} teampage-skill-chip`}
                        disabled={isSelf}
                        title={isSelf ? 'You cannot endorse your own skill' : endorsed ? 'Remove endorsement' : 'Endorse'}
                        onClick={() => void toggleEndorse(p, s.name, endorsed)}
                        style={{ cursor: isSelf ? 'default' : 'pointer' }}
                      >
                        <ThumbsUpIcon /> {s.name}
                        {s.endorsements.length > 0 ? ` · ${s.endorsements.length}` : ''}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <span className="u-label-sm">No skills listed</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
