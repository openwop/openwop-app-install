/**
 * EventBindingsPage designed states (ADR 0208 §1 admin UI) — the gate/loading
 * skeleton never strands, the empty StateCard names the next action, a
 * fetched binding's workflowId resolves to its owned-workflow label (not the
 * raw id), and create / toggle / delete each send the right request (exact path,
 * method, body) through the real client and surface a toast.
 *
 * Sabotage that turns it red: resolve labels to the raw id; POST a different
 * workflowId; PATCH `b.enabled` instead of `!b.enabled`; skip the DELETE; drop the
 * skeleton, the catalog label or the catalog-failure Notice.
 *
 * Stubbed at the fetch level (not a client-module mock), matching
 * AuditLogPage.test.tsx: a module-level vi.fn rejection trips the runner's
 * unhandled-rejection tracker across tests, fetch-level stubbing doesn't.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { EventBindingsPage } from '../EventBindingsPage.js';
import { Toaster } from '../../ui/toast.js';
import type { HostEventBinding, HostEventCatalogEntry } from '../../client/hostEventBindingsClient.js';
import type { WorkflowSummaryDTO } from '../../workflows/workflowsClient.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const BINDING: HostEventBinding = {
  bindingId: 'hevb:1',
  tenantId: 't1',
  eventType: 'host.crm.contact.created',
  workflowId: 'wf-1',
  enabled: true,
  createdBy: 'user-1',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};
const WORKFLOW: WorkflowSummaryDTO = { workflowId: 'wf-1', kind: 'workflow', name: 'Route new lead', nodeCount: 4, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' };

const CATALOG: HostEventCatalogEntry[] = [
  { emitted: 'host.crm.contact.created', type: 'openwop-app.crm-contact-created', delivery: 'durable' },
  { emitted: 'host.goals.evaluated', type: 'openwop-app.goals-evaluated', delivery: 'durable' },
];

type FetchMock = ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

function mockFetch(opts: { bindings?: HostEventBinding[]; workflows?: WorkflowSummaryDTO[]; catalog?: HostEventCatalogEntry[] | 'fail' } = {}): FetchMock {
  const bindings = opts.bindings ?? [BINDING];
  const catalog = opts.catalog ?? CATALOG;
  const workflows = opts.workflows ?? [WORKFLOW];
  const fn = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = new URL(url, 'http://localhost').pathname;
    if (path === '/host/openwop-app/host-events/bindings' && method === 'GET') {
      return jsonResponse(200, { bindings });
    }
    if (path === '/host/openwop-app/host-events/bindings' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { eventType: string; workflowId: string };
      return jsonResponse(201, {
        bindingId: 'hevb:new', tenantId: 't1', enabled: true, createdBy: 'user-1',
        createdAt: '2026-07-03T00:00:00.000Z', updatedAt: '2026-07-03T00:00:00.000Z', ...body,
      });
    }
    if (path.startsWith('/host/openwop-app/host-events/bindings/') && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as { enabled: boolean };
      return jsonResponse(200, { ...BINDING, ...body, updatedAt: '2026-07-03T00:01:00.000Z' });
    }
    if (path.startsWith('/host/openwop-app/host-events/bindings/') && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (path === '/host/openwop-app/host-events/catalog' && method === 'GET') {
      return catalog === 'fail' ? jsonResponse(500, { error: { code: 'internal_error', message: 'boom' } }) : jsonResponse(200, { types: catalog });
    }
    if (path === '/host/openwop-app/workflows' && method === 'GET') {
      return jsonResponse(200, { workflows });
    }
    throw new Error(`unhandled fetch ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** The requests made with `method` to a path under the bindings route, as (path, body). */
function requests(fn: FetchMock, method: string): { path: string; body: unknown }[] {
  return fn.mock.calls
    .filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === method)
    .map(([url, init]) => ({ path: new URL(url, 'http://localhost').pathname, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) }));
}

function renderPage(): void {
  render(<><EventBindingsPage /><Toaster /></>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('EventBindingsPage designed states', () => {
  it('gate: renders the loading skeleton, never a stranded blank, before the fetch settles', () => {
    mockFetch();
    renderPage();
    expect(screen.getByRole('status', { name: /loading/i })).toBeTruthy();
  });

  it('empty: renders the designed StateCard naming the next action', async () => {
    mockFetch({ bindings: [], workflows: [] });
    renderPage();
    expect(await screen.findByText('No event bindings yet')).toBeTruthy();
    expect(screen.getByText(/Create your first binding above/)).toBeTruthy();
  });

  it('list: resolves the bound workflowId to its owned-workflow label, not the raw id', async () => {
    mockFetch();
    renderPage();
    expect(await screen.findByText('host.crm.contact.created')).toBeTruthy();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Route new lead')).toBeTruthy();
    expect(within(table).queryByText('wf-1')).toBeNull();
  });

  it('create: POSTs the typed event type with the defaulted workflow, re-reads, and toasts success', async () => {
    const fn = mockFetch();
    renderPage();
    await screen.findByText('host.crm.contact.created');
    const getsBefore = requests(fn, 'GET').filter((r) => r.path === '/host/openwop-app/host-events/bindings').length;

    const eventTypeInput = screen.getByLabelText(/^Event type/);
    fireEvent.change(eventTypeInput, { target: { value: 'host.crm.deal.won' } });
    fireEvent.click(screen.getByRole('button', { name: /Create binding/ }));

    expect(await screen.findByText('Binding created for host.crm.deal.won.')).toBeTruthy();
    expect(requests(fn, 'POST')).toEqual([
      { path: '/host/openwop-app/host-events/bindings', body: { eventType: 'host.crm.deal.won', workflowId: 'wf-1' } },
    ]);
    expect(requests(fn, 'GET').filter((r) => r.path === '/host/openwop-app/host-events/bindings').length).toBe(getsBefore + 1);
  });

  it('toggle: PATCHes the binding to the OPPOSITE of its enabled state and toasts it', async () => {
    const fn = mockFetch();
    renderPage();
    await screen.findByText('host.crm.contact.created');

    fireEvent.click(screen.getByRole('button', { name: /Toggle host\.crm\.contact\.created/ }));

    expect(await screen.findByText('host.crm.contact.created disabled.')).toBeTruthy();
    expect(requests(fn, 'PATCH')).toEqual([
      { path: '/host/openwop-app/host-events/bindings/hevb%3A1', body: { enabled: false } },
    ]);
  });

  it('delete: confirms, DELETEs the binding by id, and toasts success', async () => {
    const origConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const fn = mockFetch();
      renderPage();
      await screen.findByText('host.crm.contact.created');

      fireEvent.click(screen.getByRole('button', { name: 'Delete binding for host.crm.contact.created' }));

      await waitFor(() => expect(screen.getByText('Binding for host.crm.contact.created deleted.')).toBeTruthy());
      expect(requests(fn, 'DELETE')).toEqual([{ path: '/host/openwop-app/host-events/bindings/hevb%3A1', body: undefined }]);
    } finally {
      window.confirm = origConfirm;
    }
  });

  // ADR 0825 — the suggestions are the backend catalog, not a hand-kept list.
  it('catalog: the event-type suggestions are the backend catalog, labelled with the v2 type', async () => {
    mockFetch();
    const { container } = render(<><EventBindingsPage /><Toaster /></>);
    await waitFor(() => expect(container.querySelectorAll('#host-event-types option')).toHaveLength(CATALOG.length));
    const opts = [...container.querySelectorAll('#host-event-types option')];
    expect(opts.map((o) => o.getAttribute('value'))).toEqual(CATALOG.map((c) => c.emitted));
    expect(opts.map((o) => o.getAttribute('label'))).toEqual(CATALOG.map((c) => c.type));
    expect(screen.queryByText(/list of event types could not be loaded/i)).toBeNull();
  });

  it('catalog read failure: says so, and free text still works', async () => {
    mockFetch({ catalog: 'fail' });
    const { container } = render(<><EventBindingsPage /><Toaster /></>);
    expect((await screen.findAllByText(/list of event types could not be loaded/i)).length).toBeGreaterThan(0);
    expect(container.querySelectorAll('#host-event-types option')).toHaveLength(0);
  });
});
