/**
 * Store Assistant chat tools (CFP-1 — CHAT-FIRST-PORT-AUDIT #1; ADR 0308 seam).
 *
 * The `feature.commerce.agents.store-assistant` pack allowlisted node typeIds that
 * NOTHING projected into the conversational tool loop, so the agent dispatched with
 * ZERO callable tools (a persona that could only talk). This registers the honest
 * subset as REAL agent tools through the one `registerFeatureAgentTool` seam, so the
 * `EmbeddedChatPanel` embed in CommercePage becomes functional with no new UI.
 *
 * SCOPE (deliberately conservative — money rules are absolute):
 *   - READS (fail EMPTY without an acting user): catalog / orders / coupons / quotes /
 *     price explanation. Ground the assistant's answers in REAL store state.
 *   - ONE draft-grade ACTION (fail TYPED): `create-quote` — drafts a quote in `draft`
 *     status; the human sends/accepts it on the governed QuotesTab path.
 * Everything money-moving or beyond draft-grade (create-order, fulfill, refund,
 * adjust-inventory, coupon issuance, quote SEND) is PRUNED from the pack allowlist,
 * not wrapped — those stay on the human-driven admin/approval surfaces.
 *
 * Authority parity: every tool resolves the SAME org RBAC the HTTP routes enforce
 * (`resolveEffectiveAccess` — workspace:read for reads, workspace:write for the
 * draft action — the featureRoute.requireOrgScope boundary) plus the `commerce`
 * toggle, per-tenant, inside `run()`.
 */
import { registerFeatureAgentTool, type BuiltinTool } from '../../host/agentToolProvider.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { listOrgs, resolveEffectiveAccess } from '../../host/accessControlService.js';
import type { Scope } from '../../host/accessControlService.js';
import { OpenwopError } from '../../types.js';
import { listProducts, getProduct, listOrders, getOrder, listCoupons } from './commerceService.js';
import { resolvePrice } from './pricing.js';
import { createQuote, getQuote, listQuotes, type QuoteLineInput } from './quotes.js';

const COMMERCE_TOGGLE = 'commerce';
const NS = 'openwop:feature.commerce.nodes.';

// The exact allowlist ids these tools back — kept identical to the pack's
// `toolAllowlist` so `agent-allowlist-resolution.test.ts` resolves each entry.
export const COMMERCE_LIST_PRODUCTS_TOOL_ID = `${NS}list-products`;
export const COMMERCE_GET_ORDER_TOOL_ID = `${NS}get-order`;
export const COMMERCE_LIST_ORDERS_TOOL_ID = `${NS}list-orders`;
export const COMMERCE_LIST_COUPONS_TOOL_ID = `${NS}list-coupons`;
export const COMMERCE_GET_QUOTE_TOOL_ID = `${NS}get-quote`;
export const COMMERCE_LIST_QUOTES_TOOL_ID = `${NS}list-quotes`;
export const COMMERCE_RESOLVE_PRICE_TOOL_ID = `${NS}resolve-price`;
export const COMMERCE_CREATE_QUOTE_TOOL_ID = `${NS}create-quote`;

/** Every id this feature registers — the pack allowlist must equal this set. */
export const COMMERCE_STORE_TOOL_IDS: readonly string[] = [
  COMMERCE_LIST_PRODUCTS_TOOL_ID,
  COMMERCE_GET_ORDER_TOOL_ID,
  COMMERCE_LIST_ORDERS_TOOL_ID,
  COMMERCE_LIST_COUPONS_TOOL_ID,
  COMMERCE_GET_QUOTE_TOOL_ID,
  COMMERCE_LIST_QUOTES_TOOL_ID,
  COMMERCE_RESOLVE_PRICE_TOOL_ID,
  COMMERCE_CREATE_QUOTE_TOOL_ID,
];

type ToolResult = { content: string; isError?: boolean };
const ok = (payload: unknown): ToolResult => ({ content: JSON.stringify(payload) });
const empty = (note: string): ToolResult => ({ content: JSON.stringify({ note }) });
const toolError = (error: string, message: string): ToolResult => ({ content: JSON.stringify({ error, message }), isError: true });
const isResult = (v: unknown): v is ToolResult => typeof (v as { content?: unknown }).content === 'string';

/** CFPT-5 — the default row cap for the unbounded list reads. Bounds the array a
 *  list tool hands the model so a large org can't blow its context window. */
const LIST_CAP = 50;

/** Slice a list payload's named array to at most `LIST_CAP` rows, stamping
 *  `truncated:true` when rows were dropped. The sibling `total` still reports the
 *  true count, so the model sees both the real size and a bounded sample. */
function capRows<T extends Record<string, unknown>>(payload: T, key: keyof T & string): T & { truncated?: boolean } {
  const rows = payload[key];
  if (!Array.isArray(rows) || rows.length <= LIST_CAP) return payload;
  return { ...payload, [key]: rows.slice(0, LIST_CAP), truncated: true };
}

async function commerceEnabled(tenantId: string, userId?: string): Promise<boolean> {
  const a = await resolveOne(COMMERCE_TOGGLE, { tenantId, ...(userId ? { userId } : {}) }).catch(() => null);
  return a?.enabled === true;
}

/** The model-facing projection the workflow surface uses — strips internal keys. */
const INTERNAL = new Set(['tenantId', 'createdBy']);
function project<T extends object>(o: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}

/**
 * Resolve the org + assert the caller holds `scope` on it — EXACT parity with
 * featureRoute.requireOrgScope (custom roles don't nest write⊃read, so each verb
 * checks its own scope). Returns the orgId, or a ToolResult to short-circuit
 * with. Assumes `scope.actingUserId` is already present.
 */
async function resolveOrg(scope: BundleScope, inputOrgId: unknown, required: Scope): Promise<{ orgId: string } | ToolResult> {
  const orgs = await listOrgs(scope.tenantId);
  const orgId = (typeof inputOrgId === 'string' && inputOrgId.trim()) || (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  if (!orgId) return toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\` (ask the user which).`);
  if (!orgs.some((o) => o.orgId === orgId)) return toolError('not_found', 'Organization not found in this workspace.');
  const access = await resolveEffectiveAccess(scope.tenantId, { subject: scope.actingUserId!, orgId });
  if (!access.scopes.includes(required)) return toolError('not_found', 'Organization not found in this workspace.');
  return { orgId };
}

/** A READ tool: fail EMPTY (a note, not an error) without a human principal or
 *  when the feature is off; typed only on org-resolution problems. */
function readTool(
  def: BuiltinTool['def'],
  run: (input: Record<string, unknown>, orgId: string, scope: BundleScope) => Promise<ToolResult>,
  // RFC 0137 §F1 — threaded as a PARAMETER, never hardcoded here. A factory that
  // fixes its own trust collapses N per-tool decisions into one and defeats the
  // compiler ratchet: every tool it mints would silently inherit one call.
  contentTrust: BuiltinTool['contentTrust'],
): BuiltinTool {
  return {
    contentTrust,
    def,
    async run(input, scope) {
      if (!scope.actingUserId) return empty('No acting user on this turn — commerce access is resolved per signed-in user.');
      if (!(await commerceEnabled(scope.tenantId, scope.actingUserId))) return empty('E-Commerce is not enabled for this workspace.');
      const org = await resolveOrg(scope, input.orgId, 'workspace:read');
      if (isResult(org)) return org;
      try {
        return await run(input, org.orgId, scope);
      } catch (err) {
        if (err instanceof OpenwopError) return toolError(err.code, err.message);
        throw err;
      }
    },
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function registerCommerceAgentTools(): void {
  // ── READS ──────────────────────────────────────────────────────────────────
  registerFeatureAgentTool(readTool(
    {
      name: COMMERCE_LIST_PRODUCTS_TOOL_ID,
      description:
        'List the store catalog (products with price, inventory, variants, type). Optional free-text `q` filters by name. '
        + 'Use it to reference REAL products/prices instead of inventing them. Returns at most 50 products (`truncated:true` '
        + 'when the catalog has more, though `total` is the true count — narrow with `q`). Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization id (omit when the workspace has exactly one).' },
          q: { type: 'string', description: 'Optional free-text name filter.' },
        },
        additionalProperties: false,
      },
    },
    async (input, orgId, scope) => {
      const products = (await listProducts(scope.tenantId, orgId, optStr(input.q))).map(project);
      return ok(capRows({ orgId, total: products.length, products }, 'products'));
    },
    'untrusted',   // customer-authored names, addresses, order notes
  ));

  registerFeatureAgentTool(readTool(
    {
      name: COMMERCE_GET_ORDER_TOOL_ID,
      description: 'Get one order by id (lines, totals, status, fulfillment, customer). Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization id (omit when the workspace has exactly one).' },
          orderId: { type: 'string', description: 'The order id to fetch.' },
        },
        required: ['orderId'],
        additionalProperties: false,
      },
    },
    async (input, orgId, scope) => {
      const order = await getOrder(scope.tenantId, orgId, str(input.orderId));
      if (!order) return toolError('not_found', 'Order not found.');
      return ok({ orgId, order: project(order) });
    },
    'untrusted',   // customer-authored names, addresses, order notes
  ));

  registerFeatureAgentTool(readTool(
    {
      name: COMMERCE_LIST_ORDERS_TOOL_ID,
      description: 'List the org\'s orders (id, status, fulfillment, total, customer). Returns at most 50 orders (`truncated:true` when more exist, though `total` is the true count). Read-only.',
      inputSchema: {
        type: 'object',
        properties: { orgId: { type: 'string', description: 'The organization id (omit when the workspace has exactly one).' } },
        additionalProperties: false,
      },
    },
    async (_input, orgId, scope) => {
      const orders = (await listOrders(scope.tenantId, orgId)).map(project);
      return ok(capRows({ orgId, total: orders.length, orders }, 'orders'));
    },
    'untrusted',   // customer-authored names, addresses, order notes
  ));

  registerFeatureAgentTool(readTool(
    {
      name: COMMERCE_LIST_COUPONS_TOOL_ID,
      description: 'List the org\'s discount coupons (code, type, value, usage). Returns at most 50 coupons (`truncated:true` when more exist, though `total` is the true count). Read-only — reference existing promotions, never invent codes.',
      inputSchema: {
        type: 'object',
        properties: { orgId: { type: 'string', description: 'The organization id (omit when the workspace has exactly one).' } },
        additionalProperties: false,
      },
    },
    async (_input, orgId, scope) => {
      const coupons = (await listCoupons(scope.tenantId, orgId)).map(project);
      return ok(capRows({ orgId, total: coupons.length, coupons }, 'coupons'));
    },
    'untrusted',   // customer-authored names, addresses, order notes
  ));

  registerFeatureAgentTool(readTool(
    {
      name: COMMERCE_LIST_QUOTES_TOOL_ID,
      description: 'List the org\'s quotes (id, status, total, customer). Returns at most 50 quotes (`truncated:true` when more exist, though `total` is the true count). Read-only.',
      inputSchema: {
        type: 'object',
        properties: { orgId: { type: 'string', description: 'The organization id (omit when the workspace has exactly one).' } },
        additionalProperties: false,
      },
    },
    async (_input, orgId, scope) => {
      const quotes = (await listQuotes(scope.tenantId, orgId)).map(project);
      return ok(capRows({ orgId, total: quotes.length, quotes }, 'quotes'));
    },
    'untrusted',   // customer-authored names, addresses, order notes
  ));

  registerFeatureAgentTool(readTool(
    {
      name: COMMERCE_GET_QUOTE_TOOL_ID,
      description: 'Get one quote by id (lines, totals, status). Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization id (omit when the workspace has exactly one).' },
          quoteId: { type: 'string', description: 'The quote id to fetch.' },
        },
        required: ['quoteId'],
        additionalProperties: false,
      },
    },
    async (input, orgId, scope) => {
      const quote = await getQuote(scope.tenantId, orgId, str(input.quoteId));
      if (!quote) return toolError('not_found', 'Quote not found.');
      return ok({ orgId, quote: project(quote) });
    },
    'untrusted',   // customer-authored names, addresses, order notes
  ));

  registerFeatureAgentTool(readTool(
    {
      name: COMMERCE_RESOLVE_PRICE_TOOL_ID,
      description:
        'Explain a product\'s effective price for a buyer — the winning price list and the resolved amount ("why this price"). '
        + 'Read-only; use it before quoting a discount so the number is grounded.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization id (omit when the workspace has exactly one).' },
          productId: { type: 'string', description: 'The product to price.' },
          variantId: { type: 'string', description: 'Optional variant id.' },
          contactId: { type: 'string', description: 'Optional CRM contact the price is for.' },
          companyId: { type: 'string', description: 'Optional CRM company the price is for.' },
        },
        required: ['productId'],
        additionalProperties: false,
      },
    },
    async (input, orgId, scope) => {
      const product = await getProduct(scope.tenantId, orgId, str(input.productId));
      if (!product) return toolError('not_found', 'Product not found.');
      const resolved = await resolvePrice(scope.tenantId, orgId, product, {
        ...(optStr(input.variantId) ? { variantId: str(input.variantId) } : {}),
        buyer: { ...(optStr(input.contactId) ? { contactId: str(input.contactId) } : {}), ...(optStr(input.companyId) ? { companyId: str(input.companyId) } : {}) },
      });
      return ok({ orgId, productId: product.productId, ...resolved });
    },
    'untrusted',   // customer-authored names, addresses, order notes
  ));

  // ── DRAFT-GRADE ACTION ───────────────────────────────────────────────────────
  // Drafts a quote in `draft` status through the owning service (no money moves,
  // no send). The human reviews/sends/accepts it on the governed QuotesTab path.
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: COMMERCE_CREATE_QUOTE_TOOL_ID,
      description:
        'Draft a quote (a DRAFT proposal — it moves no money and is not sent). Pass the product `lines` '
        + '({ productId, quantity, optional unitPrice override }) and an optional customer (`contactId`/`companyId`) and `note`. '
        + 'Confirm the items and totals with the human first. The human sends/accepts it from the Quotes page — you never send it.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization id (omit when the workspace has exactly one).' },
          lines: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                productId: { type: 'string' },
                quantity: { type: 'number' },
                unitPrice: { type: 'number', description: 'Optional per-line price override (major units).' },
              },
              required: ['productId', 'quantity'],
              additionalProperties: false,
            },
            description: 'The quote line items.',
          },
          contactId: { type: 'string', description: 'Optional CRM contact the quote is for.' },
          companyId: { type: 'string', description: 'Optional CRM company the quote is for.' },
          note: { type: 'string', description: 'Optional note shown on the quote.' },
        },
        required: ['lines'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return toolError('acting_user_required', 'Quotes can only be drafted from a human-initiated turn.');
      if (!(await commerceEnabled(scope.tenantId, scope.actingUserId))) return toolError('feature_disabled', 'E-Commerce is not enabled for this workspace.');
      const org = await resolveOrg(scope, input.orgId, 'workspace:write');
      if (isResult(org)) return org;
      const rawLines = Array.isArray(input.lines) ? input.lines : [];
      const lines: QuoteLineInput[] = rawLines
        .map((l) => l as { productId?: unknown; quantity?: unknown; unitPrice?: unknown })
        .map((l) => ({ productId: str(l.productId), quantity: Number(l.quantity), ...(typeof l.unitPrice === 'number' ? { unitPrice: l.unitPrice } : {}) }))
        .filter((l) => l.productId && Number.isFinite(l.quantity) && l.quantity > 0);
      if (!lines.length) return toolError('validation_error', 'Pass at least one line as { productId, quantity }.');
      try {
        const quote = await createQuote({
          tenantId: scope.tenantId,
          orgId: org.orgId,
          createdBy: scope.actingUserId,
          lines,
          ...(optStr(input.contactId) ? { contactId: str(input.contactId) } : {}),
          ...(optStr(input.companyId) ? { companyId: str(input.companyId) } : {}),
          ...(optStr(input.note) ? { note: str(input.note) } : {}),
        });
        return ok({
          quoteId: quote.quoteId,
          status: quote.status,
          quote: project(quote),
          note: 'Quote drafted (status: draft). Tell the user the total and that they can send it from the Quotes page — you cannot send it.',
        });
      } catch (err) {
        if (err instanceof OpenwopError) return toolError(err.code, err.message);
        throw err;
      }
    },
  });
}
