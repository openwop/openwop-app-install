/**
 * Appearance editor (ADR 0170 Phase 6) — render + interaction smoke. The client is
 * mocked (no backend in jsdom): we assert the editor loads an identity, a preset
 * applies an accent, and a 403 surfaces the read-only super-admin notice.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiError } from '../client/requestJson.js';

const getAppBrand = vi.fn();
const putAppBrand = vi.fn();
vi.mock('./appBrandClient.js', () => ({
  getAppBrand: (...a: unknown[]) => getAppBrand(...a),
  putAppBrand: (...a: unknown[]) => putAppBrand(...a),
}));

const { AppearancePanel } = await import('./AppearancePanel.js');

beforeEach(() => {
  getAppBrand.mockReset();
  putAppBrand.mockReset();
});

describe('AppearancePanel', () => {
  it('loads the app identity and renders the editor', async () => {
    getAppBrand.mockResolvedValue({ id: 'brand:host-app', name: 'App identity', identity: { productName: 'Acme' } });
    render(<AppearancePanel />);
    expect(await screen.findByRole('heading', { name: 'Appearance' })).toBeTruthy();
    expect((screen.getByLabelText('Product name') as HTMLInputElement).value).toBe('Acme');
  });

  it('applies a preset to the accent field', async () => {
    getAppBrand.mockResolvedValue({ id: 'brand:host-app', name: 'App identity', identity: {} });
    render(<AppearancePanel />);
    await screen.findByRole('heading', { name: 'Appearance' });
    fireEvent.click(screen.getByRole('button', { name: /Cool slate/ }));
    const accent = screen.getByLabelText('Brand color') as HTMLInputElement;
    await waitFor(() => expect(accent.value).toContain('oklch')); // preset set an oklch accent seed
  });

  it('shows the read-only notice for a non-superadmin (403)', async () => {
    getAppBrand.mockRejectedValue(new ApiError({ status: 403, statusText: 'forbidden', url: '/app-brand' }));
    render(<AppearancePanel />);
    expect(await screen.findByText(/super-admin/i)).toBeTruthy();
  });
});
