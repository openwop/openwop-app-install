/**
 * Podcast Shows & Distribution (ADR 0390) — the Studio panel that groups episodes
 * into a subscribable CHANNEL (a PodcastShow), publishes it, and surfaces the
 * submittable iTunes feed URL + directory-submission guidance. Composes the
 * podcasts host-extension `shows` routes; `ui/` cohesion.
 *
 * A show is the unit Apple Podcasts / Spotify subscribe to. The feed-validity
 * helper WARNS (never blocks — ADR 0390 OQ-3) on the Apple-required fields so an
 * operator knows what a directory will reject before submitting.
 *
 * @see docs/adr/0390-podcast-public-distribution.md
 */

import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Notice } from '../../ui/Notice.js';
import { TextField, TextareaField, SelectField } from '../../ui/Field.js';
import { toast } from '../../ui/toast.js';
import { confirm } from '../../ui/confirm.js';
import { LinkIcon, PlusIcon, TrashIcon, CopyIcon, ExternalLinkIcon, CheckIcon, PencilIcon } from '../../ui/icons/index.js';
import { MediaPickerDialog } from '../media/MediaPickerDialog.js';
import { assetUrl } from './podcastsClient.js';
import {
  listShowsWithCapability, createShow, updateShow, setShowPublished, deleteShow, feedUrl,
  type PodcastShow,
} from './podcastsClient.js';

/** Apple Podcasts top-level categories (the Apple Podcasts Connect taxonomy).
 *  The submitted VALUE is the canonical English string the RSS
 *  `<itunes:category>` must carry — a directory rejects anything outside this
 *  set; the visible label is localized (POD-2). Kept alphabetical, with the two
 *  compound trailing names as Apple lists them. */
const APPLE_PODCAST_CATEGORIES = [
  'Arts', 'Business', 'Comedy', 'Education', 'Fiction', 'Government',
  'Health & Fitness', 'History', 'Kids & Family', 'Leisure', 'Music', 'News',
  'Religion & Spirituality', 'Science', 'Society & Culture', 'Sports',
  'Technology', 'True Crime', 'TV & Film',
] as const;

/** Canonical category string → its i18n label key. */
const CATEGORY_LABEL_KEYS: Record<string, string> = {
  'Arts': 'catArts',
  'Business': 'catBusiness',
  'Comedy': 'catComedy',
  'Education': 'catEducation',
  'Fiction': 'catFiction',
  'Government': 'catGovernment',
  'Health & Fitness': 'catHealthFitness',
  'History': 'catHistory',
  'Kids & Family': 'catKidsFamily',
  'Leisure': 'catLeisure',
  'Music': 'catMusic',
  'News': 'catNews',
  'Religion & Spirituality': 'catReligionSpirituality',
  'Science': 'catScience',
  'Society & Culture': 'catSocietyCulture',
  'Sports': 'catSports',
  'Technology': 'catTechnology',
  'True Crime': 'catTrueCrime',
  'TV & Film': 'catTvFilm',
};

/** A category present on a show but outside the Apple taxonomy — legacy free-text
 *  data a directory will reject. Warned, never blocked (ADR 0390 OQ-3). */
function isKnownCategory(cat: string | null | undefined): boolean {
  return !!cat && (APPLE_PODCAST_CATEGORIES as readonly string[]).includes(cat.trim());
}

/** The Apple-required channel fields — a show missing any of these will be
 *  rejected by a directory (ADR 0390 OQ-3: warn, don't block). */
function missingRequiredFields(show: PodcastShow, t: (k: string) => string): string[] {
  const missing: string[] = [];
  if (!show.author.trim()) missing.push(t('validityAuthor'));
  if (!show.ownerEmail?.trim()) missing.push(t('validityOwnerEmail'));
  if (!show.imageMediaRef?.trim()) missing.push(t('validityArtwork'));
  if (!show.category?.trim()) missing.push(t('validityCategory'));
  if (!show.description.trim()) missing.push(t('validityDescription'));
  return missing;
}

/**
 * R2 SP-2 — the show EDIT form. The validity warning has always instructed
 * "add artwork / category / owner email…" while the only write surface was
 * delete-and-recreate (which unpublishes every episode). `updateShow` existed
 * in the client, imported by NOTHING — this form is its first caller. Artwork
 * rides the shared MediaPickerDialog (the cms/creative-briefs precedent);
 * empty optional fields keep their stored values (the backend's documented
 * merge semantics), so this form ADDS what's missing, it can't strand data.
 */
function EditShowForm({ show, orgId, onSaved, onCancel }: {
  show: PodcastShow; orgId: string; onSaved: () => void; onCancel: () => void;
}): JSX.Element {
  const { t } = useTranslation('podcasts');
  const [title, setTitle] = useState(show.title);
  const [author, setAuthor] = useState(show.author);
  const [description, setDescription] = useState(show.description ?? '');
  const [category, setCategory] = useState(show.category ?? '');
  const [ownerEmail, setOwnerEmail] = useState(show.ownerEmail ?? '');
  const [explicit, setExplicit] = useState(show.explicit);
  const [imageMediaRef, setImageMediaRef] = useState(show.imageMediaRef ?? '');
  // R2 PR2-4 — directory listing URLs the operator pastes back after approval.
  const [appleUrl, setAppleUrl] = useState(show.appleUrl ?? '');
  const [spotifyUrl, setSpotifyUrl] = useState(show.spotifyUrl ?? '');
  const [amazonUrl, setAmazonUrl] = useState(show.amazonUrl ?? '');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    if (!title.trim() || !author.trim()) return;
    setBusy(true);
    try {
      await updateShow(show.id, {
        title: title.trim(),
        author: author.trim(),
        explicit,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(category.trim() ? { category: category.trim() } : {}),
        ...(ownerEmail.trim() ? { ownerEmail: ownerEmail.trim() } : {}),
        ...(imageMediaRef.trim() ? { imageMediaRef: imageMediaRef.trim() } : {}),
        // Review F6 — always sent: '' is an explicit CLEAR server-side.
        appleUrl: appleUrl.trim(),
        spotifyUrl: spotifyUrl.trim(),
        amazonUrl: amazonUrl.trim(),
      });
      toast.success(t('showUpdated'));
      onSaved();
    } catch (err) { toast.error(err instanceof Error ? err.message : t('updateFailed')); }
    finally { setBusy(false); }
  };

  return (
    <form className="surface-inset u-p-3 u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h4 className="u-fs-13 u-m-0">{t('editShowHeading', { title: show.title })}</h4>
      <TextField label={t('showTitleLabel')} value={title} onChange={(e) => setTitle(e.target.value)} />
      <TextField label={t('showAuthorLabel')} value={author} onChange={(e) => setAuthor(e.target.value)} />
      <TextareaField label={t('showDescriptionLabel')} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      <SelectField label={t('showCategoryLabel')} value={category} onChange={(e) => setCategory(e.target.value)}>
        <option value="">{t('showCategoryPlaceholder')}</option>
        {APPLE_PODCAST_CATEGORIES.map((c) => (
          <option key={c} value={c}>{t(CATEGORY_LABEL_KEYS[c] ?? c)}</option>
        ))}
      </SelectField>
      <TextField label={t('showOwnerEmailLabel')} type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="podcast@acme.test" />
      <SelectField label={t('showExplicitLabel')} value={explicit ? 'yes' : 'no'} onChange={(e) => setExplicit(e.target.value === 'yes')}>
        <option value="no">{t('explicitNo')}</option>
        <option value="yes">{t('explicitYes')}</option>
      </SelectField>
      <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
        {imageMediaRef ? <img src={assetUrl(imageMediaRef)} alt="" width={48} height={48} style={{ borderRadius: 'var(--radius)' }} /> : null}
        <Button variant="secondary" size="sm" onClick={() => setPickerOpen(true)}>
          {imageMediaRef ? t('changeArtwork') : t('pickArtwork')}
        </Button>
        <span className="u-text-sm muted">{t('artworkHint')}</span>
      </div>
      {/* R2 PR2-4 — pasted back after each directory approves the feed; they
          become the public page's "Listen on" row. */}
      <TextField label={t('appleUrlLabel')} type="url" value={appleUrl} onChange={(e) => setAppleUrl(e.target.value)} placeholder="https://podcasts.apple.com/…" help={t('directoryUrlHelp')} />
      <TextField label={t('spotifyUrlLabel')} type="url" value={spotifyUrl} onChange={(e) => setSpotifyUrl(e.target.value)} placeholder="https://open.spotify.com/show/…" />
      <TextField label={t('amazonUrlLabel')} type="url" value={amazonUrl} onChange={(e) => setAmazonUrl(e.target.value)} placeholder="https://music.amazon.com/podcasts/…" />
      <div className="action-bar">
        <Button variant="primary" type="submit" disabled={busy || !title.trim() || !author.trim()}>{t('saveShow')}</Button>
        <Button variant="quiet" onClick={onCancel}>{t('common:cancel')}</Button>
      </div>
      {pickerOpen ? (
        <MediaPickerDialog
          orgId={orgId}
          // Review F2 — store the root-relative asset PATH (`serveUrl`), the
          // shape every podcasts consumer expects (feed imageUrl, prerender
          // og:image, assetUrl). A bare serveToken broke all of them.
          onSelect={(asset) => { if (asset.serveUrl) setImageMediaRef(asset.serveUrl); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </form>
  );
}

export function ShowsManager({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('podcasts');
  const [shows, setShows] = useState<PodcastShow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // R2 SP-2 — which show's edit form is open (one at a time).
  const [editingId, setEditingId] = useState<string | null>(null);

  // Create form
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [explicit, setExplicit] = useState(false);
  const [busy, setBusy] = useState(false);

  // SP-9 (round 3) — the read reports capability from the SAME predicate the
  // write routes enforce, so actions a read-only member could only 403 on are
  // never rendered. Defaults TRUE (older wire omits it) — the server stays the
  // authority; this is a courtesy layer, and hiding working actions would be
  // the worse failure.
  const [canWrite, setCanWrite] = useState(true);
  // PODU-2 (ADR 0603 §5) — this was `NBU-2`'s exact shape. The failure card
  // rendered ABOVE a skeleton that spun forever, because `shows` stayed `null` on
  // the catch; `error` was never cleared; and there was no retry, so the only
  // recovery was a page reload.
  //
  // Ported from the notebooks fix, with its CORRECTED posture:
  //   - `error` is cleared at the START of every attempt, so a card can never
  //     outlive the failure it describes;
  //   - `shows` is set to `[]` on failure so the skeleton STOPS — and the empty
  //     state is SUPPRESSED while `error` stands (below), because "no shows yet"
  //     is a claim about the server made from a read that never landed. Stopping
  //     the skeleton without that suppression would trade a hang for a lie;
  //   - the card carries a RETRY that re-runs this exact read.
  const [reloading, setReloading] = useState(false);
  const load = useCallback(() => {
    if (!orgId) return;
    setError(null);
    void listShowsWithCapability(orgId)
      .then((r) => { setShows(r.shows); setCanWrite(r.canWrite); })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setShows([]); })
      .finally(() => setReloading(false));
  }, [orgId]);
  const retryLoad = useCallback(() => { setReloading(true); load(); }, [load]);
  useEffect(() => { load(); }, [load]);

  const submit = useCallback(async () => {
    if (!orgId || !title.trim() || !author.trim()) return;
    setBusy(true);
    try {
      await createShow({
        orgId, title: title.trim(), author: author.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(category.trim() ? { category: category.trim() } : {}),
        ...(ownerEmail.trim() ? { ownerEmail: ownerEmail.trim() } : {}),
        explicit,
      });
      setTitle(''); setAuthor(''); setDescription(''); setCategory(''); setOwnerEmail(''); setExplicit(false);
      toast.success(t('showCreated'));
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('createFailed'));
    } finally { setBusy(false); }
  }, [orgId, title, author, description, category, ownerEmail, explicit, load, t]);

  const onTogglePublish = useCallback(async (show: PodcastShow) => {
    try { await setShowPublished(show.id, !show.published); load(); }
    catch (err) { toast.error(err instanceof Error ? err.message : t('publishFailed')); }
  }, [load, t]);

  const onDelete = useCallback(async (show: PodcastShow) => {
    if (!(await confirm({ title: t('confirmDeleteShow'), danger: true }))) return;
    try { await deleteShow(show.id); load(); }
    catch (err) { toast.error(err instanceof Error ? err.message : t('deleteFailed')); }
  }, [load, t]);

  const copyFeed = useCallback(async (show: PodcastShow) => {
    try { await navigator.clipboard.writeText(feedUrl(orgId, show.slug)); toast.success(t('feedUrlCopied')); }
    catch { toast.error(t('copyFailed')); }
  }, [orgId, t]);

  return (
    <div className="surface-card u-p-4 u-grid u-gap-3">
      <h2 className="nb-panel__title"><LinkIcon size={16} /> {t('showsTitle')}</h2>
      {error ? (
        <StateCard
          announce
          icon={<LinkIcon size={20} />}
          title={t('loadFailed')}
          body={error}
          action={<Button variant="secondary" loading={reloading} onClick={retryLoad}>{t('common:retry')}</Button>}
        />
      ) : null}
      {shows === null ? <Skeleton height={40} /> : shows.length === 0 ? (
        // PODU-2 — suppressed while the failure card stands: an unread list is not
        // an empty one, and this is the panel's only other claim about the server.
        error ? null : <StateCard icon={<LinkIcon size={20} />} title={t('showsTitle')} body={t('noShows')} />
      ) : (
        <ul className="nb-list">
          {shows.map((s) => {
            const missing = missingRequiredFields(s, t);
            return (
              <li key={s.id} className="nb-list__item u-grid u-gap-2">
                <div className="action-bar u-justify-between">
                  <span>
                    <strong>{s.title}</strong> · {s.author}{' '}
                    <span className={s.published ? 'chip chip--success' : 'chip chip--muted'}>
                      {s.published ? t('showPublished') : t('showDraft')}
                    </span>
                  </span>
                  {canWrite ? <span className="action-bar">
                    <Button variant="quiet" size="sm" onClick={() => setEditingId((cur) => (cur === s.id ? null : s.id))} aria-expanded={editingId === s.id}>
                      <PencilIcon size={14} /> {t('editShow')}
                    </Button>
                    <Button variant="quiet" size="sm" onClick={() => void onTogglePublish(s)}>
                      {s.published ? t('unpublish') : <><CheckIcon size={14} /> {t('publish')}</>}
                    </Button>
                    <Button variant="quiet" size="sm" onClick={() => void onDelete(s)} aria-label={t('common:delete')}><TrashIcon size={14} /></Button>
                  </span> : null}
                </div>
                {missing.length > 0 ? (
                  <Notice variant="warning">{t('validityWarn', { fields: missing.join(', ') })}</Notice>
                ) : null}
                {editingId === s.id ? (
                  <EditShowForm show={s} orgId={orgId} onSaved={() => { setEditingId(null); load(); }} onCancel={() => setEditingId(null)} />
                ) : null}
                {s.category?.trim() && !isKnownCategory(s.category) ? (
                  <Notice variant="warning">{t('validityCategoryNonTaxonomy', { category: s.category.trim() })}</Notice>
                ) : null}
                {s.published ? (
                  <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
                    <code className="u-text-sm u-break-all">{feedUrl(orgId, s.slug)}</code>
                    <Button variant="quiet" size="sm" className="u-ml-auto" onClick={() => void copyFeed(s)}>
                      <CopyIcon size={14} /> {t('copyFeedUrl')}
                    </Button>
                    <a className="btn-ghost btn-sm" href={`/pod/${encodeURIComponent(orgId)}/${encodeURIComponent(s.slug)}`} target="_blank" rel="noreferrer">
                      <ExternalLinkIcon size={14} /> {t('viewPublicPage')}
                    </a>
                  </div>
                ) : null}
                {s.published ? <p className="u-text-sm muted">{t('submitGuidance')}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
      {/* SP-9 — a read-only member sees the shows, never a create form whose
          submit can only 403. One line says why the controls are absent. */}
      {canWrite ? <form className="u-grid u-gap-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h3 className="nb-panel__title">{t('createShowHeading')}</h3>
        <TextField label={t('showTitleLabel')} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('showTitlePlaceholder')} />
        <TextField label={t('showAuthorLabel')} value={author} onChange={(e) => setAuthor(e.target.value)} placeholder={t('showAuthorPlaceholder')} />
        <TextareaField label={t('showDescriptionLabel')} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        <SelectField label={t('showCategoryLabel')} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{t('showCategoryPlaceholder')}</option>
          {APPLE_PODCAST_CATEGORIES.map((c) => (
            <option key={c} value={c}>{t(CATEGORY_LABEL_KEYS[c] ?? c)}</option>
          ))}
        </SelectField>
        <TextField label={t('showOwnerEmailLabel')} type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="podcast@acme.test" />
        <SelectField label={t('showExplicitLabel')} value={explicit ? 'yes' : 'no'} onChange={(e) => setExplicit(e.target.value === 'yes')}>
          <option value="no">{t('explicitNo')}</option>
          <option value="yes">{t('explicitYes')}</option>
        </SelectField>
        <Button variant="primary" type="submit" disabled={busy || !title.trim() || !author.trim()}><PlusIcon size={14} /> {t('createShow')}</Button>
      </form> : null}
    </div>
  );
}
