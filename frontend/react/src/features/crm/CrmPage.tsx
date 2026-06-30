/**
 * CRM page (host-extension product feature — ADR 0001 §4, extended by ADR 0008).
 *
 * Gates on useFeatureAccess('crm'). A tab bar: the preserved tenant-wide
 * **Contacts** rolodex (+ variant-stamped triage), and the org-scoped, RBAC-gated
 * **Companies / Deals / Tasks** added in ADR 0008 (an org picker drives those).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n/index.js';
import { formatNumber } from '../../i18n/format.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { handleTablistKeyDown } from '../../ui/rovingTabs.js';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { toast } from '../../ui/toast.js';
import { UserIcon, BuildingIcon, BriefcaseIcon, CheckIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import {
  CONTACT_STAGES,
  createContact,
  deleteContact,
  listContacts,
  triageContact,
  type Contact,
  type ContactStage,
} from './crmClient.js';
import {
  createCompany,
  createDeal,
  createTask,
  deleteCompany,
  deleteDeal,
  deleteTask,
  listCompanies,
  listDeals,
  listOrgs,
  listPipelines,
  listTasks,
  moveDeal,
  setTaskStatus,
  TASK_STATUSES,
  type Company,
  type Deal,
  type Org,
  type Pipeline,
  type Task,
  type TaskStatus,
} from './crmOrgClient.js';

/** Surface a failed inline mutation (delete / stage-move / status-change) — the
 *  fetch clients now throw on a non-ok response (code-review #3/#4). */
const crudErr = (e: unknown): void => { toast.error(e instanceof Error ? e.message : i18n.t('crm:actionFailed')); };
type Tab = 'contacts' | 'companies' | 'deals' | 'tasks';
const TABS: { id: Tab; labelKey: string }[] = [
  { id: 'contacts', labelKey: 'tabContacts' },
  { id: 'companies', labelKey: 'tabCompanies' },
  { id: 'deals', labelKey: 'tabDeals' },
  { id: 'tasks', labelKey: 'tabTasks' },
];

export function CrmPage(): JSX.Element {
  const { t } = useTranslation('crm');
  const crm = useFeatureAccess('crm');
  const [tab, setTab] = useState<Tab>('contacts');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');

  useEffect(() => {
    if (!crm.enabled) return;
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
  }, [crm.enabled]);

  if (crm.loading) return <Skeleton />;
  if (!crm.enabled) {
    return (
      <section className="u-grid u-gap-4">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }

  const needsOrg = tab !== 'contacts';
  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('orgPickerLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <section className="u-grid u-gap-4">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={crm.variant ? t('ledeVariant', { variant: crm.variant }) : t('lede')}
        actions={needsOrg ? orgPicker : undefined}
      />

      <div className="tabs" role="tablist" aria-label={t('tablistLabel')} onKeyDown={handleTablistKeyDown}>
        {TABS.map((tabItem) => (
          <button key={tabItem.id} type="button" role="tab" aria-selected={tab === tabItem.id} tabIndex={tab === tabItem.id ? 0 : -1} className="tab" onClick={() => setTab(tabItem.id)}>
            {t(tabItem.labelKey)}
          </button>
        ))}
      </div>

      {tab === 'contacts' ? <ContactsTab /> : null}
      {needsOrg && (!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : (
        <>
          {tab === 'companies' ? <CompaniesTab orgId={orgId} /> : null}
          {tab === 'deals' ? <DealsTab orgId={orgId} /> : null}
          {tab === 'tasks' ? <TasksTab orgId={orgId} /> : null}
        </>
      ))}
    </section>
  );
}

// ── Contacts (preserved tenant rolodex) ──────────────────────────────────────
function ContactsTab(): JSX.Element {
  const { t } = useTranslation('crm');
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [stage, setStage] = useState<ContactStage>('lead');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    void listContacts().then(setContacts).catch((err) => setError(err instanceof Error ? err.message : t('loadContactsFailed')));
  }, [t]);
  useEffect(() => { load(); }, [load]);

  const add = useCallback(async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createContact({ name: name.trim(), stage, ...(company.trim() ? { company: company.trim() } : {}) });
      setName(''); setCompany(''); setStage('lead'); load();
      toast.success(t('contactAdded'));
    } catch (err) { toast.error(err instanceof Error ? err.message : t('addFailed')); } finally { setBusy(false); }
  }, [name, company, stage, load, t]);

  const remove = useCallback(async (id: string) => {
    try { await deleteContact(id); load(); } catch (err) { toast.error(err instanceof Error ? err.message : t('deleteFailed')); }
  }, [load, t]);

  const triage = useCallback(async (id: string) => {
    try { const r = await triageContact(id); toast.success(t('triageStarted', { variant: r.variant ?? t('triageVariantDefault'), runId: r.runId.slice(0, 8) })); }
    catch (err) { toast.error(err instanceof Error ? err.message : t('triageFailed')); }
  }, [t]);

  const columns = useMemo<DataColumn<Contact>[]>(() => [
    { key: 'name', header: t('colName'), render: (c) => c.name },
    { key: 'company', header: t('colCompany'), cellClass: 'muted', render: (c) => c.company ?? '—' },
    { key: 'stage', header: t('colStage'), render: (c) => <span className="chip">{c.stage}</span> },
    { key: 'actions', header: '', render: (c) => (
      <span className="action-bar">
        <button type="button" className="btn-ghost" onClick={() => void triage(c.contactId)}>{t('triage')}</button>
        <button type="button" className="btn-ghost" onClick={() => void remove(c.contactId)} aria-label={t('deleteRowLabel', { name: c.name })}>{t('common:delete')}</button>
      </span>
    ) },
  ], [triage, remove, t]);

  return (
    <div className="u-grid u-gap-4">
      {error ? <Notice variant="error">{error}</Notice> : null}
      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldName')}</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('contactNamePlaceholder')} /></label>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldCompany')}</span><input value={company} onChange={(e) => setCompany(e.target.value)} placeholder={t('contactCompanyPlaceholder')} /></label>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldStage')}</span>
          <select value={stage} onChange={(e) => setStage(e.target.value as ContactStage)}>{CONTACT_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        </label>
        <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>{t('addContact')}</button>
      </form>
      <DataTable rows={contacts ?? []} rowKey={(c) => c.contactId} columns={columns} caption={t('captionContacts')}
        empty={contacts === null ? <SkeletonRows rows={3} columns={[160, 140, 90, 120]} /> : (
          <StateCard icon={<UserIcon />} title={t('noContactsTitle')} body={t('noContactsBody')} />
        )} />
    </div>
  );
}

// ── Companies ────────────────────────────────────────────────────────────────
function CompaniesTab({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('crm');
  const [rows, setRows] = useState<Company[] | null>(null);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { void listCompanies(orgId).then(setRows).catch((e) => toast.error(e instanceof Error ? e.message : t('loadFailed'))); }, [orgId, t]);
  useEffect(() => { setRows(null); if (orgId) load(); }, [orgId, load]);

  const add = useCallback(async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await createCompany(orgId, { name: name.trim(), ...(domain.trim() ? { domain: domain.trim() } : {}) }); setName(''); setDomain(''); load(); toast.success(t('companyAdded')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('addFailed')); } finally { setBusy(false); }
  }, [orgId, name, domain, load, t]);

  const columns = useMemo<DataColumn<Company>[]>(() => [
    { key: 'name', header: t('colName'), render: (c) => c.name },
    { key: 'domain', header: t('colDomain'), cellClass: 'muted', render: (c) => c.domain ?? '—' },
    { key: 'tags', header: t('colTags'), render: (c) => <span className="action-bar">{c.tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}</span> },
    { key: 'actions', header: '', render: (c) => <button type="button" className="btn-ghost" onClick={() => void deleteCompany(orgId, c.companyId).then(load).catch(crudErr)}>{t('common:delete')}</button> },
  ], [orgId, load, t]);

  return (
    <div className="u-grid u-gap-4">
      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldName')}</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('companyNamePlaceholder')} /></label>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldDomain')}</span><input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={t('companyDomainPlaceholder')} /></label>
        <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>{t('addCompany')}</button>
      </form>
      <DataTable rows={rows ?? []} rowKey={(c) => c.companyId} columns={columns} caption={t('captionCompanies')}
        empty={rows === null ? <SkeletonRows rows={3} columns={[160, 160, 120, 90]} /> : (
          <StateCard icon={<BuildingIcon />} title={t('noCompaniesTitle')} body={t('noCompaniesBody')} />
        )} />
    </div>
  );
}

// ── Deals ────────────────────────────────────────────────────────────────────
function DealsTab({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('crm');
  const [rows, setRows] = useState<Deal[] | null>(null);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void listDeals(orgId).then(setRows).catch((e) => toast.error(e instanceof Error ? e.message : t('loadFailed')));
    void listPipelines(orgId).then((p) => setPipeline(p[0] ?? null)).catch(() => setPipeline(null));
    void listCompanies(orgId).then(setCompanies).catch(() => setCompanies([]));
  }, [orgId, t]);
  useEffect(() => { setRows(null); if (orgId) load(); }, [orgId, load]);

  const add = useCallback(async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const amt = amount.trim() ? Number(amount) : undefined;
      if (amt !== undefined && !Number.isFinite(amt)) { toast.error(t('amountMustBeNumber')); setBusy(false); return; }
      await createDeal(orgId, { title: title.trim(), ...(amt !== undefined ? { amount: amt } : {}), ...(companyId ? { companyId } : {}) });
      setTitle(''); setAmount(''); setCompanyId(''); load(); toast.success(t('dealAdded'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('addFailed')); } finally { setBusy(false); }
  }, [orgId, title, amount, companyId, load, t]);

  const columns = useMemo<DataColumn<Deal>[]>(() => [
    { key: 'title', header: t('colTitle'), render: (d) => d.title },
    { key: 'amount', header: t('colAmount'), cellClass: 'muted', render: (d) => (d.amount !== undefined ? (d.currency ? t('amountWithCurrency', { amount: formatNumber(d.amount), currency: d.currency }) : formatNumber(d.amount)) : '—') },
    { key: 'stage', header: t('colStage'), render: (d) => (
      <select value={d.stageId} onChange={(e) => void moveDeal(orgId, d.dealId, e.target.value).then(load).catch(crudErr)} className="u-w-auto" aria-label={t('stageSelectLabel', { title: d.title })}>
        {(pipeline?.stages ?? []).map((s) => <option key={s.stageId} value={s.stageId}>{s.name}</option>)}
      </select>
    ) },
    { key: 'actions', header: '', render: (d) => <button type="button" className="btn-ghost" onClick={() => void deleteDeal(orgId, d.dealId).then(load).catch(crudErr)}>{t('common:delete')}</button> },
  ], [orgId, pipeline, load, t]);

  return (
    <div className="u-grid u-gap-4">
      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldTitle')}</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('dealTitlePlaceholder')} /></label>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldAmount')}</span><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" placeholder={t('dealAmountPlaceholder')} /></label>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldCompany')}</span>
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}><option value="">—</option>{companies.map((co) => <option key={co.companyId} value={co.companyId}>{co.name}</option>)}</select>
        </label>
        <button type="submit" className="btn-primary" disabled={busy || !title.trim()}>{t('addDeal')}</button>
      </form>
      <DataTable rows={rows ?? []} rowKey={(d) => d.dealId} columns={columns} caption={t('captionDeals')}
        empty={rows === null ? <SkeletonRows rows={3} columns={[180, 100, 120, 90]} /> : (
          <StateCard icon={<BriefcaseIcon />} title={t('noDealsTitle')} body={t('noDealsBody')} />
        )} />
    </div>
  );
}

// ── Tasks ────────────────────────────────────────────────────────────────────
function TasksTab({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('crm');
  const [rows, setRows] = useState<Task[] | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { void listTasks(orgId).then(setRows).catch((e) => toast.error(e instanceof Error ? e.message : t('loadFailed'))); }, [orgId, t]);
  useEffect(() => { setRows(null); if (orgId) load(); }, [orgId, load]);

  const add = useCallback(async () => {
    if (!title.trim()) return;
    setBusy(true);
    try { await createTask(orgId, { title: title.trim() }); setTitle(''); load(); toast.success(t('taskAdded')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('addFailed')); } finally { setBusy(false); }
  }, [orgId, title, load, t]);

  const columns = useMemo<DataColumn<Task>[]>(() => [
    { key: 'title', header: t('colTitle'), render: (row) => row.title },
    { key: 'status', header: t('colStatus'), render: (row) => (
      <select value={row.status} onChange={(e) => void setTaskStatus(orgId, row.taskId, e.target.value as TaskStatus).then(load).catch(crudErr)} className="u-w-auto" aria-label={t('statusSelectLabel', { title: row.title })}>
        {TASK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    ) },
    { key: 'actions', header: '', render: (row) => <button type="button" className="btn-ghost" onClick={() => void deleteTask(orgId, row.taskId).then(load).catch(crudErr)}>{t('common:delete')}</button> },
  ], [orgId, load, t]);

  return (
    <div className="u-grid u-gap-4">
      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="u-grid u-gap-1"><span className="u-label-sm">{t('fieldTitle')}</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('taskTitlePlaceholder')} /></label>
        <button type="submit" className="btn-primary" disabled={busy || !title.trim()}>{t('addTask')}</button>
      </form>
      <DataTable rows={rows ?? []} rowKey={(row) => row.taskId} columns={columns} caption={t('captionTasks')}
        empty={rows === null ? <SkeletonRows rows={3} columns={[220, 120, 90]} /> : (
          <StateCard icon={<CheckIcon />} title={t('noTasksTitle')} body={t('noTasksBody')} />
        )} />
    </div>
  );
}
