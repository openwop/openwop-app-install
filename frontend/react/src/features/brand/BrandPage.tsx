/**
 * Brand & Guardrails page (ADR 0155, Phase 4). A workspace-tier list + editor for
 * the workspace's brands — voice, formality, approved/banned phrases, positioning,
 * per-channel rules, and governance. Composes the shared ui/ cohesion layer
 * (PageHeader / Notice / StateCard / Modal / Field / ConfirmDialog); no bespoke
 * chrome, no raw color literals.
 *
 * @see docs/adr/0155-campaign-studio-brand-guardrails.md
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Modal } from '../../ui/Modal.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { TextField, TextareaField, SelectField } from '../../ui/Field.js';
import { MegaphoneIcon, PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import {
  listBrands, createBrand, updateBrand, deleteBrand, listOrgs,
  BRAND_CHANNELS, FeatureDisabledError,
  type Brand, type BrandChannel, type BrandInput, type BrandLockLevel, type ChannelVoiceRule, type OrgRef,
} from './brandClient.js';

type TFn = ReturnType<typeof useTranslation>['t'];

const FORMALITY_LEVELS = [1, 2, 3, 4, 5] as const;
const LOCK_LEVELS: BrandLockLevel[] = ['none', 'partial', 'full'];

const splitLines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
const joinLines = (a: string[]): string => a.join('\n');

export function BrandPage(): JSX.Element {
  const { t } = useTranslation('brand');
  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Brand | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Brand | null>(null);

  const refresh = useCallback(async () => {
    try { setBrands(await listBrands()); setDisabled(false); }
    catch (e) {
      if (e instanceof FeatureDisabledError) { setDisabled(true); setBrands([]); return; }
      setError(e instanceof Error ? e.message : t('loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    void listOrgs().then(setOrgs).catch(() => {});
  }, [refresh]);

  const remove = useCallback(async (b: Brand) => {
    try { await deleteBrand(b.id); setConfirmDelete(null); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : t('saveFailed')); }
  }, [refresh, t]);

  if (disabled) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <StateCard icon={<MegaphoneIcon size={22} />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('lede')}
        actions={brands && brands.length > 0 ? (
          <button type="button" className="btn-primary btn-sm" onClick={() => setEditing('new')}>
            <PlusIcon size={13} /> {t('newBrand')}
          </button>
        ) : undefined}
      />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {brands === null ? (
        <StateCard icon={<MegaphoneIcon size={20} />} title={t('loading')} loading />
      ) : brands.length === 0 ? (
        orgs.length === 0 ? (
          <StateCard icon={<MegaphoneIcon size={22} />} title={t('noOrgTitle')} body={t('noOrgBody')} />
        ) : (
          <StateCard
            icon={<MegaphoneIcon size={22} />}
            title={t('emptyTitle')}
            body={t('emptyBody')}
            action={<button type="button" className="btn-primary btn-sm" onClick={() => setEditing('new')}><PlusIcon size={13} /> {t('createFirst')}</button>}
          />
        )
      ) : (
        <ul className="surface-card list-view u-list-none u-m-0">
          {brands.map((b) => (
            <BrandRow key={b.id} brand={b} t={t} onEdit={() => setEditing(b)} onDelete={() => setConfirmDelete(b)} />
          ))}
        </ul>
      )}

      {editing ? (
        <BrandEditor
          brand={editing === 'new' ? null : editing}
          orgs={orgs}
          t={t}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await refresh(); }}
          onError={setError}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title={t('deleteConfirmTitle')}
          body={t('deleteConfirmBody')}
          confirmLabel={t('common:delete')}
          danger
          onConfirm={() => { void remove(confirmDelete); }}
          onCancel={() => setConfirmDelete(null)}
        />
      ) : null}
    </div>
  );
}

function BrandRow({ brand, t, onEdit, onDelete }: { brand: Brand; t: TFn; onEdit: () => void; onDelete: () => void }): JSX.Element {
  const banned = brand.keyPhrases.bannedPhrases.length;
  const channels = brand.channelVoiceRules.length;
  return (
    <li className="list-row">
      <button type="button" className="list-row-id" onClick={onEdit}>
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name u-fw-600">{brand.name}</span>
            {brand.status === 'archived' ? <span className="chip chip--muted">{t('archivedChip')}</span> : null}
            {brand.governance.lockLevel !== 'none' ? <span className="chip chip--warning">{t('lockedChip')}</span> : null}
          </span>
          {brand.description ? <span className="u-fs-13 u-text-muted">{brand.description}</span> : null}
        </span>
      </button>
      <div className="list-row-name-line">
        <span className="chip chip--muted">{t('formalityChip', { level: brand.voiceProfile.formalityLevel })}</span>
        {banned > 0 ? <span className="chip chip--danger">{t('bannedChip', { count: banned })}</span> : null}
        {channels > 0 ? <span className="chip chip--accent">{t('channelsChip', { count: channels })}</span> : null}
      </div>
      <button type="button" className="ghost btn-sm" aria-label={t('common:delete')} onClick={onDelete}><TrashIcon size={15} /></button>
    </li>
  );
}

interface EditorState {
  orgId: string;
  name: string;
  description: string;
  voice: string;
  formalityLevel: number;
  guidelines: string;
  approved: string;
  banned: string;
  tagline: string;
  elevatorPitch: string;
  channelRules: ChannelVoiceRule[];
  lockLevel: BrandLockLevel;
}

function initialState(brand: Brand | null, orgs: OrgRef[]): EditorState {
  if (!brand) {
    return {
      orgId: orgs[0]?.orgId ?? '', name: '', description: '', voice: '', formalityLevel: 3, guidelines: '',
      approved: '', banned: '', tagline: '', elevatorPitch: '', channelRules: [], lockLevel: 'none',
    };
  }
  return {
    orgId: brand.orgId,
    name: brand.name,
    description: brand.description,
    voice: brand.voiceProfile.voice,
    formalityLevel: brand.voiceProfile.formalityLevel,
    guidelines: brand.voiceProfile.guidelines,
    approved: joinLines(brand.keyPhrases.approvedTaglines),
    banned: joinLines(brand.keyPhrases.bannedPhrases),
    tagline: brand.positioning.tagline,
    elevatorPitch: brand.positioning.elevatorPitch,
    channelRules: brand.channelVoiceRules,
    lockLevel: brand.governance.lockLevel,
  };
}

function BrandEditor({ brand, orgs, t, onClose, onSaved, onError }: {
  brand: Brand | null; orgs: OrgRef[]; t: TFn;
  onClose: () => void; onSaved: () => void; onError: (m: string) => void;
}): JSX.Element {
  const [s, setS] = useState<EditorState>(() => initialState(brand, orgs));
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof EditorState>(k: K, v: EditorState[K]): void => setS((p) => ({ ...p, [k]: v }));

  const addRule = (): void => {
    const used = new Set(s.channelRules.map((r) => r.channel));
    const next = BRAND_CHANNELS.find((c) => !used.has(c));
    if (next) set('channelRules', [...s.channelRules, { channel: next, tone: '', samplePhrases: [], avoidPhrases: [] }]);
  };
  const updateRule = (i: number, patch: Partial<ChannelVoiceRule>): void =>
    set('channelRules', s.channelRules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  // maxLength is exact-optional (number, not number|undefined) — clearing it must
  // OMIT the key, not assign undefined.
  const setRuleMaxLength = (i: number, raw: string): void =>
    set('channelRules', s.channelRules.map((r, j) => {
      if (j !== i) return r;
      if (!raw) { const { maxLength: _omit, ...rest } = r; return rest; }
      return { ...r, maxLength: Number(raw) };
    }));
  const removeRule = (i: number): void => set('channelRules', s.channelRules.filter((_, j) => j !== i));

  const save = useCallback(async () => {
    setSaving(true);
    const payload: BrandInput = {
      name: s.name,
      description: s.description,
      voiceProfile: { voice: s.voice, formalityLevel: s.formalityLevel, guidelines: s.guidelines },
      keyPhrases: { approvedTaglines: splitLines(s.approved), bannedPhrases: splitLines(s.banned) },
      positioning: { tagline: s.tagline, elevatorPitch: s.elevatorPitch },
      channelVoiceRules: s.channelRules,
      governance: { lockLevel: s.lockLevel },
    };
    try {
      if (brand) await updateBrand(brand.id, payload);
      else await createBrand({ ...payload, orgId: s.orgId });
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : t('saveFailed'));
      setSaving(false);
    }
  }, [brand, s, onSaved, onError, t]);

  const canSave = s.name.trim().length > 0 && (brand !== null || s.orgId.length > 0);

  return (
    <Modal label={brand ? t('editorEditTitle') : t('editorCreateTitle')} onClose={onClose} showClose>
      <h2 className="u-mt-0">{brand ? t('editorEditTitle') : t('editorCreateTitle')}</h2>
      <form onSubmit={(e) => { e.preventDefault(); if (canSave && !saving) void save(); }}>
        <fieldset className="u-mb-4 u-border-none u-p-0">
          <legend className="u-fw-600 u-mb-2">{t('secIdentity')}</legend>
          {!brand ? (
            <SelectField label={t('fieldOrg')} value={s.orgId} onChange={(e) => set('orgId', e.target.value)} required>
              {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
            </SelectField>
          ) : null}
          <TextField label={t('fieldName')} value={s.name} placeholder={t('fieldNamePlaceholder')} onChange={(e) => set('name', e.target.value)} required />
          <TextareaField label={t('fieldDescription')} value={s.description} rows={2} onChange={(e) => set('description', e.target.value)} />
        </fieldset>

        <fieldset className="u-mb-4 u-border-none u-p-0">
          <legend className="u-fw-600 u-mb-2">{t('secVoice')}</legend>
          <TextField label={t('fieldVoice')} value={s.voice} placeholder={t('fieldVoicePlaceholder')} onChange={(e) => set('voice', e.target.value)} />
          <SelectField label={t('fieldFormality')} value={String(s.formalityLevel)} onChange={(e) => set('formalityLevel', Number(e.target.value))}>
            {FORMALITY_LEVELS.map((n) => <option key={n} value={n}>{n} — {t(`formality_${n}`)}</option>)}
          </SelectField>
          <TextareaField label={t('fieldGuidelines')} help={t('fieldGuidelinesHelp')} value={s.guidelines} rows={3} onChange={(e) => set('guidelines', e.target.value)} />
        </fieldset>

        <fieldset className="u-mb-4 u-border-none u-p-0">
          <legend className="u-fw-600 u-mb-2">{t('secPhrases')}</legend>
          <TextareaField label={t('fieldApproved')} help={t('fieldApprovedHelp')} value={s.approved} rows={3} onChange={(e) => set('approved', e.target.value)} />
          <TextareaField label={t('fieldBanned')} help={t('fieldBannedHelp')} value={s.banned} rows={3} onChange={(e) => set('banned', e.target.value)} />
        </fieldset>

        <fieldset className="u-mb-4 u-border-none u-p-0">
          <legend className="u-fw-600 u-mb-2">{t('secPositioning')}</legend>
          <TextField label={t('fieldTagline')} value={s.tagline} onChange={(e) => set('tagline', e.target.value)} />
          <TextareaField label={t('fieldElevatorPitch')} value={s.elevatorPitch} rows={2} onChange={(e) => set('elevatorPitch', e.target.value)} />
        </fieldset>

        <fieldset className="u-mb-4 u-border-none u-p-0">
          <legend className="u-fw-600 u-mb-2">{t('secChannels')}</legend>
          {s.channelRules.map((r, i) => (
            <div key={i} className="u-flex u-items-end u-gap-2 u-mb-2 u-flex-wrap">
              <SelectField label={t('fieldChannel')} value={r.channel} onChange={(e) => updateRule(i, { channel: e.target.value as BrandChannel })}>
                {BRAND_CHANNELS.map((c) => <option key={c} value={c}>{t(`channel_${c}`)}</option>)}
              </SelectField>
              <TextField label={t('fieldTone')} value={r.tone} onChange={(e) => updateRule(i, { tone: e.target.value })} />
              <TextField label={t('fieldMaxLength')} type="number" value={r.maxLength ?? ''} onChange={(e) => setRuleMaxLength(i, e.target.value)} />
              <button type="button" className="ghost btn-sm" aria-label={t('removeRule')} onClick={() => removeRule(i)}><TrashIcon size={15} /></button>
            </div>
          ))}
          {s.channelRules.length < BRAND_CHANNELS.length ? (
            <button type="button" className="secondary btn-sm" onClick={addRule}><PlusIcon size={13} /> {t('addChannelRule')}</button>
          ) : null}
        </fieldset>

        <fieldset className="u-mb-4 u-border-none u-p-0">
          <legend className="u-fw-600 u-mb-2">{t('secGovernance')}</legend>
          <SelectField label={t('fieldLockLevel')} value={s.lockLevel} onChange={(e) => set('lockLevel', e.target.value as BrandLockLevel)}>
            {LOCK_LEVELS.map((l) => <option key={l} value={l}>{t(`lock_${l}`)}</option>)}
          </SelectField>
        </fieldset>

        <div className="action-bar u-flex u-gap-2 u-justify-end">
          <button type="button" className="secondary btn-sm" onClick={onClose}>{t('common:cancel')}</button>
          <button type="submit" className="btn-primary btn-sm" disabled={!canSave || saving}>{t('common:save')}</button>
        </div>
      </form>
    </Modal>
  );
}
