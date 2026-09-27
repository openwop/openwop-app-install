/**
 * CRM page (host-extension product feature — ADR 0001 §4, extended by ADR 0008).
 *
 * Gates on useFeatureAccess('crm'). A tab bar: the preserved tenant-wide
 * **Contacts** rolodex (+ variant-stamped triage), and the org-scoped, RBAC-gated
 * **Companies / Deals / Tasks** added in ADR 0008 (an org picker drives those).
 *
 * The shell only — each tab's markup + data-fetching lives in its own sibling
 * file (CRMGAP-FE-10), following the ReportsTab.tsx precedent this branch set:
 * ContactsTab.tsx, CompaniesTab.tsx, DealsTab.tsx, TasksTab.tsx, ReportsTab.tsx.
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { Tabs, TabPanel, useUrlTab } from '../../ui/Tabs.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { listOrgs, type Org } from './crmOrgClient.js';
import { ContactsTab } from './ContactsTab.js';
import { CompaniesTab } from './CompaniesTab.js';
import { DealsTab } from './DealsTab.js';
import { TasksTab } from './TasksTab.js';
import { ReportsTab } from './ReportsTab.js';
import { GmailSyncTab } from './GmailSyncTab.js';
import { BookingTab } from './BookingTab.js';
import { SignTab } from './SignTab.js';

/** ADR 0208 §2 (C2) — the stable feature.crm.agents persona every CRM install
 *  ships (feature.crm.nodes@1.3.0 is a required pack, so the agent pack's
 *  toolAllowlist always resolves). Replaces the earlier roster-lookup
 *  resolution (gap-analysis §5B / Phase B4), which hid the affordance on any
 *  host that hadn't happened to seed a "sales-execution" roster entry. */
const SALES_AGENT_ID = 'feature.crm.agents.sales-ops';
type Tab = 'contacts' | 'companies' | 'deals' | 'tasks' | 'booking' | 'esign' | 'reports' | 'gmailsync';
const TABS: { id: Tab; labelKey: string }[] = [
  { id: 'contacts', labelKey: 'tabContacts' },
  { id: 'companies', labelKey: 'tabCompanies' },
  { id: 'deals', labelKey: 'tabDeals' },
  { id: 'tasks', labelKey: 'tabTasks' },
  { id: 'booking', labelKey: 'tabBooking' },
  { id: 'esign', labelKey: 'tabEsign' },
  { id: 'reports', labelKey: 'tabReports' },
  { id: 'gmailsync', labelKey: 'tabGmailSync' },
];
const TAB_IDS: readonly Tab[] = TABS.map((tabItem) => tabItem.id);

export function CrmPage(): JSX.Element {
  const { t } = useTranslation('crm');
  const crm = useFeatureAccess('crm');
  const navigate = useNavigate();
  // Rule 12 (routing-correction canon): the open tab binds to `?tab=` so a
  // reload or shared link restores it — never invisible in-page state.
  const [tab, setTab] = useUrlTab<Tab>('tab', TAB_IDS, 'contacts');
  // `.catch(() => setOrgs([]))` rendered "No organizations — create an
  // organization first" over a failed read, on the CRM: an operator would
  // reasonably conclude their companies, deals and tasks were gone.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs, crm.enabled);
  // CRM-UX-16 — a record page that deletes its record navigates here with
  // `state.focusTitle`; land focus on the title so the move is announced.
  // Deferred one tick: App.tsx moves focus to <main> on every pathname change
  // in ITS effect, which runs AFTER this child's — a synchronous focus here
  // would be taken straight back.
  // Consumed ONCE: the state is then cleared from the history entry (a
  // `replace` of the same URL), so Back / Forward through this entry does
  // not re-run the jump on a visit the user made themselves.
  const location = useLocation();
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!(location.state as { focusTitle?: boolean } | null)?.focusTitle) return;
    const id = window.setTimeout(() => {
      titleRef.current?.focus();
      navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
    }, 0);
    return () => window.clearTimeout(id);
  }, [location.key, location.state, location.pathname, location.search, navigate]);

  if (crm.loading) return <Skeleton />;
  if (!crm.enabled) {
    return (
      <section data-walkthrough="crm.page" className="u-grid u-gap-4">
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
  const askAgent = (
    <Button variant="secondary" onClick={() => navigate(`/?agent=${encodeURIComponent(SALES_AGENT_ID)}`)}>
      {t('askSalesAgent')}
    </Button>
  );
  const headerActions = (
    <span className="action-bar">
      {askAgent}
      {needsOrg ? orgPicker : null}
    </span>
  );

  return (
    <section className="u-grid u-gap-4">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        titleRef={titleRef}
        lede={crm.variant ? t('ledeVariant', { variant: crm.variant }) : t('lede')}
        actions={headerActions}
      />

      <Tabs
        items={TABS.map((tabItem) => ({ id: tabItem.id, label: t(tabItem.labelKey) }))}
        value={tab}
        onChange={setTab}
        label={t('tablistLabel')}
        idBase="crm"
      />

      <TabPanel idBase="crm" tabId={tab}>
        {tab === 'contacts' ? <ContactsTab /> : null}
        {/* HG-4 — the noun and the branch ORDER (failed → zero-orgs → children)
            are `OrgSelectionState`'s now. This page had it inverted (the skeleton
            was checked ABOVE the zero-org branch); every org-scoped tab is the
            CHILD, which is what makes the right order unskippable. `needsOrg`
            stays OUTSIDE: the Contacts tab is tenant-wide, so on that tab there
            is no org-gated read and therefore nothing to say about organizations.
            Each tab owns its own loading affordance keyed on its own rows read;
            with no organization selected `orgId` is '' and those reads never
            start, which is why both org states must sit above them. */}
        {needsOrg && (
          <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
            emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')}>
            {tab === 'companies' ? <CompaniesTab orgId={orgId} /> : null}
            {tab === 'deals' ? <DealsTab orgId={orgId} /> : null}
            {tab === 'tasks' ? <TasksTab orgId={orgId} /> : null}
            {tab === 'booking' ? <BookingTab orgId={orgId} /> : null}
            {tab === 'esign' ? <SignTab orgId={orgId} /> : null}
            {tab === 'reports' ? <ReportsTab orgId={orgId} /> : null}
            {tab === 'gmailsync' ? <GmailSyncTab orgId={orgId} /> : null}
          </OrgSelectionState>
        )}
      </TabPanel>
    </section>
  );
}
