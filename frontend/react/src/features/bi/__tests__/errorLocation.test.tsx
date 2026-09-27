/**
 * UX_UPGRADE-bi BI-G1 + BI-G2.
 *
 * BI-G1 is two bugs stacked. The wire envelope is `{ error: <code>, message,
 * details }` (`ErrorEnvelope`), but this client read `error.message` — and
 * `error` is a STRING, so `.message` was ALWAYS undefined and every server
 * sentence fell through to "createBiMetric returned 422". The page's docstring
 * claims it "surfaces the typed 422s rather than duplicating the registry rules";
 * it surfaced none of them. On top of that, the validator LOCATES each rejection
 * via `details.field`, which was discarded too.
 *
 * BI-G2: a failed entity-type read left the picker holding only the kernel types
 * and the field datalist empty — the form silently offered less than it should.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { biErrorFrom } from '../biClient.js';

const envelope = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('BI-G1 — the client parses the real ErrorEnvelope', () => {
  it('keeps the server message instead of a status line', async () => {
    const err = await biErrorFrom(
      envelope(422, { error: 'validation_error', message: 'Field `amount` is `string` — a sum aggregate needs a number field.', details: { field: 'field' } }),
      'createBiMetric',
    );
    expect(err.message).toBe('Field `amount` is `string` — a sum aggregate needs a number field.');
    expect(err.message).not.toContain('returned 422');
  });

  it('keeps the field the validator blamed', async () => {
    const err = await biErrorFrom(envelope(422, { error: 'validation_error', message: 'Unknown entity type.', details: { field: 'entityType' } }), 'createBiMetric');
    expect(err.field).toBe('entityType');
  });

  it('still falls back when the body carries no message', async () => {
    const err = await biErrorFrom(new Response('gateway', { status: 502 }), 'createBiMetric');
    expect(err.message).toBe('createBiMetric returned 502');
    expect(err.field).toBeUndefined();
  });

  it('does not invent a field when the server located nothing', async () => {
    const err = await biErrorFrom(envelope(409, { error: 'conflict', message: 'A metric with that id exists.' }), 'createBiMetric');
    expect(err.message).toBe('A metric with that id exists.');
    expect(err.field).toBeUndefined();
  });
});

/* ── the page ── */

const { listBiMetrics, createBiMetric, listEntityTypes, listOrgs } = vi.hoisted(() => ({
  listBiMetrics: vi.fn(), createBiMetric: vi.fn(), listEntityTypes: vi.fn(), listOrgs: vi.fn(),
}));
vi.mock('../biClient.js', async (orig) => ({
  ...(await orig<typeof import('../biClient.js')>()),
  listBiMetrics, createBiMetric,
}));
vi.mock('../../entities/entitiesClient.js', async (orig) => ({
  ...(await orig<typeof import('../../entities/entitiesClient.js')>()),
  listEntityTypes,
}));
vi.mock('../../../client/accessClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/accessClient.js')>()),
  listOrgs,
}));

import { MetricsPage } from '../MetricsPage.js';

const mount = async (): Promise<void> => {
  render(<MetricsPage />);
  await act(async () => {});
};

const located = (message: string, field: string): Error => {
  const e = new Error(message) as Error & { field?: string };
  e.field = field;
  return e;
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  listBiMetrics.mockResolvedValue([]);
  listEntityTypes.mockResolvedValue([{ name: 'deal', fields: [{ key: 'amount' }] }]);
});

describe('BI-G1 — a located error lands ON the control', () => {
  const openForm = async (): Promise<void> => {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /New metric/i })); });
    fireEvent.change(screen.getByLabelText(/Title/i), { target: { value: 'Win rate' } });
    fireEvent.change(screen.getByLabelText(/Entity/i), { target: { value: 'deal' } });
  };

  it('associates the message with the blamed field, not a floating notice', async () => {
    createBiMetric.mockRejectedValue(located('Unknown entity type `deal` for this workspace.', 'entityType'));
    await mount();
    await openForm();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save/i })); });

    const select = screen.getByLabelText(/Entity/i);
    expect(select.getAttribute('aria-invalid')).toBe('true');
    const describedBy = select.getAttribute('aria-describedby') ?? '';
    expect(describedBy).not.toBe('');
    expect(document.getElementById(describedBy.split(' ').pop()!)?.textContent)
      .toContain('Unknown entity type');
    // Not shown twice — the detached notice is for UNlocated errors only.
    expect(document.body.textContent!.match(/Unknown entity type/g)).toHaveLength(1);
  });

  it('an UNlocated error still shows, in the notice', async () => {
    createBiMetric.mockRejectedValue(new Error('A metric with that id exists.'));
    await mount();
    await openForm();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save/i })); });
    expect(document.body.textContent).toContain('A metric with that id exists.');
    expect(screen.getByLabelText(/Entity/i).getAttribute('aria-invalid')).not.toBe('true');
  });
});

describe('BI-G2 — a failed entity-type read is visible', () => {
  it('says the picker is incomplete instead of silently shrinking it', async () => {
    listEntityTypes.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('only the built-in ones');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('says nothing when the types load', async () => {
    await mount();
    expect(document.body.textContent).not.toContain('only the built-in ones');
  });
});
