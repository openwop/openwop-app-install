/**
 * Brand & Guardrails page (ADR 0155, Phase 4). A workspace-tier list + editor for
 * the workspace's brands — voice, formality, approved/banned phrases, positioning,
 * per-channel rules, and governance. Composes the shared ui/ cohesion layer
 * (PageHeader / Notice / StateCard / Modal / Field / ConfirmDialog); no bespoke
 * chrome, no raw color literals.
 *
 * @see docs/adr/0155-campaign-studio-brand-guardrails.md
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Modal } from '../../ui/Modal.js';
import { formatDateTime } from '../../i18n/format.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { TextField, TextareaField, SelectField } from '../../ui/Field.js';
import { MegaphoneIcon, PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import {
  listBrands, createBrand, updateBrand, deleteBrand, listOrgs, getBrandAudit, type BrandAuditRow,
  listBrandFonts, uploadBrandFont, deleteBrandFont,
  BRAND_CHANNELS, FeatureDisabledError,
  type Brand, type BrandChannel, type BrandInput, type BrandLockLevel, type BrandFontMeta, type BrandFontRole, type ChannelVoiceRule, type OrgRef,
} from './brandClient.js';

type TFn = ReturnType<typeof useTranslation>['t'];

const FORMALITY_LEVELS = [1, 2, 3, 4, 5] as const;
const LOCK_LEVELS: BrandLockLevel[] = ['none', 'partial', 'full'];

const splitLines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
const joinLines = (a: string[]): string => a.join('\n');

export function BrandPage(): JSX.Element {
  const { t } = useTranslation('brand');
  const { t: tc } = useTranslation('common');
  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [brandsFailed, setBrandsFailed] = useState(false);
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [orgsFailed, setOrgsFailed] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Brand | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Brand | null>(null);

  const refresh = useCallback(async () => {
    setBrandsFailed(false);
    // R2 BR-SP-3 — a recovered list must not render under a STALE error
    // banner, and a load failure must not dual-message (the announce
    // StateCard below is the load-failure surface; the Notice is for
    // mutations).
    setError(null);
    try { setBrands(await listBrands()); setDisabled(false); }
    catch (e) {
      if (e instanceof FeatureDisabledError) { setDisabled(true); setBrands([]); return; }
      setBrandsFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // BRAND-R2-1 — a failed orgs read must not impersonate "no organization
    // yet": the empty-state branch below tells the user to CREATE an org, and
    // a transient 500 said that to users who already own one.
    void listOrgs().then((o) => { setOrgs(o); setOrgsFailed(false); }).catch(() => setOrgsFailed(true));
  }, [refresh]);

  // R2 BR-SP-2 — the delete failure surfaced ONLY behind the dialog's scrim
  // (the exact BR-G1 class, delete lane): the dialog stayed open with zero
  // feedback and could double-fire. The error now renders IN the dialog and
  // `busy` guards the double-fire.
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const remove = useCallback(async (b: Brand) => {
    setDeleteBusy(true);
    setDeleteError(null);
    try { await deleteBrand(b.id); setConfirmDelete(null); await refresh(); }
    catch (e) { setDeleteError(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setDeleteBusy(false); }
  }, [refresh, t]);

  // §4.5 collection kit (DESIGN.md rule 13): gated name/description search + status facet → separate memo.
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'archived'>('');
  const visibleBrands = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (brands ?? []).filter((b) =>
      (!q || b.name.toLowerCase().includes(q) || b.description.toLowerCase().includes(q))
      && (!statusFilter || b.status === statusFilter));
  }, [brands, query, statusFilter]);
  const clearFilters = useCallback(() => { setQuery(''); setStatusFilter(''); }, []);

  if (disabled) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <StateCard icon={<MegaphoneIcon size={22} />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </div>
    );
  }

  return (
    <div data-walkthrough="brand.page">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('lede')}
        actions={brands && brands.length > 0 ? (
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <PlusIcon size={13} /> {t('newBrand')}
          </Button>
        ) : undefined}
      />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {brands && brands.length > 3 ? (
        <div className="filterbar u-mb-3" role="group" aria-label={t('filterGroup')}>
          <input
            type="search"
            className="ui-input filterbar-search"
            placeholder={t('filterBrandsPlaceholder')}
            aria-label={t('filterBrandsAria')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="ui-input filterbar-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | 'active' | 'archived')} aria-label={t('filterStatusLabel')}>
            <option value="">{t('allStatuses')}</option>
            <option value="active">{t('statusActive')}</option>
            <option value="archived">{t('archivedChip')}</option>
          </select>
        </div>
      ) : null}
      {brands === null ? (
        <StateCard icon={<MegaphoneIcon size={20} />} title={t('loading')} loading />
      ) : brandsFailed ? (
        <StateCard announce icon={<MegaphoneIcon size={22} />} title={tc('loadFailedTitle')} body={tc('loadFailedBody')} />
      ) : brands.length === 0 ? (
        orgs.length === 0 ? (
          orgsFailed ? (
            <StateCard announce icon={<MegaphoneIcon size={22} />} title={tc('loadFailedTitle')} body={tc('loadFailedBody')} />
          ) : (
            <StateCard icon={<MegaphoneIcon size={22} />} title={t('noOrgTitle')} body={t('noOrgBody')} />
          )
        ) : (
          <StateCard
            icon={<MegaphoneIcon size={22} />}
            title={t('emptyTitle')}
            body={t('emptyBody')}
            action={<Button variant="primary" size="sm" onClick={() => setEditing('new')}><PlusIcon size={13} /> {t('createFirst')}</Button>}
          />
        )
      ) : visibleBrands.length === 0 ? (
        <StateCard icon={<MegaphoneIcon size={22} />} title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" size="sm" onClick={clearFilters}>{t('clearFilters')}</Button>} />
      ) : (
        <ul className="surface-card list-view u-list-none u-m-0">
          {visibleBrands.map((b) => (
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
          body={<>
            {t('deleteConfirmBody')}
            {/* Review F4/F5 — an inline role=alert INSIDE the dialog: the
                global announcer lives outside aria-modal (AT may drop it),
                and a block Notice inside ConfirmDialog's <p> is invalid
                nesting. role=alert fires on insertion within the dialog. */}
            {deleteError ? <span role="alert" className="u-text-danger u-fs-13"> {deleteError}</span> : null}
          </>}
          confirmLabel={t('common:delete')}
          danger
          busy={deleteBusy}
          onConfirm={() => { void remove(confirmDelete); }}
          onCancel={() => { setDeleteError(null); setConfirmDelete(null); }}
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
      <Button variant="quiet" size="sm" aria-label={t('common:delete')} onClick={onDelete}><TrashIcon size={15} /></Button>
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
  // BR-G1 — failures raised INSIDE the dialog have to be shown inside it. The
  // parent's <Notice> renders outside `ModalPortal`, i.e. behind the scrim, so a
  // failed save read as a Save button that simply did nothing. `Modal` already
  // exposes an `error` slot for exactly this; the editor just never used it.
  const [editorError, setEditorError] = useState<string | null>(null);
  // R3 BR-SP-7 — the guardrail-change audit trail (wire-only since ADR 0354 P5)
  // gets its reader: a disclosure inside the editor, existing brands only.
  // Failed ≠ empty; loaded lazily on first open.
  const [auditOpen, setAuditOpen] = useState(false);
  const [audit, setAudit] = useState<BrandAuditRow[] | null>(null);
  const [auditFailed, setAuditFailed] = useState(false);
  const loadAudit = (): void => {
    if (!brand) return;
    setAuditFailed(false); setAudit(null);
    void getBrandAudit(brand.id).then(setAudit).catch(() => setAuditFailed(true));
  };
  const toggleAudit = (): void => {
    setAuditOpen((open) => {
      if (!open && audit === null && !auditFailed) loadAudit();
      return !open;
    });
  };
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
  /** Channels already spoken for — see BR-G3 at the channel select below. */
  const usedChannels = new Set(s.channelRules.map((r) => r.channel));

  const save = useCallback(async () => {
    setSaving(true);
    // R2 BR-SP-1 (Blocker) — the backend replaces each provided facet
    // WHOLESALE, so a payload holding only the fields this editor renders
    // silently wiped everything else: a rename reset
    // governance.allowedEditors → [] (partial-lock editors lost access),
    // requireApproval → false, DELETED governance.compliance (the ads
    // blockPublish enforcement switched off by any save), and erased
    // agent-authored voice samplePhrases / keyPhrases.valuePropositions /
    // positioning.differentiators. Every facet now spreads the LOADED brand
    // first and overrides only the fields the editor actually edits.
    const payload: BrandInput = {
      name: s.name,
      description: s.description,
      voiceProfile: { ...brand?.voiceProfile, voice: s.voice, formalityLevel: s.formalityLevel, guidelines: s.guidelines },
      keyPhrases: { ...brand?.keyPhrases, approvedTaglines: splitLines(s.approved), bannedPhrases: splitLines(s.banned) },
      positioning: { ...brand?.positioning, tagline: s.tagline, elevatorPitch: s.elevatorPitch },
      channelVoiceRules: s.channelRules,
      governance: { ...brand?.governance, lockLevel: s.lockLevel },
      // R2 BR-SP-5 — a stale editor gets a 409, never a silent clobber.
      ...(brand ? { expectedUpdatedAt: brand.updatedAt } : {}),
    };
    try {
      if (brand) await updateBrand(brand.id, payload);
      else await createBrand({ ...payload, orgId: s.orgId });
      onSaved();
    } catch (e) {
      // Also surfaced to the parent so the message survives if the dialog is
      // dismissed, but the dialog is where the user is looking.
      const raw = e instanceof Error ? e.message : '';
      // Review F7 — branch on the carried HTTP status, not a message regex.
      const status = (e as { status?: number }).status;
      const msg = status === 409 ? t('saveConflict') : (raw || t('saveFailed'));
      setEditorError(msg);
      onError(msg);
      setSaving(false);
    }
  }, [brand, s, onSaved, onError, t]);

  const canSave = s.name.trim().length > 0 && (brand !== null || s.orgId.length > 0);

  return (
    <Modal
      label={brand ? t('editorEditTitle') : t('editorCreateTitle')}
      onClose={onClose}
      showClose
      error={editorError}
    >
      <h2 className="u-mt-0">{brand ? t('editorEditTitle') : t('editorCreateTitle')}</h2>
      {/* BR-G2 — the list already knows this brand is locked (it renders a chip
          for it). State the rule BEFORE five fieldsets of work, the way a
          governed record is expected to announce its own editability. This
          discloses the rule; it deliberately does NOT predict this user's
          verdict — the server holds the org-scope facts, and a wrong prediction
          would lock out someone who may in fact edit. */}
      {brand && brand.governance.lockLevel !== 'none' ? (
        <div className="u-mb-3">
          <Notice variant="warning">
            {brand.governance.lockLevel === 'full' ? t('lockNoticeFull') : t('lockNoticePartial')}
          </Notice>
        </div>
      ) : null}
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
            <div key={i} className="surface-form u-mb-2">
              {/* BR-G3 — `addRule` picks an UNUSED channel, but this select used
                  to offer every channel, so an edit could duplicate one. Scoring
                  resolves a rule with `find(r => r.channel === channel)` —
                  first match wins — so the duplicate is inert: an author could
                  write a tone and a maxLength that silently never apply. Offer
                  only the free channels plus this row's own. */}
              <SelectField label={t('fieldChannel')} value={r.channel} onChange={(e) => updateRule(i, { channel: e.target.value as BrandChannel })}>
                {BRAND_CHANNELS.filter((c) => c === r.channel || !usedChannels.has(c))
                  .map((c) => <option key={c} value={c}>{t(`channel_${c}`)}</option>)}
              </SelectField>
              <TextField label={t('fieldTone')} value={r.tone} onChange={(e) => updateRule(i, { tone: e.target.value })} />
              <TextField label={t('fieldMaxLength')} type="number" value={r.maxLength ?? ''} onChange={(e) => setRuleMaxLength(i, e.target.value)} />
              <Button variant="quiet" size="sm" aria-label={t('removeRule')} onClick={() => removeRule(i)}><TrashIcon size={15} /></Button>
            </div>
          ))}
          {s.channelRules.length < BRAND_CHANNELS.length ? (
            <Button variant="secondary" size="sm" onClick={addRule}><PlusIcon size={13} /> {t('addChannelRule')}</Button>
          ) : null}
        </fieldset>

        <fieldset className="u-mb-4 u-border-none u-p-0">
          <legend className="u-fw-600 u-mb-2">{t('secGovernance')}</legend>
          <SelectField label={t('fieldLockLevel')} value={s.lockLevel} onChange={(e) => set('lockLevel', e.target.value as BrandLockLevel)}>
            {LOCK_LEVELS.map((l) => <option key={l} value={l}>{t(`lock_${l}`)}</option>)}
          </SelectField>
        </fieldset>

        {/* ADR 0399 OQ-1 — ad-render fonts. Edit-mode only (needs a brandId);
            managed by their own routes, so NOT part of the brand save payload. */}
        {brand ? (
          <fieldset className="u-mb-4 u-border-none u-p-0">
            <legend className="u-fw-600 u-mb-2">{t('secAdFonts')}</legend>
            <p className="muted u-fs-13 u-mt-0">{t('adFontsLede')}</p>
            <BrandFontsSection brandId={brand.id} t={t} onError={setEditorError} />
          </fieldset>
        ) : null}

        {brand ? (
          <fieldset className="u-border-0 u-p-0 u-m-0">
            {/* R3 BR-SP-7 — the ADR 0354 P5 audit trail, wire-only until now.
                A DISCLOSURE (aria-expanded), lazy-loaded; failed ≠ empty. */}
            <Button
              type="button" variant="quiet" size="sm"
              aria-expanded={auditOpen} aria-controls="brand-audit-panel"
              onClick={toggleAudit}
            >{t('auditTrail')}</Button>
            {auditOpen ? (
              <div id="brand-audit-panel" className="u-grid u-gap-1 u-mt-2">
                {auditFailed ? (
                  <span className="u-fs-13 muted">{t('auditLoadFailed')} <Button type="button" variant="quiet" size="sm" onClick={loadAudit}>{t('common:retry')}</Button></span>
                ) : audit === null ? <span className="u-fs-13 muted">{t('common:loading')}</span> : audit.length === 0 ? (
                  <span className="u-fs-13 muted">{t('auditEmpty')}</span>
                ) : audit.slice(0, 20).map((row) => (
                  <div key={row.auditId} className="u-fs-13">
                    <span className="muted">{formatDateTime(row.changedAt)}</span> · <code>{row.actor}</code>
                    <ul className="u-m-0 u-pl-3">
                      {row.changes.map((c, i) => (
                        <li key={i}><code>{c.field}</code>: {JSON.stringify(c.from)} → {JSON.stringify(c.to)}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : null}
          </fieldset>
        ) : null}

        <div className="action-bar u-flex u-gap-2 u-justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>{t('common:cancel')}</Button>
          <Button type="submit" variant="primary" size="sm" disabled={!canSave || saving}>{t('common:save')}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** ADR 0399 OQ-1 — per-role (sans/serif) custom-font upload for ad rendering.
 *  Gated behind a license attestation; managed by its own routes. */
const AD_FONT_ROLES: BrandFontRole[] = ['sans', 'serif'];

function BrandFontsSection({ brandId, t, onError }: { brandId: string; t: TFn; onError: (m: string) => void }): JSX.Element {
  const [fonts, setFonts] = useState<BrandFontMeta[] | null>(null);
  // Distinct from `[]`. A failed read used to fall to `[]`, and this section then rendered
  // EVERY font role as unassigned — not an empty state but a FORM showing defaults, which
  // reads as "you have no brand fonts" and invites re-uploading one that already exists.
  const [fontsFailed, setFontsFailed] = useState(false);
  const [attested, setAttested] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<BrandFontRole | null>(null);

  const load = useCallback(async () => {
    setFontsFailed(false);
    try { setFonts(await listBrandFonts(brandId)); }
    catch (e) { onError(e instanceof Error ? e.message : t('adFontsLoadFailed')); setFonts([]); setFontsFailed(true); }
  }, [brandId, onError, t]);
  useEffect(() => { void load(); }, [load]);

  const byRole = (role: BrandFontRole): BrandFontMeta | undefined => (fonts ?? []).find((f) => f.role === role);

  const upload = async (role: BrandFontRole, file: File): Promise<void> => {
    if (!attested[role]) { onError(t('adFontsAttestFirst')); return; }
    setBusy(role);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(typeof r.result === 'string' ? r.result : '');
        r.onerror = () => reject(new Error('read failed'));
        r.readAsDataURL(file);
      });
      const b64 = dataUrl.split(',')[1] ?? '';
      await uploadBrandFont(brandId, role, b64, true);
      await load();
    } catch (e) { onError(e instanceof Error ? e.message : t('adFontsUploadFailed')); }
    finally { setBusy(null); }
  };

  const remove = async (role: BrandFontRole): Promise<void> => {
    setBusy(role);
    try { await deleteBrandFont(brandId, role); await load(); }
    catch (e) { onError(e instanceof Error ? e.message : t('adFontsUploadFailed')); }
    finally { setBusy(null); }
  };

  if (fonts === null) return <span className="muted u-fs-13">{t('common:loading')}</span>;
  // Ordered ABOVE the role grid: the grid renders each role from `fonts`, so on a failed
  // read it would show them all empty — a claim about the brand, not a report of a failure.
  if (fontsFailed) return <span className="muted u-fs-13">{t('common:loadFailed')}</span>;

  return (
    <div className="u-grid u-gap-2">
      {AD_FONT_ROLES.map((role) => {
        const current = byRole(role);
        return (
          <div key={role} className="surface-form u-grid u-gap-1">
            <span className="u-fw-600 u-fs-13">{t(`adFontRole_${role}`)}</span>
            {current ? (
              <div className="u-flex u-items-center u-gap-2 u-wrap">
                <span className="chip chip--success">{current.family}</span>
                <Button variant="quiet" size="sm" disabled={busy === role} onClick={() => void remove(role)}>
                  <TrashIcon size={13} /> {t('adFontsRemove')}
                </Button>
              </div>
            ) : (
              <div className="u-grid u-gap-1">
                <label className="u-flex u-items-start u-gap-2 u-fs-13">
                  <input type="checkbox" checked={!!attested[role]} onChange={(e) => setAttested((a) => ({ ...a, [role]: e.target.checked }))} />
                  <span>{t('adFontsAttest')}</span>
                </label>
                <input type="file" accept=".ttf,.otf,font/ttf,font/otf" disabled={!attested[role] || busy === role}
                  aria-label={t('adFontsChoose', { role: t(`adFontRole_${role}`) })}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(role, f); e.target.value = ''; }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
