/**
 * FP-1 (docs/steward/CODEBASE-ASSESSMENT.md): the headline feature pages had no component
 * tests. Covers CrmPage's access-gate tri-state — loading → skeleton,
 * disabled → "not enabled" StateCard (the FE-is-never-the-authority gate), and
 * enabled → renders fetched data — plus the Phase-A honesty fixes: the deals
 * pipeline picker (list filtered by the SELECTED pipeline), the company
 * search box (?q=), and the triage "View run" provenance link.
 *
 * Also pinned here: CRM-UX-4 (failed reads are the canonical announced card +
 * Retry, never an empty state), HIGH-1 (no "No … yet" during a retry), CRM-UX-12
 * / LOW-8 (create forms gated on the defs/pipelines they need), CRM-UX-16 (focus
 * lands on the title after a record delete), CRMGAP-FE-9 (agent deep-link,
 * board columnFooter) and ADR 0768 D5 (the Pocket's agent + honest scope).
 *
 * Sabotage that turns it red (wave-4 /grade-tests probes, 20 witnessed): e.g.
 * the access-loading branch dropped; the title focus or its `focusTitle` guard
 * removed; any failed-read catch writing `[]` instead of UNKNOWN; either create
 * gate losing its failure flag; the segment filter or `?q=` dropped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ADR 0768 D5 — stub the Pocket so the page test reads WHICH agent and WHAT scope it mounts.
vi.mock('../../../chat/ChatPocket.js', () => ({
  ChatPocket: ({ agentId, contextLabel }: { agentId: string; contextLabel?: unknown }) => (
    <div data-testid="pocket" data-agent={agentId}>{contextLabel as string}</div>
  ),
}));
import { act, render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
// Type-only (erased at runtime, so it does not race `vi.mock` below). Typing the
// hoisted mocks against the REAL client types is what makes a fixture that drifts
// from the client a TYPE error here rather than a green test asserting a shape the
// app no longer returns.
import type * as CrmClient from '../crmClient.js';
import type * as OrgClient from '../crmOrgClient.js';
import type { Contact } from '../crmClient.js';
import type { Deal, Pipeline, Task } from '../crmOrgClient.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

/** A contact FIXTURE: the identifying trio every test sets, plus any real `Contact`
 *  field a test needs. Server-owned fields (`tenantId`, `createdAt`, `updatedAt`)
 *  stay optional because the component never reads them and demanding them would
 *  add noise to every fixture — but a MISSPELLED field is still an excess-property
 *  error, which is the drift this needs to catch. */
type ContactFixture = Partial<Contact> & Pick<Contact, 'contactId'>;

// CRMGAP-FE-9: pins the `?agent=` deep-link target — keep react-router-dom
// otherwise real (MemoryRouter/Link) so routing still works; only useNavigate
// is swapped for a spy.
const navigateSpy = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateSpy };
});

// CRMGAP-FE-9 (board path): mocking KanbanBoardView tests OUR wiring — the
// board/cards/columnFooter props DealsTab hands it. The onMoveCard → moveDeal
// round-trip is NOT re-asserted here: dealsBoardKeyboard.test.tsx drives it
// through the REAL KanbanBoardView ("Space → ArrowRight once → Space calls
// moveDeal…"), and probe w4g4-cp-board-move-DBK showed it red under the same
// break that reddened the old simulated-move half of the board case below.
vi.mock('../../../kanban/KanbanBoardView.js', () => ({
  KanbanBoardView: (props: {
    board: { columns: { id: string; name: string }[] };
    cards: { id: string; columnId: string }[];
    columnFooter?: (col: { id: string }, cards: { id: string; columnId: string }[]) => JSX.Element | null;
  }) => {
    return (
      <div data-testid="kanban-board-mock">
        {props.board.columns.map((col) => {
          const colCards = props.cards.filter((c) => c.columnId === col.id);
          return (
            <div key={col.id} data-testid={`col-${col.id}`}>
              <span>{col.name}</span>
              {props.columnFooter ? props.columnFooter(col, colCards) : null}
            </div>
          );
        })}
      </div>
    );
  },
}));

// The REAL hook's return type (makeFeatureAccess), never a hand-rolled subset.
const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: access.useFeatureAccess,
}));
const setAccess = (over: { enabled: boolean; loading?: boolean }): void => {
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ loading: false, ...over }));
};
const triageContact = vi.hoisted(() => vi.fn<typeof CrmClient.triageContact>(async () => ({ runId: 'run-abc-123', variant: 'basic', workflowId: 'wf1', bindings: {} })));
const listContacts = vi.hoisted(() => vi.fn(async (): Promise<ContactFixture[]> => [{ contactId: 'c1', name: 'Ada Lovelace', stage: 'lead' }]));
const listSegments = vi.hoisted(() => vi.fn<typeof CrmClient.listSegments>(async () => []));
const listSegmentMembers = vi.hoisted(() => vi.fn(async (): Promise<ContactFixture[]> => []));
const listContactFields = vi.hoisted(() => vi.fn<typeof CrmClient.listContactFields>(async () => []));
vi.mock('../crmClient.js', () => ({
  CONTACT_STAGES: ['lead', 'qualified', 'customer', 'churned'],
  listContacts,
  createContact: vi.fn(),
  deleteContact: vi.fn(),
  triageContact,
  listSegments,
  createSegment: vi.fn(),
  deleteSegment: vi.fn(),
  listSegmentMembers,
  // CRM-UX-7 — ContactsTab now reads the tenant's contact field DEFS. This
  // factory is exhaustive (no `importOriginal` spread), so an omission here is
  // an `undefined is not a function` on mount, not a silent real fetch.
  listContactFields,
  createContactField: vi.fn(),
  deleteContactField: vi.fn(),
}));
const listDeals = vi.hoisted(() => vi.fn(async (): Promise<Deal[]> => []));
const listCompanies = vi.hoisted(() => vi.fn<typeof OrgClient.listCompanies>(async () => []));
const listPipelines = vi.hoisted(() => vi.fn(async (): Promise<Pipeline[]> => [
  { pipelineId: 'p1', name: 'Sales', stages: [{ stageId: 's1', name: 'New', probability: 10 }] },
  { pipelineId: 'p2', name: 'Renewals', stages: [{ stageId: 's2', name: 'Due', probability: 50 }] },
]));
const listTasks = vi.hoisted(() => vi.fn(async (): Promise<Task[]> => []));
vi.mock('../crmOrgClient.js', () => ({
  TASK_STATUSES: ['open', 'doing', 'done'],
  listOrgs: vi.fn<typeof OrgClient.listOrgs>(async () => [{ orgId: 'o1', name: 'Org One' }]),
  listCompanies,
  listDeals,
  listTasks,
  listPipelines,
  createCompany: vi.fn(), createDeal: vi.fn(), createTask: vi.fn(),
  deleteCompany: vi.fn(), deleteDeal: vi.fn(), deleteTask: vi.fn(),
  moveDeal: vi.fn(), setTaskStatus: vi.fn(),
}));

import { CrmPage } from '../CrmPage.js';

const renderPage = () => render(<MemoryRouter><CrmPage /></MemoryRouter>);

beforeEach(() => {
  // resetAllMocks (not clear): an unconsumed `*Once` or a case-level
  // `mockResolvedValue` must not leak into the next case. Vitest 4 restores
  // each `vi.fn(impl)` original, so the hoisted defaults above survive.
  vi.resetAllMocks();
  setAccess({ enabled: false });
  listSegments.mockResolvedValue([{ segmentId: 'seg1', name: 'Qualified leads', filters: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }]);
  listSegmentMembers.mockResolvedValue([{ contactId: 'c1' }]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('CrmPage access gate', () => {
  it('renders a skeleton while access is loading (neither gate copy nor content)', () => {
    setAccess({ enabled: false, loading: true });
    const { container } = renderPage();
    // While loading we show neither the "not enabled" gate nor the CRM content…
    expect(screen.queryByText(/not enabled/i)).toBeNull();
    expect(screen.queryByText('CRM')).toBeNull();
    // …and the skeleton IS there (a blank render must not pass). `Skeleton` is
    // `aria-hidden` with no role or text, so its class is the only handle.
    expect(container.querySelector('.skeleton')).not.toBeNull();
  });

  it('shows the "not enabled" StateCard when the feature is off (server-gated)', () => {
    setAccess({ enabled: false });
    renderPage();
    expect(screen.getByText(/CRM is not enabled/i)).toBeTruthy();
  });

  it('renders the CRM page + fetched contacts when enabled', async () => {
    setAccess({ enabled: true });
    renderPage();
    // The header renders immediately…
    expect(screen.getAllByText('CRM').length).toBeGreaterThan(0);
    // …and the mocked contact lands after the async fetch.
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeTruthy());
  });
});

describe('CrmPage Phase-A fixes', () => {
  it('deals: shows the pipeline picker for >1 pipelines and filters by the selected one', async () => {
    setAccess({ enabled: true });
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Deals' }));
    // Initial load filters by the FIRST pipeline (not an unfiltered list).
    await waitFor(() => expect(listDeals).toHaveBeenCalledWith('o1', { pipelineId: 'p1' }));
    const picker = await screen.findByLabelText('Pipeline');
    fireEvent.change(picker, { target: { value: 'p2' } });
    await waitFor(() => expect(listDeals).toHaveBeenCalledWith('o1', { pipelineId: 'p2' }));
  });

  it('companies: the search box passes q to listCompanies (debounced)', async () => {
    setAccess({ enabled: true });
    // >3 companies — the filterbar search is gated on the unfiltered total.
    listCompanies.mockResolvedValue([1, 2, 3, 4].map((i) => ({ companyId: `co${i}`, name: `Co ${i}`, tags: [] })));
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Companies' }));
    await waitFor(() => expect(listCompanies).toHaveBeenCalledWith('o1', undefined));
    fireEvent.change(screen.getByLabelText('Search companies'), { target: { value: 'acme' } });
    await waitFor(() => expect(listCompanies).toHaveBeenCalledWith('o1', 'acme'), { timeout: 2000 });
  });

  it('contacts: the segment select fetches its live members and filters the visible list', async () => {
    setAccess({ enabled: true });
    listContacts.mockResolvedValue([
      { contactId: 'c1', name: 'Ada Lovelace', stage: 'lead' },
      { contactId: 'c2', name: 'Bob Builder', stage: 'qualified' },
    ]);
    listSegmentMembers.mockResolvedValue([{ contactId: 'c2', name: 'Bob Builder', stage: 'qualified' }]);
    renderPage();
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeTruthy());
    expect(screen.getByText('Bob Builder')).toBeTruthy();

    const picker = await screen.findByLabelText('Segment');
    fireEvent.change(picker, { target: { value: 'seg1' } });
    await waitFor(() => expect(listSegmentMembers).toHaveBeenCalledWith('seg1'));
    await waitFor(() => expect(screen.queryByText('Ada Lovelace')).toBeNull());
    expect(screen.getByText('Bob Builder')).toBeTruthy();
  });

  it('contacts: triage persists a lastTriage stamp surfaced as a View run link', async () => {
    setAccess({ enabled: true });
    renderPage();
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeTruthy());
    // After triage the reload returns the persisted stamp (B3a).
    listContacts.mockResolvedValue([{
      contactId: 'c1', name: 'Ada Lovelace', stage: 'lead',
      lastTriage: { variant: 'basic', runId: 'run-abc-123', at: '2026-07-03T12:00:00.000Z' },
    }]);
    fireEvent.click(screen.getByRole('button', { name: 'Triage' }));
    const link = await screen.findByRole('link', { name: /view the latest triage run/i });
    expect(link.getAttribute('href')).toBe('/runs/run-abc-123');
  });
});

describe('CrmPage Phase-B fixes (CRMGAP-FE-9)', () => {
  it('pins the "Ask the sales agent" deep-link target', async () => {
    setAccess({ enabled: true });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Ask the sales agent' }));
    expect(navigateSpy).toHaveBeenCalledWith('/?agent=vendor.openwop-app.crm.agents.sales-ops');
  });

  it('deals board: renders columns with the columnFooter meta (count + amount sum per column)', async () => {
    setAccess({ enabled: true });
    listPipelines.mockResolvedValueOnce([
      { pipelineId: 'p1', name: 'Sales', stages: [
        { stageId: 's1', name: 'New', probability: 10 },
        { stageId: 's2', name: 'Won', probability: 90 },
      ] },
    ]);
    listDeals.mockResolvedValueOnce([
      { dealId: 'd1', title: 'Globex expansion', pipelineId: 'p1', stageId: 's1', amount: 1000, status: 'open' },
      { dealId: 'd2', title: 'Initech renewal', pipelineId: 'p1', stageId: 's2', amount: 2000, status: 'open' },
    ]);
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Deals' }));
    await waitFor(() => expect(screen.getByTestId('kanban-board-mock')).toBeTruthy());

    // columnFooter renders each column's card count + amount sum (ADR 0008 board rollup).
    // The count is matched plural-AGNOSTICALLY on purpose. This used to assert
    // the literal '1 deals': `boardColumnMeta` has no `_one`/`_other` forms, so
    // a one-card column reads "1 deals" — the LOW-6 defect PipelinesPage fixed
    // for its own strings. Pinning it would block that fix; asserting "1 deal"
    // would fail today (BLOCKED-ON-PRODUCT, wave-4 /grade-tests g4). The claim
    // here is the count and the sum, which both forms carry.
    await waitFor(() => expect(screen.getByTestId('col-s1').textContent).toMatch(/1 deals? · /));
    expect(screen.getByTestId('col-s1').textContent).toContain('1,000');
    expect(screen.getByTestId('col-s2').textContent).toMatch(/1 deals? · /);
    expect(screen.getByTestId('col-s2').textContent).toContain('2,000');
  });
});

describe('CrmPage UX audit fixes', () => {
  // CRM-UX-4 — these four used to assert the RAW SERVER STRING was on screen
  // ("contacts boom"), i.e. they pinned the shape the audit called out: a bare
  // Notice carrying the transport's message, with no Retry and no consequence
  // clause, whose only recovery was a page reload. The contract is now the
  // canonical announced failed-read card on the SHARED `common:` copy — the
  // bar the same feature's SignTab/GmailSyncTab already met.
  // CRM-UX-16 — a record page's delete navigates here with `state.focusTitle`;
  // the page must land focus on its title (deferred a tick, because App.tsx
  // moves focus to <main> on every pathname change in its own, later effect).
  it('arriving with state.focusTitle moves focus to the page title', async () => {
    setAccess({ enabled: true });
    render(
      <MemoryRouter initialEntries={[{ pathname: '/crm', search: '?tab=deals', state: { focusTitle: true } }]}>
        <CrmPage />
      </MemoryRouter>,
    );
    const title = await screen.findByRole('heading', { level: 1, name: 'CRM' });
    await waitFor(() => expect(document.activeElement).toBe(title));
    // …and the state is consumed: the entry is replaced WITHOUT it, so Back /
    // Forward through this entry does not re-run the jump.
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ pathname: '/crm', search: '?tab=deals' }, { replace: true, state: null }));
  });

  it('arriving WITHOUT that state leaves focus alone (no unsolicited focus jump on an ordinary visit)', async () => {
    setAccess({ enabled: true });
    render(<MemoryRouter initialEntries={['/crm?tab=deals']}><CrmPage /></MemoryRouter>);
    const title = await screen.findByRole('heading', { level: 1, name: 'CRM' });
    // The focus jump is deferred by a 0-ms timer; a 0-ms timer queued AFTER it
    // runs after it (FIFO), so this waits exactly past the jump — no fixed sleep.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(document.activeElement).not.toBe(title);
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  const FAILED_TITLE = 'Could not load this';
  const FAILED_BODY = 'The list could not be read, so we cannot say what is here. Retry, or reload the page.';

  it('contacts: a failed read is the canonical announced card + Retry, never the misleading empty state', async () => {
    setAccess({ enabled: true });
    listContacts.mockReset();
    listContacts.mockRejectedValueOnce(new Error('contacts boom'));
    renderPage();
    expect(await screen.findByText(FAILED_TITLE)).toBeTruthy();
    expect(screen.getByText(FAILED_BODY)).toBeTruthy();
    // The transport's own words are NOT what the user is handed.
    expect(screen.queryByText('contacts boom')).toBeNull();
    // §Correction — this used to assert the empty StateCard RENDERS. That
    // pinned the defect: a failed read is not an honestly-empty list, and
    // showing both told the user "it broke" AND "you have none".
    expect(screen.queryByText('No contacts yet')).toBeNull();

    // The recovery is real: Retry re-issues the read (before CRM-UX-4 the only
    // recovery on this tab was a page reload).
    const before = listContacts.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(listContacts.mock.calls.length).toBeGreaterThan(before));
  });

  it('contacts: HIGH-1 — DURING the retry it shows the loading state, never "No contacts yet"', async () => {
    // The Retry added above reintroduced the exact claim it was added to
    // remove. `load()` clears `error` SYNCHRONOUSLY while the `[]` the failed
    // read wrote stays in state, and the empty state is gated on `error` — so
    // for the whole retry request the tab said "No contacts yet" about a list
    // it had just failed to read. Mount was safe only because `contacts`
    // starts `null`.
    //
    // `await waitFor(calls > before)` cannot see this window at all: it only
    // proves a request went out. A promise the TEST settles can.
    setAccess({ enabled: true });
    listContacts.mockReset();
    listContacts.mockRejectedValueOnce(new Error('contacts boom'));
    renderPage();
    await screen.findByText(FAILED_TITLE);

    let land!: (v: ContactFixture[]) => void;
    listContacts.mockReturnValueOnce(new Promise((res) => { land = res; }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(listContacts.mock.calls.length).toBe(2));
    expect(screen.queryByText('No contacts yet')).toBeNull();
    expect(screen.queryByText(FAILED_TITLE)).toBeNull();

    land([{ contactId: 'c1', name: 'Ada Lovelace', stage: 'lead' }]);
    expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
  });

  it('companies: a failed read is the canonical announced card + Retry, never the misleading empty state', async () => {
    setAccess({ enabled: true });
    listCompanies.mockRejectedValueOnce(new Error('companies boom'));
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Companies' }));
    expect(await screen.findByText(FAILED_TITLE)).toBeTruthy();
    expect(screen.queryByText('companies boom')).toBeNull();
    // §Correction — see the contacts case: a failed read must not render as
    // an honestly-empty list.
    expect(screen.queryByText('No companies yet')).toBeNull();
    const before = listCompanies.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(listCompanies.mock.calls.length).toBeGreaterThan(before));
  });

  it('tasks: a failed read is the canonical announced card + Retry, never the misleading empty state', async () => {
    setAccess({ enabled: true });
    listTasks.mockRejectedValueOnce(new Error('tasks boom'));
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Tasks' }));
    expect(await screen.findByText(FAILED_TITLE)).toBeTruthy();
    expect(screen.queryByText('tasks boom')).toBeNull();
    // §Correction — see the contacts case: a failed read must not render as
    // an honestly-empty list.
    expect(screen.queryByText('No tasks yet')).toBeNull();
    const before = listTasks.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(listTasks.mock.calls.length).toBeGreaterThan(before));
  });

  it('deals: a pipeline load failure is the canonical announced card + Retry, never "No deals yet"', async () => {
    setAccess({ enabled: true });
    listPipelines.mockRejectedValueOnce(new Error('pipelines boom'));
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Deals' }));
    expect(await screen.findByText(FAILED_TITLE)).toBeTruthy();
    expect(screen.queryByText('pipelines boom')).toBeNull();
    // The board's "No deals yet" StateCard must NOT render — a pipeline
    // fetch failure is not an honestly-empty pipeline (UX audit finding #2).
    expect(screen.queryByText('No deals yet')).toBeNull();
    const before = listPipelines.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(listPipelines.mock.calls.length).toBeGreaterThan(before));
  });

  it('deals: HIGH-1 — DURING the retry the board shows the loading state, never "No deals yet"', async () => {
    // Same family as the contacts case, reached through the DEALS-list read:
    // its catch left `rows = []`, and the Retry calls `loadPipelines()`, which
    // clears `error` + `pipelinesFailed` SYNCHRONOUSLY. Because `pipelines`
    // itself does not change, the effect that would have nulled `rows` never
    // re-fires — so the stale `[]` renders "No deals yet" for the whole retry.
    //
    // (The pipelines-read failure is the same defect but is masked: replacing
    // `pipelines` re-mints `load`, whose effect nulls `rows` on the way past.
    // Choosing the read that is NOT masked is what makes this test discriminate.)
    setAccess({ enabled: true });
    listDeals.mockRejectedValueOnce(new Error('deals boom'));
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Deals' }));
    await screen.findByText(FAILED_TITLE);

    const callsBefore = listPipelines.mock.calls.length;
    let land!: (v: Pipeline[]) => void;
    listPipelines.mockReturnValueOnce(new Promise((res) => { land = res; }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(listPipelines.mock.calls.length).toBe(callsBefore + 1));
    expect(screen.queryByText('No deals yet')).toBeNull();
    expect(screen.queryByText(FAILED_TITLE)).toBeNull();

    land([{ pipelineId: 'p1', name: 'Sales', stages: [{ stageId: 's1', name: 'New', probability: 10 }] }]);
    await waitFor(() => expect(listDeals.mock.calls.length).toBeGreaterThan(1));
  });

  it('deals: CRM-UX-12 — a pipelines-load failure DISABLES the create form and names why', async () => {
    setAccess({ enabled: true });
    listPipelines.mockRejectedValueOnce(new Error('pipelines boom'));
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Deals' }));
    await screen.findByText('Could not load this');
    // Before: the form stayed fully enabled, so "Add deal" posted with no
    // pipelineId while the surface below said the read failed.
    // A title is typed FIRST: with an empty title the button is disabled by
    // `!title.trim()` alone, which made this assertion unable to fail (probe
    // w4g4-cp-deals-gate stayed green with the pipelines gate removed).
    fireEvent.change(screen.getByPlaceholderText('Q3 expansion'), { target: { value: 'New deal' } });
    const submit = screen.getByRole('button', { name: 'Add deal' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText(/nowhere to be filed/)).toBeTruthy();
  });

  it('deals: a DEALS-list failure leaves the create form usable (the gate is pipelines-specific)', async () => {
    // The discriminator for the test above: `error` is set by BOTH reads, so a
    // gate written off `error` would wrongly block creation when only the list
    // read failed — the deal itself is perfectly fileable.
    setAccess({ enabled: true });
    listDeals.mockRejectedValueOnce(new Error('deals boom'));
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Deals' }));
    await screen.findByText('Could not load this');
    const title = screen.getByPlaceholderText('Q3 expansion') as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'New deal' } });
    const submit = screen.getByRole('button', { name: 'Add deal' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it('contacts: LOW-8 — a failed field-DEFS read disables Add contact and names why', async () => {
    // The mirror of the deals gate above, which this tab was missing: without
    // the defs the form renders no custom inputs at all, so a REQUIRED custom
    // field comes back as a server 400 the user has no way to act on.
    setAccess({ enabled: true });
    listContactFields.mockRejectedValueOnce(new Error('fields boom'));
    renderPage();
    expect(await screen.findByText('Contact fields didn’t load')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New person' } });
    expect((screen.getByRole('button', { name: 'Add contact' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/a required one would be rejected on save/)).toBeTruthy();
  });

  it('contacts: a SUCCESSFUL field-defs read leaves Add contact usable (the discriminator)', async () => {
    setAccess({ enabled: true });
    renderPage();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'New person' } });
    expect((screen.getByRole('button', { name: 'Add contact' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('ADR 0768 D5 — the feature assistant Pocket', () => {
  it('mounts this feature\'s agent with an honest scope (orgs the caller can read)', async () => {
    setAccess({ enabled: true });
    renderPage();
    const pocket = await screen.findByTestId('pocket');
    expect(pocket.getAttribute('data-agent')).toBe('vendor.openwop-app.crm.agents.sales-ops');
    expect(pocket.textContent).toBe('CRM records in organizations you can read');
  });
  it('no Pocket while the feature is disabled', async () => {
    setAccess({ enabled: false });
    renderPage();
    expect(await screen.findByText(/CRM is not enabled/i)).toBeTruthy();
    expect(screen.queryByTestId('pocket')).toBeNull();
  });
});
