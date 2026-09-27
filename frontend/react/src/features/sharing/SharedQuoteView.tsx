/**
 * Public shared-quote view (ecommerce gap plan §5C C3) — the buyer's side of a
 * `commerce_quote` share link: the PII-free quote projection (lines, totals,
 * validity) plus the ACCEPT action, which posts the live share token as the
 * capability proof to the commerce public accept route. A live-mode accept
 * follows the hosted Stripe Checkout URL; demo mode confirms the recorded order.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { useFormat } from '../../i18n/useFormat.js';
import { config, fetchOpts } from '../../client/config.js';

interface QuoteResource {
  quoteId?: unknown; orgId?: unknown; status?: unknown; version?: unknown;
  lines?: unknown; subtotal?: unknown; total?: unknown; currency?: unknown;
  note?: unknown; expiresAt?: unknown;
}
interface QuoteLine { name: string; quantity: number; unitPrice: number }

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function SharedQuoteView({ token, resource }: { token: string; resource: Record<string, unknown> }): JSX.Element {
  const { t } = useTranslation('sharing');
  const fmt = useFormat();
  const r = resource as QuoteResource;
  const lines: QuoteLine[] = Array.isArray(r.lines)
    ? (r.lines as Record<string, unknown>[]).map((l) => ({ name: str(l.name), quantity: num(l.quantity), unitPrice: num(l.unitPrice) }))
    : [];
  const currency = str(r.currency) || 'USD';
  const status = str(r.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [acceptedOrder, setAcceptedOrder] = useState<string | null>(null);
  // Hoisted rather than repeated: the notice both SHOWS and ANNOUNCES this, and
  // inlining it twice would put a 160-character expression on one line.
  const acceptedText = t('quoteAccepted', {
    defaultValue: 'Quote accepted — order {{order}} was recorded. The seller will follow up about payment.',
    order: acceptedOrder,
  });

  const accept = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const res = await fetch(
        `${config.baseUrl}/host/openwop-app/public-store/${encodeURIComponent(str(r.orgId))}/quotes/${encodeURIComponent(str(r.quoteId))}/accept`,
        fetchOpts({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }),
      );
      const body = (await res.json()) as { mode?: string; checkoutUrl?: string; orderId?: string; message?: string };
      if (!res.ok) { setError(body.message || t('quoteAcceptFailed', { defaultValue: 'Accepting the quote failed — it may have expired or changed.' })); return; }
      if (body.mode === 'live' && body.checkoutUrl) { window.location.href = body.checkoutUrl; return; }
      setAcceptedOrder(body.orderId ?? '');
    } catch { setError(t('quoteAcceptFailed', { defaultValue: 'Accepting the quote failed — it may have expired or changed.' })); }
    finally { setBusy(false); }
  }, [r.orgId, r.quoteId, token, t]);

  return (
    <div className="u-grid u-gap-3">
      <header className="u-flex u-flex-col u-gap-2">
        <span className="chip chip--muted u-fs-11 u-self-start">{t('quoteChip', { defaultValue: 'Quote' })}{typeof r.version === 'number' ? ` · v${r.version}` : ''}</span>
        <h1 className="page-header__title">{t('quoteTitle', { defaultValue: 'Your quote' })}</h1>
        {str(r.note) ? <p className="muted u-fs-13 u-m-0">{str(r.note)}</p> : null}
        {str(r.expiresAt) ? <p className="muted u-fs-11 u-m-0">{t('quoteValidUntil', { defaultValue: 'Valid until' })} {fmt.date(str(r.expiresAt))}</p> : null}
      </header>

      <div className="surface-card u-p-4 u-grid u-gap-2">
        <ul className="u-grid u-gap-1 u-list-none u-p-0 u-m-0">
          {lines.map((l, i) => (
            <li key={i} className="action-bar u-justify-between u-text-sm">
              <span>{l.name} × {l.quantity}</span>
              <span>{fmt.currency(l.unitPrice * l.quantity, currency)}</span>
            </li>
          ))}
        </ul>
        {/* R2 SR-9 — the payload carries `subtotal`; when it differs from the
            total (a discount), dropping it left the total unexplained. */}
        {num(r.subtotal) !== 0 && num(r.subtotal) !== num(r.total) ? (
          <div className="action-bar u-justify-between u-text-sm">
            <span>{t('quoteSubtotal', { defaultValue: 'Subtotal' })}</span>
            <span>{fmt.currency(num(r.subtotal), currency)}</span>
          </div>
        ) : null}
        <div className="action-bar u-justify-between u-pt-3 u-border-t">
          <strong>{t('quoteTotal', { defaultValue: 'Total' })}</strong>
          <strong>{fmt.currency(num(r.total), currency)}</strong>
        </div>
      </div>

      {/* SHUX-9 — `announce` is REQUIRED here: per `Notice`'s own docblock a
          conditionally-mounted live region enters the DOM with its text already
          inside and announces nothing, and role="alert"-on-insertion is explicitly
          NOT assumed. This is a public, anonymous, transactional surface — a
          screen-reader user who pressed Accept and failed was getting no feedback
          at all, while SUCCESS was already announced. */}
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      {acceptedOrder !== null ? (
        <Notice variant="success" announce={acceptedText}>{acceptedText}</Notice>
      ) : status === 'sent' ? (
        <div><Button variant="primary" disabled={busy} onClick={() => void accept()}>{busy ? t('quoteAccepting', { defaultValue: 'Accepting…' }) : t('quoteAccept', { defaultValue: 'Accept this quote' })}</Button></div>
      ) : (
        <Notice variant="info">{t('quoteNotOpen', { defaultValue: 'This quote is not open for acceptance right now.' })}</Notice>
      )}
    </div>
  );
}
