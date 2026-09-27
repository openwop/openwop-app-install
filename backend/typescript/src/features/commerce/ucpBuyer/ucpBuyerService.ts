/**
 * UCP buyer/client (ADR 0188, Phases 1–3 floor) — THIS host's agents shop
 * EXTERNAL UCP merchants: discover → search → cart → (approved) pay → track.
 * The host is the payer; the merchant stays Merchant of Record.
 *
 * Floor per the ADR correction notes: REST-transport merchants addressed by an
 * egress-policy-gated base URL (Connections provider manifests arrive with the
 * first credentialed merchant; MCP transport deferred); demo-mode placement
 * (typed AP2 mandates, NOT VC-signed — explicit warnings). The MONEY GATE is
 * not a floor: every checkout requires (a) the fail-closed per-org spend cap
 * and (b) an APPROVED `commerce-spend` sign-off on the ONE queue (ALWAYS —
 * real money has no free threshold), resumed idempotently by `spendIdemKey`.
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection, hostExtStorage } from '../../../host/hostExtPersistence.js';
import { makeMcpClient, McpError } from '../../../host/mcpClient.js';
import { getProvider } from '../../connections/providerRegistry.js';
import { OpenwopError } from '../../../types.js';
import { cleanString } from '../../../host/boundedStrings.js';
import { assertEgressAllowed } from '../../../host/egressPolicy.js';
import { getApproval, createCommerceSpendApproval } from '../../../host/approvalService.js';
import { getNotificationEmitter } from '../../../notifications/emitter.js';
import { appendAudit } from '../../../host/auditChainService.js';
import { createLogger } from '../../../observability/logger.js';
import { recordCommerceAction } from '../telemetry.js';
import { toStripeMinorUnits } from '../../billing/stripeApi.js';
import { CURRENCIES } from '../commerceService.js';
import { registerRetentionPurger } from '../../../host/retentionPurger.js';
import { registerSubjectEraser } from '../../../host/subjectErasure.js';
import { subjectKeyForms } from '../../../host/subjectErasureRedaction.js';

const log = createLogger('commerce.ucp-buyer');
import { buildCartMandate, buildPaymentMandate, signPaymentMandate, type Ap2CartLine, type Ap2CartMandate, type Ap2IntentMandate, type Ap2PaymentMandate } from './ap2Mandates.js';
import { assertEffectAllowed } from '../../../host/runEffectContext.js';

const nowIso = (): string => new Date().toISOString();
/** Read at call time (not module load) so a test can shorten it via env. */
function fetchTimeoutMs(): number {
  const raw = Number(process.env.OPENWOP_UCP_BUYER_FETCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}
const MAX = { purchasesPerOrg: 2000, lines: 100, intent: 500 } as const;

/** Fail-closed per-org buyer spend cap (MINOR units). UNSET ⇒ ZERO — an operator
 *  must explicitly authorize agent purchasing at all (the ADR's posture). */
function orgSpendCapMinor(): number {
  const raw = Number(process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

/** R2 UCP-P2-M2 — the currency the cap is DENOMINATED IN (default USD).
 *
 *  The cap is one number of minor units. Comparing it against spend in a different
 *  currency is meaningless — the pre-R2 code summed raw minor units across
 *  currencies and claimed in a comment that this erred safe (it does not: a EUR or
 *  GBP minor unit is worth MORE than a cent, so counting it as one under-counts and
 *  the org OVER-spends). But counting each currency in its own bucket, which is
 *  where this pass first landed, is ALSO wrong — it silently authorizes the full cap
 *  once PER currency, six times the exposure the operator set.
 *
 *  So the cap names its currency and a purchase in any other currency is REFUSED.
 *  No FX, no invented budgets, no silent multiplication of the operator's ceiling. */
function orgSpendCapCurrency(): string {
  const raw = (process.env.OPENWOP_UCP_BUYER_ORG_CAP_CURRENCY ?? 'USD').trim().toUpperCase();
  return raw || 'USD';
}

// `unknown` = a placement whose merchant response was ambiguous (timeout); it must
// be reconciled via the track path before any retry (grade-code B9), never blindly
// re-checked-out like `failed`.
export type UcpPurchaseStatus = 'draft' | 'awaiting_approval' | 'placing' | 'placed' | 'unknown' | 'failed' | 'canceled';
export interface UcpPurchase {
  purchaseId: string; tenantId: string; orgId: string;
  /** ADR 0258 — the merchant is addressed by EXACTLY ONE transport: a REST base `merchantUrl`
   *  OR a `reach:'mcp'` connection `merchantServerId`. Pre-0258 purchases always carry
   *  `merchantUrl` (REST), so this stays back-compatible. */
  merchantUrl?: string;
  merchantServerId?: string;
  intentMandate: Ap2IntentMandate;
  cartMandate: Ap2CartMandate;
  paymentMandate?: Ap2PaymentMandate;
  approvalId?: string;
  /** The merchant's order id once placed (also the idempotency witness). */
  extOrderId?: string;
  extStatus?: string;
  /** R2 UCP-P2-B2 — what the MERCHANT says it charged, and whether we could check it
   *  against the mandate the human signed. Before this, no amount crossed the checkout
   *  boundary in either direction: we sent line ids and quantities, never read a total,
   *  and recorded our own mandate price forever — so a price that moved between search
   *  and checkout left every host-side record (and the "X of Y authorized" line) wrong,
   *  with the mandate attesting a price the merchant never agreed to.
   *  `'unavailable'` is stated, never implied: a merchant that returns no total leaves
   *  the purchase UNRECONCILED, and the screen says so rather than showing our figure
   *  as though it had been confirmed. */
  confirmedTotalMinor?: number;
  confirmedCurrency?: string;
  reconciliation?: 'matched' | 'unavailable';
  status: UcpPurchaseStatus;
  createdBy: string; createdAt: string; updatedAt: string;
}

const purchases = new DurableCollection<UcpPurchase>('commerce:ucp-purchase', (p) => p.purchaseId, undefined, (p) => p.tenantId);

// ── R2 UCP-P2-M4 — lifecycle for a store nobody could erase ──────────────────
// These rows carry `createdBy` (a first-party subject) and `intentMandate.intent` —
// up to 500 characters of the human's OWN authorization sentence ("book flowers for
// Jane, 12 Elm St, before Friday"), plus merchant line names. The collection appeared
// in NO retention purger and NO subject eraser anywhere in the repo, and the only
// bound on growth was a hard 409 at 2000 rows per org with no way to clear it.
registerRetentionPurger({
  feature: 'commerce-ucp-buyer',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return { deleted: 0, failed: 0 };
    // REDACT, don't delete (review M-9): twelve lines below, the eraser argues that
    // "an org's spend record must survive an erasure" — and this purger was hard-
    // deleting the same rows on age, which also silently releases cap and destroys the
    // evidence behind an open dispute. Age removes the PERSON, not the ledger.
    let deleted = 0; let failed = 0;
    for (const row of await purchases.listForTenantIndexed(tenantId)) {
      if (row.tenantId !== tenantId || row.updatedAt >= cutoffIso) continue;
      if (row.createdBy === 'erased' && row.intentMandate.intent === '[erased]') continue; // already clean
      try {
        await purchases.put({ ...row, createdBy: 'erased', intentMandate: { ...row.intentMandate, intent: '[erased]' }, updatedAt: nowIso() });
        deleted += 1;
      } catch { failed += 1; }
    }
    return { deleted, failed };
  },
});

/** An erased subject's purchases keep their financial skeleton (amount, merchant,
 *  status — an org's spend record must survive an erasure) but lose the person: the
 *  free-text intent they wrote and their subject id. Exported named so the eraser is
 *  attributable rather than an anonymous closure. */
export async function eraseSubjectUcpPurchases(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms, raw } = subjectKeyForms(subjectKey);
  const keys = new Set([...forms, raw].map((f) => f.toLowerCase()));
  for (const p of await purchases.listForTenantIndexed(tenantId)) {
    if (p.tenantId !== tenantId || !keys.has(p.createdBy.toLowerCase())) continue;
    await purchases.put({
      ...p,
      createdBy: 'erased',
      intentMandate: { ...p.intentMandate, intent: '[erased]' },
      updatedAt: nowIso(),
    });
  }
}
registerSubjectEraser(eraseSubjectUcpPurchases);

export async function listPurchases(tenantId: string, orgId: string): Promise<UcpPurchase[]> {
  return (await purchases.listForTenantIndexed(tenantId)).filter((p) => p.orgId === orgId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function getPurchase(tenantId: string, orgId: string, purchaseId: string): Promise<UcpPurchase | null> {
  const p = await purchases.get(purchaseId);
  return p && p.tenantId === tenantId && p.orgId === orgId ? p : null;
}

/** Max bytes we read from an untrusted merchant response (grade-code I9 — a hostile
 *  merchant must not be able to OOM the host with a giant body). */
const MERCHANT_MAX_BYTES = 512 * 1024;

/** Egress-gated JSON fetch to an external merchant (SSRF baseline + tenant egress
 *  rules — RFC 0079 posture; uncredentialed floor). Redirects are NOT followed and
 *  are re-checked against the egress policy per hop (grade-code B10 — a merchant
 *  302 to 169.254.169.254/loopback would otherwise bypass the SSRF baseline); the
 *  body is size-bounded (grade-code I9). */
async function merchantFetch(tenantId: string, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  // ADR 0533 — a merchant call is a PURCHASE path (`checkoutPurchase`). Of every
  // seam in this codebase this is the one where re-firing on a replay costs the
  // operator real money, so it fails closed before the first hop.
  assertEffectAllowed('payment', 'ucp merchant call');
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    await assertEgressAllowed(tenantId, current); // re-gate EVERY hop, including redirects
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), fetchTimeoutMs());
    let res: Response;
    try {
      res = await fetch(current, { ...init, signal: ctl.signal, redirect: 'manual' });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof OpenwopError) throw err;
      throw new OpenwopError('validation_error', 'The merchant could not be reached.', 502, { url: (() => { try { return new URL(current).origin; } catch { return ''; } })() });
    }
    try {
      // A redirect (0 status under 'manual' in some runtimes, or 3xx) → resolve the
      // Location relative to the current URL and loop so the next hop is egress-gated.
      if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
        const loc = res.headers.get('location');
        if (!loc) throw new OpenwopError('validation_error', 'The merchant returned an unusable redirect.', 502, {});
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) throw new OpenwopError('validation_error', `Merchant returned ${res.status}.`, 502, { url: new URL(current).origin, status: res.status });
      const text = await readBounded(res, MERCHANT_MAX_BYTES);
      try { return JSON.parse(text) as Record<string, unknown>; }
      catch { throw new OpenwopError('validation_error', 'The merchant returned an invalid response.', 502, { url: new URL(current).origin }); }
    } finally { clearTimeout(timer); }
  }
  throw new OpenwopError('validation_error', 'Too many merchant redirects.', 502, {});
}

/** Read at most `max` bytes of a response body, aborting if the merchant exceeds it. */
async function readBounded(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, max);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > max) { await reader.cancel().catch(() => undefined); throw new OpenwopError('validation_error', 'The merchant response is too large.', 502, {}); }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((u) => Buffer.from(u))).toString('utf8');
}

function normalizeMerchantUrl(raw: unknown): string {
  const url = cleanString(raw, 500);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new OpenwopError('validation_error', 'A valid merchant URL is required.', 400, { field: 'merchantUrl' }); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new OpenwopError('validation_error', 'The merchant URL must be http(s).', 400, { field: 'merchantUrl' });
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

// ── ADR 0258 — transport abstraction (REST base URL OR a reach:'mcp' connection) ─────
export type MerchantRef = { kind: 'url'; url: string } | { kind: 'mcp'; serverId: string };
/** The four UCP operations the buyer performs against a merchant. Over MCP each maps to a
 *  `ucp.<op>` tool (a host-assumed convention — no public UCP-over-MCP standard yet; the REST
 *  path is the interoperable floor). */
export type MerchantOp = 'discover' | 'search' | 'checkout' | 'order-status';

/** A merchant-call failure that carries whether the outcome is AMBIGUOUS (a transport
 *  timeout/unreachable — the merchant MAY have acted) vs definitive (it responded without
 *  acting). checkout uses this to choose `unknown` (block re-checkout) vs `failed`. */
class MerchantCallError extends OpenwopError {
  constructor(message: string, readonly ambiguous: boolean, status = 502, details: Record<string, unknown> = {}) {
    super('validation_error', message, status, details);
  }
}

/** Validate the caller-supplied merchant addressing — EXACTLY ONE of merchantUrl / merchantServerId. */
export function normalizeMerchantRef(body: { merchantUrl?: unknown; merchantServerId?: unknown }): MerchantRef {
  const serverId = cleanString(body.merchantServerId, 200);
  const hasUrl = body.merchantUrl !== undefined && body.merchantUrl !== null && cleanString(body.merchantUrl, 500) !== '';
  if (serverId && hasUrl) throw new OpenwopError('validation_error', 'Provide EITHER merchantUrl OR merchantServerId, not both.', 400, {});
  if (serverId) return { kind: 'mcp', serverId };
  return { kind: 'url', url: normalizeMerchantUrl(body.merchantUrl) };
}
/** The merchant ref recorded on a purchase (back-compat: pre-0258 rows have merchantUrl only). */
function merchantRefOf(p: UcpPurchase): MerchantRef {
  if (p.merchantServerId) return { kind: 'mcp', serverId: p.merchantServerId };
  return { kind: 'url', url: p.merchantUrl ?? '' };
}
/** A human label for approval proposals / notifications (no PII). For REST it's the network
 *  ORIGIN (the real payee, self-verifying). For MCP the serverId is a local alias, so we
 *  resolve the connection manifest to show the declared display-name + endpoint HOST too —
 *  so the money-approver can see WHO they're paying, at parity with REST (ux-review). */
function merchantLabel(ref: MerchantRef): string {
  if (ref.kind === 'url') { try { return new URL(ref.url).origin; } catch { return ref.url; } }
  const m = getProvider(ref.serverId);
  let host = '';
  try { if (m?.reach === 'mcp' && m.mcpServer?.url) host = new URL(m.mcpServer.url).host; } catch { /* keep host empty */ }
  const name = m?.label && m.label !== ref.serverId ? m.label : '';
  const detail = [name, host].filter(Boolean).join(' · ');
  return detail ? `MCP:${ref.serverId} (${detail})` : `MCP:${ref.serverId}`;
}

/** The credential-resolving acting user for a merchant call, or undefined. The buyer's
 *  `actor` field doubles as an audit label and carries the synthetic sentinels 'agent'/'system'
 *  for autonomous (node-surface) checkout — those are NOT real users, so they must NOT be
 *  forwarded as `actingUserId` (that would ask mcpClient to resolve a user/org credential for a
 *  non-user). An autonomous caller resolves a WORKSPACE-scoped connection instead (ADR 0258 §Identity;
 *  the D2 confused-deputy gate). Only a real signed-in userId flows through. */
function actingUserOf(actor: string | undefined): string | undefined {
  return actor && actor !== 'agent' && actor !== 'system' ? actor : undefined;
}

/** ADR 0258 — one merchant call, transport-dispatched. REST hits the op's UCP endpoint via
 *  the egress-gated `merchantFetch`; MCP invokes the `ucp.<op>` tool via the RUNLESS
 *  `host/mcpClient` (governance allowlist + BYOK credential + audited egress are enforced by
 *  the client). Returns the merchant's structured result; throws `MerchantCallError` with the
 *  ambiguous flag on failure. `params` carries the op body (search q, checkout mandate, …). */
async function merchantCall(
  tenantId: string, ref: MerchantRef, op: MerchantOp,
  ctx: { actingUserId?: string; orgId?: string; params?: Record<string, unknown>; idempotencyKey?: string },
): Promise<Record<string, unknown>> {
  if (ref.kind === 'mcp') {
    const client = makeMcpClient({ storage: hostExtStorage(), tenantId, ...(ctx.actingUserId ? { actingUserId: ctx.actingUserId } : {}), ...(ctx.orgId ? { orgId: ctx.orgId } : {}) }); // runId omitted ⇒ runless (no stamp)
    let out: { result: unknown; isError: boolean };
    try {
      out = await client.invokeTool(ref.serverId, `ucp.${op}`, ctx.params ?? {}, { timeoutMs: fetchTimeoutMs() });
    } catch (err) {
      const code = err instanceof McpError ? err.code : '';
      // FAIL-SAFE for money: default a failure to AMBIGUOUS (the merchant MAY have acted) ⇒
      // 'unknown' ⇒ blocks a blind re-checkout. It is DEFINITIVE (not placed ⇒ 'failed' is
      // safe) ONLY for a pre-flight gate error (the request never egressed) or a JSON-RPC
      // error (the server responded without acting). A post-send read failure (bad/oversized
      // response) stays ambiguous — the merchant may have placed before the body went wrong.
      const definitelyNotPlaced = code === 'mcp_error' || ['server_not_found', 'insecure_mcp_endpoint', 'connector_not_allowed', 'mcp_not_connected'].includes(code);
      throw new MerchantCallError(err instanceof Error ? err.message : 'MCP call failed', !definitelyNotPlaced, 502, { serverId: ref.serverId, op });
    }
    if (out.isError) throw new MerchantCallError('The merchant tool returned an error.', false, 502, { serverId: ref.serverId, op }); // responded, didn't act ⇒ definitive
    return (out.result && typeof out.result === 'object' && !Array.isArray(out.result)) ? out.result as Record<string, unknown> : { result: out.result };
  }
  // REST — the pre-0258 paths, unchanged. `merchantFetch` throws OpenwopError; "could not be
  // reached" is the ambiguous (timeout/unreachable) case, a definite HTTP status is not.
  const paths: Record<MerchantOp, string> = { discover: '/.well-known/ucp', search: `/catalog${ctx.params?.q ? `?q=${encodeURIComponent(String(ctx.params.q))}` : ''}`, checkout: '/checkout', 'order-status': `/orders/${encodeURIComponent(String(ctx.params?.orderId ?? ''))}` };
  const url = `${ref.url}${paths[op]}`;
  try {
    return op === 'checkout'
      ? await merchantFetch(tenantId, url, { method: 'POST', headers: { 'content-type': 'application/json', ...(ctx.idempotencyKey ? { 'idempotency-key': ctx.idempotencyKey } : {}) }, body: JSON.stringify(ctx.params ?? {}) })
      : await merchantFetch(tenantId, url);
  } catch (err) {
    // Same fail-safe as MCP: DEFINITIVE (not placed) ONLY when the merchant returned a clean
    // HTTP status (it responded without placing — `merchantFetch` stamps `details.status` on
    // exactly that path); every other REST failure — unreachable, oversized/invalid body, bad
    // redirect — carries no status and is AMBIGUOUS ⇒ 'unknown'. Keyed on the STRUCTURED status,
    // not the prose message, so a money decision can't silently flip on a wording change.
    const ambiguous = !(err instanceof OpenwopError && typeof err.details?.status === 'number');
    throw new MerchantCallError(err instanceof OpenwopError ? err.message : 'The merchant could not be reached.', ambiguous, 502, {});
  }
}

/** Phase 1 — fetch the merchant's UCP discovery document (REST or MCP). */
export async function discoverMerchant(tenantId: string, body: { merchantUrl?: unknown; merchantServerId?: unknown }, ctx: { actingUserId?: string; orgId?: string } = {}): Promise<Record<string, unknown>> {
  return merchantCall(tenantId, normalizeMerchantRef(body), 'discover', ctx);
}

/** Phase 1 — search the merchant catalog (read-only; REST or MCP). */
export async function searchMerchantCatalog(tenantId: string, body: { merchantUrl?: unknown; merchantServerId?: unknown; q?: string }, ctx: { actingUserId?: string; orgId?: string } = {}): Promise<Record<string, unknown>> {
  return merchantCall(tenantId, normalizeMerchantRef(body), 'search', { ...ctx, ...(body.q?.trim() ? { params: { q: body.q.trim() } } : {}) });
}

/** Phase 2 — build a cart (Intent → Cart mandates) and persist a DRAFT purchase.
 *  No money moves here; the mandates pin what the human authorized. */
export async function buildPurchaseDraft(input: {
  tenantId: string; orgId: string; createdBy: string;
  merchantUrl?: unknown;
  merchantServerId?: unknown;
  intent: unknown;
  maxAmountMinor: unknown;
  currency?: unknown;
  lines: { externalProductId?: unknown; name?: unknown; quantity?: unknown; unitPriceMinor?: unknown }[];
}): Promise<UcpPurchase> {
  if ((await listPurchases(input.tenantId, input.orgId)).length >= MAX.purchasesPerOrg) {
    throw new OpenwopError('validation_error', `This org has the maximum ${MAX.purchasesPerOrg} purchases.`, 409, {});
  }
  const ref = normalizeMerchantRef(input); // ADR 0258 — REST url OR mcp serverId
  const intent = cleanString(input.intent, MAX.intent);
  if (!intent) throw new OpenwopError('validation_error', 'The human `intent` authorization text is required.', 400, { field: 'intent' });
  const maxAmountMinor = typeof input.maxAmountMinor === 'number' && Number.isFinite(input.maxAmountMinor) && input.maxAmountMinor > 0 ? Math.trunc(input.maxAmountMinor) : 0;
  if (maxAmountMinor <= 0) throw new OpenwopError('validation_error', '`maxAmountMinor` (the authorized ceiling) must be a positive integer.', 400, { field: 'maxAmountMinor' });
  // R2 UCP-P2-M3 — VALIDATE the currency. `cleanString` only trims and bounds, so an
  // agent passing "EURO" or "dollars" persisted a draft whose currency then threw a
  // RangeError inside `Intl.NumberFormat` on every render — taking out the whole
  // /commerce/purchases route via its ErrorBoundary, for EVERY purchase in the org, on
  // a read-only surface with no way to edit or delete the offending row. The seller
  // lane already validates against this same list.
  const currency = cleanString(input.currency, 8, 'USD').toUpperCase();
  if (!(CURRENCIES as readonly string[]).includes(currency)) {
    throw new OpenwopError('validation_error', `Unsupported currency '${currency}'. Supported: ${CURRENCIES.join(', ')}.`, 400, { field: 'currency', supported: CURRENCIES });
  }
  const lines: Ap2CartLine[] = (input.lines ?? []).slice(0, MAX.lines).map((l) => ({
    externalProductId: cleanString(l.externalProductId, 120),
    name: cleanString(l.name, 200),
    quantity: typeof l.quantity === 'number' && Number.isFinite(l.quantity) && l.quantity > 0 ? Math.trunc(l.quantity) : 0,
    unitPriceMinor: typeof l.unitPriceMinor === 'number' && Number.isFinite(l.unitPriceMinor) && l.unitPriceMinor >= 0 ? Math.trunc(l.unitPriceMinor) : 0,
  })).filter((l) => l.externalProductId && l.quantity > 0);
  if (lines.length === 0) throw new OpenwopError('validation_error', 'At least one cart line is required.', 400, {});
  let mandates: { intent: Ap2IntentMandate; cart: Ap2CartMandate };
  try {
    // The AP2 mandate's merchant field carries a stable identifier for either transport.
    mandates = buildCartMandate({ intent, maxAmountMinor, merchantUrl: merchantLabel(ref), lines, currency });
  } catch (err) {
    throw new OpenwopError('validation_error', err instanceof Error ? err.message : 'Cart mandate construction failed.', 409, { code: 'intent_ceiling_exceeded' });
  }
  const ts = nowIso();
  const p: UcpPurchase = {
    purchaseId: `ucpb:${randomUUID()}`, tenantId: input.tenantId, orgId: input.orgId,
    ...(ref.kind === 'url' ? { merchantUrl: ref.url } : { merchantServerId: ref.serverId }),
    intentMandate: mandates.intent, cartMandate: mandates.cart,
    status: 'draft', createdBy: input.createdBy, createdAt: ts, updatedAt: ts,
  };
  await purchases.put(p);
  recordCommerceAction('ucp-buyer.draft-created', p, input.createdBy, { purchaseId: p.purchaseId, merchant: merchantLabel(ref), totalMinor: mandates.cart.totalMinor, currency });
  return p;
}

/**
 * R2 UCP-P2-B1 — MAJOR-unit money for a HUMAN to read, exponent-correct.
 *
 * The exponent comes from `Intl` itself (JPY 0, USD 2, KWD 3) — matching the
 * frontend's `formatCurrencyMinor`, so the sentence a human approves and the figure
 * the same row shows cannot disagree. An earlier version of this docblock claimed
 * `fromStripeMinorUnits` "applies the same zero-decimal table" including KWD: it has
 * a zero-decimal set and NO three-decimal one, so KWD came out 10× high — the B1
 * defect class, re-introduced inside the B1 fix (review M-3).
 *
 * Falls back to `<minor> <CCY> (minor units)` rather than throwing: an unrecognized
 * currency must not take down the approval that governs the spend.
 */
export function formatMinor(minor: number, currency: string): string {
  try {
    const fmt = new Intl.NumberFormat('en', { style: 'currency', currency });
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    return fmt.format(minor / 10 ** digits);
  } catch {
    return `${minor} ${currency} (minor units)`;
  }
}

/** Phase 3 — checkout: the HIGHEST-RISK action in the app (autonomous real-money
 *  movement). Fail-closed: per-org cap (unset ⇒ zero ⇒ deny) AND an APPROVED
 *  commerce-spend sign-off (always — no free threshold). Idempotent: a placed
 *  purchase never re-posts; the approval is keyed to the purchase. */
export async function checkoutPurchase(tenantId: string, orgId: string, purchaseId: string, opts: { actor?: string } = {}): Promise<UcpPurchase> {
  const p = await getPurchase(tenantId, orgId, purchaseId);
  if (!p) throw new OpenwopError('not_found', 'Purchase not found.', 404, { purchaseId });
  if (p.status === 'placed') return p; // idempotent — never double-place
  if (p.status === 'placing') throw new OpenwopError('validation_error', 'This purchase is being placed — retry in a moment.', 409, { status: 'placing' });
  if (p.status === 'unknown') throw new OpenwopError('validation_error', 'This purchase\'s outcome could not be confirmed (the merchant was unreachable mid-checkout and may have placed the order). VERIFY it directly with the merchant before retrying — a blind retry could double-buy.', 409, { status: 'unknown' });
  if (p.status !== 'draft' && p.status !== 'awaiting_approval' && p.status !== 'failed') {
    throw new OpenwopError('validation_error', `Purchase is '${p.status}'.`, 409, { status: p.status });
  }
  const ref = merchantRefOf(p);
  // grade-code I9: REST real-money movement must not go over plaintext http (except the
  // dev/test loopback flag the egress baseline already gates on). MCP transport enforces
  // https inside mcpClient (`insecure_mcp_endpoint`), so it needs no check here.
  if (ref.kind === 'url' && ref.url.startsWith('http://') && process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE !== 'true') {
    throw new OpenwopError('validation_error', 'A payment merchant must be reached over https.', 400, { code: 'insecure_merchant' });
  }
  // Gate 1 — the fail-closed org cap (a fast pre-check; the AUTHORITATIVE check is
  // re-run after the placing-CAS below, grade-code B8).
  //
  // R2 UCP-P2-M2 — the cap is DENOMINATED (see `orgSpendCapCurrency`): spend is
  // compared only against spend in the same currency, and a purchase in any other
  // currency is refused outright rather than measured against a number that does not
  // describe it. The pre-R2 code summed raw minor units across currencies under a
  // comment claiming that erred safe; it does not.
  //
  // R2 UCP-P2-M1 — 'unknown' now counts as committed. It was excluded, while this
  // same function refuses to RETRY an unknown purchase 20 lines above precisely
  // because "the merchant may have placed the order": ten timed-out $500 checkouts
  // read as $0 committed and the org could immediately spend its whole cap again.
  // A possibly-committed spend is committed for cap purposes; releasing it is what
  // reconciliation is for.
  const cap = orgSpendCapMinor();
  const capCurrency = orgSpendCapCurrency();
  if (cap > 0 && p.cartMandate.currency !== capCurrency) {
    // The remedy is an OPERATOR action, so the env var belongs in `details` (which the
    // logs and the operator docs carry), not in the sentence a buyer reads (review M-8).
    throw new OpenwopError('forbidden', `Agent purchasing is authorized in ${capCurrency}, and this purchase is in ${p.cartMandate.currency}. An administrator must authorize this currency before it can be bought — a cap in one currency cannot bound spend in another.`, 403, { code: 'spend_cap_currency', capCurrency, purchaseCurrency: p.cartMandate.currency, operatorSetting: 'OPENWOP_UCP_BUYER_ORG_CAP_CURRENCY' });
  }
  const COMMITTED: readonly UcpPurchaseStatus[] = ['placed', 'placing', 'unknown'];
  // Sum OTHER purchases' committed spend IN THIS PURCHASE'S CURRENCY, excluding THIS
  // one so the post-CAS re-check (where this row is itself 'placing') doesn't
  // double-count it.
  const spentOf = async (): Promise<number> =>
    (await listPurchases(tenantId, orgId))
      .filter((x) => x.purchaseId !== purchaseId
        && COMMITTED.includes(x.status)
        && x.cartMandate.currency === p.cartMandate.currency)
      .reduce((s, x) => s + x.cartMandate.totalMinor, 0);
  const overCap = (spent: number): boolean => cap <= 0 || spent + p.cartMandate.totalMinor > cap;
  if (overCap(await spentOf())) {
    throw new OpenwopError('forbidden', cap <= 0
      ? 'Agent purchasing is not enabled — set OPENWOP_UCP_BUYER_ORG_CAP_MINOR to authorize a spend cap.'
      : 'This purchase would exceed the org spend cap.', 403, { code: 'spend_cap', capMinor: cap });
  }
  // Gate 2 — the ALWAYS human sign-off on the ONE queue (resumed by key).
  const gateKey = `ucp-buy:${purchaseId}`;
  const priorApprovalId = p.approvalId;
  if (priorApprovalId) {
    const appr = await getApproval(priorApprovalId);
    if (!appr || appr.tenantId !== tenantId) throw new OpenwopError('internal_error', 'Approval record missing.', 500, {});
    if (appr.status === 'rejected') throw new OpenwopError('approval_required', 'This purchase was rejected by an approver.', 409, { approvalStatus: 'rejected' });
    if (appr.status !== 'approved') throw new OpenwopError('approval_required', 'A sign-off for this purchase is pending in the reviews inbox.', 409, { approvalStatus: 'pending' });
  } else {
    const appr = await createCommerceSpendApproval({
      tenantId, orgId, spendKind: 'order',
      amountMinor: p.cartMandate.totalMinor, amountCurrency: p.cartMandate.currency,
      spendIdemKey: gateKey,
      // R2 UCP-P2-B1 — this hardcoded `/100`, so a ¥1,234,500 purchase read as
      // "12345.00 JPY" (~1/100 of the truth) on the ONE screen where a human
      // authorizes the spend. The rule was already known and written down 60 lines
      // below — on the low-stakes *notification* — and skipped here.
      proposal: `Agent purchase from ${merchantLabel(ref)} — ${formatMinor(p.cartMandate.totalMinor, p.cartMandate.currency)} (${p.cartMandate.lines.length} line${p.cartMandate.lines.length === 1 ? '' : 's'})`,
    });
    await purchases.put({ ...p, status: 'awaiting_approval', approvalId: appr.approvalId, updatedAt: nowIso() });
    recordCommerceAction('ucp-buyer.approval-required', p, opts.actor ?? 'system', { purchaseId, approvalId: appr.approvalId, totalMinor: p.cartMandate.totalMinor });
    throw new OpenwopError('approval_required', 'This purchase needs a human sign-off — it is waiting in the reviews inbox.', 409, { approvalStatus: 'pending' });
  }
  // Approved — CAS into 'placing' FIRST (cross-instance): two concurrent
  // checkouts of one approved purchase must never double-buy — the loser sees
  // the transition (or the placed result) and stops.
  const raw = await purchases.get(purchaseId);
  if (!raw || raw.tenantId !== tenantId) throw new OpenwopError('not_found', 'Purchase not found.', 404, { purchaseId });
  if (raw.status === 'placed') return raw; // raced with a completed placement
  if (raw.status === 'placing' || !(await purchases.compareAndSwap(raw, { ...raw, status: 'placing', updatedAt: nowIso() }))) {
    throw new OpenwopError('validation_error', 'This purchase is being placed — retry in a moment.', 409, { status: 'placing' });
  }
  // grade-code B8: AUTHORITATIVE cap check — re-count now that we hold the 'placing'
  // claim (which itself counts toward `spent`), so two concurrent DIFFERENT purchases
  // can't both slip under a stale total. Over cap ⇒ release the claim (we're the sole
  // writer while it's 'placing') and refuse.
  if (overCap(await spentOf())) {
    await purchases.put({ ...raw, updatedAt: nowIso() }); // revert placing → the prior status
    throw new OpenwopError('forbidden', 'This purchase would exceed the org spend cap.', 403, { code: 'spend_cap', capMinor: cap });
  }
  // Author the PaymentMandate and place. The merchant POST carries the purchaseId +
  // mandate as an idempotency key (grade-code B9) so a retried/ambiguous request the
  // merchant can dedupe.
  // DEF-2 — sign the mandate as a verifiable credential when AP2 signing is configured;
  // otherwise it carries the honest unsigned warning (signPaymentMandate is a no-op).
  const payment: Ap2PaymentMandate = signPaymentMandate(buildPaymentMandate(p.cartMandate, priorApprovalId));
  const idempotencyKey = `ucp-buy:${purchaseId}`;
  let ext: Record<string, unknown>;
  try {
    // ADR 0258 — transport-dispatched checkout (REST POST /checkout or the ucp.checkout MCP
    // tool). The idempotency key rides the body AND (REST) the header so a retried/ambiguous
    // request the merchant can dedupe.
    const actingUserId = actingUserOf(opts.actor);
    ext = await merchantCall(tenantId, ref, 'checkout', {
      ...(actingUserId ? { actingUserId } : {}), orgId,
      idempotencyKey,
      params: {
        idempotencyKey,
        lines: p.cartMandate.lines.map((l) => ({ productId: l.externalProductId, quantity: l.quantity })),
        // R2 UCP-P2-B2 — tell the merchant what the human AUTHORIZED, so a merchant that
        // checks can refuse a divergence at its own boundary (the escalation every
        // payment rail in this field defines) instead of silently billing a new price.
        authorizedTotalMinor: p.cartMandate.totalMinor,
        currency: p.cartMandate.currency,
        ap2_mandate: payment,
      },
    });
  } catch (err) {
    // grade-code B9 / ADR 0258: DEFAULT-AMBIGUOUS. A failure is 'unknown' (the merchant MAY
    // have placed ⇒ block a blind re-checkout that could double-buy) UNLESS it is provably
    // DEFINITIVE (merchant did not place ⇒ 'failed' is safe to retry): a clean HTTP status, an
    // MCP pre-flight gate error, or an MCP tool/JSON-RPC error. `merchantCall` normalizes both
    // transports into `MerchantCallError.ambiguous`; an unexpected non-MerchantCallError here
    // fails SAFE to ambiguous. The 'unknown' state must be reconciled with the merchant
    // out-of-band before any retry.
    const ambiguous = err instanceof MerchantCallError ? err.ambiguous : true;
    const nextStatus: UcpPurchaseStatus = ambiguous ? 'unknown' : 'failed';
    const current = (await purchases.get(purchaseId)) ?? raw;
    await purchases.put({ ...current, status: nextStatus, paymentMandate: payment, updatedAt: nowIso() });
    recordCommerceAction(nextStatus === 'unknown' ? 'ucp-buyer.place-unknown' : 'ucp-buyer.place-failed', current, opts.actor ?? 'system', { purchaseId, error: err instanceof OpenwopError ? err.message : 'merchant_unreachable' });
    throw err;
  }
  // R2 UCP-P2-B3 — read the merchant's order id in BOTH spellings. `orderId` alone
  // missed this host's own UCP REST projection (`toUcpOrder` emits `id`), and the
  // only REST test mocks `{orderId}` — shaped to the extractor, so the lane had
  // never met a merchant it did not author.
  const extObj = ext as { orderId?: unknown; id?: unknown; status?: unknown; order?: { orderId?: unknown; id?: unknown; status?: unknown } };
  const extOrderId = cleanString(extObj.orderId ?? extObj.id ?? extObj.order?.orderId ?? extObj.order?.id, 200);
  // …and an id we could not read means we do NOT know this order was placed. It used
  // to persist `placed` regardless, which then made `trackPurchase` return early
  // forever (it requires `extOrderId`) while the chat tool reported a successful
  // re-check. 'unknown' is the honest state: the money may have moved and only the
  // merchant can say.
  if (!extOrderId) {
    const current = (await purchases.get(purchaseId)) ?? raw;
    await purchases.put({ ...current, status: 'unknown', paymentMandate: payment, updatedAt: nowIso() });
    recordCommerceAction('ucp-buyer.place-unknown', current, opts.actor ?? 'system', { purchaseId, error: 'merchant_response_without_order_id' });
    throw new OpenwopError('internal_error', 'The merchant accepted the checkout but returned no order id, so we cannot confirm the purchase or track it. VERIFY it directly with the merchant — a blind retry could double-buy.', 502, { status: 'unknown', code: 'no_order_id' });
  }
  // Take the merchant's OWN status rather than asserting 'pending' over it (the old
  // code fabricated a status the merchant may have contradicted in the same response).
  const extStatus = cleanString(extObj.status ?? extObj.order?.status, 60) || 'pending';
  // R2 UCP-P2-B2 — reconcile what the merchant says it charged against the mandate.
  const confirmed = readConfirmedTotal(ext, p.cartMandate.currency);
  if (confirmed && (confirmed.totalMinor !== p.cartMandate.totalMinor || confirmed.currency !== p.cartMandate.currency)) {
    // A DIVERGENCE is not a failure to retry and not a success to record: the order may
    // exist at a price nobody authorized. Park it as 'unknown' (the state whose whole
    // meaning is "verify with the merchant"), keeping BOTH figures so the screen can
    // show what was authorized beside what was charged.
    const current = (await purchases.get(purchaseId)) ?? raw;
    await purchases.put({ ...current, status: 'unknown', paymentMandate: payment, extOrderId, extStatus, confirmedTotalMinor: confirmed.totalMinor, confirmedCurrency: confirmed.currency, updatedAt: nowIso() });
    recordCommerceAction('ucp-buyer.place-diverged', current, opts.actor ?? 'system', { purchaseId, extOrderId, authorizedMinor: p.cartMandate.totalMinor, authorizedCurrency: p.cartMandate.currency, confirmedMinor: confirmed.totalMinor, confirmedCurrency: confirmed.currency });
    throw new OpenwopError('validation_error', `The merchant confirmed ${formatMinor(confirmed.totalMinor, confirmed.currency)} but the approved authorization was ${formatMinor(p.cartMandate.totalMinor, p.cartMandate.currency)}. The order may exist at a price nobody approved — verify it with the merchant.`, 409, { status: 'unknown', code: 'amount_diverged' });
  }
  const placed: UcpPurchase = {
    ...raw, status: 'placed', paymentMandate: payment, extOrderId, extStatus,
    ...(confirmed ? { confirmedTotalMinor: confirmed.totalMinor, confirmedCurrency: confirmed.currency, reconciliation: 'matched' as const } : { reconciliation: 'unavailable' as const }),
    updatedAt: nowIso(),
  };
  await purchases.put(placed);
  recordCommerceAction('ucp-buyer.placed', placed, opts.actor ?? 'system', { purchaseId, extOrderId, totalMinor: p.cartMandate.totalMinor, currency: p.cartMandate.currency });
  try {
    await getNotificationEmitter().emit({
      tenantId, type: 'commerce.ucp-buyer.placed', priority: 'low',
      // No amount in the string — /100 mis-renders JPY (0dp) / BHD (3dp); the
      // detail page formats it correctly (formatCurrencyMinor). Merchant is enough context.
      title: 'Agent purchase placed', message: `Purchase ${purchaseId} placed with ${merchantLabel(ref)}.`,
      // Deep-link spine (ADR 0336): land on the specific purchase.
      actionUrl: `/commerce/purchases/${encodeURIComponent(purchaseId)}?org=${encodeURIComponent(placed.orgId)}`,
    });
  } catch (err) { log.warn('ucp-buyer placed notification emit failed', { purchaseId, error: err instanceof Error ? err.message : String(err) }); }
  return placed;
}

/** R2 UCP-P2-B2 — the merchant's confirmed total, in whichever shape it answers with
 *  (top level or nested under `order`, minor units or a UCP `totals.total` money object).
 *  Returns null when the merchant states no total — which is a REPORTABLE outcome, not a
 *  reason to assume our own figure was confirmed. */
function readConfirmedTotal(ext: unknown, fallbackCurrency: string): { totalMinor: number; currency: string } | null {
  const o = (ext ?? {}) as Record<string, unknown>;
  const order = (o.order ?? {}) as Record<string, unknown>;
  const totals = ((o.totals ?? order.totals) ?? {}) as { total?: { amount?: unknown; currency?: unknown } };
  const minorRaw = o.totalMinor ?? order.totalMinor;
  // Fall back to the currency WE authorized and sent in the request (review M-1): a
  // merchant that returned a total but omitted the currency was previously recorded as
  // "returned no total", and the page then stated that falsehood — the cheapest way to
  // defeat reconciliation was to omit three letters, not the amount.
  const currency = cleanString(o.currency ?? order.currency ?? totals.total?.currency, 8).toUpperCase() || fallbackCurrency;
  if (typeof minorRaw === 'number' && Number.isInteger(minorRaw) && minorRaw >= 0 && currency) {
    return { totalMinor: minorRaw, currency };
  }
  // A UCP `totals.total` is MAJOR units — convert with the same exponent table the
  // charge uses rather than a hardcoded ×100.
  const major = totals.total?.amount;
  if (typeof major === 'number' && Number.isFinite(major) && major >= 0 && currency) {
    return { totalMinor: toStripeMinorUnits(major, currency), currency };
  }
  return null;
}

/** Phase 3 — track the external order's status (read-only; notifies on change).
 *  R3 B-2 — `unknown` WITH an extOrderId is now trackable: a successful
 *  merchant answer PROMOTES it to 'placed' (the order demonstrably landed);
 *  a definitive merchant 404 resolves it to 'failed' (the order demonstrably
 *  did not — the cap releases); an ambiguous transport failure keeps
 *  'unknown'. An `unknown` WITHOUT an extOrderId has nothing to query — only
 *  the explicit operator close (below) can resolve it. */
export async function trackPurchase(tenantId: string, orgId: string, purchaseId: string, ctx: { actingUserId?: string } = {}): Promise<UcpPurchase> {
  const p = await getPurchase(tenantId, orgId, purchaseId);
  if (!p) throw new OpenwopError('not_found', 'Purchase not found.', 404, { purchaseId });
  if (!(p.status === 'placed' || p.status === 'unknown') || !p.extOrderId) return p;
  // ADR 0258 — order-status over the same transport the purchase was placed on.
  let ext: Record<string, unknown>;
  try {
    ext = await merchantCall(tenantId, merchantRefOf(p), 'order-status', { ...(ctx.actingUserId ? { actingUserId: ctx.actingUserId } : {}), orgId, params: { orderId: p.extOrderId } });
  } catch (err) {
    // A definitive not-found from the merchant resolves the ambiguity DOWN:
    // the order does not exist there, so the money never moved — 'failed'
    // releases the cap. Anything ambiguous keeps 'unknown' (never guess).
    if (p.status === 'unknown' && err instanceof OpenwopError && err.details?.status === 404) {
      const next: UcpPurchase = { ...p, status: 'failed', updatedAt: nowIso() };
      await purchases.put(next);
      return next;
    }
    throw err;
  }
  const extStatus = cleanString((ext as { status?: unknown }).status ?? (ext as { order?: { status?: unknown } }).order?.status, 60) || p.extStatus || 'pending';
  if (p.status === 'unknown') {
    // The merchant answered for this order id — it landed. Promote.
    const next: UcpPurchase = { ...p, status: 'placed', extStatus, updatedAt: nowIso() };
    await purchases.put(next);
    return next;
  }
  if (extStatus !== p.extStatus) {
    const next = { ...p, extStatus, updatedAt: nowIso() };
    await purchases.put(next);
    try {
      await getNotificationEmitter().emit({ tenantId, type: 'commerce.ucp-buyer.status', priority: 'low', title: 'Agent purchase update', message: `Purchase ${purchaseId} is now '${extStatus}'.`, actionUrl: `/commerce/purchases/${encodeURIComponent(purchaseId)}?org=${encodeURIComponent(orgId)}` });
    } catch (err) { log.warn('ucp-buyer status notification emit failed', { purchaseId, error: err instanceof Error ? err.message : String(err) }); }
    return next;
  }
  return p;
}

/** R3 B-2 — the explicit operator close for an `unknown` purchase. Without
 *  this, `unknown` permanently consumed the lifetime cap with NO release path
 *  (a gate with no exit). The operator asserts what they verified out-of-band:
 *  'not_placed' → 'failed' (cap releases); 'confirmed_placed' → 'placed' (cap
 *  stays consumed, tracking resumes if an extOrderId exists). Only valid FROM
 *  'unknown'; audited with the actor + reason. */
export async function closeUnknownPurchase(
  tenantId: string, orgId: string, purchaseId: string,
  input: { outcome: 'not_placed' | 'confirmed_placed'; reason: string; actingUserId?: string },
): Promise<UcpPurchase> {
  const p = await getPurchase(tenantId, orgId, purchaseId);
  if (!p) throw new OpenwopError('not_found', 'Purchase not found.', 404, { purchaseId });
  if (p.status !== 'unknown') {
    throw new OpenwopError('validation_error', `Only an 'unknown' purchase can be closed this way (this one is '${p.status}').`, 400, { purchaseId, status: p.status });
  }
  const reason = cleanString(input.reason, 500);
  if (!reason) throw new OpenwopError('validation_error', 'Field `reason` is required — state what you verified with the merchant.', 400, { field: 'reason' });
  const next: UcpPurchase = {
    ...p,
    status: input.outcome === 'not_placed' ? 'failed' : 'placed',
    updatedAt: nowIso(),
  };
  await purchases.put(next);
  await appendAudit(tenantId, 'commerce.ucp-buyer.unknown-closed', {
    purchaseId, outcome: input.outcome, reason,
    ...(input.actingUserId ? { actor: input.actingUserId } : {}),
    totalMinor: p.cartMandate.totalMinor, currency: p.cartMandate.currency,
  });
  return next;
}

export async function __resetUcpBuyer(): Promise<void> {
  await purchases.__clear();
}
