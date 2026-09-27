/**
 * Team directory (host-extension product feature — ADR 0005). A read view of
 * every profile in the tenant, with a per-skill endorse affordance. Endorsing is
 * fail-closed on the backend (not your own skill, one per endorser); the UI
 * mirrors that by disabling self-endorsement. Always-on (profiles graduated off
 * its toggle, § Correction 2026-06-12) — no feature gate.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n/index.js';
import { useFormat } from '../../i18n/useFormat.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { CheckIcon, ClockIcon, GlobeIcon, SearchIcon, ThumbsUpIcon, UserIcon } from '../../ui/icons/index.js';
import { assetUrl, endorseSkill, listProfiles, unendorseSkill, type AvailabilityStatus, type Profile } from './profilesClient.js';
import { isMine, useMyIdentity } from './useMyIdentity.js';

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

/** PROF-UX-17 — identity of ONE endorse toggle (a skill name may contain any
 *  character, so the separator is a control char no name can carry). */
function endorseKey(userId: string, skill: string): string {
  return `${userId}\u0000${skill}`;
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
  // ADR 0492 — identity as a union; `isMine` returns 'unknown', never a silent false.
  const identity = useMyIdentity();
  const myId = identity.status === 'known' ? identity.userId : null;

  /** The directory read FAILED — distinct from "no profiles yet". A FLAG, not
   *  the raw `err.message` (PROF-UX-11): the announced StateCard below carries
   *  the designed copy; a server blob above it was the shape PROF-UX-3 removed
   *  from /profile. */
  const [rowsFailed, setRowsFailed] = useState(false);
  /** PROF-UX-17 — the ONE endorse toggle in flight (`userId + skill`), so a second
   *  click cannot re-POST the same endorsement and land as a false "failed". */
  const [pendingEndorse, setPendingEndorse] = useState<string | null>(null);
  // PROF-1 (render honesty) — asset tokens whose bytes are GONE (a pre-fix
  // profile stored a 7-day scratch token forever). A dead avatar falls back to
  // the initials/tint state, never a broken <img>.
  const [deadAssets, setDeadAssets] = useState<ReadonlySet<string>>(new Set());
  const markDead = useCallback((token: string) => {
    setDeadAssets((cur) => new Set(cur).add(token));
  }, []);
  const [query, setQuery] = useState('');
  // §4.5 collection kit (DESIGN.md rule 13): a department facet alongside the
  // canon search. Options derive from the loaded rows (self-describing).
  const [departmentFilter, setDepartmentFilter] = useState('');

  const load = useCallback(() => {
    setRowsFailed(false);
    void listProfiles()
      .then(setRows)
      // `rows` stays null on failure, and the render below treats null as
      // LOADING — so an error Notice used to appear with a skeleton still
      // pulsing underneath it, on a page whose empty state reads "Profiles
      // appear here as teammates fill them in." Both halves are wrong at once:
      // it says the read is still going, and it invites you to wait for
      // teammates. The flag routes to the designed failed-read state instead.
      .catch(() => setRowsFailed(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const replace = useCallback((updated: Profile) => {
    setRows((cur) => (cur ? cur.map((p) => (p.userId === updated.userId ? updated : p)) : cur));
  }, []);

  const toggleEndorse = useCallback(
    async (target: Profile, skill: string, endorsed: boolean) => {
      const key = endorseKey(target.userId, skill);
      setPendingEndorse(key);
      try {
        const updated = endorsed ? await unendorseSkill(target.userId, skill) : await endorseSkill(target.userId, skill);
        replace(updated);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('endorsementFailed'));
      } finally {
        setPendingEndorse((cur) => (cur === key ? null : cur));
      }
    },
    [replace, t],
  );

  // Departments present in the loaded directory (drives the facet dropdown).
  const departmentOptions = useMemo(() => {
    if (!rows) return [];
    return [...new Set(rows.map((p) => p.department?.trim()).filter((d): d is string => Boolean(d)))]
      .sort((a, b) => a.localeCompare(b));
  }, [rows]);

  // Filter by the search box + department facet, then sort: you first, then alphabetically.
  const visible = useMemo(() => {
    if (!rows) return null;
    const q = query.trim().toLowerCase();
    const matched = rows.filter((p) =>
      (!q || searchHaystack(p).includes(q)) &&
      (!departmentFilter || p.department?.trim() === departmentFilter));
    return [...matched].sort((a, b) => {
      if (a.userId === myId) return -1;
      if (b.userId === myId) return 1;
      return nameOf(a).localeCompare(nameOf(b));
    });
  }, [rows, query, departmentFilter, myId]);
  const filtersActive = query.trim() !== '' || departmentFilter !== '';
  const clearFilters = (): void => { setQuery(''); setDepartmentFilter(''); };

  return (
    <div>
      <PageHeader eyebrow={t('teamEyebrow')} title={t('teamTitle')} lede={t('teamLede')} />

      {rows && rows.length > 0 ? (
        <div className="filterbar" role="group" aria-label={t('filterGroup')}>
          {rows.length > 3 ? (
            <>
              <input
                type="search"
                className="ui-input filterbar-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('searchPlaceholder')}
                aria-label={t('searchAriaLabel')}
              />
              {departmentOptions.length > 1 ? (
                <select className="ui-input filterbar-select" aria-label={t('filterDepartmentAria')} value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)}>
                  <option value="">{t('allDepartments')}</option>
                  {departmentOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              ) : null}
            </>
          ) : null}
          <span className="teampage-count u-ml-auto" aria-live="polite">
            {filtersActive && visible
              ? t('countFiltered', { shown: f.number(visible.length), total: f.number(rows.length) })
              : f.number(rows.length)}
            {' '}
            {t('countPeople', { count: rows.length })}
          </span>
        </div>
      ) : null}

      {rowsFailed ? (
        <StateCard announce icon={<UserIcon />} title={t('directoryFailedTitle')} body={t('directoryFailedBody')}
          action={<Button variant="secondary" onClick={load}>{t('directoryRetry')}</Button>} />
      ) : !rows ? (
        <Skeleton />
      ) : rows.length === 0 ? (
        <StateCard icon={<UserIcon />} title={t('noProfilesTitle')} body={t('noProfilesBody')} />
      ) : visible && visible.length === 0 ? (
        <StateCard
          icon={<SearchIcon />}
          title={t('noMatchesTitle')}
          body={query.trim() ? t('noMatchesBody', { query: query.trim() }) : t('noMatchesBodyGeneric')}
          action={<Button variant="secondary" onClick={clearFilters}>{t('clearFilters')}</Button>}
        />
      ) : (
        <div className="teampage-grid">
          {visible!.map((p) => {
            const self = isMine(identity, p.userId);
            const name = nameOf(p);
            const initials = initialsOf(p);
            const role = [p.jobTitle, p.department].filter(Boolean).join(' · ');
            const status = p.availability?.status;
            const empty = isEmptyProfile(p);
            return (
              <div key={p.userId} className={`surface-card teampage-card${self === true ? ' teampage-card--self' : ''}`}>
                <div className="u-flex u-gap-3 u-items-start">
                  <div className="teampage-avatar-wrap">
                    {(() => {
                      const avatarLive = Boolean(p.avatarAssetToken) && !deadAssets.has(p.avatarAssetToken!);
                      return (
                        <div className={`teampage-avatar${avatarLive ? '' : ` teampage-tint-${tintIndex(p.userId)}`}`}>
                          {avatarLive ? (
                            // onError is a resource-load failure hook (the designed broken-media
                            // fallback), not a user interaction (AssetPreview precedent).
                            // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
                            <img src={assetUrl(p.avatarAssetToken!)} alt="" className="teampage-avatar-img" onError={() => markDead(p.avatarAssetToken!)} />
                          ) : initials ? (
                            <span className="teampage-initials">{initials}</span>
                          ) : (
                            <UserIcon />
                          )}
                        </div>
                      );
                    })()}
                    {status ? (
                      <span
                        className={`teampage-status-dot teampage-status-dot--${status}`}
                        title={t(AVAILABILITY_LABEL_KEY[status])}
                        role="img"
                        aria-label={t(AVAILABILITY_LABEL_KEY[status])}
                      />
                    ) : null}
                  </div>
                  <div className="u-grid u-gap-0-5 u-minw-0 u-flex-1">
                    <div className="teampage-name-row">
                      <strong className="u-truncate">{name}</strong>
                      {p.emailVerified === true ? (
                        // PROF-UX-16 — the chip was icon-only with a `title`, which
                        // assistive tech does not reliably expose; the meaning is
                        // now real (sr-only) text, the icon decorative (§11).
                        <span className="chip chip--success teampage-flag" title={t('emailVerifiedTitle')}>
                          <CheckIcon size={12} />
                          <span className="sr-only">{t('emailVerifiedTitle')}</span>
                        </span>
                      ) : null}
                      {self === true ? <span className="chip chip--accent teampage-flag">{t('youChip')}</span> : null}
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
                      // `self` is `boolean | 'unknown'`, so this surface must say
                      // what unknown MEANS: don't offer the action, and don't claim
                      // an aria-pressed state we never read. NB every check on
                      // `self` is `=== true` — the string 'unknown' is truthy, so a
                      // bare `self ?` would mark every row as your own.
                      const ownershipUnknown = self === 'unknown';
                      // ADR 0624 D7 — `endorsedByMe` is decided server-side for the ACTING user
                      // (`/team` is projected with the caller as viewer), so the chip reads
                      // it rather than re-deriving it from an id list.
                      const endorsed = !ownershipUnknown && myId ? s.endorsements.endorsedByMe : false;
                      // PROF-UX-9 — WHY the chip is disabled / what pressing it does
                      // was `title`-only, which assistive tech does not reliably
                      // expose. The same string now rides as sr-only text inside the
                      // button, so it is part of what a screen reader speaks.
                      const why = self === true ? t('cannotEndorseOwn') : ownershipUnknown ? t('endorseIdentityUnknown') : endorsed ? t('removeEndorsement') : t('endorseSkill');
                      // PROF-UX-17 — in flight: disabled + busy, so a second click
                      // cannot re-POST and surface as a false "Endorsement failed".
                      const pending = pendingEndorse === endorseKey(p.userId, s.name);
                      return (
                        <button
                          key={s.name}
                          type="button"
                          className={`${endorsed ? 'chip chip--accent' : 'chip'} teampage-skill-chip`}
                          disabled={self === true || ownershipUnknown || pending}
                          aria-busy={pending || undefined}
                          aria-pressed={ownershipUnknown ? undefined : endorsed}
                          title={why}
                          onClick={() => void toggleEndorse(p, s.name, endorsed)}
                        >
                          <ThumbsUpIcon size={13} /> {s.name}
                          {s.endorsements.count > 0 ? <span className="teampage-endorse-count">{f.number(s.endorsements.count)}</span> : null}
                          <span className="sr-only">, {why}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : empty ? (
                  <span className="u-label-sm teampage-empty-hint">
                    {self === true ? t('emptyProfileSelf') : t('emptyProfileOther')}
                  </span>
                ) : null}

                {/* PROF-UX-4 — the portfolio finally renders where teammates look. */}
                {p.portfolioAssetTokens.some((tk) => !deadAssets.has(tk)) ? (
                  <div className="teampage-portfolio-strip">
                    {p.portfolioAssetTokens.filter((tk) => !deadAssets.has(tk)).slice(0, 6).map((tk) => (
                      // onError is a resource-load failure hook (the designed broken-media
                      // fallback), not a user interaction (AssetPreview precedent).
                      // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
                      <img key={tk} src={assetUrl(tk)} alt={t('portfolioImageAlt')} className="teampage-portfolio-thumb" loading="lazy" onError={() => markDead(tk)} />
                    ))}
                  </div>
                ) : null}

                {p.interests.length > 0 ? (
                  <span className="teampage-meta teampage-interests">{t('interestsPrefix', { list: f.list(p.interests) })}</span>
                ) : null}

                {self === true ? (
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
