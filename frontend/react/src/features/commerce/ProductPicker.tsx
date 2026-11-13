/**
 * ProductPicker (ADR 1110 P2) — choose one product of the org's catalog by typing its
 * name. Built on the shared `ui/Combobox`: the catalog can hold up to 500,000 products,
 * so the options are a server search (`listProductsPage`, 20 at a time), never a
 * `<select>` of the whole catalog.
 */
import { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox, type ComboboxOption } from '../../ui/Combobox.js';
import { useFormat } from '../../i18n/useFormat.js';
import { listProductsPage, type Product } from './commerceClient.js';

export interface ProductPickerProps {
  orgId: string;
  label: React.ReactNode;
  value: Product | null;
  onChange: (product: Product | null) => void;
  required?: boolean | undefined;
  help?: React.ReactNode | undefined;
  autoFocus?: boolean | undefined;
}

export function ProductPicker({ orgId, label, value, onChange, required, help, autoFocus }: ProductPickerProps): JSX.Element {
  const { t } = useTranslation('commerce');
  const fmt = useFormat();
  // Every product an answer has offered, so a choice hands back its row. Merged, never
  // replaced: an answer the Combobox discards as stale must not drop the rows of the one
  // it shows.
  const seen = useRef(new Map<string, Product>());
  const load = useCallback(async (query: string, signal: AbortSignal): Promise<{ options: ComboboxOption[]; more: boolean }> => {
    const page = await listProductsPage(orgId, { ...(query ? { q: query } : {}), limit: 20 }, signal);
    for (const p of page.products) seen.current.set(p.productId, p);
    return { options: page.products.map((p) => ({ id: p.productId, label: p.name, hint: fmt.currency(p.price, p.currency) })), more: page.nextCursor !== undefined };
  }, [orgId, fmt]);
  const option = useMemo<ComboboxOption | null>(() => (value ? { id: value.productId, label: value.name } : null), [value]);
  return (
    <Combobox
      label={label}
      value={option}
      required={required}
      help={help}
      placeholder={t('pickProductSearch')}
      load={load}
      autoFocus={autoFocus}
      onChange={(o) => onChange(o ? seen.current.get(o.id) ?? null : null)}
    />
  );
}
