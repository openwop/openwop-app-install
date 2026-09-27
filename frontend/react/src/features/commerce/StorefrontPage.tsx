/**
 * Public storefront (gap plan §5C C2) — the anonymous shopper surface at
 * `/store/:orgId`, rendered in the bare PublicShell like `/p/:slug` (ADR 0027
 * pattern). Reads ONLY the public-store JSON routes (active products, projected
 * fields); checkout posts the guest form and either follows the hosted Stripe
 * Checkout URL (live) or shows the demo confirmation (keyless operator).
 * A client-side cart only — an anonymous visitor has no server cart.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Field } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import { useFormat } from '../../i18n/useFormat.js';
import { config, fetchOpts } from '../../client/config.js';

interface PublicProduct {
  productId: string; type: string; name: string; description?: string;
  price: number; currency: string; imageAssetTokens: string[];
  variants: { variantId: string; name: string; price?: number }[];
  categories: string[]; tags: string[];
  attributes?: { label: string; value: string }[]; // DEF-4 (ADR 0240)
  customFields?: { label: string; value: string }[]; // ADR 0257 — label-resolved by the server
}

const root = `${config.baseUrl}/host/openwop-app`;
const assetSrc = (token: string): string => `${config.baseUrl}/host/openwop-app/assets/${encodeURIComponent(token)}`;

/** grade-code H1: the cart holds a PRICE/CURRENCY/NAME snapshot per line — captured
 *  at add time — so the total and currency are correct regardless of the visible
 *  (category-filtered) product page, and a filtered-out line can still be shown +
 *  removed. Never price the cart off the currently-visible product list. */
interface CartLine { qty: number; price: number; currency: string; name: string }

export function StorefrontPage({ orgId }: { orgId: string }): JSX.Element {
  const { t } = useTranslation('commerce');
  const fmt = useFormat();
  const [products, setProducts] = useState<PublicProduct[] | null>(null);
  const [storeName, setStoreName] = useState('');
  const [loadError, setLoadError] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [category, setCategory] = useState('');
  const [nonce, setNonce] = useState(0); // grade-ux B1: bump to re-run the fetch (Retry)
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [checkingOut, setCheckingOut] = useState(false);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);

  useEffect(() => {
    // grade-code H2: an active flag so the LAST click wins, not the last response.
    let active = true;
    setProducts(null); setLoadError(false);
    const q = category ? `?category=${encodeURIComponent(category)}` : '';
    void fetch(`${root}/public-store/${encodeURIComponent(orgId)}/products${q}`, fetchOpts({}))
      .then(async (r) => {
        if (r.status === 404) { if (active) { setNotFound(true); setProducts([]); } return null; }
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as { products: PublicProduct[]; store?: { name?: string } };
      })
      .then((r) => { if (active && r) { setProducts(r.products); if (r.store?.name) setStoreName(r.store.name); } })
      // grade-code H3: a transient failure is an ERROR, not "store not found" / empty.
      .catch(() => { if (active) { setLoadError(true); setProducts([]); } });
    return () => { active = false; };
  }, [orgId, category, nonce]);

  // Guard per-product array fields: a product row omitting `categories` would
  // throw in this render (outside the fetch catch) → white screen (pricing-'*' class).
  const categories = useMemo(() => [...new Set((products ?? []).flatMap((p) => p.categories ?? []))].sort(), [products]);
  const cartCount = Object.values(cart).reduce((s, l) => s + l.qty, 0);
  const cartTotal = useMemo(() => Object.values(cart).reduce((s, l) => s + l.qty * l.price, 0), [cart]);
  const currency = Object.values(cart)[0]?.currency ?? products?.[0]?.currency ?? 'USD';
  const add = (p: PublicProduct): void => setCart((c) => ({ ...c, [p.productId]: { qty: (c[p.productId]?.qty ?? 0) + 1, price: p.price, currency: p.currency, name: p.name } }));
  const remove = (id: string): void => setCart((c) => { const cur = c[id]; if (!cur) return c; const next = { ...c }; if (cur.qty <= 1) delete next[id]; else next[id] = { ...cur, qty: cur.qty - 1 }; return next; });

  if (notFound && !category) {
    return <div className="u-p-4"><StateCard title={t('storeNotFound')} body={t('storeNotFoundBody')} /></div>;
  }

  return (
    <div className="u-p-4 u-grid u-gap-4 u-mx-auto storefront-shell">
      <header className="u-grid u-gap-1">
        <h1 className="u-m-0">{storeName || t('storeTitle')}</h1>
        <p className="u-m-0 muted">{t('storeLede')}</p>
      </header>

      {/* grade-code LOW: only echo a well-shaped order id back into the banner so the
          public page can't be turned into an arbitrary-text phishing lever. */}
      {params.get('paid') ? <Notice variant="success">{t('paidBanner', { order: /^ord:[\w-]{1,80}$/.test(params.get('order') ?? '') ? params.get('order')! : '' })}</Notice> : null}
      {params.get('canceled') ? <Notice variant="warning">{t('canceledBanner')}</Notice> : null}

      {categories.length > 0 ? (
        <nav className="action-bar u-gap-1 u-flex-wrap" aria-label={t('categoriesLabel')}>
          {/* grade-ux B2: aria-pressed so the active filter is announced, not conveyed by button variant alone (§11). */}
          <Button aria-pressed={category === ''} variant={category === '' ? 'primary' : 'secondary'} onClick={() => setCategory('')}>{t('allCategories')}</Button>
          {categories.map((cat) => (
            <Button key={cat} aria-pressed={category === cat} variant={category === cat ? 'primary' : 'secondary'} onClick={() => setCategory(cat)}>{cat}</Button>
          ))}
        </nav>
      ) : null}

      {products === null ? <Skeleton /> : loadError ? (
        // grade-ux B1: a REAL retry — bump the fetch nonce (the old handler set
        // category to itself, a no-op that never re-ran the effect).
        <StateCard announce title={t('loadErrorTitle')} body={t('loadErrorBody')} action={<Button variant="primary" onClick={() => setNonce((x) => x + 1)}>{t('retry')}</Button>} />
      ) : products.length === 0 ? (
        <StateCard title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <div className="card-grid">
          {products.map((p) => (
            <article key={p.productId} className="surface-card u-p-4 u-grid u-gap-2">
              {p.imageAssetTokens?.[0] ? <img src={assetSrc(p.imageAssetTokens[0])} alt="" className="storefront-product-img" /> : null}
              <div><strong>{p.name}</strong> <span className="chip">{t(`type_${p.type}`, { defaultValue: p.type })}</span></div>
              {p.description ? <p className="u-m-0 u-text-sm muted">{p.description}</p> : null}
              {(p.attributes?.length || p.customFields?.length) ? (
                <dl className="u-grid u-gap-1 u-m-0 u-text-sm">
                  {[...(p.attributes ?? []), ...(p.customFields ?? [])].map((a, i) => (
                    <div key={`d-${a.label}-${i}`} className="action-bar u-justify-between u-gap-2"><dt className="muted">{a.label}</dt><dd className="u-m-0">{a.value}</dd></div>
                  ))}
                </dl>
              ) : null}
              <div className="action-bar u-justify-between u-items-center">
                <strong>{fmt.currency(p.price, p.currency)}</strong>
                <div className="action-bar u-gap-1 u-items-center">
                  {cart[p.productId] ? (
                    <>
                      <Button variant="secondary" aria-label={t('removeOne', { name: p.name })} onClick={() => remove(p.productId)}>−</Button>
                      <span aria-live="polite">{cart[p.productId]?.qty}</span>
                    </>
                  ) : null}
                  <Button variant="primary" aria-label={t('addOne', { name: p.name })} onClick={() => add(p)}>{cart[p.productId] ? '+' : t('addToCart')}</Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {cartCount > 0 ? (
        checkingOut
          ? <CheckoutForm orgId={orgId} cart={cart} total={cartTotal} currency={currency} onPlaced={() => setCart({})} onBack={() => setCheckingOut(false)} />
          : (
            <div className="surface-card u-p-4 action-bar u-justify-between u-items-center">
              <strong>{t('cartSummary', { count: cartCount, total: fmt.currency(cartTotal, currency) })}</strong>
              <Button variant="primary" onClick={() => setCheckingOut(true)}>{t('checkout')}</Button>
            </div>
          )
      ) : null}
    </div>
  );
}

function CheckoutForm({ orgId, cart, total, currency, onBack, onPlaced }: { orgId: string; cart: Record<string, CartLine>; total: number; currency: string; onBack: () => void; onPlaced: () => void }): JSX.Element {
  const { t } = useTranslation('commerce');
  const fmt = useFormat();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [coupon, setCoupon] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [demoOrder, setDemoOrder] = useState<string | null>(null);
  const [demoCharge, setDemoCharge] = useState<{ charge: number; currency: string } | null>(null);
  // GEN-2d — one idempotency key per checkout-form mount: a double-tap or a network
  // retry replays the SAME key so the backend returns the one order instead of minting
  // a second (and a second stock reservation). A failed attempt releases the claim
  // server-side, so a corrected resubmit from this same mount still succeeds.
  // `crypto.randomUUID` exists only in secure contexts (https/localhost); a public
  // storefront on a plain-http posture would otherwise THROW here and break checkout
  // (the codebase's guarded pattern — useRealtimeVoice/useCollabPresence).
  const [idempotencyKey] = useState(() =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `ck-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  // ADR 0451 P2b — an affiliate `?ref=` on the storefront URL (captured once per mount).
  const [refCode] = useState(() =>
    (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('ref') : null) || null);

  const submit = useCallback(async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError(t('emailInvalid')); return; }
    setBusy(true); setError('');
    try {
      const res = await fetch(`${root}/public-store/${encodeURIComponent(orgId)}/checkout`, fetchOpts({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify({
          email: email.trim(), ...(name.trim() ? { name: name.trim() } : {}),
          ...(coupon.trim() ? { couponCode: coupon.trim() } : {}),
          // ADR 0451 P2b — carry an affiliate `?ref=` from the landing URL into
          // checkout so a referred purchase accrues commission (the backend
          // validates it against a real affiliate; junk is dropped). Mount-
          // agnostic read (the storefront is a custom /store mount, not a Route).
          ...(refCode ? { ref: refCode } : {}),
          lines: Object.entries(cart).map(([productId, l]) => ({ productId, quantity: l.qty })),
        }),
      }));
      const body = await res.json().catch(() => ({} as Record<string, unknown>)) as { mode?: string; checkoutUrl?: string; orderId?: string; message?: string; charge?: number; currency?: string };
      if (!res.ok) { setError(body.message || t('checkoutFailed')); return; }
      if (body.mode === 'live' && body.checkoutUrl) { onPlaced(); window.location.href = body.checkoutUrl; return; }
      // grade-code LOW: clear the cart on a demo placement so it can't be re-submitted.
      onPlaced();
      // R2 CM-P2-M6 — state what was CHARGED (goods + tax + shipping), not the goods-only
      // cart total the shopper saw a second ago. The response has carried it all along.
      if (typeof body.charge === 'number') setDemoCharge({ charge: body.charge, currency: body.currency ?? currency });
      setDemoOrder(body.orderId ?? '');
    } catch { setError(t('checkoutFailed')); } finally { setBusy(false); }
  }, [orgId, cart, email, name, coupon, currency, t, onPlaced, idempotencyKey, refCode]);

  if (demoOrder !== null) {
    return (
      <div className="surface-card u-p-4 u-grid u-gap-2">
        <Notice variant="success" announce={t('demoPlacedTitle')}>{t('demoPlacedTitle')}</Notice>
        {demoOrder ? <p className="u-m-0 u-text-sm muted">{t('demoPlacedBody', { order: demoOrder })}</p> : null}
        {/* Review B-2 — this said "Charged: $103" directly under "no card was charged".
            The NUMBER is the point of M6 (the shopper finally sees tax + shipping); the
            verb was a false money claim on a shopper-facing screen, in four locales. */}
        {demoCharge ? <p className="u-m-0 u-text-sm"><strong>{t('orderTotalLabel', { total: fmt.currency(demoCharge.charge, demoCharge.currency) })}</strong></p> : null}
      </div>
    );
  }

  return (
    <div className="surface-card u-p-4 u-grid u-gap-3">
      <div className="action-bar u-justify-between u-items-center">
        {/* R2 CM-P2-M6 — this said "Checkout — $90.00" while the Stripe page then charged
            $103: the heading was the GOODS-only client cart, and tax/shipping are quoted
            server-side at order create. Name what the number IS, and say what is still to
            come, rather than presenting a subtotal as the amount due. */}
        <strong>{t('checkoutSubtotal', { total: fmt.currency(total, currency) })}</strong>
        <Button variant="secondary" onClick={onBack}>{t('back')}</Button>
      </div>
      <p className="u-m-0 u-text-sm muted">{t('taxShippingNote')}</p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      <Field label={t('fieldEmail')} required>{(w) => <input {...w} type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} autoFocus />}</Field>
      <Field label={t('fieldName')}>{(w) => <input {...w} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />}</Field>
      <Field label={t('fieldCoupon')}>{(w) => <input {...w} value={coupon} onChange={(e) => setCoupon(e.target.value)} maxLength={120} />}</Field>
      <div><Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? t('placing') : t('placeOrder')}</Button></div>
      <p className="u-m-0 u-text-sm muted">{t('paymentNote')}</p>
    </div>
  );
}
