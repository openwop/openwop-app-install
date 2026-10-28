/**
 * ADR 0948 P2c — the money steps of the public funnel viewer.
 *
 * - **checkout**: the step's OFFER, not a cart. The visitor picks one of the offered
 *   products and any offered add-ons; the server prices everything from the catalog
 *   and refuses anything the offer does not list. The live lane leaves for Stripe and
 *   returns to this step; the demo lane says no payment was taken.
 * - **upsell / downsell**: shown only with the purchase's offer capability (the
 *   order and `ft` the checkout returned in the URL fragment). Accept charges the card
 *   saved at checkout, No thanks records the decline; either way the SERVER decides
 *   where the funnel goes next from the recorded decision, never this page.
 *
 * Prices shown are the products' public list prices; tax and shipping are added at
 * payment (the storefront's own wording).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { config, fetchOpts } from '../../../client/config.js';
import { Notice } from '../../../ui/Notice.js';
import { Field } from '../../../ui/Field.js';
import { Skeleton } from '../../../ui/Skeleton.js';
import { Button } from '../../../ui/Button.js';
import { useFormat } from '../../../i18n/useFormat.js';

export interface StepOffer { productIds: string[]; bumpProductIds?: string[]; oneClickProductId?: string }
export interface Purchase { orderId: string; ft: string }
interface OfferProduct { productId: string; name: string; description?: string; price: number; currency: string }

const store = (orgId: string, sfx: string): string => `${config.baseUrl}/host/openwop-app/public-store/${encodeURIComponent(orgId)}${sfx}`;

async function readProducts(orgId: string, ids: string[]): Promise<OfferProduct[] | null> {
  try {
    const out = await Promise.all(ids.map(async (id) => {
      const r = await fetch(store(orgId, `/products/${encodeURIComponent(id)}`), fetchOpts({}));
      if (r.status === 404) return null; // inactive or gone: simply not offered
      if (!r.ok) throw new Error(String(r.status));
      return ((await r.json()) as { product: OfferProduct }).product;
    }));
    return out.filter((p): p is OfferProduct => p !== null);
  } catch {
    return null;
  }
}

async function post(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(url, fetchOpts({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

/** The checkout step's offer: one product, optional add-ons, then payment. */
export function FunnelCheckoutPanel({ orgId, funnelId, stepId, offer, onDemoDone }: {
  orgId: string; funnelId: string; stepId: string; offer: StepOffer;
  /** Move on without paying here: the demo lane took no payment, or the offer has
   *  nothing left to sell. */
  onDemoDone: () => void;
}): JSX.Element {
  const { t } = useTranslation('funnels');
  const fmt = useFormat();
  const [products, setProducts] = useState<OfferProduct[] | null | 'error'>(null);
  const [bumps, setBumps] = useState<OfferProduct[]>([]);
  const [choice, setChoice] = useState('');
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [demo, setDemo] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setProducts(null);
    void Promise.all([readProducts(orgId, offer.productIds), readProducts(orgId, offer.bumpProductIds ?? [])]).then(([main, add]) => {
      if (!active) return;
      if (main === null) { setProducts('error'); return; }
      setProducts(main);
      setBumps(add ?? []);
      setChoice((c) => c || main[0]?.productId || '');
    });
    return () => { active = false; };
  }, [orgId, offer.productIds, offer.bumpProductIds, attempt]);

  const pay = async (): Promise<void> => {
    if (!choice) return;
    setBusy(true); setError('');
    try {
      const r = await post(store(orgId, '/checkout'), {
        email, ...(name.trim() ? { name } : {}), savePaymentMethod: save,
        lines: [{ productId: choice, quantity: 1 }],
        bumps: Object.keys(picked).filter((id) => picked[id]).map((productId) => ({ productId })),
        funnel: { funnelId, stepId },
      });
      if (r.status === 201 && typeof r.body.checkoutUrl === 'string') { window.location.assign(r.body.checkoutUrl); return; }
      if (r.status === 201) { setDemo(true); return; }
      setError(typeof r.body.message === 'string' ? r.body.message : t('offerPayFailed'));
    } catch {
      setError(t('offerPayFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (products === null) return <div className="fp-shell u-p-4" role="status" aria-label={t('common:loading')}><Skeleton /></div>;
  if (products === 'error') {
    return (
      <div className="fp-shell u-p-4 u-grid u-gap-2 u-justify-start">
        <Notice variant="error" announce={t('offerLoadFailed')}>{t('offerLoadFailed')}</Notice>
        <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>{t('common:retry')}</Button>
      </div>
    );
  }
  if (products.length === 0) {
    // Never a dead end: an offer whose products are all gone still lets the visitor on.
    return (
      <div className="fp-shell u-p-4 u-grid u-gap-2 u-justify-start">
        <Notice variant="info">{t('offerNothingAvailable')}</Notice>
        <Button variant="primary" onClick={onDemoDone}>{t('viewerContinue')}</Button>
      </div>
    );
  }
  if (demo) {
    return (
      <div className="fp-shell u-p-4 u-grid u-gap-2 u-justify-start">
        <Notice variant="info">{t('offerDemoPlaced')}</Notice>
        <Button variant="primary" onClick={onDemoDone}>{t('viewerContinue')}</Button>
      </div>
    );
  }
  return (
    <section className="fp-shell u-p-4 u-grid u-gap-3" aria-label={t('offerCheckoutLabel')}>
      <fieldset className="u-grid u-gap-2 u-m-0 u-p-0 u-border-0">
        <legend className="u-fw-600">{t('offerChooseProduct')}</legend>
        {products.map((p) => (
          <label key={p.productId} className="action-bar u-gap-2 u-items-center">
            <input type="radio" name="funnel-offer-product" value={p.productId} checked={choice === p.productId} onChange={() => setChoice(p.productId)} />
            <span>{p.name}</span>
            <span className="muted">{fmt.currency(p.price, p.currency)}</span>
          </label>
        ))}
      </fieldset>
      {bumps.length > 0 ? (
        <fieldset className="u-grid u-gap-2 u-m-0 u-p-0 u-border-0">
          <legend className="u-fw-600">{t('offerAddOns')}</legend>
          {bumps.map((p) => (
            <label key={p.productId} className="action-bar u-gap-2 u-items-center">
              <input type="checkbox" checked={Boolean(picked[p.productId])} onChange={(e) => setPicked((m) => ({ ...m, [p.productId]: e.target.checked }))} />
              <span>{t('offerAddOn', { name: p.name })}</span>
              <span className="muted">{fmt.currency(p.price, p.currency)}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      <Field label={t('offerEmail')} required>{(w) => <input {...w} type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} />}</Field>
      <Field label={t('offerName')}>{(w) => <input {...w} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />}</Field>
      <label className="action-bar u-gap-2 u-items-start">
        <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
        <span className="u-text-sm">{t('offerSaveCard')}</span>
      </label>
      <div>
        <Button variant="primary" disabled={busy || !choice || !email.trim()} aria-busy={busy} onClick={() => { void pay(); }}>
          {busy ? t('offerPaying') : t('offerPay')}
        </Button>
      </div>
      <p className="u-m-0 u-text-sm muted">{t('offerPaymentNote')}</p>
    </section>
  );
}

type OfferResult = 'accepted' | 'declinedByBank' | 'pending' | 'gone' | 'failed';

/** An upsell/downsell offer for THIS purchase: Accept or No thanks, then onDecided. */
export function FunnelOneClickPanel({ orgId, funnelId, stepId, offer, purchase, onDecided }: {
  orgId: string; funnelId: string; stepId: string; offer: StepOffer; purchase: Purchase;
  onDecided: () => void;
}): JSX.Element | null {
  const { t } = useTranslation('funnels');
  const fmt = useFormat();
  const [product, setProduct] = useState<OfferProduct | null | 'none' | 'error'>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [result, setResult] = useState<OfferResult | null>(null);
  const id = offer.oneClickProductId;

  useEffect(() => {
    let active = true;
    if (!id) { setProduct('none'); return; }
    setProduct(null);
    void readProducts(orgId, [id]).then((p) => { if (active) setProduct(p === null ? 'error' : p[0] ?? 'none'); });
    return () => { active = false; };
  }, [orgId, id, attempt]);

  const order = (sfx: string): string => store(orgId, `/orders/${encodeURIComponent(purchase.orderId)}${sfx}`);
  const accept = async (): Promise<void> => {
    if (!id) return;
    setBusy('accept');
    try {
      const r = await post(order('/one-click'), { productId: id, quantity: 1, funnel: { funnelId, stepId }, ft: purchase.ft });
      if (r.status === 201 || r.status === 200) { onDecided(); return; }
      // 400 = this purchase cannot take the offer (no saved card, chain limit): like a
      // closed offer, say so and move on rather than offering an Accept that cannot work.
      setResult(r.status === 402 ? 'declinedByBank' : r.status === 202 ? 'pending' : r.status === 404 || r.status === 400 ? 'gone' : 'failed');
    } catch {
      setResult('failed');
    } finally {
      setBusy(null);
    }
  };
  const decline = async (): Promise<void> => {
    setBusy('decline');
    try {
      const r = await post(order('/funnel-decline'), { funnel: { funnelId, stepId }, ft: purchase.ft });
      if (r.status === 200) { onDecided(); return; }
      setResult(r.status === 404 ? 'gone' : 'failed');
    } catch {
      setResult('failed');
    } finally {
      setBusy(null);
    }
  };

  if (product === null) return <div className="fp-shell u-p-4" role="status" aria-label={t('common:loading')}><Skeleton /></div>;
  // Never a dead end for a buyer who already paid: no product to offer (none set,
  // or archived) says so and moves on; a failed read offers a retry AND the way on.
  if (product === 'none' || product === 'error') {
    return (
      <div className="fp-shell u-p-4 u-grid u-gap-2 u-justify-start">
        <Notice variant={product === 'error' ? 'error' : 'info'} {...(product === 'error' ? { announce: t('offerLoadFailed') } : {})}>
          {product === 'error' ? t('offerLoadFailed') : t('offerGone')}
        </Notice>
        <div className="action-bar u-gap-2">
          {product === 'error' ? <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>{t('common:retry')}</Button> : null}
          <Button variant="primary" onClick={onDecided}>{t('viewerContinue')}</Button>
        </div>
      </div>
    );
  }
  if (result && result !== 'failed') {
    const msg = { accepted: '', declinedByBank: t('offerCardDeclined'), pending: t('offerPending'), gone: t('offerGone') }[result];
    return (
      <div className="fp-shell u-p-4 u-grid u-gap-2 u-justify-start">
        <Notice variant={result === 'declinedByBank' ? 'warning' : 'info'} announce={msg}>{msg}</Notice>
        <Button variant="primary" onClick={onDecided}>{t('viewerContinue')}</Button>
      </div>
    );
  }
  return (
    <section className="fp-shell u-p-4 u-grid u-gap-2" aria-label={t('offerOneClickLabel')}>
      <p className="u-m-0"><span className="u-fw-600">{product.name}</span> <span className="muted">{fmt.currency(product.price, product.currency)}</span></p>
      <p className="u-m-0 u-text-sm muted">{t('offerOneClickNote')}</p>
      {result === 'failed' ? <Notice variant="error" announce={t('offerActionFailed')}>{t('offerActionFailed')}</Notice> : null}
      <div className="action-bar u-gap-2">
        <Button variant="primary" disabled={busy !== null} aria-busy={busy === 'accept'} onClick={() => { void accept(); }}>
          {busy === 'accept' ? t('offerPaying') : t('offerAccept')}
        </Button>
        <Button variant="secondary" disabled={busy !== null} aria-busy={busy === 'decline'} onClick={() => { void decline(); }}>
          {t('offerDecline')}
        </Button>
      </div>
    </section>
  );
}

/** Back from Stripe: wait for the webhook to mark the purchase paid, then go on. */
export async function waitForPaid(orgId: string, funnelId: string, stepId: string, purchase: Purchase, opts: { tries?: number; delayMs?: number } = {}): Promise<boolean> {
  const tries = opts.tries ?? 15;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await post(store(orgId, `/orders/${encodeURIComponent(purchase.orderId)}/funnel-offer`), { funnel: { funnelId, stepId }, ft: purchase.ft });
      if (r.status === 404) return false;
      if (r.body.paid === true) return true;
    } catch { /* a blip: keep waiting */ }
    await new Promise((res) => setTimeout(res, opts.delayMs ?? 1500));
  }
  return false;
}
