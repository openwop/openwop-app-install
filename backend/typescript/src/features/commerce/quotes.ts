/**
 * Quote-to-order (ecommerce gap plan §5C C3 — the keystone product gap).
 *
 * A `Quote` is the negotiation object the order state machine lacked: snapshot
 * pricing (via the C4 resolver, per-line override allowed), immutable
 * `QuoteRevision`s on every post-`sent` edit, an expiry, and a conversion that
 * honors the NEGOTIATED prices (never silent repricing — staleness fails
 * loudly). The lifecycle:
 *
 *     draft ──send──▶ sent ──accept──▶ accepted ──(auto)──▶ converted
 *       ▲               │                                      (orderId)
 *       └──revise───────┘         sent ──decline──▶ declined
 *                                 sent ──(deadline)──▶ expired (lazy)
 *
 * Governance: SEND is the gated moment (the negotiation-side commitment) — an
 * at/over-threshold quote parks a `commerce-spend` approval through the SAME
 * assertCommerceGate machinery as orders/refunds (ADR 0221 B3). Acceptance by
 * the buyer converts ungated (the human already signed the send).
 * Sharing: a sent quote can mint a `commerce_quote` share link (the ONE sharing
 * feature — expiring, view-capped, revocable); the public accept route proves
 * possession of the live token before converting.
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString, optionalCleanString } from '../../host/boundedStrings.js';
import { recordCommerceAction } from './telemetry.js';
import { resolvePrice, resolveSellable } from './pricing.js';
import { getProduct, createOrder, assertQuoteSendGate, quantizeMoney, type Order } from './commerceService.js';

const nowIso = (): string => new Date().toISOString();
const MAX = { lines: 200, note: 2000, perOrg: 5000, revisions: 50 } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired', 'converted'] as const;
/** ADR 0644 D3 — the statuses a MINTED public share link may still resolve, the
 *  mirror of `documentsService.SHAREABLE_STATUSES`. `accepted`/`converted` are IN
 *  deliberately: `acceptQuote` CAS's `sent -> accepted` (and a demo accept converts),
 *  so an allowlist of `['sent']` would 404 the buyer's own confirmation page at the
 *  instant they accept. `draft` (revised/never-sent), `declined` and `expired` darken. */
export const SHAREABLE_QUOTE_STATUSES: readonly QuoteStatus[] = ['sent', 'accepted', 'converted'];
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export interface QuoteLine {
  productId: string; name: string; quantity: number;
  /** The C4-resolved price at quote time (the reference point). */
  listPrice: number;
  /** The negotiated price (defaults to listPrice; overridable per line). */
  unitPrice: number;
  priceSource?: string;
}
export interface Quote {
  quoteId: string; tenantId: string; orgId: string;
  contactId?: string; companyId?: string; dealId?: string;
  lines: QuoteLine[];
  subtotal: number; total: number; currency: string;
  note?: string;
  status: QuoteStatus;
  version: number;
  expiresAt?: string;
  convertedOrderId?: string;
  createdBy: string; createdAt: string; updatedAt: string;
}
export interface QuoteRevision {
  revisionId: string; quoteId: string; tenantId: string; orgId: string;
  version: number; snapshot: Quote; actor: string; at: string;
}

const quotes = new DurableCollection<Quote>('commerce:quote', (q) => q.quoteId, undefined, (q) => q.tenantId);
const revisions = new DurableCollection<QuoteRevision>('commerce:quote-revision', (r) => r.revisionId, undefined, (r) => r.tenantId);

export async function listQuotes(tenantId: string, orgId: string, status?: QuoteStatus): Promise<Quote[]> {
  return (await quotes.listForTenantIndexed(tenantId))
    .filter((q) => q.orgId === orgId && (!status || q.status === status))
    .map(lazyExpire)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Expiry is LAZY (the approval-gate pattern): a `sent` quote past its deadline
 *  reads as `expired`; the durable flip happens on the next mutation attempt. */
function lazyExpire(q: Quote): Quote {
  if (q.status === 'sent' && q.expiresAt && Date.parse(q.expiresAt) <= Date.now()) return { ...q, status: 'expired' };
  return q;
}

export async function getQuote(tenantId: string, orgId: string, quoteId: string): Promise<Quote | null> {
  const q = await quotes.get(quoteId);
  return q && q.tenantId === tenantId && q.orgId === orgId ? lazyExpire(q) : null;
}

export async function listQuoteRevisions(tenantId: string, orgId: string, quoteId: string): Promise<QuoteRevision[]> {
  return (await revisions.listForTenantIndexed(tenantId))
    .filter((r) => r.orgId === orgId && r.quoteId === quoteId)
    .sort((a, b) => b.version - a.version);
}

export interface QuoteLineInput { productId: string; quantity: number; unitPrice?: number }

async function priceLines(tenantId: string, orgId: string, raw: QuoteLineInput[], buyer: { contactId?: string; companyId?: string }): Promise<{ lines: QuoteLine[]; currency: string }> {
  const lines: QuoteLine[] = [];
  let currency = 'USD';
  for (const l of raw.slice(0, MAX.lines)) {
    const qty = typeof l.quantity === 'number' && Number.isFinite(l.quantity) && l.quantity > 0 ? Math.trunc(l.quantity) : 0;
    if (qty <= 0) continue;
    const product = await getProduct(tenantId, orgId, String(l.productId));
    if (!product) throw new OpenwopError('validation_error', `Product not found: ${l.productId}`, 400, { productId: l.productId });
    if (lines.length > 0 && product.currency !== currency) {
      throw new OpenwopError('validation_error', 'All lines in a quote must share one currency.', 400, { expected: currency, got: product.currency });
    }
    // D3 — assortment: an account buyer can only be quoted what they may buy.
    if (buyer.contactId || buyer.companyId) {
      const sellable = await resolveSellable(tenantId, orgId, product.productId, buyer);
      if (!sellable.sellable) {
        throw new OpenwopError('validation_error', `'${product.name}' is not in this account's assortment.`, 409, { code: 'not_sellable', productId: product.productId });
      }
    }
    const resolved = await resolvePrice(tenantId, orgId, product, { buyer });
    const negotiated = typeof l.unitPrice === 'number' && Number.isFinite(l.unitPrice) && l.unitPrice >= 0 ? l.unitPrice : resolved.price;
    lines.push({
      productId: product.productId, name: product.name, quantity: qty,
      listPrice: resolved.price, unitPrice: negotiated,
      ...(resolved.source !== 'default' ? { priceSource: resolved.source } : {}),
    });
    currency = product.currency;
  }
  if (lines.length === 0) throw new OpenwopError('validation_error', 'A quote needs at least one line with quantity > 0.', 400, {});
  return { lines, currency };
}

function totals(lines: QuoteLine[], currency: string): { subtotal: number; total: number } {
  // R2 CM-P2-I3 — quantize in the quote's own currency (JPY has no minor unit).
  const subtotal = quantizeMoney(lines.reduce((s, l) => s + l.listPrice * l.quantity, 0), currency);
  const total = quantizeMoney(lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0), currency);
  return { subtotal, total };
}

export async function createQuote(input: {
  tenantId: string; orgId: string; createdBy: string;
  lines: QuoteLineInput[];
  contactId?: string; companyId?: string; dealId?: string;
  note?: unknown; expiresInDays?: number;
}): Promise<Quote> {
  const existing = await listQuotes(input.tenantId, input.orgId);
  if (existing.length >= MAX.perOrg) throw new OpenwopError('validation_error', `This org has the maximum ${MAX.perOrg} quotes.`, 409, { max: MAX.perOrg });
  const buyer = { ...(input.contactId ? { contactId: input.contactId } : {}), ...(input.companyId ? { companyId: input.companyId } : {}) };
  const { lines, currency } = await priceLines(input.tenantId, input.orgId, input.lines ?? [], buyer);
  const { subtotal, total } = totals(lines, currency);
  const ts = nowIso();
  const days = typeof input.expiresInDays === 'number' && Number.isFinite(input.expiresInDays) && input.expiresInDays > 0 ? Math.min(365, Math.trunc(input.expiresInDays)) : 30;
  const q: Quote = {
    quoteId: `qte:${randomUUID()}`, tenantId: input.tenantId, orgId: input.orgId,
    ...(input.contactId ? { contactId: input.contactId } : {}),
    ...(input.companyId ? { companyId: input.companyId } : {}),
    ...(input.dealId ? { dealId: input.dealId } : {}),
    lines, subtotal, total, currency,
    ...(optionalCleanString(input.note, MAX.note) ? { note: cleanString(input.note, MAX.note) } : {}),
    status: 'draft', version: 1,
    expiresAt: new Date(Date.now() + days * DAY_MS).toISOString(),
    createdBy: input.createdBy, createdAt: ts, updatedAt: ts,
  };
  await quotes.put(q);
  recordCommerceAction('quote.created', q, input.createdBy, { quoteId: q.quoteId, total: q.total, currency: q.currency, lineCount: q.lines.length });
  return q;
}

/** Revise a draft/sent quote. A post-`sent` edit pins the pre-edit snapshot as an
 *  immutable revision, bumps `version`, and DEMOTES the quote to draft — the
 *  protected-field re-approval discipline (a revised negotiation re-sends). */
export async function reviseQuote(
  tenantId: string, orgId: string, quoteId: string,
  patch: { lines?: QuoteLineInput[]; note?: unknown; expiresInDays?: number },
  opts: { actor?: string } = {},
): Promise<Quote | null> {
  const q = await getQuote(tenantId, orgId, quoteId);
  if (!q) return null;
  if (q.status !== 'draft' && q.status !== 'sent') {
    throw new OpenwopError('validation_error', `Only a draft or sent quote can be revised (is '${q.status}').`, 409, { status: q.status });
  }
  if (q.status === 'sent') {
    const revs = await listQuoteRevisions(tenantId, orgId, quoteId);
    if (revs.length >= MAX.revisions) throw new OpenwopError('validation_error', `This quote has the maximum ${MAX.revisions} revisions.`, 409, {});
    await revisions.put({ revisionId: `qrev:${randomUUID()}`, quoteId, tenantId, orgId, version: q.version, snapshot: q, actor: opts.actor ?? 'system', at: nowIso() });
  }
  const buyer = { ...(q.contactId ? { contactId: q.contactId } : {}), ...(q.companyId ? { companyId: q.companyId } : {}) };
  const next: Quote = { ...q, updatedAt: nowIso() };
  if (patch.lines !== undefined) {
    const { lines, currency } = await priceLines(tenantId, orgId, patch.lines, buyer);
    next.lines = lines; next.currency = currency;
    const t = totals(lines, currency); next.subtotal = t.subtotal; next.total = t.total;
  }
  if (patch.note !== undefined) { const n = optionalCleanString(patch.note, MAX.note); if (n) next.note = n; else delete next.note; }
  if (typeof patch.expiresInDays === 'number' && Number.isFinite(patch.expiresInDays) && patch.expiresInDays > 0) {
    next.expiresAt = new Date(Date.now() + Math.min(365, Math.trunc(patch.expiresInDays)) * DAY_MS).toISOString();
  }
  if (q.status === 'sent') { next.status = 'draft'; next.version = q.version + 1; }
  await quotes.put(next);
  recordCommerceAction('quote.revised', next, opts.actor ?? 'system', { quoteId, version: next.version, total: next.total });
  return next;
}

/** Send a draft quote — THE gated moment (B3): an at/over-threshold total parks a
 *  `commerce-spend` approval keyed per (quote, version); a retry after the human
 *  decision resumes. */
export async function sendQuote(tenantId: string, orgId: string, quoteId: string, opts: { actor?: string } = {}): Promise<Quote | null> {
  const q = await getQuote(tenantId, orgId, quoteId);
  if (!q) return null;
  if (q.status !== 'draft') throw new OpenwopError('validation_error', `Only a draft quote can be sent (is '${q.status}').`, 409, { status: q.status });
  await assertQuoteSendGate(q);
  const next: Quote = { ...q, status: 'sent', updatedAt: nowIso() };
  await quotes.put(next);
  recordCommerceAction('quote.sent', next, opts.actor ?? 'system', { quoteId, version: next.version, total: next.total, currency: next.currency });
  return next;
}

export async function declineQuote(tenantId: string, orgId: string, quoteId: string, opts: { actor?: string } = {}): Promise<Quote | null> {
  const q = await getQuote(tenantId, orgId, quoteId);
  if (!q) return null;
  if (q.status !== 'sent') throw new OpenwopError('validation_error', `Only a sent quote can be declined (is '${q.status}').`, 409, { status: q.status });
  const next: Quote = { ...q, status: 'declined', updatedAt: nowIso() };
  await quotes.put(next);
  recordCommerceAction('quote.declined', next, opts.actor ?? 'system', { quoteId });
  return next;
}

/**
 * Accept a sent quote and convert it to an order at the NEGOTIATED snapshot
 * prices. Staleness fails loudly (409 `quote_stale` details) instead of silent
 * repricing: every product must still exist and be active. Expired quotes
 * refuse. The conversion order carries `priceSource:'quote'` lines.
 */
export async function acceptQuote(tenantId: string, orgId: string, quoteId: string, opts: { actor?: string } = {}): Promise<{ quote: Quote; order: Order } | null> {
  const q = await getQuote(tenantId, orgId, quoteId);
  if (!q) return null;
  if (q.status === 'expired') throw new OpenwopError('validation_error', 'This quote has expired — ask for a fresh one.', 409, { status: 'expired' });
  if (q.status !== 'sent') throw new OpenwopError('validation_error', `Only a sent quote can be accepted (is '${q.status}').`, 409, { status: q.status });
  for (const line of q.lines) {
    const p = await getProduct(tenantId, orgId, line.productId);
    if (!p || !p.active) {
      throw new OpenwopError('validation_error', `Quote is stale: '${line.name}' is no longer available.`, 409, { code: 'quote_stale', productId: line.productId });
    }
  }
  // CAS the sent→accepted flip FIRST (cross-instance): two concurrent accepts of
  // one quote must never mint two orders — the loser sees the state change.
  const raw = await quotes.get(quoteId); // the exact stored row for byte-match CAS
  if (!raw || raw.status !== 'sent' || !(await quotes.compareAndSwap(raw, { ...raw, status: 'accepted', updatedAt: nowIso() }))) {
    throw new OpenwopError('validation_error', 'This quote was just accepted or changed — refresh to see its state.', 409, { status: 'accepted' });
  }
  let order: Order;
  try {
    order = await createOrder({
      tenantId, orgId, createdBy: opts.actor ?? `quote:${quoteId}`,
      ...(q.contactId ? { contactId: q.contactId } : {}),
      lines: q.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPriceOverride: l.unitPrice })),
    });
  } catch (err) {
    // Roll the flip back (e.g. out_of_stock) so the quote stays actionable.
    const flipped = await quotes.get(quoteId);
    if (flipped && flipped.status === 'accepted') await quotes.put({ ...flipped, status: 'sent', updatedAt: nowIso() });
    throw err;
  }
  const next: Quote = { ...(await quotes.get(quoteId))!, status: 'converted', convertedOrderId: order.orderId, updatedAt: nowIso() };
  await quotes.put(next);
  recordCommerceAction('quote.accepted', next, opts.actor ?? 'system', { quoteId, orderId: order.orderId, total: next.total, currency: next.currency });
  return { quote: next, order };
}

/** The safe PUBLIC projection of a quote (share-link viewer + accept page):
 *  no tenant ids, no CRM ids, no actor ids. */
export function projectQuotePublic(q: Quote): Record<string, unknown> {
  return {
    quoteId: q.quoteId,
    status: q.status,
    lines: q.lines.map((l) => ({ name: l.name, quantity: l.quantity, unitPrice: l.unitPrice })),
    subtotal: q.subtotal, total: q.total, currency: q.currency,
    ...(q.note ? { note: q.note } : {}),
    ...(q.expiresAt ? { expiresAt: q.expiresAt } : {}),
    version: q.version,
  };
}

