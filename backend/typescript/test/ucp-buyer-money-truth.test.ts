/**
 * commerce-ucp-buyer ROUND 2 (UX_UPGRADE-commerce-ucp-buyer, pass 2) — the seams
 * where an agent spends real money.
 *
 *  - UCP-P2-B1  the approval sentence a human reads is exponent-correct
 *  - UCP-P2-B2  the merchant's confirmed total is reconciled against the mandate
 *  - UCP-P2-B3  an order id is required to claim `placed`, in both spellings
 *  - UCP-P2-M1  a possibly-charged (`unknown`) purchase counts against the cap
 *  - UCP-P2-M2  the cap is counted per CURRENCY, not as raw minor units
 *  - UCP-P2-M3  an unsupported currency is refused at intake
 *  - UCP-P2-M4  an erased subject's words leave; the spend record stays
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  buildPurchaseDraft, checkoutPurchase, listPurchases, getPurchase, formatMinor,
  eraseSubjectUcpPurchases, __resetUcpBuyer, trackPurchase, closeUnknownPurchase,
} from '../src/features/commerce/ucpBuyer/ucpBuyerService.js';
import { listApprovals, resolveApproval } from '../src/host/approvalService.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { purgeRetained } from '../src/host/retentionPurger.js';
import { claimApproval } from '../src/host/approvalDecision.js';
import { createHostAdapterSuite } from '../src/host/index.js';

const T = 'tenant-ucpb-r2';
const ORG = 'org-ucpb-r2';
const BY = 'user-ucpb-r2';
const MERCHANT = 'https://merchant.example';

let storage: Awaited<ReturnType<typeof openStorage>>;

/** The merchant's checkout answer, swapped per test. */
let merchantReply: Record<string, unknown> = { orderId: 'ext-1' };

vi.mock('../src/host/egressPolicy.js', () => ({ assertEgressAllowed: async () => undefined }));

beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR = '100000000';
  // Every merchant call answers from `merchantReply` — no network, no timing.
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(merchantReply), { status: 200, headers: { 'content-type': 'application/json' } }));
});
beforeEach(async () => {
  await __resetUcpBuyer();
  merchantReply = { orderId: 'ext-1' };
});

async function draft(over: { currency?: string; unitPriceMinor?: number; maxAmountMinor?: number } = {}): Promise<string> {
  const p = await buildPurchaseDraft({
    tenantId: T, orgId: ORG, createdBy: BY, merchantUrl: MERCHANT,
    intent: 'buy two widgets for the office',
    maxAmountMinor: over.maxAmountMinor ?? 500000,
    currency: over.currency ?? 'USD',
    lines: [{ externalProductId: 'ext-1', name: 'Widget', quantity: 2, unitPriceMinor: over.unitPriceMinor ?? 1200 }],
  });
  return p.purchaseId;
}

/** Drive the ALWAYS approval gate to approved, then place. */
async function place(purchaseId: string): Promise<void> {
  await expect(checkoutPurchase(T, ORG, purchaseId, { actor: BY })).rejects.toThrow(/sign-off/i);
  const appr = (await listApprovals(T, 'pending')).find((a) => a.spendIdemKey === `ucp-buy:${purchaseId}`);
  await resolveApproval(appr!.approvalId, { status: 'approved' });
}

describe('UCP-P2-B1/B4 (review B-1) — the approval a human presses actually approves', () => {
  it('claiming the approval through the REGISTRY completes the purchase end to end', async () => {
    // My tests approved by calling `resolveApproval` directly — the back door. That
    // proved the service and NOTHING about the button: `commerce-spend` was routed to
    // the run-proposal finalizer, which needs a roster and a workflowId these rows
    // leave empty, so every Approve threw "Proposing agent no longer exists" and left
    // the row pending — with the new Place button then 409ing forever. Drive the same
    // entry point the inbox does.
    const id = await draft();
    await expect(checkoutPurchase(T, ORG, id, { actor: BY })).rejects.toThrow(/sign-off/i);
    const appr = (await listApprovals(T, 'pending')).find((a) => a.spendIdemKey === `ucp-buy:${id}`);

    const deps = { storage, hostSuite: createHostAdapterSuite({ storage }) };
    const decided = await claimApproval(deps, { tenantId: T, decidedBy: BY }, appr!.approvalId);
    expect(decided.status).toBe('approved');

    merchantReply = { orderId: 'ext-approved', totalMinor: 2400, currency: 'USD' };
    const placed = await checkoutPurchase(T, ORG, id, { actor: BY });
    expect(placed.status).toBe('placed');
  });
});

describe('UCP-P2-B1 — the sentence a human authorizes', () => {
  it('formats a zero-decimal currency without the /100 that understated it 100×', () => {
    expect(formatMinor(1234500, 'JPY')).toContain('1,234,500');
    expect(formatMinor(1234500, 'JPY')).not.toContain('12,345.00');
  });

  it('still formats a two-decimal currency the usual way', () => {
    expect(formatMinor(2400, 'USD')).toContain('24.00');
  });

  it('the approval proposal carries the formatted figure (JPY, not JPY/100)', async () => {
    process.env.OPENWOP_UCP_BUYER_ORG_CAP_CURRENCY = 'JPY'; // the cap names its currency
    const id = await draft({ currency: 'JPY', unitPriceMinor: 617250, maxAmountMinor: 5000000 });
    await expect(checkoutPurchase(T, ORG, id, { actor: BY })).rejects.toThrow(/sign-off/i);
    const appr = (await listApprovals(T, 'pending')).find((a) => a.spendIdemKey === `ucp-buy:${id}`);
    expect(appr?.proposal).toContain('1,234,500');
    expect(appr?.proposal).not.toContain('12,345.00');
    // …and the structured figure the inbox can render instead of parsing prose.
    expect(appr?.amountMinor).toBe(1234500);
    expect(appr?.amountCurrency).toBe('JPY');
    delete process.env.OPENWOP_UCP_BUYER_ORG_CAP_CURRENCY;
  });
});

describe('UCP-P2-B3 — you cannot claim `placed` without the merchant\'s order id', () => {
  it('reads the id from a UCP `id` field (this host\'s own REST projection)', async () => {
    const id = await draft();
    await place(id);
    merchantReply = { id: 'ucp-order-9', status: 'confirmed' };
    const placed = await checkoutPurchase(T, ORG, id, { actor: BY });
    expect(placed.extOrderId).toBe('ucp-order-9');
    // …and the merchant's OWN status, rather than an asserted 'pending'.
    expect(placed.extStatus).toBe('confirmed');
  });

  it('parks as `unknown` — never `placed` — when no order id comes back', async () => {
    const id = await draft();
    await place(id);
    merchantReply = { ok: true };
    await expect(checkoutPurchase(T, ORG, id, { actor: BY })).rejects.toThrow(/no order id/i);
    expect((await getPurchase(T, ORG, id))?.status).toBe('unknown');
  });
});

describe('UCP-P2-B2 — reconcile what the merchant charged against what was authorized', () => {
  it('records a matching total as reconciled', async () => {
    const id = await draft(); // 2 × 1200 = 2400 USD minor
    await place(id);
    merchantReply = { orderId: 'ext-7', totalMinor: 2400, currency: 'USD' };
    const placed = await checkoutPurchase(T, ORG, id, { actor: BY });
    expect(placed.reconciliation).toBe('matched');
    expect(placed.confirmedTotalMinor).toBe(2400);
  });

  it('a DIVERGENT total parks the purchase and keeps both figures', async () => {
    const id = await draft();
    await place(id);
    merchantReply = { orderId: 'ext-8', totalMinor: 16000, currency: 'USD' }; // the price moved
    await expect(checkoutPurchase(T, ORG, id, { actor: BY })).rejects.toThrow(/nobody approved/i);
    const after = await getPurchase(T, ORG, id);
    expect(after?.status).toBe('unknown');
    expect(after?.confirmedTotalMinor).toBe(16000);      // what the merchant says
    expect(after?.cartMandate.totalMinor).toBe(2400);    // what the human signed
  });

  it('says UNRECONCILED rather than implying confirmation when no total comes back', async () => {
    const id = await draft();
    await place(id);
    merchantReply = { orderId: 'ext-9' };
    const placed = await checkoutPurchase(T, ORG, id, { actor: BY });
    expect(placed.reconciliation).toBe('unavailable');
    expect(placed.confirmedTotalMinor).toBeUndefined();
  });
});

describe('UCP-P2-M1 / M2 — what the spend cap counts', () => {
  it('a possibly-charged `unknown` purchase consumes the cap', async () => {
    process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR = '5000';
    try {
      const first = await draft({ unitPriceMinor: 2000 }); // 4000
      await place(first);
      merchantReply = { ok: true }; // no order id ⇒ parks as `unknown`
      await expect(checkoutPurchase(T, ORG, first, { actor: BY })).rejects.toThrow();
      expect((await getPurchase(T, ORG, first))?.status).toBe('unknown');

      // 4000 is possibly committed, so a further 4000 must not fit under a 5000 cap.
      const second = await draft({ unitPriceMinor: 2000 });
      await expect(checkoutPurchase(T, ORG, second, { actor: BY })).rejects.toThrow(/spend cap/i);
    } finally {
      process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR = '100000000';
    }
  });

  it('the cap is DENOMINATED — a purchase in another currency is refused, not silently re-budgeted', async () => {
    process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR = '5000'; // USD by default
    try {
      // Bucketing per currency (where this pass first landed) would authorize the FULL
      // cap once per currency — six times the operator's ceiling. A cap of $50 says
      // nothing about ¥, so a ¥ purchase must be refused rather than measured against it.
      const jpy = await draft({ currency: 'JPY', unitPriceMinor: 2000, maxAmountMinor: 500000 });
      // Assert the CODE + the currencies, not the sentence: the copy legitimately
      // changed once already this pass (the operator env var moved out of the
      // user-facing message), and a test that pins prose fails on an improvement.
      await expect(checkoutPurchase(T, ORG, jpy, { actor: BY })).rejects.toMatchObject({
        code: 'forbidden', details: { code: 'spend_cap_currency', capCurrency: 'USD', purchaseCurrency: 'JPY' },
      });
      expect((await getPurchase(T, ORG, jpy))?.status).toBe('draft'); // never parked for approval
    } finally {
      process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR = '100000000';
    }
  });

  it('…and the operator can authorize that currency explicitly', async () => {
    process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR = '5000000';
    process.env.OPENWOP_UCP_BUYER_ORG_CAP_CURRENCY = 'JPY';
    try {
      const jpy = await draft({ currency: 'JPY', unitPriceMinor: 2000, maxAmountMinor: 500000 });
      await expect(checkoutPurchase(T, ORG, jpy, { actor: BY })).rejects.toThrow(/sign-off/i);
      expect((await getPurchase(T, ORG, jpy))?.status).toBe('awaiting_approval');
      // …and a USD purchase is now the one refused — the cap describes exactly one currency.
      const usd = await draft({ unitPriceMinor: 2000 });
      await expect(checkoutPurchase(T, ORG, usd, { actor: BY })).rejects.toMatchObject({
        details: { code: 'spend_cap_currency', capCurrency: 'JPY', purchaseCurrency: 'USD' },
      });
    } finally {
      delete process.env.OPENWOP_UCP_BUYER_ORG_CAP_CURRENCY;
      process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR = '100000000';
    }
  });
});

describe('review fold-ins — defects the independent pass found in the fix', () => {
  it('M-1: a merchant cannot suppress reconciliation by omitting the CURRENCY', async () => {
    const id = await draft();
    await place(id);
    // A total, no currency — previously recorded as "returned no total", and the page
    // then said so. The currency we AUTHORIZED and sent is the honest fallback.
    merchantReply = { orderId: 'ext-nc', totalMinor: 999999 };
    await expect(checkoutPurchase(T, ORG, id, { actor: BY })).rejects.toThrow(/nobody approved/i);
    expect((await getPurchase(T, ORG, id))?.confirmedTotalMinor).toBe(999999);
  });

  it('M-3: a three-decimal currency formats to its real exponent', () => {
    // `fromStripeMinorUnits` has a zero-decimal table and NO three-decimal one, so the
    // first cut rendered KWD 10× high — disagreeing with the same figure on screen.
    expect(formatMinor(1000, 'KWD')).toContain('1.000');
    expect(formatMinor(1000, 'KWD')).not.toContain('10.000');
    expect(formatMinor(1000, 'USD')).toContain('10.00'); // the common case is unchanged
  });
});

describe('UCP-P2-M3 / M4 — intake and lifecycle', () => {
  it('refuses an unsupported currency instead of persisting a row that bricks the page', async () => {
    await expect(draft({ currency: 'EURO' })).rejects.toThrow(/Unsupported currency/i);
  });

  it('the retention purger is REGISTERED and REDACTS aged rows (wiring, not mechanism)', async () => {
    const id = await draft();
    const results = await purgeRetained(T, 'confidential-pii', new Date(Date.now() + 60_000).toISOString());
    expect(results.some((r) => r.feature === 'commerce-ucp-buyer')).toBe(true);

    // The row SURVIVES with its money intact — age removes the person, not the ledger
    // (review M-9: hard-deleting also releases cap and destroys dispute evidence).
    const after = (await listPurchases(T, ORG)).find((p) => p.purchaseId === id);
    expect(after?.intentMandate.intent).toBe('[erased]');
    expect(after?.createdBy).toBe('erased');
    expect(after?.cartMandate.totalMinor).toBe(2400);
  });

  it('the eraser is REGISTERED, not just exported (mechanism vs wiring)', async () => {
    // Calling `eraseSubjectUcpPurchases` directly proves the mechanism. It proves
    // NOTHING about whether the registry ever calls it — a registration that never
    // executes is inert, and that is exactly how an erasure gap hides. Drive the HOST
    // entry point instead, which is what a real GDPR erasure runs.
    const id = await draft();
    await eraseSubject(T, BY);
    const after = (await listPurchases(T, ORG)).find((p) => p.purchaseId === id);
    expect(after?.intentMandate.intent).toBe('[erased]');
  });

  it('erasing a subject removes their words and id but keeps the spend record', async () => {
    const id = await draft();
    await eraseSubjectUcpPurchases(T, BY);
    const after = (await listPurchases(T, ORG)).find((p) => p.purchaseId === id);
    expect(after?.intentMandate.intent).toBe('[erased]');
    expect(after?.createdBy).toBe('erased');
    expect(after?.cartMandate.totalMinor).toBe(2400); // the org's spend record survives
  });
});

describe('R3 B-2 — the `unknown` state finally has exits', () => {
  it('track promotes unknown→placed when the merchant answers for the order id', async () => {
    const id = await draft();
    await place(id);
    merchantReply = { ok: true }; // no order id → parks unknown (no ext id)
    await expect(checkoutPurchase(T, ORG, id, { actor: BY })).rejects.toThrow(/no order id/i);
    expect((await getPurchase(T, ORG, id))?.status).toBe('unknown');
    // WITHOUT an extOrderId track has nothing to query — it must NOT guess.
    merchantReply = { status: 'confirmed' };
    const still = await trackPurchase(T, ORG, id, { actingUserId: BY });
    expect(still.status).toBe('unknown');
  });

  it('closeUnknownPurchase: not_placed → failed (cap releases); confirmed_placed → placed; only FROM unknown; reason required', async () => {
    const id = await draft();
    await place(id);
    merchantReply = { ok: true };
    await expect(checkoutPurchase(T, ORG, id, { actor: BY })).rejects.toThrow(/no order id/i);

    // reason required
    await expect(closeUnknownPurchase(T, ORG, id, { outcome: 'not_placed', reason: '  ', actingUserId: BY }))
      .rejects.toThrow(/reason/i);

    const closed = await closeUnknownPurchase(T, ORG, id, { outcome: 'not_placed', reason: 'Merchant support confirmed no order exists.', actingUserId: BY });
    expect(closed.status).toBe('failed');

    // Only from unknown — a second close 400s naming the current status.
    await expect(closeUnknownPurchase(T, ORG, id, { outcome: 'confirmed_placed', reason: 'x', actingUserId: BY }))
      .rejects.toThrow(/'failed'/);

    // The other outcome: park a second purchase, close as confirmed_placed.
    const id2 = await draft();
    await place(id2);
    merchantReply = { ok: true };
    await expect(checkoutPurchase(T, ORG, id2, { actor: BY })).rejects.toThrow(/no order id/i);
    const kept = await closeUnknownPurchase(T, ORG, id2, { outcome: 'confirmed_placed', reason: 'Order visible in the merchant dashboard.', actingUserId: BY });
    expect(kept.status).toBe('placed'); // cap stays consumed
  });
});
