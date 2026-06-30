/**
 * Team directory (host-extension product feature — ADR 0005). A read view of
 * every profile in the tenant, with a per-skill endorse affordance. Endorsing is
 * fail-closed on the backend (not your own skill, one per endorser); the UI
 * mirrors that by disabling self-endorsement. Always-on (profiles graduated off
 * its toggle, § Correction 2026-06-12) — no feature gate.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n/index.js';
import { useFormat } from '../../i18n/useFormat.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { CheckIcon, ClockIcon, GlobeIcon, SearchIcon, ThumbsUpIcon, UserIcon } from '../../ui/icons/index.js';
import { assetUrl, endorseSkill, getMyProfile, listProfiles, unendorseSkill, type AvailabilityStatus, type Profile } from './profilesClient.js';

/** Human display name, never the raw `user:<uuid>` id. */
function nameOf(p: Profile): string {
  return p.displayName?.trim() || i18n.t('profiles:unnamedTeammate');
}

/** A short, readable handle derived from the opaque user id. */
function handleOf(p: Profile): string {
  return `#${p.userId.replace(/^user:/, '').slice(0, 8)}`;
}

/** Up to two initials from a real name (empty when we only have a handle). */
function initialsOf(p: Profile): string {
  const name = p.displayName?.trim();
  if (!name) return '';
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Deterministic 0–5 tint bucket so a given person always gets the same colour. */
function tintIndex(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 6;
}

const AVAILABILITY_LABEL_KEY: Record<AvailabilityStatus, string> = {
  available: 'availabilityAvailable',
  busy: 'availabilityBusy',
  away: 'availabilityAway',
};

/** A profile nobody has filled in yet — show a single tasteful hint, not a
 *  stack of "No title set" / "No skills listed" noise. */
function isEmptyProfile(p: Profile): boolean {
  return (
    !p.jobTitle && !p.department && !p.bio &&
    p.skills.length === 0 && p.interests.length === 0 &&
    !p.contact?.location && !p.availability?.status
  );
}

function searchHaystack(p: Profile): string {
  return [nameOf(p), p.jobTitle, p.department, p.contact?.location, ...p.skills.map((s) => s.name), ...p.interests]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function TeamPage(): JSX.Element {
  const { t } = useTranslation('profiles');
  const f = useFormat();
  // Profiles graduated to always-on (§ Correction 2026-06-12) — no feature gate.
  const [rows, setRows] = useState<Profile[] | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(() => {
    setError(null);
    void getMyProfile().then((p) => setMyId(p.userId)).catch(() => setMyId(null));
    void listProfiles()
      .then(setRows)
      .catch((err) => setError(err instanceof Error ? err.message : t('loadDirectoryFailed')));
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const replace = useCallback((updated: Profile) => {
    setRows((cur) => (cur ? cur.map((p) => (p.userId === updated.userId ? updated : p)) : cur));
  }, []);

  const toggleEndorse = useCallback(
    async (target: Profile, skill: string, endorsed: boolean) => {
      try {
        const updated = endorsed ? await unendorseSkill(target.userId, skill) : await endorseSkill(target.userId, skill);
        replace(updated);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('endorsementFailed'));
      }
    },
    [replace, t],
  );

  // Filter by the search box, then sort: you first, then alphabetically.
  const visible = useMemo(() => {
    if (!rows) return null;
    const q = query.trim().toLowerCase();
    const matched = q ? rows.filter((p) => searchHaystack(p).includes(q)) : rows;
    return [...matched].sort((a, b) => {
      if (a.userId === myId) return -1;
      if (b.userId === myId) return 1;
      return nameOf(a).localeCompare(nameOf(b));
    });
  }, [rows, query, myId]);

  return (
    <div>
      <PageHeader eyebrow={t('teamEyebrow')} title={t('teamTitle')} lede={t('teamLede')} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {rows && rows.length > 0 ? (
        <div className="teampage-toolbar">
          <div className="teampage-search">
            <span className="teampage-search-icon" aria-hidden><SearchIcon size={16} /></span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchAriaLabel')}
            />
          </div>
          <span className="teampage-count" aria-live="polite">
            {query.trim() && visible
              ? t('countFiltered', { shown: f.number(visible.length), total: f.number(rows.length) })
              : f.number(rows.length)}
            {' '}
            {t('countPeople', { count: rows.length })}
          </span>
        </div>
      ) : null}

      {!rows ? (
        <Skeleton />
      ) : rows.length === 0 ? (
        <StateCard icon={<UserIcon />} title={t('noProfilesTitle')} body={t('noProfilesBody')} />
      ) : visible && visible.length === 0 ? (
        <StateCard
          icon={<SearchIcon />}
          title={t('noMatchesTitle')}
          body={t('noMatchesBody', { query: query.trim() })}
        />
      ) : (
        <div className="teampage-grid">
          {visible!.map((p) => {
            const self = p.userId === myId;
            const name = nameOf(p);
            const initials = initialsOf(p);
            const role = [p.jobTitle, p.department].filter(Boolean).join(' · ');
            const status = p.availability?.status;
            const empty = isEmptyProfile(p);
            return (
              <div key={p.userId} className={`surface-card teampage-card${self ? ' teampage-card--self' : ''}`}>
                <div className="u-flex u-gap-3 u-items-start">
                  <div className="teampage-avatar-wrap">
                    <div className={`teampage-avatar${p.avatarAssetToken ? '' : ` teampage-tint-${tintIndex(p.userId)}`}`}>
                      {p.avatarAssetToken ? (
                        <img src={assetUrl(p.avatarAssetToken)} alt="" className="teampage-avatar-img" />
                      ) : initials ? (
                        <span className="teampage-initials">{initials}</span>
                      ) : (
                        <UserIcon />
                      )}
                    </div>
                    {status ? (
                      <span
                        className={`teampage-status-dot teampage-status-dot--${status}`}
                        title={t(AVAILABILITY_LABEL_KEY[status])}
                      />
                    ) : null}
                  </div>
                  <div className="u-grid u-gap-0-5 u-minw-0 u-flex-1">
                    <div className="teampage-name-row">
                      <strong className="u-truncate">{name}</strong>
                      {p.emailVerified === true ? (
                        <span className="chip chip--success teampage-flag" title={t('emailVerifiedTitle')}><CheckIcon size={12} /></span>
                      ) : null}
                      {self ? <span className="chip chip--accent teampage-flag">{t('youChip')}</span> : null}
                    </div>
                    <span className="u-label-sm u-truncate">{role || handleOf(p)}</span>
                  </div>
                </div>

                {(p.contact?.location || p.availability?.timezone || status) ? (
                  <div className="u-flex u-wrap u-gap-3">
                    {p.contact?.location ? (
                      <span className="teampage-meta"><GlobeIcon size={13} /> {p.contact.location}</span>
                    ) : null}
                    {p.availability?.timezone ? (
                      <span className="teampage-meta"><ClockIcon size={13} /> {p.availability.timezone}</span>
                    ) : null}
                    {status ? (
                      <span className="teampage-meta">
                        {t(AVAILABILITY_LABEL_KEY[status])}
                        {p.availability?.hoursPerWeek ? t('hoursPerWeek', { hours: f.number(p.availability.hoursPerWeek) }) : ''}
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {p.bio ? <p className="teampage-bio u-label-sm u-m-0">{p.bio}</p> : null}

                {p.skills.length > 0 ? (
                  <div className="u-flex u-wrap u-gap-1">
                    {p.skills.map((s) => {
                      const endorsed = myId ? s.endorsements.includes(myId) : false;
                      return (
                        <button
                          key={s.name}
                          type="button"
                          className={`${endorsed ? 'chip chip--accent' : 'chip'} teampage-skill-chip`}
                          disabled={self}
                          aria-pressed={endorsed}
                          title={self ? t('cannotEndorseOwn') : endorsed ? t('removeEndorsement') : t('endorseSkill')}
                          onClick={() => void toggleEndorse(p, s.name, endorsed)}
                        >
                          <ThumbsUpIcon size={13} /> {s.name}
                          {s.endorsements.length > 0 ? <span className="teampage-endorse-count">{f.number(s.endorsements.length)}</span> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : empty ? (
                  <span className="u-label-sm teampage-empty-hint">
                    {self ? t('emptyProfileSelf') : t('emptyProfileOther')}
                  </span>
                ) : null}

                {p.interests.length > 0 ? (
                  <span className="teampage-meta teampage-interests">{t('interestsPrefix', { list: f.list(p.interests) })}</span>
                ) : null}

                {self ? (
                  <div className="teampage-footer">
                    <div
                      className="teampage-meter"
                      role="progressbar"
                      aria-valuenow={p.completeness}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={t('completenessAria')}
                    >
                      <div className="teampage-meter-fill" style={{ width: `${p.completeness}%` }} />
                    </div>
                    <span className="u-label-sm teampage-meter-label">{f.percent(p.completeness / 100)}</span>
                    <Link to="/profile" className="btn-ghost btn-sm">{t('editProfile')}</Link>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
