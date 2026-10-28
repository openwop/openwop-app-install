/**
 * ADR 0993 D8 — the Team library tab of `/prompts`: the org prompt library
 * (`/host/openwop-app/prompts/orgs/:orgId/entries`) that the chat's `/p-<slug>`
 * commands read. Before this, no screen could create, edit, set the visibility
 * of or delete a library entry; the page only edited prompts in this browser.
 *
 * Publishing writes the text into the library's own store (D4), or binds a
 * template that already lives in the prompt store. Every edit sends the revision
 * it opened, so a stale edit is refused rather than applied (D3). After a write,
 * the chat commands are told to re-read.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button.js';
import { IconButton } from '../ui/IconButton.js';
import { Modal } from '../ui/Modal.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { Skeleton } from '../ui/Skeleton.js';
import { SelectField, TextField, TextareaField } from '../ui/Field.js';
import { OrgSelectionState } from '../ui/OrgSelectionState.js';
import { useOrgSelection } from '../ui/useOrgSelection.js';
import { confirm } from '../ui/confirm.js';
import { toast } from '../ui/toast.js';
import { GlobeIcon, LockIcon, PencilIcon, TrashIcon, UsersIcon } from '../ui/icons/index.js';
import { listOrgs, type PromptEntry, type PromptKind, type PromptVisibility } from '../client/promptLibraryClient.js';
import { stageComposerDraft } from '../chat/composerSeed.js';
import { invalidatePromptCommands } from '../chat/promptCommands.js';
import {
  TeamLibraryError, deleteTeamPrompt, editTeamPrompt, listTeamPrompts, publishTeamPrompt, renderTeamPrompt,
} from './teamLibraryClient.js';

/** What "Share with team" on a My-prompts card hands over. */
export interface PublishDraft {
  name: string;
  description?: string;
  /** A prompt kept in this browser: its text is published into the library. */
  template?: { kind: PromptKind; text: string };
  /** A prompt already in the prompt store: the entry binds it. */
  promptRef?: string;
}

type Editing = { mode: 'publish'; draft: PublishDraft } | { mode: 'edit'; entry: PromptEntry };

export function TeamLibrary({ draft, onDraftTaken }: { draft: PublishDraft | null; onDraftTaken: () => void }): JSX.Element {
  const { t } = useTranslation('prompts');
  const navigate = useNavigate();
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection(listOrgs);
  const [entries, setEntries] = useState<PromptEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // A reload after a write refreshes in the BACKGROUND (grade-ux P61UX-5): the
  // cards stay mounted, so the modal's focus return still has its trigger. Only
  // an org switch shows the skeleton.
  const [loadedOrg, setLoadedOrg] = useState('');
  useEffect(() => {
    if (!orgId) return undefined;
    let cancelled = false;
    if (loadedOrg !== orgId) setEntries(null);
    setFailed(false);
    listTeamPrompts(orgId)
      .then((list) => { if (!cancelled) { setEntries(list); setLoadedOrg(orgId); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
    // `loadedOrg` is read, not tracked: tracking it would re-fetch after every load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, nonce]);

  // A "Share with team" from the My-prompts tab opens the publish form here.
  useEffect(() => {
    if (draft) { setEditing({ mode: 'publish', draft }); onDraftTaken(); }
  }, [draft, onDraftTaken]);

  const afterWrite = useCallback(() => { invalidatePromptCommands(); reload(); }, [reload]);

  async function openInChat(e: PromptEntry): Promise<void> {
    try {
      stageComposerDraft(await renderTeamPrompt(orgId, e.entryId));
      navigate('/chat');
    } catch (err) {
      if (err instanceof TeamLibraryError && err.status === 404) { toast.error(t('teamGone')); reload(); return; }
      toast.error(t('teamUseFailed'));
    }
  }

  async function remove(e: PromptEntry): Promise<void> {
    const ok = await confirm({ title: t('teamDeleteTitle', { name: e.name }), body: t('teamDeleteBody'), confirmLabel: t('deletePromptButton'), danger: true });
    if (!ok) return;
    try {
      await deleteTeamPrompt(orgId, e.entryId);
      toast.success(t('teamDeleted', { name: e.name }));
      afterWrite();
    } catch (err) {
      if (err instanceof TeamLibraryError && err.status === 403) toast.error(t('teamForbidden'));
      else if (err instanceof TeamLibraryError && err.status === 404) { toast.error(t('teamGone')); reload(); }
      else toast.error(t('teamDeleteFailed'));
    }
  }

  return (
    <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs} emptyBody={t('teamOrgsEmptyClause')} failedBody={t('teamOrgsFailedClause')} icon={<UsersIcon />}>
      <div className="page-stack">
        <div className="filterbar" role="group" aria-label={t('teamToolbarAria')}>
          {orgs && orgs.length > 1 ? (
            <select className="ui-input filterbar-select" aria-label={t('teamOrgPickerAria')} value={orgId} onChange={(ev) => setOrgId(ev.target.value)}>
              {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name || o.orgId}</option>)}
            </select>
          ) : null}
          <span className="muted u-fs-13">{t('teamHint')}</span>
          <Button variant="primary" className="u-ml-auto" onClick={() => setEditing({ mode: 'publish', draft: { name: '', template: { kind: 'user', text: '' } } })}>
            {t('teamPublishNew')}
          </Button>
        </div>

        {failed ? (
          <StateCard announce title={t('teamLoadFailedTitle')} body={t('teamLoadFailedBody')} action={<Button variant="secondary" size="sm" onClick={reload}>{t('retry')}</Button>} />
        ) : entries === null ? (
          <div role="status" aria-busy="true" aria-label={t('teamLoadingAria')} className="card-grid">
            {Array.from({ length: 3 }, (_, i) => <div className="surface-card u-grid u-gap-2" key={i}><Skeleton width="50%" height={16} /><Skeleton width="80%" /></div>)}
          </div>
        ) : entries.length === 0 ? (
          <StateCard
            icon={<UsersIcon size={26} />}
            title={t('teamEmptyTitle')}
            body={t('teamEmptyBody')}
            action={<Button variant="primary" onClick={() => setEditing({ mode: 'publish', draft: { name: '', template: { kind: 'user', text: '' } } })}>{t('teamPublishNew')}</Button>}
          />
        ) : (
          <div className="card-grid">
            {entries.map((e) => (
              <div key={e.entryId} className="surface-card u-grid u-gap-2">
                <div className="action-bar u-justify-between u-items-baseline u-gap-2">
                  <strong className="prompt-list-item-name">{e.name}</strong>
                  <VisibilityChip visibility={e.visibility ?? 'private'} />
                </div>
                {e.description ? <div className="muted prompt-list-item-desc">{e.description}</div> : null}
                <div className="action-bar u-gap-2 u-wrap">
                  {e.ownedByCaller ? <span className="chip chip--muted">{t('teamYours')}</span> : null}
                  {e.available === false ? <span className="chip chip--warning" id={`team-unavailable-${e.entryId}`} title={t('teamUnavailableHelp')}>{t('teamUnavailable')}</span> : null}
                  {e.promptRef ? <code className="prompt-list-item-id">{e.promptRef}</code> : null}
                </div>
                <div className="action-bar u-gap-2 u-justify-end">
                  <Button
                    variant="secondary" size="sm" disabled={e.available === false}
                    {...(e.available === false ? { 'aria-describedby': `team-unavailable-${e.entryId}` } : {})}
                    onClick={() => { void openInChat(e); }}
                  >{t('teamUseInChat')}</Button>
                  <IconButton label={t('editLabel', { name: e.name })} icon={<PencilIcon size={15} />} onClick={() => setEditing({ mode: 'edit', entry: e })} />
                  <IconButton label={t('deleteLabel', { name: e.name })} className="icon-button u-text-danger" icon={<TrashIcon size={15} />} onClick={() => { void remove(e); }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing ? (
        <TeamPromptEditor
          orgId={orgId}
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); afterWrite(); }}
          onReloadLatest={() => { setEditing(null); reload(); }}
        />
      ) : null}
    </OrgSelectionState>
  );
}

function VisibilityChip({ visibility }: { visibility: PromptVisibility }): JSX.Element {
  const { t } = useTranslation('prompts');
  if (visibility === 'private') return <span className="chip chip--muted u-nowrap"><LockIcon size={12} aria-hidden /> {t('visibilityPrivate')}</span>;
  if (visibility === 'shared') return <span className="chip chip--muted u-nowrap"><GlobeIcon size={12} aria-hidden /> {t('visibilityShared')}</span>;
  return <span className="chip chip--muted u-nowrap"><UsersIcon size={12} aria-hidden /> {t('visibilityOrg')}</span>;
}

function TeamPromptEditor({ orgId, editing, onClose, onSaved, onReloadLatest }: {
  orgId: string;
  editing: Editing;
  onClose: () => void;
  onSaved: () => void;
  /** After a stale-edit conflict: drop this form and reload the library. */
  onReloadLatest: () => void;
}): JSX.Element {
  const { t } = useTranslation('prompts');
  const entry = editing.mode === 'edit' ? editing.entry : null;
  const draft = editing.mode === 'publish' ? editing.draft : null;
  const [name, setName] = useState(entry?.name ?? draft?.name ?? '');
  const [description, setDescription] = useState(entry?.description ?? draft?.description ?? '');
  const [kind, setKind] = useState<PromptKind>(draft?.template?.kind ?? 'user');
  const [text, setText] = useState(entry?.body?.text ?? draft?.template?.text ?? '');
  const [visibility, setVisibility] = useState<PromptVisibility>(entry?.visibility ?? 'org');
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  // Visibility is the ACL, so only the entry's owner may change it (D2).
  const mayChangeVisibility = !entry || entry.ownedByCaller === true;
  // A published entry whose pinned body is gone has no kind left to inherit.
  const needsKind = !entry || (!entry.promptRef && !entry.body);
  // A binding's text lives in the prompt store, not in the library (D4).
  const bindsTemplate = Boolean(entry ? entry.promptRef : draft?.promptRef);
  const textEditable = !bindsTemplate;

  async function save(): Promise<void> {
    setError(null);
    if (!name.trim()) { setError(t('errorNameRequired')); return; }
    if (textEditable && !text.trim()) { setError(t('errorTextRequired')); return; }
    setSaving(true);
    try {
      if (entry) {
        await editTeamPrompt(orgId, entry.entryId, {
          name: name.trim(),
          description: description.trim(),
          ...(mayChangeVisibility ? { visibility } : {}),
          ...(textEditable && text !== entry.body?.text ? { text, ...(needsKind ? { kind } : {}) } : {}),
          expectedRevision: entry.revision ?? 1,
        });
        toast.success(t('teamSaved', { name: name.trim() }));
      } else {
        await publishTeamPrompt(orgId, {
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          visibility,
          ...(draft?.promptRef ? { promptRef: draft.promptRef } : { template: { kind, text } }),
        });
        toast.success(t('teamPublished', { name: name.trim() }));
      }
      onSaved();
    } catch (err) {
      // A stale edit keeps the form and what was typed (grade-ux P61UX-4); the
      // notice offers the reload, which the user chooses after copying anything.
      if (err instanceof TeamLibraryError && err.code === 'conflict') { setStale(true); setError(t('teamConflict')); return; }
      if (err instanceof TeamLibraryError && err.status === 403) { setError(t('teamForbidden')); return; }
      setError(t('teamSaveFailed'));
    } finally {
      setSaving(false);
    }
  }

  const title = entry ? t('teamEditTitle') : t('teamPublishTitle');
  return (
    <Modal label={title} onClose={onClose}>
      <div className="modal-header">
        <h3>{title}</h3>
        <Button variant="secondary" onClick={onClose}>{t('common:cancel')}</Button>
      </div>
      <div className="modal-body">
        {error ? (
          <Notice variant={stale ? 'warning' : 'error'} announce={error}>
            {error}{stale ? <> <Button variant="link" onClick={onReloadLatest}>{t('teamConflictReload')}</Button></> : null}
          </Notice>
        ) : null}
        <TextField label={t('fieldName')} required value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} autoFocus />
        <TextField label={t('fieldDescription')} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('descriptionPlaceholder')} />
        <SelectField
          label={t('fieldVisibility')} value={visibility} disabled={!mayChangeVisibility}
          onChange={(e) => setVisibility(e.target.value as PromptVisibility)}
          help={mayChangeVisibility ? t('visibilityHelp') : t('teamVisibilityOwnerOnly')}
        >
          <option value="org">{t('visibilityOrg')}</option>
          <option value="private">{t('visibilityPrivate')}</option>
          {visibility === 'shared' || entry?.visibility === 'shared' ? <option value="shared">{t('visibilityShared')}</option> : null}
        </SelectField>
        {textEditable && needsKind ? (
          <SelectField label={t('fieldKind')} value={kind} onChange={(e) => setKind(e.target.value as PromptKind)}>
            <option value="system">{t('kindSystem')}</option>
            <option value="user">{t('kindUser')}</option>
            <option value="few-shot">{t('kindFewShot')}</option>
            <option value="schema-hint">{t('kindSchemaHint')}</option>
          </SelectField>
        ) : null}
        {textEditable ? (
          <TextareaField label={t('fieldPromptText')} required value={text} onChange={(e) => setText(e.target.value)} rows={10} />
        ) : (
          <p className="muted">{t('teamBindsTemplate', { ref: entry?.promptRef ?? draft?.promptRef ?? '' })}</p>
        )}
        <div className="action-bar u-gap-2 u-justify-end u-mt-4">
          <Button variant="secondary" onClick={onClose}>{t('common:cancel')}</Button>
          <Button variant="primary" onClick={() => { void save(); }} loading={saving} disabled={stale}>{saving ? t('teamSaving') : entry ? t('saveChanges') : t('teamPublishButton')}</Button>
        </div>
      </div>
    </Modal>
  );
}
