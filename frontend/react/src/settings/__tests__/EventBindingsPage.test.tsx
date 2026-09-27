/**
 * EventBindingsPage designed states (ADR 0208 §1 admin UI) — the gate/loading
 * skeleton never strands, the empty StateCard names the next action, a
 * fetched binding's workflowId resolves to its owned-workflow label (not the
 * raw id), and create / toggle / delete each round-trip through the real
 * client + surface a toast.
 *
 * Stubbed at the fetch level (not a client-module mock), matching
 * AuditLogPage.test.tsx: a module-level vi.fn rejection trips the runner's
 * unhandled-rejection tracker across tests, fetch-level stubbing doesn't.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { EventBindingsPage } from '../EventBindingsPage.js';
import { Toaster } from '../../ui/toast.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const BINDING = {
  bindingId: 'hevb:1',
  tenantId: 't1',
  eventType: 'host.crm.contact.created',
  workflowId: 'wf-1',
  enabled: true,
  createdBy: 'user-1',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};
const WORKFLOW = { workflowId: 'wf-1', name: 'Route new lead', nodeCount: 4, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' };

function mockFetch(opts: { bindings?: unknown[]; workflows?: unknown[] } = {}): ReturnType<typeof vi.fn> {
  const bindings = opts.bindings ?? [BINDING];
  const workflows = opts.workflows ?? [WORKFLOW];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
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
    if (path === '/host/openwop-app/workflows' && method === 'GET') {
      return jsonResponse(200, { workflows });
    }
    throw new Error(`unhandled fetch ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
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

  it('create: submits the form and toasts success', async () => {
    mockFetch();
    renderPage();
    await screen.findByText('host.crm.contact.created');

    const eventTypeInput = screen.getByLabelText(/^Event type/);
    fireEvent.change(eventTypeInput, { target: { value: 'host.crm.deal.won' } });
    fireEvent.click(screen.getByRole('button', { name: /Create binding/ }));

    expect(await screen.findByText('Binding created for host.crm.deal.won.')).toBeTruthy();
  });

  it('toggle: flips enabled via PATCH and toasts the new state', async () => {
    mockFetch();
    renderPage();
    await screen.findByText('host.crm.contact.created');

    fireEvent.click(screen.getByRole('button', { name: /Toggle host\.crm\.contact\.created/ }));

    expect(await screen.findByText('host.crm.contact.created disabled.')).toBeTruthy();
  });

  it('delete: confirms, deletes, and toasts success', async () => {
    const origConfirm = window.confirm;
    window.confirm = () => true;
    mockFetch();
    renderPage();
    await screen.findByText('host.crm.contact.created');

    fireEvent.click(screen.getByRole('button', { name: 'Delete binding for host.crm.contact.created' }));

    await waitFor(() => expect(screen.getByText('Binding for host.crm.contact.created deleted.')).toBeTruthy());
    window.confirm = origConfirm;
  });
});
