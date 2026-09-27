/**
 * ADR 0257 (FE follow-on) — the product-EDIT form for typed customFields. These are the
 * first commerce SPA tests. They pin the two behaviors most likely to silently regress
 * (flagged in the pre-implementation architecture review):
 *   1. edit mode SEEDS customFields values from the product, and
 *   2. it sends `customFields` UNCONDITIONALLY on save — so clearing a value persists
 *      (the backend PATCH replaces the map only when the key is present; omitting it on
 *      clear would leave the old value stale — the "replace-on-clear" trap).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { Product } from '../commerceClient.js';

const { listProductFields, updateProduct, createProduct } = vi.hoisted(() => ({
  listProductFields: vi.fn(), updateProduct: vi.fn(), createProduct: vi.fn(),
}));
vi.mock('../commerceClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commerceClient.js')>()),
  listProductFields, updateProduct, createProduct,
}));
// Echo i18n keys (the precedent) — assertions here key off DATA (the field label/value), not copy.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../../ui/toast.js', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

import { ProductForm } from '../CommercePage.js';

const baseProduct = (customFields: Record<string, string | number | boolean>): Product => ({
  productId: 'p1', type: 'physical', name: 'Widget', price: 10, currency: 'USD',
  variants: [], active: true, updatedAt: '', customFields,
});

beforeEach(() => {
  cleanup();
  listProductFields.mockReset(); updateProduct.mockReset(); createProduct.mockReset();
  listProductFields.mockResolvedValue([{ defId: 'd1', key: 'sku', label: 'SKU', type: 'string', required: false }]);
  updateProduct.mockResolvedValue({});
  createProduct.mockResolvedValue({});
});

describe('ProductForm — edit mode customFields (ADR 0257)', () => {
  it('seeds the typed value from the product and sends it (present) on save', async () => {
    render(<ProductForm orgId="o1" product={baseProduct({ sku: 'A1' })} onDone={() => {}} />);
    const sku = await screen.findByLabelText('SKU');
    expect((sku as HTMLInputElement).value).toBe('A1');

    fireEvent.change(sku, { target: { value: 'B2' } });
    fireEvent.click(screen.getByText('save'));

    await waitFor(() => expect(updateProduct).toHaveBeenCalled());
    expect(updateProduct.mock.calls[0][1]).toBe('p1');
    expect((updateProduct.mock.calls[0][2] as { customFields: unknown }).customFields).toEqual({ sku: 'B2' });
    expect(createProduct).not.toHaveBeenCalled();
  });

  it('clearing a value sends customFields:{} (the replace-on-clear guard, not an omit)', async () => {
    render(<ProductForm orgId="o1" product={baseProduct({ sku: 'A1' })} onDone={() => {}} />);
    const sku = await screen.findByLabelText('SKU');
    fireEvent.change(sku, { target: { value: '' } });
    fireEvent.click(screen.getByText('save'));

    await waitFor(() => expect(updateProduct).toHaveBeenCalled());
    expect((updateProduct.mock.calls[0][2] as { customFields: unknown }).customFields).toEqual({});
  });

  it('locks the immutable type selector in edit mode (the PATCH route ignores type)', async () => {
    render(<ProductForm orgId="o1" product={baseProduct({})} onDone={() => {}} />);
    await screen.findByLabelText('SKU');
    expect((screen.getByLabelText('fieldType') as HTMLSelectElement).disabled).toBe(true);
  });

  it('renders an in-form Cancel that closes without saving', async () => {
    const onCancel = vi.fn();
    render(<ProductForm orgId="o1" product={baseProduct({ sku: 'A1' })} onDone={() => {}} onCancel={onCancel} />);
    await screen.findByLabelText('SKU');
    fireEvent.click(screen.getByText('cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(updateProduct).not.toHaveBeenCalled();
    expect(createProduct).not.toHaveBeenCalled();
  });

  it('does NOT send fields the form does not render, so they are preserved by the PATCH', async () => {
    // The whole design rests on this: the PATCH replaces a field only when its key is present,
    // so a product's populated description/variants/categories/dims/type/currency survive an
    // unrelated edit precisely because the edit body omits them.
    const product: Product = { ...baseProduct({ sku: 'A1' }), description: 'Old desc', variants: [{ variantId: 'v1', name: 'X' }], categories: ['c1'] };
    render(<ProductForm orgId="o1" product={product} onDone={() => {}} />);
    await screen.findByLabelText('SKU');
    fireEvent.click(screen.getByText('save'));

    await waitFor(() => expect(updateProduct).toHaveBeenCalled());
    const body = updateProduct.mock.calls[0][2] as Record<string, unknown>;
    for (const k of ['description', 'variants', 'categories', 'dims', 'imageAssetTokens', 'type', 'currency']) {
      expect(k in body).toBe(false);
    }
  });

  it('create path is unchanged — omits customFields when none are set', async () => {
    render(<ProductForm orgId="o1" onDone={() => {}} />); // no product ⇒ create mode
    await waitFor(() => expect(listProductFields).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/fieldName/), { target: { value: 'New widget' } }); // label has a required '*'
    fireEvent.click(screen.getByText('create'));

    await waitFor(() => expect(createProduct).toHaveBeenCalled());
    expect('customFields' in (createProduct.mock.calls[0][1] as Record<string, unknown>)).toBe(false);
    expect(updateProduct).not.toHaveBeenCalled();
  });
});
