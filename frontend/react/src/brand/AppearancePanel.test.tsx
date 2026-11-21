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
 *  - The public-page motion preset (ADR 1029 D6) loads into its select, saves, and the
 *    "Calm (default)" option removes the key from the saved theme.
 *
 * Sabotage-witnessed (wave 51, re-probed wave 115): drop the AA early return, its toast
 * or the Contrast-check Notice → the below-AA case red; apply another preset's accent →
 * the preset case red; keep a default pairing's fonts → the default-preset case red;
 * treat 403 as a load failure → the 403 case red; skip the generator-owned split or its
 * notice → the legacy-override case red; ignore the stored motion, save a different one, or keep it
 * when "Calm (default)" is chosen → the motion case red.
 *
 * Issue #5913: the footer text is a field. Red when the stored value is not loaded
 * into it, an edit is not saved, or clearing it sends anything but `''`.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
const selectByLabel = (label: string): HTMLSelectElement => {
  const el = screen.getByLabelText(label);
  if (!(el instanceof HTMLSelectElement)) throw new Error(`${label} is not a <select>`);
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

  it('issue 5913 — the footer text is an editable field: a stored value shows, an edit saves, empty clears it', async () => {
    getAppBrand.mockResolvedValue(brand({ footerText: '© 2026 Old Name' }));
    render(<AppearancePanel />);
    await screen.findByRole('heading', { name: 'Appearance' });
    const footer = inputByLabel('Footer text');
    expect(footer.value).toBe('© 2026 Old Name');
    fireEvent.change(footer, { target: { value: '© 2026 New Name' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(putAppBrand).toHaveBeenCalledTimes(1));
    expect(sentIdentity()?.footerText).toBe('© 2026 New Name');
    fireEvent.change(inputByLabel('Footer text'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(putAppBrand).toHaveBeenCalledTimes(2));
    expect(putAppBrand.mock.calls[1]?.[0].identity?.footerText).toBe('');
  });

  it('saves the public-page motion preset, and "Calm (default)" removes it (ADR 1029 D6)', async () => {
    getAppBrand.mockResolvedValue(brand({ theme: { motion: 'subtle' } }));
    render(<AppearancePanel />);
    await screen.findByRole('heading', { name: 'Appearance' });
    const motion = selectByLabel('Public page motion');
    expect(motion.value).toBe('subtle');
    fireEvent.change(motion, { target: { value: 'lively' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(putAppBrand).toHaveBeenCalledTimes(1));
    expect(sentIdentity()?.theme?.motion).toBe('lively');
    // Choose the option the user sees as "Calm (default)", by its label.
    const calm = within(selectByLabel('Public page motion')).getByRole('option', { name: 'Calm (default)' });
    if (!(calm instanceof HTMLOptionElement)) throw new Error('Calm (default) is not an <option>');
    fireEvent.change(selectByLabel('Public page motion'), { target: { value: calm.value } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(putAppBrand).toHaveBeenCalledTimes(2));
    const second = putAppBrand.mock.calls[1]?.[0].identity;
    expect(second?.theme).toBeDefined(); // the theme was sent, without its motion key
    expect(second?.theme && 'motion' in second.theme).toBe(false);
  });

  it('shows the read-only notice for a non-superadmin (403), with the editor withheld', async () => {
    getAppBrand.mockRejectedValue(new ApiError({ status: 403, statusText: 'forbidden', url: '/app-brand' }));
    render(<AppearancePanel />);
    // Settle on the page heading (both the denied and the load-failed states render
    // it), so a 403 mistaken for a load failure reds on the notice, not by timeout.
    await screen.findByRole('heading', { name: 'Appearance' });
    // Counted, not looked up: a 403 read as a load failure reds on the value (0, and the
    // load-failed title present), not on a lookup miss.
    expect(screen.queryAllByText('super-admin')).toHaveLength(1);
    expect(screen.queryAllByText('Could not load your brand settings')).toHaveLength(0);
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
    // The warning names the failure before Save: exactly one, counted after the heading settled.
    expect(screen.queryAllByText(CONTRAST_CHECK)).toHaveLength(1);
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
    // The dropped token is NAMED visibly, and only it (the kept --cat-ai is not listed).
    expect(screen.queryAllByText(/^Ignored generator-owned tokens: --clay\. /)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(putAppBrand).toHaveBeenCalledTimes(1));
    expect(sentIdentity()?.theme?.override?.light).toEqual({ '--cat-ai': '#654321' }); // generator-owned key never sent
  });
});
