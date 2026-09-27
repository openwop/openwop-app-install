/**
 * `HG-3` — the compat-endpoints card is the eighteenth `ui/useOrgSelection`
 * adopter and, until this file, the ONLY one with no guard at all: nothing in
 * `byok/__tests__/` mounted it, so sabotaging the seam left it green.
 *
 * It is also the purest instance of the dependency edge the seam exists to close.
 * The endpoints effect is gated `if (!orgId) return`, and the only
 * `available === null` branch is an `aria-busy="true"` region labelled "Loading
 * endpoints…". So ANY org read that leaves `orgId` empty — a failure, or a
 * genuine `[]` — used to leave a screen-reader user being told, forever, that a
 * BYOK endpoint list was still arriving. The request it was waiting for had never
 * been made.
 *
 * Both polarities, because an "absent" assertion alone is vacuous — a card that
 * renders nothing at all would satisfy it:
 *   - read FAILS      → the honest, retryable disclosure (`HG-3`'s existing fix);
 *                       never a false "no endpoints", never the busy region
 *   - read is `[]`     → the zero-workspace state (`HG-1`); never the busy region
 *   - read is healthy → the real card still renders, so neither branch above can
 *                       pass by swallowing the surface
 *
 * The card is driven through the REAL client functions it imports, never a
 * replica of its logic and never the hook directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react';

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(),
  listCompatEndpoints: vi.fn(),
  // The WRITE half (ORG-HON-2). `createCompatEndpoint` carries the organization
  // IN THE BODY (`{ orgId, label, baseUrl, … }`), so an empty one is not a 404 —
  // it is a POST that asks the backend to file a BYOK endpoint, key and all,
  // under no organization.
  createCompatEndpoint: vi.fn(),
  deleteCompatEndpoint: vi.fn(),
}));
vi.mock('../../client/promptLibraryClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listOrgs: api.listOrgs };
});
vi.mock('../lib/compatClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    listCompatEndpoints: api.listCompatEndpoints,
    createCompatEndpoint: api.createCompatEndpoint,
    deleteCompatEndpoint: api.deleteCompatEndpoint,
  };
});

import { CompatEndpointsCard } from '../CompatEndpointsCard.js';

const FAILED = /Could not load your organizations/;
const NO_ORGS = 'No organization yet — create one to add a self-hosted endpoint.';
const LOADING = 'Loading endpoints…';

/** The endless-spinner fingerprint: the busy region this card can never leave. */
const busyRegion = (c: HTMLElement): Element | null => c.querySelector('[aria-busy="true"]');

beforeEach(() => {
  vi.clearAllMocks();
  api.listCompatEndpoints.mockResolvedValue([]);
});
afterEach(cleanup);

/**
 * Try as hard as a user could to add an endpoint, and do nothing if there is
 * nothing to try. An ATTEMPT rather than an absence check, so the `not.toHaveBeen
 * Called` that follows is falsifiable: move this create form above the org-state
 * branches (the shape `bi/MetricsPage` has) and this helper really does fire
 * `createCompatEndpoint({ orgId: '', … })`.
 */
const attemptCreate = async (): Promise<void> => {
  const label = screen.queryByLabelText('Label');
  const baseUrl = screen.queryByLabelText('Base URL');
  if (label) fireEvent.change(label, { target: { value: 'Local Ollama' } });
  if (baseUrl) fireEvent.change(baseUrl, { target: { value: 'https://vllm.internal/v1' } });
  const add = screen.queryByRole('button', { name: 'Add endpoint' });
  if (add) await act(async () => { fireEvent.click(add); });
};

describe('compat endpoints — the org read is failed-vs-empty, and neither is "loading"', () => {
  it('read FAILS: the honest disclosure with a retry — never a false "no endpoints", never the busy region', async () => {
    api.listOrgs.mockRejectedValue(new Error('boom'));
    const { container } = render(<CompatEndpointsCard />);

    await waitFor(() => expect(screen.getByText(FAILED)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // The endpoints read never started, so nothing may be claimed about endpoints.
    expect(api.listCompatEndpoints).not.toHaveBeenCalled();
    expect(screen.queryByText(NO_ORGS)).toBeNull();
    expect(screen.queryByText('Add endpoint')).toBeNull();
    // Loading may only say it is loading, and this one would never stop.
    expect(busyRegion(container)).toBeNull();
    expect(screen.queryByLabelText(LOADING)).toBeNull();
    // ORG-HON-2 — and no WRITE either. `orgId` is '' in this state too.
    await attemptCreate();
    expect(api.createCompatEndpoint).not.toHaveBeenCalled();
  });

  it('read SUCCEEDS with []: the zero-ORGANIZATION state — not a failure, not an endless "Loading endpoints…"', async () => {
    api.listOrgs.mockResolvedValue([]);
    const { container } = render(<CompatEndpointsCard />);

    await waitFor(() => expect(screen.getByText(NO_ORGS)).toBeTruthy());
    // The server answered "none": that is not a failure …
    expect(screen.queryByText(FAILED)).toBeNull();
    // … and it is not a request still in flight. This is the assertion the whole
    // file exists for: before `HG-1` the card sat here permanently.
    expect(busyRegion(container)).toBeNull();
    expect(screen.queryByLabelText(LOADING)).toBeNull();
    expect(api.listCompatEndpoints).not.toHaveBeenCalled();
    // No organization ⇒ no write target ⇒ no create form.
    expect(screen.queryByText('Add endpoint')).toBeNull();
    // ORG-HON-2 — the WRITE half. The absence of the button is today's mechanism;
    // the property is that no endpoint is ever filed under an empty organization
    // id, and that survives a refactor which keeps the control and renames it.
    await attemptCreate();
    expect(api.createCompatEndpoint).not.toHaveBeenCalled();
    // `deleteCompatEndpoint` is keyed by endpoint id, not org — but the list it
    // acts on was never read, so there is nothing to delete either.
    expect(api.deleteCompatEndpoint).not.toHaveBeenCalled();
  });

  it('the empty state does NOT announce — only the failed read does (DESIGN.md §4.6 rule 8)', async () => {
    // The first cut rendered this as `<Notice variant="info">`, which emits
    // `role="status" aria-live="polite"`. That makes an ordinary first visit
    // speak, and a live region that fires on every ordinary first visit is one
    // people switch off — taking the FAILURE announcements with it. The empty
    // state is silent; the `orgsFailed` Notice above keeps its region.
    api.listOrgs.mockResolvedValue([]);
    const { container } = render(<CompatEndpointsCard />);

    await waitFor(() => expect(screen.getByText(NO_ORGS)).toBeTruthy());
    expect(container.querySelector('[aria-live]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('healthy read: the real card still renders, so the two branches above are not swallowing it', async () => {
    api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
    const { container } = render(<CompatEndpointsCard />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Add endpoint' })).toBeTruthy());
    expect(api.listCompatEndpoints).toHaveBeenCalledWith('o1');
    expect(screen.queryByText(NO_ORGS)).toBeNull();
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(busyRegion(container)).toBeNull();

    // Positive control for the two write assertions above: the same gestures DO
    // write when there is an organization to write to. Without it, a card whose
    // create form is broken for everyone would satisfy them.
    api.createCompatEndpoint.mockResolvedValue({
      id: 'e1', label: 'Local Ollama', baseUrl: 'https://vllm.internal/v1',
      hasKey: false, capabilities: { vision: false, tools: false, longContext: false },
    });
    await attemptCreate();
    expect(api.createCompatEndpoint).toHaveBeenCalledTimes(1);
    expect((api.createCompatEndpoint.mock.calls[0]?.[0] as { orgId: string }).orgId).toBe('o1');
  });
});
