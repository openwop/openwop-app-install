/**
 * Appearance editor (ADR 0170 Phase 6, ADR 0510 §5, ADR 0883 correction).
 * The client is mocked (no backend in jsdom).
 *
 *  - It loads the stored identity into the editor, and a preset writes THAT preset's
 *    accent seed.
 *  - The default preset CLEARS the font override instead of freezing it (ADR 0883).
 *  - A 403 is the read-only super-admin notice, with the editor withheld.
 *  - AA is a persistence invariant (ADR 0510 §5, DSA-014): a below-AA theme is never
 *    saved, the Save stays reachable, and the refusal is SAID — a toast naming WCAG AA
 *    and the "Contrast check" warning, which a passing theme does not show.
 *  - Generator-owned tokens in a legacy override are dropped, named, and never sent.
 *
 * Sabotage-witnessed (wave 51): drop the AA early return → case 5 red; drop its toast
 * or the Contrast-check Notice → case 5 red; apply another preset's accent → case 2 red;
 * keep a default pairing's fonts → case 3 red; treat 403 as a load failure → case 4 red;
 * skip the generator-owned split or its notice → case 6 red.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiError } from '../client/requestJson.js';
import { toast } from '../ui/toast.js';
import type { AppBrand } from './appBrandClient.js';
import type { PublicBrandIdentity } from './applyBrand.js';

type BrandClient = typeof import('./appBrandClient.js');
const getAppBrand = vi.fn<BrandClient['getAppBrand']>();
const putAppBrand = vi.fn<BrandClient['putAppBrand']>();
vi.mock('./appBrandClient.js', async (orig) => ({
  ...(await orig<BrandClient>()),
  getAppBrand: () => getAppBrand(),
  putAppBrand: (patch: Parameters<BrandClient['putAppBrand']>[0]) => putAppBrand(patch),
}));

const { AppearancePanel } = await import('./AppearancePanel.js');

const brand = (identity: PublicBrandIdentity): AppBrand => ({ id: 'brand:host-app', name: 'App identity', description: '', identity });
/** The identity the panel sent on its FIRST save. */
const sentIdentity = (): PublicBrandIdentity | undefined => putAppBrand.mock.calls[0]?.[0].identity;
const inputByLabel = (label: string): HTMLInputElement => {
  const el = screen.getByLabelText(label);
  if (!(el instanceof HTMLInputElement)) throw new Error(`${label} is not an <input>`);
  return el;
};

const BELOW_AA_TOAST = 'a token pair falls below WCAG AA — see the Contrast panel. Generated colors are auto-adjusted; advanced overrides are not.';
const CONTRAST_CHECK = 'Contrast check:';

let toastError: MockInstance<typeof toast.error>;
beforeEach(() => {
  getAppBrand.mockReset();
  putAppBrand.mockReset();
  putAppBrand.mockImplementation(async (patch) => brand(patch.identity ?? {}));
  toastError = vi.spyOn(toast, 'error');
});
afterEach(() => { toastError.mockRestore(); });

describe('AppearancePanel', () => {
  it('loads the app identity and renders the editor', async () => {
    getAppBrand.mockResolvedValue(brand({ productName: 'Acme' }));
    render(<AppearancePanel />);
    expect(await screen.findByRole('heading', { name: 'Appearance' })).toBeTruthy();
    expect(inputByLabel('Product name').value).toBe('Acme');
  });

  it('applies a preset to the accent field', async () => {
    getAppBrand.mockResolvedValue(brand({}));
    render(<AppearancePanel />);
    await screen.findByRole('heading', { name: 'Appearance' });
    fireEvent.click(screen.getByRole('button', { name: /Cool slate/ }));
    // Cool slate's own seed (brand/defaults.ts BRAND_PRESETS), pinned literally.
    await waitFor(() => expect(inputByLabel('Brand color').value).toBe('oklch(58% 0.11 245)'));
  });

  it('the default preset clears the font override instead of freezing it (ADR 0883 correction)', async () => {
    // A stored pairing (Modern grotesk) is replaced by "no override" when the
    // default preset is chosen, so the app keeps following its shipped face. The
    // old behaviour wrote the default pairing's fonts into the brand, which kept
    // Instrument Serif live on app.openwop.dev after the default changed.
    getAppBrand.mockResolvedValue(brand({
      typography: { serif: '"Fraunces", Georgia, serif', sans: '"Inter", ui-sans-serif, system-ui, sans-serif', mono: '"Geist Mono", ui-monospace, monospace', fontsHref: 'https://fonts.googleapis.com/css2?family=Fraunces' },
    }));
    render(<AppearancePanel />);
    await screen.findByRole('heading', { name: 'Appearance' });
    fireEvent.click(screen.getByRole('button', { name: /Clay \(default\)/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(putAppBrand).toHaveBeenCalled());
    expect(sentIdentity()).toBeDefined();
    expect(sentIdentity()?.typography).toBeUndefined();
  });

  it('shows the read-only notice for a non-superadmin (403), with the editor withheld', async () => {
    getAppBrand.mockRejectedValue(new ApiError({ status: 403, statusText: 'forbidden', url: '/app-brand' }));
    render(<AppearancePanel />);
    expect(await screen.findByText(/super-admin/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull();
  });
});

describe('AppearancePanel — AA save gate (ADR 0510 §5, DSA-014)', () => {
  it('refuses to persist a below-AA override, with the refusal reachable and announced', async () => {
    // --cat-* tokens survive the generator-owned filter but are NOT contrast
    // pairs, so force a failing pair via a hostile generated seed instead:
    // a near-invisible accent makes the primary-button pair fail.
    getAppBrand.mockResolvedValue(brand({ theme: { accentSeed: 'oklch(99% 0.01 90)' } }));
    render(<AppearancePanel />);
    await screen.findByRole('heading', { name: 'Appearance' });
    expect(screen.getByText(CONTRAST_CHECK)).toBeTruthy(); // the warning names the failure before Save
    const save = screen.getByRole('button', { name: /Save/ });
    if (!(save instanceof HTMLButtonElement)) throw new Error('Save is not a <button>');
    expect(save.disabled).toBe(false); // reachable, never a dead button
    fireEvent.click(save);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(BELOW_AA_TOAST)); // the refusal is announced
    expect(putAppBrand).not.toHaveBeenCalled();
  });

  it('a passing theme shows no Contrast-check warning (control for the case above)', async () => {
    getAppBrand.mockResolvedValue(brand({ theme: { accentSeed: 'oklch(58% 0.13 40)' } }));
    render(<AppearancePanel />);
    await screen.findByRole('heading', { name: 'Appearance' });
    expect(screen.queryByText(CONTRAST_CHECK)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(putAppBrand).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalled();
  });

  it('strips generator-owned tokens from a loaded legacy override and says so', async () => {
    getAppBrand.mockResolvedValue(brand({
      theme: { accentSeed: 'oklch(58% 0.13 40)', override: { light: { '--clay': '#123456', '--cat-ai': '#654321' } } },
    }));
    render(<AppearancePanel />);
    await screen.findByRole('heading', { name: 'Appearance' });
    expect(screen.getByText(/--clay/)).toBeTruthy(); // the dropped token is NAMED visibly
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(putAppBrand).toHaveBeenCalledTimes(1));
    expect(sentIdentity()?.theme?.override?.light).toEqual({ '--cat-ai': '#654321' }); // generator-owned key never sent
  });
});
