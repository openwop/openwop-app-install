/**
 * CRM page (host-extension product feature — ADR 0001 §4, extended by ADR 0008).
 *
 * Gates on useFeatureAccess('crm'). A tab bar: the preserved tenant-wide
 * **Contacts** rolodex (+ variant-stamped triage), and the org-scoped, RBAC-gated
 * **Companies / Deals / Tasks** added in ADR 0008 (an org picker drives those).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
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

const labelStyle = { color: 'var(--ink-3)', fontSize: '0.85em' } as const;
/** Surface a failed inline mutation (delete / stage-move / status-change) — the
 *  fetch clients now throw on a non-ok response (code-review #3/#4). */
const crudErr = (e: unknown): void => { toast.error(e instanceof Error ? e.message : 'Action failed.'); };
type Tab = 'contacts' | 'companies' | 'deals' | 'tasks';
const TABS: { id: Tab; label: string }[] = [
  { id: 'contacts', label: 'Contacts' },
  { id: 'companies', label: 'Companies' },
  { id: 'deals', label: 'Deals' },
  { id: 'tasks', label: 'Tasks' },
];

export function CrmPage(): JSX.Element {
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
        <PageHeader eyebrow="Business" title="CRM" />
        <StateCard title="CRM is not enabled" body="Ask an administrator to turn on the CRM feature in Admin → Feature toggles." />
      </section>
    );
  }

  const needsOrg = tab !== 'contacts';
  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label="Organization">
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <section className="u-grid u-gap-4">
      <PageHeader
        eyebrow="Business"
        title="CRM"
        lede={`Contacts, companies, deals, and tasks.${crm.variant ? ` You're in variant "${crm.variant}".` : ''}`}
        actions={needsOrg ? orgPicker : undefined}
      />

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className="tab" onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'contacts' ? <ContactsTab /> : null}
      {needsOrg && (!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard title="No organizations" body="Create an organization first — companies, deals, and tasks belong to an org." />
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
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [stage, setStage] = useState<ContactStage>('lead');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    void listContacts().then(setContacts).catch((err) => setError(err instanceof Error ? err.message : 'Failed to load contacts.'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = useCallback(async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createContact({ name: name.trim(), stage, ...(company.trim() ? { company: company.trim() } : {}) });
      setName(''); setCompany(''); setStage('lead'); load();
      toast.success('Contact added.');
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Add failed.'); } finally { setBusy(false); }
  }, [name, company, stage, load]);

  const remove = useCallback(async (id: string) => {
    try { await deleteContact(id); load(); } catch (err) { toast.error(err instanceof Error ? err.message : 'Delete failed.'); }
  }, [load]);

  const triage = useCallback(async (id: string) => {
    try { const r = await triageContact(id); toast.success(`Triage started — variant ${r.variant ?? 'default'} (run ${r.runId.slice(0, 8)}…).`); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Triage failed.'); }
  }, []);

  const columns = useMemo<DataColumn<Contact>[]>(() => [
    { key: 'name', header: 'Name', render: (c) => c.name },
    { key: 'company', header: 'Company', cellClass: 'muted', render: (c) => c.company ?? '—' },
    { key: 'stage', header: 'Stage', render: (c) => <span className="chip">{c.stage}</span> },
    { key: 'actions', header: '', render: (c) => (
      <span className="action-bar">
        <button type="button" className="btn-ghost" onClick={() => void triage(c.contactId)}>Triage</button>
        <button type="button" className="btn-ghost" onClick={() => void remove(c.contactId)} aria-label={`Delete ${c.name}`}>Delete</button>
      </span>
    ) },
  ], [triage, remove]);

  return (
    <div className="u-grid u-gap-4">
      {error ? <Notice variant="error">{error}</Notice> : null}
      <div className="surface-card u-p-4 surface-form">
        <label className="u-grid u-gap-1"><span style={labelStyle}>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" /></label>
        <label className="u-grid u-gap-1"><span style={labelStyle}>Company</span><input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme" /></label>
        <label className="u-grid u-gap-1"><span style={labelStyle}>Stage</span>
          <select value={stage} onChange={(e) => setStage(e.target.value as ContactStage)}>{CONTACT_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        </label>
        <button type="button" className="btn-primary" disabled={busy || !name.trim()} onClick={() => void add()}>Add contact</button>
      </div>
      <DataTable rows={contacts ?? []} rowKey={(c) => c.contactId} columns={columns} caption="Contacts"
        empty={contacts === null ? <SkeletonRows rows={3} columns={[160, 140, 90, 120]} /> : (
          <StateCard icon={<UserIcon />} title="No contacts yet" body="Add your first contact with the form above — name, company, and a pipeline stage." />
        )} />
    </div>
  );
}

// ── Companies ────────────────────────────────────────────────────────────────
function CompaniesTab({ orgId }: { orgId: string }): JSX.Element {
  const [rows, setRows] = useState<Company[] | null>(null);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { void listCompanies(orgId).then(setRows).catch((e) => toast.error(e instanceof Error ? e.message : 'Load failed.')); }, [orgId]);
  useEffect(() => { setRows(null); if (orgId) load(); }, [orgId, load]);

  const add = useCallback(async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await createCompany(orgId, { name: name.trim(), ...(domain.trim() ? { domain: domain.trim() } : {}) }); setName(''); setDomain(''); load(); toast.success('Company added.'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Add failed.'); } finally { setBusy(false); }
  }, [orgId, name, domain, load]);

  const columns = useMemo<DataColumn<Company>[]>(() => [
    { key: 'name', header: 'Name', render: (c) => c.name },
    { key: 'domain', header: 'Domain', cellClass: 'muted', render: (c) => c.domain ?? '—' },
    { key: 'tags', header: 'Tags', render: (c) => <span className="action-bar">{c.tags.map((t) => <span key={t} className="chip">{t}</span>)}</span> },
    { key: 'actions', header: '', render: (c) => <button type="button" className="btn-ghost" onClick={() => void deleteCompany(orgId, c.companyId).then(load).catch(crudErr)}>Delete</button> },
  ], [orgId, load]);

  return (
    <div className="u-grid u-gap-4">
      <div className="surface-card u-p-4 surface-form">
        <label className="u-grid u-gap-1"><span style={labelStyle}>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Globex" /></label>
        <label className="u-grid u-gap-1"><span style={labelStyle}>Domain</span><input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="globex.com" /></label>
        <button type="button" className="btn-primary" disabled={busy || !name.trim()} onClick={() => void add()}>Add company</button>
      </div>
      <DataTable rows={rows ?? []} rowKey={(c) => c.companyId} columns={columns} caption="Companies"
        empty={rows === null ? <SkeletonRows rows={3} columns={[160, 160, 120, 90]} /> : (
          <StateCard icon={<BuildingIcon />} title="No companies yet" body="Add a company with the form above to start grouping deals and contacts." />
        )} />
    </div>
  );
}

// ── Deals ────────────────────────────────────────────────────────────────────
function DealsTab({ orgId }: { orgId: string }): JSX.Element {
  const [rows, setRows] = useState<Deal[] | null>(null);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void listDeals(orgId).then(setRows).catch((e) => toast.error(e instanceof Error ? e.message : 'Load failed.'));
    void listPipelines(orgId).then((p) => setPipeline(p[0] ?? null)).catch(() => setPipeline(null));
    void listCompanies(orgId).then(setCompanies).catch(() => setCompanies([]));
  }, [orgId]);
  useEffect(() => { setRows(null); if (orgId) load(); }, [orgId, load]);

  const add = useCallback(async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const amt = amount.trim() ? Number(amount) : undefined;
      if (amt !== undefined && !Number.isFinite(amt)) { toast.error('Amount must be a number.'); setBusy(false); return; }
      await createDeal(orgId, { title: title.trim(), ...(amt !== undefined ? { amount: amt } : {}), ...(companyId ? { companyId } : {}) });
      setTitle(''); setAmount(''); setCompanyId(''); load(); toast.success('Deal added.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Add failed.'); } finally { setBusy(false); }
  }, [orgId, title, amount, companyId, load]);

  const columns = useMemo<DataColumn<Deal>[]>(() => [
    { key: 'title', header: 'Title', render: (d) => d.title },
    { key: 'amount', header: 'Amount', cellClass: 'muted', render: (d) => (d.amount !== undefined ? `${d.amount}${d.currency ? ` ${d.currency}` : ''}` : '—') },
    { key: 'stage', header: 'Stage', render: (d) => (
      <select value={d.stageId} onChange={(e) => void moveDeal(orgId, d.dealId, e.target.value).then(load).catch(crudErr)} className="u-w-auto" aria-label="Stage">
        {(pipeline?.stages ?? []).map((s) => <option key={s.stageId} value={s.stageId}>{s.name}</option>)}
      </select>
    ) },
    { key: 'actions', header: '', render: (d) => <button type="button" className="btn-ghost" onClick={() => void deleteDeal(orgId, d.dealId).then(load).catch(crudErr)}>Delete</button> },
  ], [orgId, pipeline, load]);

  return (
    <div className="u-grid u-gap-4">
      <div className="surface-card u-p-4 surface-form">
        <label className="u-grid u-gap-1"><span style={labelStyle}>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Globex expansion" /></label>
        <label className="u-grid u-gap-1"><span style={labelStyle}>Amount</span><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" placeholder="5000" /></label>
        <label className="u-grid u-gap-1"><span style={labelStyle}>Company</span>
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}><option value="">—</option>{companies.map((co) => <option key={co.companyId} value={co.companyId}>{co.name}</option>)}</select>
        </label>
        <button type="button" className="btn-primary" disabled={busy || !title.trim()} onClick={() => void add()}>Add deal</button>
      </div>
      <DataTable rows={rows ?? []} rowKey={(d) => d.dealId} columns={columns} caption="Deals"
        empty={rows === null ? <SkeletonRows rows={3} columns={[180, 100, 120, 90]} /> : (
          <StateCard icon={<BriefcaseIcon />} title="No deals yet" body="Add a deal with the form above — give it a title, amount, and company." />
        )} />
    </div>
  );
}

// ── Tasks ────────────────────────────────────────────────────────────────────
function TasksTab({ orgId }: { orgId: string }): JSX.Element {
  const [rows, setRows] = useState<Task[] | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { void listTasks(orgId).then(setRows).catch((e) => toast.error(e instanceof Error ? e.message : 'Load failed.')); }, [orgId]);
  useEffect(() => { setRows(null); if (orgId) load(); }, [orgId, load]);

  const add = useCallback(async () => {
    if (!title.trim()) return;
    setBusy(true);
    try { await createTask(orgId, { title: title.trim() }); setTitle(''); load(); toast.success('Task added.'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Add failed.'); } finally { setBusy(false); }
  }, [orgId, title, load]);

  const columns = useMemo<DataColumn<Task>[]>(() => [
    { key: 'title', header: 'Title', render: (t) => t.title },
    { key: 'status', header: 'Status', render: (t) => (
      <select value={t.status} onChange={(e) => void setTaskStatus(orgId, t.taskId, e.target.value as TaskStatus).then(load).catch(crudErr)} className="u-w-auto" aria-label="Status">
        {TASK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    ) },
    { key: 'actions', header: '', render: (t) => <button type="button" className="btn-ghost" onClick={() => void deleteTask(orgId, t.taskId).then(load).catch(crudErr)}>Delete</button> },
  ], [orgId, load]);

  return (
    <div className="u-grid u-gap-4">
      <div className="surface-card u-p-4 surface-form">
        <label className="u-grid u-gap-1"><span style={labelStyle}>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Follow up with Globex" /></label>
        <button type="button" className="btn-primary" disabled={busy || !title.trim()} onClick={() => void add()}>Add task</button>
      </div>
      <DataTable rows={rows ?? []} rowKey={(t) => t.taskId} columns={columns} caption="Tasks"
        empty={rows === null ? <SkeletonRows rows={3} columns={[220, 120, 90]} /> : (
          <StateCard icon={<CheckIcon />} title="No tasks yet" body="Add a task with the form above to track follow-ups for this org." />
        )} />
    </div>
  );
}
