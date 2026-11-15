/**
 * ADR 1123 — "Add existing person": put someone who already has an account in
 * this org, bound to their sign-in at once, with no email round trip.
 *
 * The list is what the server offers (`member-candidates`): people from orgs
 * the caller can act in. The filter box only narrows that list and never
 * searches beyond it. A host superadmin also gets an exact-email lookup, whose
 * miss reads the same whether there is no account or it is not addable.
 * `LinkAccountControl` binds an unbound roster row the same way.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { SelectField, TextField } from '../ui/Field.js';
import { Notice } from '../ui/Notice.js';
import { UserIcon } from '../ui/icons/index.js';
import { NEUTRAL_CHIP } from './orgUi.js';
import { addExistingMember, linkMember, listMemberCandidates, lookupMemberByEmail, type Addee, type LookupCandidate, type MemberCandidate } from './addExistingClient.js';

const label = (c: { displayName: string; email?: string }): string => (c.email && c.email !== c.displayName ? `${c.displayName} · ${c.email}` : c.displayName);

/** The shared picker body: the offered people, plus a superadmin's lookup. */
function PersonChooser({ orgId, purpose, isSuperadmin, value, onChange }: {
  orgId: string;
  purpose: 'add' | 'link';
  isSuperadmin: boolean;
  value: Addee | null;
  onChange: (who: Addee | null) => void;
}): JSX.Element {
  const { t } = useTranslation('orgs');
  const [candidates, setCandidates] = useState<MemberCandidate[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [filter, setFilter] = useState('');
  const [email, setEmail] = useState('');
  const [found, setFound] = useState<LookupCandidate | null | undefined>(undefined);
  const [lookupFailed, setLookupFailed] = useState(false);

  useEffect(() => {
    let live = true;
    listMemberCandidates(orgId, purpose)
      .then((c) => { if (live) setCandidates(c); })
      .catch(() => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, [orgId, purpose]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (candidates ?? []).filter((c) => !q || label(c).toLowerCase().includes(q));
  }, [candidates, filter]);
  const picked = value && 'candidateId' in value ? value.candidateId : '';

  const lookUp = async (): Promise<void> => {
    setLookupFailed(false);
    try {
      const c = await lookupMemberByEmail(orgId, email.trim());
      setFound(c);
      onChange(c ? { lookupToken: c.lookupToken } : null);
    } catch {
      setLookupFailed(true);
    }
  };

  return (
    <div className="u-flex u-wrap u-gap-2 u-items-end">
      {loadFailed ? <Notice variant="error" announce={t('addExistingLoadFailed')}>{t('addExistingLoadFailed')}</Notice> : null}
      {candidates !== null && candidates.length === 0 && !isSuperadmin ? <p className="members-muted">{t('addExistingNoneOffered')}</p> : null}
      {candidates !== null && candidates.length > 0 ? (
        <>
          <TextField label={t('addExistingFilterLabel')} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('addExistingFilterPlaceholder')} />
          <SelectField label={t('addExistingPersonLabel')} value={picked} onChange={(e) => { setFound(undefined); onChange(e.target.value ? { candidateId: e.target.value } : null); }}>
            <option value="">{t('addExistingChoose')}</option>
            {shown.map((c) => <option key={c.candidateId} value={c.candidateId}>{label(c)}</option>)}
          </SelectField>
        </>
      ) : null}
      {isSuperadmin ? (
        <span className="u-flex u-gap-2 u-items-end">
          <TextField label={t('addExistingLookupLabel')} type="email" value={email} onChange={(e) => { setEmail(e.target.value); setFound(undefined); }} help={t('addExistingLookupHelp')} />
          <Button variant="secondary" disabled={!email.includes('@')} onClick={() => void lookUp()}>{t('addExistingLookupButton')}</Button>
        </span>
      ) : null}
      {found ? <span className={NEUTRAL_CHIP}>{label(found)}</span> : null}
      {found === null ? <p className="members-muted">{t('addExistingLookupMiss')}</p> : null}
      {lookupFailed ? <Notice variant="error" announce={t('addExistingLookupFailed')}>{t('addExistingLookupFailed')}</Notice> : null}
    </div>
  );
}

export interface AddExistingPersonSectionProps {
  orgId: string;
  canManage: boolean;
  isSuperadmin: boolean;
  assignableRoleIds: string[];
  roleLabel: (id: string) => string;
  onChanged: () => void | Promise<void>;
}

export function AddExistingPersonSection({ orgId, canManage, isSuperadmin, assignableRoleIds, roleLabel, onChanged }: AddExistingPersonSectionProps): JSX.Element | null {
  const { t } = useTranslation('orgs');
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState<Addee | null>(null);
  const [roles, setRoles] = useState<Set<string>>(new Set(['viewer']));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  if (!canManage) return null;

  const submit = async (): Promise<void> => {
    if (!who) return;
    setBusy(true);
    setError(null);
    try {
      await addExistingMember(orgId, who, [...roles]);
      setAdded(true);
      setWho(null);
      setOpen(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('addExistingFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="u-mb-3">
      {added ? <Notice variant="success" announce={t('addExistingAdded')} onDismiss={() => setAdded(false)} dismissLabel={t('common:close')}>{t('addExistingAdded')}</Notice> : null}
      {!open ? (
        <Button variant="secondary" onClick={() => { setOpen(true); setAdded(false); }}>
          <UserIcon size={13} /> {t('addExistingButton')}
        </Button>
      ) : (
        <div className="surface-card">
          <PersonChooser orgId={orgId} purpose="add" isSuperadmin={isSuperadmin} value={who} onChange={setWho} />
          <span className="action-bar u-gap-1-5 u-mt-2">
            {assignableRoleIds.map((role) => (
              <label key={role} className={`${NEUTRAL_CHIP} members-chip-toggle`} data-off={!roles.has(role) || undefined}>
                <input type="checkbox" checked={roles.has(role)} onChange={() => setRoles((s) => { const n = new Set(s); if (n.has(role)) n.delete(role); else n.add(role); return n; })} className="u-mr-1" />
                {roleLabel(role)}
              </label>
            ))}
          </span>
          {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
          <span className="action-bar u-mt-2">
            <Button variant="primary" disabled={!who || busy} onClick={() => void submit()}>{t('addExistingSubmit')}</Button>
            <Button variant="secondary" onClick={() => { setOpen(false); setWho(null); setError(null); }}>{t('common:cancel')}</Button>
          </span>
        </div>
      )}
    </div>
  );
}

/** "Link to account" on a roster row that is tied to nobody's sign-in. */
export function LinkAccountControl({ orgId, memberId, name, isSuperadmin, onChanged }: {
  orgId: string;
  memberId: string;
  name: string;
  isSuperadmin: boolean;
  onChanged: () => void | Promise<void>;
}): JSX.Element {
  const { t } = useTranslation('orgs');
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState<Addee | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) {
    return <Button variant="secondary" onClick={() => setOpen(true)} aria-label={t('linkAccountAriaLabel', { name })}>{t('linkAccountButton')}</Button>;
  }
  const submit = async (): Promise<void> => {
    if (!who) return;
    setBusy(true);
    setError(null);
    try {
      await linkMember(orgId, memberId, who);
      setOpen(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('linkAccountFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="u-mt-2">
      <p className="members-muted">{t('linkAccountHelp')}</p>
      <PersonChooser orgId={orgId} purpose="link" isSuperadmin={isSuperadmin} value={who} onChange={setWho} />
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      <span className="action-bar u-mt-2">
        <Button variant="primary" disabled={!who || busy} onClick={() => void submit()}>{t('linkAccountSubmit')}</Button>
        <Button variant="secondary" onClick={() => { setOpen(false); setWho(null); setError(null); }}>{t('common:cancel')}</Button>
      </span>
    </div>
  );
}
