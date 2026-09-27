/**
 * The human-editable application contract (ADR 0737 phase 3): deployment
 * requirements, auth guards, design/brand references, and public-share data
 * policy. These values were previously preserved by coercion but mostly hidden
 * behind raw document state. This panel keeps every write inside the existing
 * canvas history/CAS path; it does not configure credentials or a deployer.
 */
import { useEffect, useState } from 'react';
import type { InputHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { PlusIcon, TrashIcon } from '../../ui/icons/index.js';
import type { WorkspaceTabProps } from '../../canvas/types.js';
import type { Screen } from './canvasTree.js';
import type { AppAuthProfile, AppDataSource, AppEnvRequirement, AppResourceRef, AppSharePolicy } from './screenOps.js';

const AUTH_KINDS = ['none', 'email-password', 'oauth', 'sso'] as const;
const STAGES = ['runtime', 'build', 'deploy'] as const;
const ROLE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const list = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
type ResourceRefDraft = Partial<AppResourceRef>;

function CommitText({ value, onCommit, invalid = false, ...props }: {
  value: string; onCommit: (next: string) => void; invalid?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur'>): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <input {...props} className={`cv-editor__input${invalid ? ' ab-data__ident--invalid' : ''}`} aria-invalid={invalid || undefined} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== value) onCommit(draft); }} />;
}

function uniqueEnv(taken: Set<string>): string {
  let n = 1; let key = 'NEW_ENV';
  while (taken.has(key)) key = `NEW_ENV_${++n}`;
  return key;
}

export function ContractWorkspace({ doc, commitDoc, onAnnounce }: WorkspaceTabProps): JSX.Element {
  const { t } = useTranslation('app-builder');
  const sources = list<AppDataSource>(doc.dataSources);
  const screens = list<Screen>(doc.screens);
  const auth = (doc.authProfile && typeof doc.authProfile === 'object' && !Array.isArray(doc.authProfile) ? doc.authProfile : {}) as AppAuthProfile;
  const roles = list<string>(auth.roles);
  const guards = list<NonNullable<AppAuthProfile['guards']>[number]>(auth.guards);
  const envs = list<AppEnvRequirement>(doc.envRequirements);
  const policy = (doc.sharePolicy && typeof doc.sharePolicy === 'object' && !Array.isArray(doc.sharePolicy) ? doc.sharePolicy : {}) as AppSharePolicy;
  const ref = (key: 'designSystemRef' | 'brandRef'): ResourceRefDraft => {
    const value = doc[key];
    return value && typeof value === 'object' && !Array.isArray(value) ? value as ResourceRefDraft : {};
  };
  const setRef = (key: 'designSystemRef' | 'brandRef', patch: ResourceRefDraft): void => commitDoc((next) => {
    const current = next[key] && typeof next[key] === 'object' && !Array.isArray(next[key]) ? next[key] as ResourceRefDraft : {};
    const result = { ...current, ...patch };
    const id = result.id?.trim();
    if (!id) delete next[key];
    else next[key] = { id, ...(result.mode ? { mode: result.mode } : {}) };
  });
  const updateAuth = (mutate: (next: AppAuthProfile) => void): void => commitDoc((next) => {
    const current = next.authProfile && typeof next.authProfile === 'object' && !Array.isArray(next.authProfile) ? next.authProfile as AppAuthProfile : {};
    const result = { ...current }; mutate(result); next.authProfile = result;
  });
  const updateEnv = (index: number, patch: Partial<AppEnvRequirement>): void => commitDoc((next) => {
    const all = list<AppEnvRequirement>(next.envRequirements); const current = all[index];
    if (current) all[index] = { ...current, ...patch };
    next.envRequirements = all;
  });
  const updatePolicy = (mutate: (next: AppSharePolicy) => void): void => commitDoc((next) => {
    const current = next.sharePolicy && typeof next.sharePolicy === 'object' && !Array.isArray(next.sharePolicy) ? next.sharePolicy as AppSharePolicy : {};
    const result = { ...current }; mutate(result); next.sharePolicy = result;
  });

  return <div className="ab-contract">
    <section className="surface-card ab-contract__section" aria-label={t('contractIdentity')}>
      <h3>{t('contractIdentity')}</h3>
      <p className="cv-editor__empty">{t('contractIdentityLede')}</p>
      {(['designSystemRef', 'brandRef'] as const).map((key) => {
        const current = ref(key); const label = t(key === 'designSystemRef' ? 'contractDesignSystem' : 'contractBrand');
        return <div key={key} className="ab-contract__row">
          <label className="ab-contract__field"><span>{label}</span><CommitText value={current.id ?? ''} aria-label={label} maxLength={120} onCommit={(id) => setRef(key, { id })} /></label>
          <label className="ab-contract__field"><span>{t('contractReferenceMode')}</span><select className="cv-editor__input" value={current.mode ?? 'linked'} disabled={!current.id} onChange={(event) => setRef(key, { mode: event.target.value as NonNullable<AppResourceRef['mode']> })}><option value="linked">{t('contractModeLinked')}</option><option value="detached">{t('contractModeDetached')}</option></select></label>
        </div>;
      })}
    </section>

    <section className="surface-card ab-contract__section" aria-label={t('contractAuth')}>
      <div className="ab-data__head"><h3>{t('contractAuth')}</h3><label className="ab-contract__field"><span>{t('contractAuthKind')}</span><select className="cv-editor__input" value={auth.kind ?? 'none'} onChange={(event) => updateAuth((next) => { next.kind = event.target.value; })}>{AUTH_KINDS.map((kind) => <option key={kind} value={kind}>{t(`contractAuth_${kind}`)}</option>)}</select></label></div>
      <div className="ab-data__head"><h4>{t('contractRoles')}</h4><Button variant="secondary" size="sm" onClick={() => updateAuth((next) => { next.roles = [...list<string>(next.roles), `role_${list<string>(next.roles).length + 1}`]; })}><PlusIcon size={13} aria-hidden /> {t('contractAddRole')}</Button></div>
      {roles.length === 0 ? <p className="cv-editor__empty">{t('contractNoRoles')}</p> : <div className="ab-contract__list">{roles.map((role, index) => <div key={`${role}:${index}`} className="ab-contract__row"><CommitText value={role} aria-label={t('contractRole')} invalid={!ROLE.test(role)} onCommit={(value) => updateAuth((next) => { const all = list<string>(next.roles); all[index] = value; next.roles = all; })} /><Button variant="quiet" size="sm" aria-label={t('contractRemove')} title={t('contractRemove')} onClick={() => updateAuth((next) => { next.roles = list<string>(next.roles).filter((_, i) => i !== index); })}><TrashIcon size={13} aria-hidden /></Button></div>)}</div>}
      <div className="ab-data__head"><h4>{t('contractGuards')}</h4><Button variant="secondary" size="sm" disabled={screens.length === 0} onClick={() => updateAuth((next) => { next.guards = [...list<NonNullable<AppAuthProfile['guards']>[number]>(next.guards), { screenId: screens[0]?.id ?? '' }]; })}><PlusIcon size={13} aria-hidden /> {t('contractAddGuard')}</Button></div>
      {guards.length === 0 ? <p className="cv-editor__empty">{t('contractNoGuards')}</p> : guards.map((guard, index) => <div key={index} className="ab-contract__row"><label className="ab-contract__field"><span>{t('contractScreen')}</span><select className="cv-editor__input" value={guard.screenId} onChange={(event) => updateAuth((next) => { const all = list<NonNullable<AppAuthProfile['guards']>[number]>(next.guards); if (all[index]) all[index]!.screenId = event.target.value; next.guards = all; })}>{screens.map((screen) => <option key={screen.id} value={screen.id}>{screen.name || screen.id}</option>)}</select></label><label className="ab-contract__field"><span>{t('contractRequiredRole')}</span><select className="cv-editor__input" value={guard.requiresRole ?? ''} onChange={(event) => updateAuth((next) => { const all = list<NonNullable<AppAuthProfile['guards']>[number]>(next.guards); if (all[index]) { if (event.target.value) all[index]!.requiresRole = event.target.value; else delete all[index]!.requiresRole; } next.guards = all; })}><option value="">—</option>{roles.map((role) => <option key={role} value={role}>{role}</option>)}</select></label><label className="ab-contract__field"><span>{t('contractRedirect')}</span><select className="cv-editor__input" value={guard.redirectTo ?? ''} onChange={(event) => updateAuth((next) => { const all = list<NonNullable<AppAuthProfile['guards']>[number]>(next.guards); if (all[index]) { if (event.target.value) all[index]!.redirectTo = event.target.value; else delete all[index]!.redirectTo; } next.guards = all; })}><option value="">—</option>{screens.map((screen) => <option key={screen.id} value={screen.id}>{screen.name || screen.id}</option>)}</select></label><Button variant="quiet" size="sm" aria-label={t('contractRemove')} title={t('contractRemove')} onClick={() => updateAuth((next) => { next.guards = list<NonNullable<AppAuthProfile['guards']>[number]>(next.guards).filter((_, i) => i !== index); })}><TrashIcon size={13} aria-hidden /></Button></div>)}
    </section>

    <section className="surface-card ab-contract__section" aria-label={t('contractEnv')}>
      <div className="ab-data__head"><h3>{t('contractEnv')}</h3><Button variant="secondary" size="sm" onClick={() => { commitDoc((next) => { next.envRequirements = [...list<AppEnvRequirement>(next.envRequirements), { key: uniqueEnv(new Set(list<AppEnvRequirement>(next.envRequirements).map((item) => item.key))), purpose: t('contractNewEnv'), requiredFor: ['runtime'] }]; }); onAnnounce(t('contractEnvAdded')); }}><PlusIcon size={13} aria-hidden /> {t('contractAddEnv')}</Button></div>
      {envs.length === 0 ? <p className="cv-editor__empty">{t('contractNoEnv')}</p> : envs.map((item, index) => <div key={`${item.key}:${index}`} className="ab-contract__rule"><div className="ab-contract__row"><label className="ab-contract__field"><span>{t('contractEnvKey')}</span><CommitText value={item.key} aria-label={t('contractEnvKey')} invalid={!ENV.test(item.key)} onCommit={(key) => updateEnv(index, { key })} /></label><label className="ab-contract__field"><span>{t('contractEnvPurpose')}</span><CommitText value={item.purpose} aria-label={t('contractEnvPurpose')} maxLength={200} onCommit={(purpose) => updateEnv(index, { purpose })} /></label><Button variant="quiet" size="sm" aria-label={t('contractRemove')} title={t('contractRemove')} onClick={() => commitDoc((next) => { next.envRequirements = list<AppEnvRequirement>(next.envRequirements).filter((_, i) => i !== index); })}><TrashIcon size={13} aria-hidden /></Button></div><div className="ab-contract__stages" role="group" aria-label={t('contractStages')}>{STAGES.map((stage) => <label key={stage}><input type="checkbox" checked={item.requiredFor?.includes(stage) ?? false} onChange={(event) => updateEnv(index, { requiredFor: event.target.checked ? [...new Set([...(item.requiredFor ?? []), stage])] : (item.requiredFor ?? []).filter((current) => current !== stage) })} /> {t(`contractStage_${stage}`)}</label>)}</div></div>)}
    </section>

    <section className="surface-card ab-contract__section" aria-label={t('contractSharing')}>
      <h3>{t('contractSharing')}</h3><p className="cv-editor__empty">{t('contractSharingLede')}</p>
      <label className="ab-contract__field"><span>{t('contractSampleData')}</span><select className="cv-editor__input" value={policy.sampleData ?? 'redact'} onChange={(event) => updatePolicy((next) => { next.sampleData = event.target.value as NonNullable<AppSharePolicy['sampleData']>; })}><option value="redact">{t('contractRedact')}</option><option value="include">{t('contractInclude')}</option></select></label>
      {sources.map((source) => <label key={source.id} className="ab-contract__field"><span>{t('contractSourceOverride', { name: source.name || source.id })}</span><select className="cv-editor__input" value={policy.perSource?.[source.id] === undefined ? '' : policy.perSource[source.id] ? 'include' : 'redact'} onChange={(event) => updatePolicy((next) => { const perSource = { ...(next.perSource ?? {}) }; if (!event.target.value) delete perSource[source.id]; else perSource[source.id] = event.target.value === 'include'; if (Object.keys(perSource).length) next.perSource = perSource; else delete next.perSource; })}><option value="">{t('contractInherit')}</option><option value="redact">{t('contractRedact')}</option><option value="include">{t('contractInclude')}</option></select></label>)}
    </section>
  </div>;
}
