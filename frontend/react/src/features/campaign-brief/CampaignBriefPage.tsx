/**
 * Personas & Campaign Brief page (ADR 0156, Phase 4). Two tabs — Briefs and
 * Personas — on the shared ui/ cohesion layer. The brief detail is a wizard-style
 * editor (identity · product · audience · channels · messaging) with a Validate
 * action and a read-only Kernel panel; generating the kernel happens through the
 * one chat scoped to the Brief Strategist agent (ADR 0058 — deep-link, no second
 * chat). The messaging kernel is the foundation every channel echoes.
 *
 * @see docs/adr/0156-campaign-studio-personas-brief.md
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Modal } from '../../ui/Modal.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { TextField, TextareaField, SelectField, CheckboxField } from '../../ui/Field.js';
import { handleTablistKeyDown } from '../../ui/rovingTabs.js';
import { MegaphoneIcon, PlusIcon, TrashIcon, SparklesIcon, CheckIcon, AlertIcon } from '../../ui/icons/index.js';
import {
  listPersonas, createPersona, updatePersona, deletePersona,
  listBriefs, createBrief, updateBrief, deleteBrief, validateBriefById,
  listOrgs, listBrands, BUYER_STAGES, FeatureDisabledError, BRIEF_STRATEGIST_AGENT,
  type Persona, type CampaignBrief, type BrandRef, type OrgRef, type ValidationResult, type BuyerStage, type CampaignChannel,
} from './campaignBriefClient.js';

type TFn = ReturnType<typeof useTranslation>['t'];
const splitLines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
const joinLines = (a: string[]): string => a.join('\n');

export function CampaignBriefPage(): JSX.Element {
  const { t } = useTranslation('campaign-brief');
  const [tab, setTab] = useState<'briefs' | 'personas'>('briefs');
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [brands, setBrands] = useState<BrandRef[]>([]);

  useEffect(() => {
    void listOrgs().then(setOrgs).catch(() => {});
    void listBrands().then(setBrands).catch(() => {});
  }, []);

  return (
    <div>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {error ? <Notice variant="error">{error}</Notice> : null}
      {disabled ? (
        <StateCard icon={<MegaphoneIcon size={22} />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      ) : (
        <>
          <div className="tabs u-mb-4" role="tablist" aria-label={t('tablistLabel')} onKeyDown={handleTablistKeyDown}>
            <button type="button" role="tab" aria-selected={tab === 'briefs'} tabIndex={tab === 'briefs' ? 0 : -1} className="tab" onClick={() => setTab('briefs')}>{t('tabBriefs')}</button>
            <button type="button" role="tab" aria-selected={tab === 'personas'} tabIndex={tab === 'personas' ? 0 : -1} className="tab" onClick={() => setTab('personas')}>{t('tabPersonas')}</button>
          </div>
          {tab === 'briefs'
            ? <BriefsTab t={t} orgs={orgs} brands={brands} onDisabled={() => setDisabled(true)} onError={setError} />
            : <PersonasTab t={t} orgs={orgs} brands={brands} onDisabled={() => setDisabled(true)} onError={setError} />}
        </>
      )}
    </div>
  );
}

// ============================================================================
// BRIEFS
// ============================================================================

function BriefsTab({ t, orgs, brands, onDisabled, onError }: { t: TFn; orgs: OrgRef[]; brands: BrandRef[]; onDisabled: () => void; onError: (m: string) => void }): JSX.Element {
  const navigate = useNavigate();
  const [briefs, setBriefs] = useState<CampaignBrief[] | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<CampaignBrief | null>(null);

  const refresh = useCallback(async () => {
    try { setBriefs(await listBriefs()); }
    catch (e) { if (e instanceof FeatureDisabledError) { onDisabled(); setBriefs([]); return; } onError(e instanceof Error ? e.message : 'load failed'); }
  }, [onDisabled, onError]);
  useEffect(() => { void refresh(); void listPersonas().then(setPersonas).catch(() => {}); }, [refresh]);

  const current = useMemo(() => briefs?.find((b) => b.id === selected) ?? null, [briefs, selected]);

  if (current) {
    return (
      <BriefDetail
        t={t} brief={current} brands={brands} personas={personas}
        onBack={() => { setSelected(null); void refresh(); }}
        onChanged={refresh} onError={onError}
        onOpenStrategist={() => navigate(`/?agent=${encodeURIComponent(BRIEF_STRATEGIST_AGENT)}`)}
      />
    );
  }

  return (
    <>
      {briefs === null ? (
        <StateCard icon={<MegaphoneIcon size={20} />} title={t('loadingBriefs')} loading />
      ) : briefs.length === 0 ? (
        orgs.length === 0
          ? <StateCard icon={<MegaphoneIcon size={22} />} title={t('noOrgTitle')} body={t('noOrgBody')} />
          : <StateCard icon={<MegaphoneIcon size={22} />} title={t('emptyBriefsTitle')} body={t('emptyBriefsBody')} action={<button type="button" className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}><PlusIcon size={13} /> {t('newBrief')}</button>} />
      ) : (
        <>
          <div className="action-bar u-flex u-justify-end u-mb-3">
            <button type="button" className="btn-primary btn-sm" onClick={() => setCreateOpen(true)}><PlusIcon size={13} /> {t('newBrief')}</button>
          </div>
          <ul className="surface-card list-view u-list-none u-m-0">
            {briefs.map((b) => (
              <li key={b.id} className="list-row">
                <button type="button" className="list-row-id" onClick={() => setSelected(b.id)}>
                  <span className="list-row-name-wrap">
                    <span className="list-row-name-line"><span className="list-row-name u-fw-600">{b.name}</span><StatusChip status={b.status} t={t} />{b.kernelStale ? <span className="chip chip--warning">{t('kernelStale')}</span> : null}</span>
                    {b.productName ? <span className="u-fs-13 u-text-muted">{b.productName}</span> : null}
                  </span>
                </button>
                <div className="list-row-name-line">
                  {b.kernel ? <span className="chip chip--success">{t('hasKernel')}</span> : <span className="chip chip--muted">{t('noKernel')}</span>}
                  <span className="chip chip--muted">{t('channelsEnabled', { count: b.channels.filter((c) => c.enabled).length })}</span>
                </div>
                <button type="button" className="ghost btn-sm" aria-label={t('common:delete')} onClick={() => setConfirmDelete(b)}><TrashIcon size={15} /></button>
              </li>
            ))}
          </ul>
        </>
      )}

      {createOpen ? (
        <CreateBriefModal t={t} orgs={orgs} onClose={() => setCreateOpen(false)} onCreated={async (b) => { setCreateOpen(false); await refresh(); setSelected(b.id); }} onError={onError} />
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog title={t('deleteBriefTitle')} body={t('deleteBriefBody')} confirmLabel={t('common:delete')} danger
          onConfirm={async () => { try { await deleteBrief(confirmDelete.id); setConfirmDelete(null); await refresh(); } catch (e) { onError(e instanceof Error ? e.message : 'delete failed'); } }}
          onCancel={() => setConfirmDelete(null)} />
      ) : null}
    </>
  );
}

function StatusChip({ status, t }: { status: CampaignBrief['status']; t: TFn }): JSX.Element {
  const cls = status === 'confirmed' ? 'chip--accent' : status === 'validated' ? 'chip--success' : 'chip--muted';
  return <span className={`chip ${cls}`}>{t(`status_${status}`)}</span>;
}

function CreateBriefModal({ t, orgs, onClose, onCreated, onError }: { t: TFn; orgs: OrgRef[]; onClose: () => void; onCreated: (b: CampaignBrief) => void; onError: (m: string) => void }): JSX.Element {
  const [orgId, setOrgId] = useState(orgs[0]?.orgId ?? '');
  const [name, setName] = useState('');
  const [productName, setProductName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    setBusy(true);
    try { onCreated(await createBrief({ orgId, name, productName })); }
    catch (e) { onError(e instanceof Error ? e.message : 'create failed'); setBusy(false); }
  };
  return (
    <Modal label={t('newBrief')} onClose={onClose} showClose>
      <h2 className="u-mt-0">{t('newBrief')}</h2>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim() && orgId && !busy) void submit(); }}>
        <SelectField label={t('fieldOrg')} value={orgId} onChange={(e) => setOrgId(e.target.value)} required>
          {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
        <TextField label={t('fieldBriefName')} value={name} onChange={(e) => setName(e.target.value)} required />
        <TextField label={t('fieldProductName')} value={productName} onChange={(e) => setProductName(e.target.value)} />
        <div className="action-bar u-flex u-gap-2 u-justify-end">
          <button type="button" className="secondary btn-sm" onClick={onClose}>{t('common:cancel')}</button>
          <button type="submit" className="btn-primary btn-sm" disabled={!name.trim() || !orgId || busy}>{t('common:create')}</button>
        </div>
      </form>
    </Modal>
  );
}

function BriefDetail({ t, brief, brands, personas, onBack, onChanged, onError, onOpenStrategist }: {
  t: TFn; brief: CampaignBrief; brands: BrandRef[]; personas: Persona[];
  onBack: () => void; onChanged: () => Promise<void>; onError: (m: string) => void; onOpenStrategist: () => void;
}): JSX.Element {
  const [objective, setObjective] = useState(brief.objective);
  const [productName, setProductName] = useState(brief.productName);
  const [productDescription, setProductDescription] = useState(brief.productDescription);
  const [industryVertical, setIndustryVertical] = useState(brief.industryVertical);
  const [brandId, setBrandId] = useState(brief.brandId ?? '');
  const [personaIds, setPersonaIds] = useState<string[]>(brief.personaIds);
  const [channels, setChannels] = useState(brief.channels);
  const [valueProp, setValueProp] = useState(brief.messaging.primaryValueProp);
  const [proofPoints, setProofPoints] = useState(joinLines(brief.messaging.proofPoints));
  const [ctaStrategy, setCtaStrategy] = useState(brief.messaging.ctaStrategy);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [busy, setBusy] = useState(false);

  const orgPersonas = useMemo(() => personas.filter((p) => p.orgId === brief.orgId), [personas, brief.orgId]);
  const togglePersona = (id: string): void => setPersonaIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const toggleChannel = (type: CampaignChannel): void => setChannels((prev) => prev.map((c) => c.type === type ? { ...c, enabled: !c.enabled } : c));

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await updateBrief(brief.id, {
        objective, productName, productDescription, industryVertical,
        ...(brandId ? { brandId } : {}),
        personaIds, channels,
        messaging: { primaryValueProp: valueProp, proofPoints: splitLines(proofPoints), ctaStrategy, toneOverride: brief.messaging.toneOverride },
      });
      await onChanged();
    } catch (e) { onError(e instanceof Error ? e.message : 'save failed'); }
    setBusy(false);
  };
  const validate = async (): Promise<void> => {
    try { setValidation(await validateBriefById(brief.id)); } catch (e) { onError(e instanceof Error ? e.message : 'validate failed'); }
  };

  return (
    <div>
      <div className="action-bar u-flex u-items-center u-gap-2 u-mb-4">
        <button type="button" className="ghost btn-sm" onClick={onBack}>← {t('backToBriefs')}</button>
        <h2 className="u-m-0 u-flex-1">{brief.name}</h2>
        <button type="button" className="secondary btn-sm" onClick={() => void validate()}>{t('validate')}</button>
        <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void save()}>{busy ? t('common:saving') : t('common:save')}</button>
      </div>

      {validation ? (
        <Notice variant={validation.valid ? 'success' : 'warning'}>
          {validation.valid
            ? <span><CheckIcon size={14} /> {t('validValid', { channels: validation.enabledChannels.map((c) => t(`channel_${c}`)).join(', ') })}</span>
            : <span><AlertIcon size={14} /> {t('validInvalid')} {validation.issues.map((i) => i.message).join(' ')}</span>}
        </Notice>
      ) : null}

      {brief.kernel ? (
        <section className="surface-card u-mb-4">
          <div className="u-flex u-items-center u-gap-2 u-mb-2"><SparklesIcon size={16} /> <h3 className="u-m-0">{t('kernelTitle')}</h3>{brief.kernelStale ? <span className="chip chip--warning">{t('kernelStale')}</span> : null}</div>
          <p className="u-fw-600 u-mb-1">{brief.kernel.headline}</p>
          <p className="u-text-muted u-mt-0">{brief.kernel.supportingStatement}</p>
          {brief.kernel.proofPoints.length ? <ul>{brief.kernel.proofPoints.map((p, i) => <li key={i}>{p}</li>)}</ul> : null}
          <p className="u-fs-13"><strong>{t('kernelCta')}:</strong> {brief.kernel.primaryCta} · <strong>{t('kernelTone')}:</strong> {brief.kernel.tone}{brief.kernel.sourceDocIds.length ? ` · ${t('kernelSources', { count: brief.kernel.sourceDocIds.length })}` : ''}</p>
        </section>
      ) : (
        <Notice variant="info">{t('noKernelYet')} <button type="button" className="btn-link" onClick={onOpenStrategist}>{t('generateWithStrategist')}</button></Notice>
      )}

      <section className="surface-card u-mb-4">
        <h3 className="u-mt-0">{t('secProduct')}</h3>
        <TextareaField label={t('fieldObjective')} value={objective} rows={2} onChange={(e) => setObjective(e.target.value)} />
        <TextField label={t('fieldProductName')} value={productName} onChange={(e) => setProductName(e.target.value)} />
        <TextareaField label={t('fieldProductDescription')} value={productDescription} rows={2} onChange={(e) => setProductDescription(e.target.value)} />
        <TextField label={t('fieldIndustry')} value={industryVertical} onChange={(e) => setIndustryVertical(e.target.value)} />
        <SelectField label={t('fieldBrand')} value={brandId} onChange={(e) => setBrandId(e.target.value)}>
          <option value="">{t('brandNone')}</option>
          {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </SelectField>
      </section>

      <section className="surface-card u-mb-4">
        <h3 className="u-mt-0">{t('secAudience')}</h3>
        {orgPersonas.length === 0 ? <p className="u-text-muted">{t('noPersonasForOrg')}</p> : orgPersonas.map((p) => (
          <CheckboxField key={p.id} label={`${p.name}${p.role ? ` — ${p.role}` : ''}`} checked={personaIds.includes(p.id)} onChange={() => togglePersona(p.id)} />
        ))}
      </section>

      <section className="surface-card u-mb-4">
        <h3 className="u-mt-0">{t('secChannels')}</h3>
        {channels.map((c) => (
          <CheckboxField key={c.type} label={t(`channel_${c.type}`)} checked={c.enabled} onChange={() => toggleChannel(c.type)} />
        ))}
      </section>

      <section className="surface-card u-mb-4">
        <h3 className="u-mt-0">{t('secMessaging')}</h3>
        <TextareaField label={t('fieldValueProp')} value={valueProp} rows={2} onChange={(e) => setValueProp(e.target.value)} />
        <TextareaField label={t('fieldProofPoints')} help={t('fieldProofPointsHelp')} value={proofPoints} rows={3} onChange={(e) => setProofPoints(e.target.value)} />
        <TextField label={t('fieldCtaStrategy')} value={ctaStrategy} onChange={(e) => setCtaStrategy(e.target.value)} />
      </section>
    </div>
  );
}

// ============================================================================
// PERSONAS
// ============================================================================

function PersonasTab({ t, orgs, brands, onDisabled, onError }: { t: TFn; orgs: OrgRef[]; brands: BrandRef[]; onDisabled: () => void; onError: (m: string) => void }): JSX.Element {
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [editing, setEditing] = useState<Persona | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Persona | null>(null);

  const refresh = useCallback(async () => {
    try { setPersonas(await listPersonas()); }
    catch (e) { if (e instanceof FeatureDisabledError) { onDisabled(); setPersonas([]); return; } onError(e instanceof Error ? e.message : 'load failed'); }
  }, [onDisabled, onError]);
  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <>
      {personas === null ? (
        <StateCard icon={<MegaphoneIcon size={20} />} title={t('loadingPersonas')} loading />
      ) : personas.length === 0 ? (
        orgs.length === 0
          ? <StateCard icon={<MegaphoneIcon size={22} />} title={t('noOrgTitle')} body={t('noOrgBody')} />
          : <StateCard icon={<MegaphoneIcon size={22} />} title={t('emptyPersonasTitle')} body={t('emptyPersonasBody')} action={<button type="button" className="btn-primary btn-sm" onClick={() => setEditing('new')}><PlusIcon size={13} /> {t('newPersona')}</button>} />
      ) : (
        <>
          <div className="action-bar u-flex u-justify-end u-mb-3"><button type="button" className="btn-primary btn-sm" onClick={() => setEditing('new')}><PlusIcon size={13} /> {t('newPersona')}</button></div>
          <ul className="surface-card list-view u-list-none u-m-0">
            {personas.map((p) => (
              <li key={p.id} className="list-row">
                <button type="button" className="list-row-id" onClick={() => setEditing(p)}>
                  <span className="list-row-name-wrap">
                    <span className="list-row-name-line"><span className="list-row-name u-fw-600">{p.name}</span>{p.role ? <span className="u-text-muted u-fs-13">{p.role}</span> : null}</span>
                  </span>
                </button>
                <div className="list-row-name-line"><span className="chip chip--muted">{t(`buyerStage_${p.buyerStage}`)}</span>{p.painPoints.length ? <span className="chip chip--muted">{t('painPointsCount', { count: p.painPoints.length })}</span> : null}</div>
                <button type="button" className="ghost btn-sm" aria-label={t('common:delete')} onClick={() => setConfirmDelete(p)}><TrashIcon size={15} /></button>
              </li>
            ))}
          </ul>
        </>
      )}
      {editing ? <PersonaEditor t={t} persona={editing === 'new' ? null : editing} orgs={orgs} brands={brands} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await refresh(); }} onError={onError} /> : null}
      {confirmDelete ? (
        <ConfirmDialog title={t('deletePersonaTitle')} body={t('deletePersonaBody')} confirmLabel={t('common:delete')} danger
          onConfirm={async () => { try { await deletePersona(confirmDelete.id); setConfirmDelete(null); await refresh(); } catch (e) { onError(e instanceof Error ? e.message : 'delete failed'); } }}
          onCancel={() => setConfirmDelete(null)} />
      ) : null}
    </>
  );
}

function PersonaEditor({ t, persona, orgs, brands, onClose, onSaved, onError }: { t: TFn; persona: Persona | null; orgs: OrgRef[]; brands: BrandRef[]; onClose: () => void; onSaved: () => void; onError: (m: string) => void }): JSX.Element {
  const [orgId, setOrgId] = useState(persona?.orgId ?? orgs[0]?.orgId ?? '');
  const [name, setName] = useState(persona?.name ?? '');
  const [role, setRole] = useState(persona?.role ?? '');
  const [buyerStage, setBuyerStage] = useState<BuyerStage>(persona?.buyerStage ?? 'problem_aware');
  const [painPoints, setPainPoints] = useState(joinLines(persona?.painPoints ?? []));
  const [objections, setObjections] = useState(joinLines(persona?.objections ?? []));
  const [goals, setGoals] = useState(joinLines(persona?.goals ?? []));
  const [demographics, setDemographics] = useState(persona?.demographics ?? '');
  const [brandId, setBrandId] = useState(persona?.brandId ?? '');
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    const payload = { name, role, buyerStage, painPoints: splitLines(painPoints), objections: splitLines(objections), goals: splitLines(goals), demographics, ...(brandId ? { brandId } : {}) };
    try {
      if (persona) await updatePersona(persona.id, payload);
      else await createPersona({ ...payload, orgId });
      onSaved();
    } catch (e) { onError(e instanceof Error ? e.message : 'save failed'); setBusy(false); }
  };

  const canSave = name.trim().length > 0 && (persona !== null || orgId.length > 0);
  return (
    <Modal label={persona ? t('editPersona') : t('newPersona')} onClose={onClose} showClose>
      <h2 className="u-mt-0">{persona ? t('editPersona') : t('newPersona')}</h2>
      <form onSubmit={(e) => { e.preventDefault(); if (canSave && !busy) void save(); }}>
        {!persona ? (
          <SelectField label={t('fieldOrg')} value={orgId} onChange={(e) => setOrgId(e.target.value)} required>
            {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </SelectField>
        ) : null}
        <TextField label={t('fieldPersonaName')} value={name} onChange={(e) => setName(e.target.value)} required />
        <TextField label={t('fieldRole')} value={role} onChange={(e) => setRole(e.target.value)} />
        <SelectField label={t('fieldBuyerStage')} value={buyerStage} onChange={(e) => setBuyerStage(e.target.value as BuyerStage)}>
          {BUYER_STAGES.map((s) => <option key={s} value={s}>{t(`buyerStage_${s}`)}</option>)}
        </SelectField>
        <TextareaField label={t('fieldPainPoints')} help={t('linePerItem')} value={painPoints} rows={3} onChange={(e) => setPainPoints(e.target.value)} />
        <TextareaField label={t('fieldObjections')} help={t('linePerItem')} value={objections} rows={3} onChange={(e) => setObjections(e.target.value)} />
        <TextareaField label={t('fieldGoals')} help={t('linePerItem')} value={goals} rows={2} onChange={(e) => setGoals(e.target.value)} />
        <TextareaField label={t('fieldDemographics')} value={demographics} rows={2} onChange={(e) => setDemographics(e.target.value)} />
        <SelectField label={t('fieldBrand')} value={brandId} onChange={(e) => setBrandId(e.target.value)}>
          <option value="">{t('brandNone')}</option>
          {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </SelectField>
        <div className="action-bar u-flex u-gap-2 u-justify-end">
          <button type="button" className="secondary btn-sm" onClick={onClose}>{t('common:cancel')}</button>
          <button type="submit" className="btn-primary btn-sm" disabled={!canSave || busy}>{t('common:save')}</button>
        </div>
      </form>
    </Modal>
  );
}
