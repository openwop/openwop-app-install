/**
 * Data-integration adapter — `ctx.dataIntegration` (ADR 0783 phase 1), the
 * node-context surface `vendor.myndhyve.data-integration` calls.
 *
 * PHASE 1 serves the four methods that need no new concept:
 *   - `fetchMCP`        → `ctx.mcp.invokeTool` / `ctx.mcp.readResource`;
 *   - `fetchVariable`   → the run's variable bag (`host/variablesRuntime.ts`);
 *   - `transform`       → a JSONata evaluation under a budget;
 *   - `computeVariable` → the same, then WRITES the variable (the pack does not).
 *
 * PHASE 2a adds `fetchRest` (GET, optionally `Link`-paginated) and `fetchGraphql`
 * (queries) over a CONNECTION acting as a data source (ADR 0783 D1–D8; URL rules
 * in `host/dataSourceUrl.ts`). PHASE 2b serves writes (non-GET REST, GraphQL
 * mutations) through the egress ledger (D7). Accepted writes are deduplicated;
 * retry after an ambiguous transport failure relies on the provider honouring
 * its forwarded key. PHASE 2c claims the six served methods and explicitly
 * withholds the two unavailable ones (D9). Claim only what executes (ADR 0765).
 *
 * MCP content is untrusted. It arrives through the one MCP client, which
 * defangs peer fences at ingress (`defangPeerFence`), and every model boundary
 * fences it (ADR 0358). This adapter adds no second fencing layer; it keeps
 * `untrustedContent: true` on the result so the provenance is not lost here.
 *
 * Failures THROW `{ code }`, the pack's own convention (`host_capability_missing`,
 * `variable_not_found`); the node fails with that code.
 */
import jsonata from 'jsonata';
import { Kind, parse } from 'graphql';
import { setRunVariable, snapshotRunVariables } from './variablesRuntime.js';
import { getConnection } from '../features/connections/connectionsService.js';
import { getProvider } from '../features/connections/providerRegistry.js';
import { buildSourceUrl, isWithinBase, nextLink, sourceError, validateDataSourceBaseUrl } from './dataSourceUrl.js';
import { egressLedgerKey, priorSend, recordSend, releaseSend, reserveSend, type EgressSentRecord } from './egressSentLedger.js';
import { applyBinding, type ApplyBindingArgs, type ApplyBindingResult } from './dataBinding.js';
import { checkFetchA2AArgs, fetchA2A, type FetchA2AArgs, type FetchA2AResult } from './dataA2a.js';
import type { NegotiationRecorder } from './negotiationDecided.js';
import type { BundleScope } from './inMemorySurfaces.js';

/** The JSONata budget. A guard runs at every evaluation step (`timeout`,
 *  `stack`), and sequences are capped. A single built-in call is not
 *  preemptible, so the input and the expression are size-capped too. */
export const DATA_INTEGRATION_BUDGET = {
  timeoutMs: 1_000,
  stack: 200,
  sequence: 100_000,
  maxExpressionChars: 8_192,
  maxInputBytes: 1_000_000,
  maxOutputBytes: 1_000_000,
} as const;

export type DataLanguage = 'jsonata' | 'jq' | 'host-extension';

export interface McpOperation {
  kind: 'tool' | 'resource';
  toolName?: string;
  uri?: string;
}

/** The slice of `ctx.mcp` this adapter needs (`host/mcpClient.ts`). */
export interface DataIntegrationMcp {
  invokeTool(serverId: string, toolName: string, args: unknown, opts?: { timeoutMs?: number }): Promise<{ result: unknown; structuredContent?: unknown; isError: boolean }>;
  readResource(serverId: string, uri: string, opts?: { timeoutMs?: number }): Promise<{ content: unknown; mimeType?: string }>;
}

/** ADR 0783 D7 — the REST verbs that write, and so go through the ledger. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** ADR 0783 D6 — pagination caps. Hitting one FAILS (`pagination_limit_exceeded`):
 *  a partial list presented as complete is the absence-is-a-claim defect. */
export const PAGINATION_LIMITS = { maxPages: 20, maxBytes: 5_000_000, maxWallMs: 60_000 } as const;

/** The slice of `ctx.connectors` the data-source methods need (`host/connectorsAdapter.ts`). */
export interface DataIntegrationConnectors {
  invoke(connectorId: string, request: {
    url: string; method?: string; body?: string; contentType?: string; connectionId?: string;
    extraHeaders?: Record<string, string>;
  }): Promise<InvokeResult>;
}

type InvokeResult = { ok: boolean; status?: number; data?: unknown; error?: string; link?: string };

export interface DataIntegrationAdapter {
  fetchMCP(args: { serverId: unknown; operation: unknown; args?: unknown; idempotencyKey?: unknown }): Promise<{ data: unknown; isError?: boolean; mimeType?: string; untrustedContent: true }>;
  fetchVariable(args: { variableName: unknown }): Promise<{ found: boolean; value: unknown }>;
  transform(args: { expression: unknown; language?: unknown; data: unknown }): Promise<{ result: unknown }>;
  computeVariable(args: { variableName: unknown; expression: unknown; language?: unknown; context?: unknown }): Promise<{ value: unknown }>;
  fetchRest(args: { sourceId: unknown; method?: unknown; path?: unknown; params?: unknown; body?: unknown; paginate?: unknown; idempotencyKey?: unknown }): Promise<{ data: unknown; status: number; pages?: number; fetchedAt: string }>;
  fetchGraphql(args: { sourceId: unknown; operation: unknown; operationName?: unknown; variables?: unknown; idempotencyKey?: unknown }): Promise<{ data: unknown; errors?: unknown[]; fetchedAt: string }>;
  /** ADR 0865 P1 — one value into a canvas's state at a JSON Pointer. */
  applyBinding(args: ApplyBindingArgs): Promise<ApplyBindingResult>;
  /** ADR 0865 P2 — one task to an A2A peer that is a Connection data source. */
  fetchA2A(args: FetchA2AArgs): Promise<FetchA2AResult>;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) fail('validation_error', `${field} must be a non-empty string`);
  return value;
}

function byteSize(value: unknown): number {
  // `undefined` serialises to nothing; a non-serialisable value (a cycle, a
  // BigInt) is a caller error, not something to evaluate over.
  try { return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8'); } catch { return Number.POSITIVE_INFINITY; }
}

/** Evaluate one JSONata expression under the budget. Exported for the tests. */
export async function evaluateJsonata(expression: unknown, language: unknown, input: unknown): Promise<unknown> {
  const lang = language ?? 'jsonata';
  if (lang !== 'jsonata') {
    // `jq` has no vetted engine yet and `host-extension` names no evaluator this
    // host provides (ADR 0783 phase 1).
    fail('unsupported_language', `expression language '${String(lang)}' is not supported by this host; use 'jsonata'`);
  }
  const text = requireString(expression, 'expression');
  const B = DATA_INTEGRATION_BUDGET;
  if (text.length > B.maxExpressionChars) fail('validation_error', `expression exceeds ${B.maxExpressionChars} characters`);
  if (byteSize(input) > B.maxInputBytes) fail('payload_too_large', `expression input exceeds ${B.maxInputBytes} bytes`);
  let compiled: ReturnType<typeof jsonata>;
  try {
    compiled = jsonata(text, { timeout: B.timeoutMs, stack: B.stack, sequence: B.sequence });
  } catch (err) {
    fail('expression_invalid', `expression does not parse: ${(err as { message?: string }).message ?? String(err)}`);
  }
  let result: unknown;
  try {
    result = await compiled.evaluate(input);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    // D1011 stack, D1012 timeout: the budget, not the expression's own error.
    if (e.code === 'D1011' || e.code === 'D1012') fail('expression_budget_exceeded', `expression exceeded its evaluation budget (${e.code})`);
    fail('expression_failed', `expression failed: ${e.message ?? e.code ?? String(err)}`);
  }
  if (byteSize(result) > B.maxOutputBytes) fail('payload_too_large', `expression result exceeds ${B.maxOutputBytes} bytes`);
  return result;
}

export interface DataIntegrationDeps {
  runId: string;
  /** The run's tenant: a `sourceId` resolves only inside it (D2). */
  tenantId?: string;
  mcp?: DataIntegrationMcp;
  connectors?: DataIntegrationConnectors;
  /** ADR 0865 B17 — the run's surface scope (tenant, person, personal tenant),
   *  the SAME object the executor hands `ctx.canvas`, so a binding passes the
   *  one run-lane canvas gate under exactly the run's authority. */
  canvasScope?: BundleScope;
  /** ADR 0858 P4 — `negotiation.decided` for a fetchA2A exchange lands on this run's log. */
  recordNegotiation?: NegotiationRecorder;
}

/** One refusal for every "this source is not usable by this run" (D2), so a
 *  workflow cannot probe which connection ids exist, whose they are, or which
 *  are configured. */
function unavailable(): never {
  throw sourceError('source_unavailable', 'This data source is not available to this run.');
}

/** D2 — `sourceId` → the connection's provider and its re-validated base URL. */
async function resolveSource(deps: DataIntegrationDeps, sourceId: unknown): Promise<{ connectionId: string; provider: string; base: string }> {
  if (typeof sourceId !== 'string' || sourceId.length === 0) throw sourceError('validation_error', 'sourceId must be a non-empty string');
  if (!deps.tenantId || !deps.connectors) fail('host_capability_missing', 'this host exposes no connector broker to the run');
  const c = await getConnection(deps.tenantId, sourceId);
  if (!c || c.status !== 'active' || !c.dataSource) unavailable();
  let base: string;
  try {
    // D1 — re-validated at CALL time: the pins or the deny list may have moved.
    base = validateDataSourceBaseUrl(c.dataSource.baseUrl, getProvider(c.provider)?.apiHosts);
  } catch {
    unavailable();
  }
  return { connectionId: c.connectionId, provider: c.provider, base };
}

/** Map the invoker's fail-closed codes onto the source vocabulary. */
function invokeFailure(error: string | undefined): never {
  if (error === 'connector_timeout') throw sourceError('source_timeout', 'The data source did not answer in time.');
  if (error === 'connector_request_failed') throw sourceError('source_request_failed', 'The request to the data source failed.');
  // A provider's read-only posture is not a secret, and a workflow needs to know
  // its write can never succeed here.
  if (error === 'connector_read_only') throw sourceError('connector_read_only', 'This data source is read-only; it does not accept writes.');
  // no/pinned connection, host not allowed, insecure base: all one
  // non-probing refusal (D2).
  unavailable();
}

/** A write's request body: JSON-encoded, whatever its type, and size-capped. */
function encodeBody(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  let text: string | undefined;
  try { text = JSON.stringify(body); } catch { text = undefined; }
  if (text === undefined) throw sourceError('validation_error', 'body must be JSON-serialisable');
  if (Buffer.byteLength(text, 'utf8') > DATA_INTEGRATION_BUDGET.maxInputBytes) {
    throw sourceError('payload_too_large', `body exceeds ${DATA_INTEGRATION_BUDGET.maxInputBytes} bytes`);
  }
  return text;
}

/**
 * D7 — send ONE write through the egress ledger (ADR 0619 / 0769), keyed on the
 * pack's `idempotencyKey` (a hash of run, node and arguments, so it is stable
 * across a `config.retry` re-run and a same-run recovery restart). The key is
 * also forwarded as `Idempotency-Key` for providers that honour it.
 *
 * Put-on-accept: a 2xx is recorded; anything else releases the reservation so a
 * retry re-sends. A timeout releases too, because the ledger cannot know whether
 * the provider acted; `Idempotency-Key` is the provider-side guard for that case.
 *
 * A duplicate FAILS `duplicate_result_unavailable` and is never re-sent. The
 * ledger records the status only, never a body (correction to D7 in ADR 0783:
 * the body read from a customer's API may carry subject data, and `egress:sent`
 * is erasure-exempt because it holds none).
 */
async function ledgeredWrite(
  tenantId: string,
  provider: string,
  idempotencyKey: unknown,
  send: (headers: Record<string, string>) => Promise<InvokeResult>,
): Promise<InvokeResult> {
  if (typeof idempotencyKey !== 'string' || idempotencyKey === '' || idempotencyKey.length > 200) {
    throw sourceError('validation_error', 'a write needs an idempotencyKey (a non-empty string of at most 200 characters)');
  }
  const key = egressLedgerKey(tenantId, 'data', idempotencyKey);
  const already = (rec: EgressSentRecord | null): Error => sourceError(
    'duplicate_result_unavailable',
    `this write was already sent${rec?.status ? ` and accepted with HTTP ${rec.status}` : ''}; it is not sent again, and its response is not kept`,
  );
  // The insert-if-absent CAS is the one check: an accepted, an in-flight and a
  // racing write with this key all lose it.
  const row: EgressSentRecord = { key, tenantId, channel: 'data', provider, providerRef: '', createdAt: new Date().toISOString() };
  if ((await reserveSend(row)) === 'duplicate') throw already(await priorSend(key));
  let r: InvokeResult;
  try {
    r = await send({ 'Idempotency-Key': idempotencyKey });
  } catch (err) {
    await releaseSend(key);
    throw err;
  }
  if (!r.ok) {
    await releaseSend(key);
    return r;
  }
  await recordSend({ ...row, ...(typeof r.status === 'number' ? { status: r.status } : {}) });
  return r;
}

function byteSizeOf(v: unknown): number { return byteSize(v); }

/** D8 — inspect the canonical GraphQL AST, including escaped block strings.
 * All operations in the document must be reads: operationName cannot select a
 * hidden write. Syntax/type-system-only documents fail before credential use. */
export function graphqlOperationKinds(doc: string): Set<'query' | 'mutation' | 'subscription'> {
  let document: ReturnType<typeof parse>;
  try {
    document = parse(doc, { noLocation: true, maxTokens: 10_000 });
  } catch {
    throw sourceError('validation_error', 'operation must be a valid GraphQL executable document');
  }
  const kinds = new Set<'query' | 'mutation' | 'subscription'>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) kinds.add(definition.operation);
    else if (definition.kind !== Kind.FRAGMENT_DEFINITION) {
      throw sourceError('validation_error', 'operation must contain only executable GraphQL definitions');
    }
  }
  if (kinds.size === 0) throw sourceError('validation_error', 'operation must contain a GraphQL operation');
  return kinds;
}

export function makeDataIntegrationAdapter(deps: DataIntegrationDeps): DataIntegrationAdapter {
  return {
    async fetchMCP({ serverId, operation, args }) {
      const server = requireString(serverId, 'serverId');
      if (!deps.mcp) fail('host_capability_missing', 'this host exposes no MCP client to the run');
      const op = (operation ?? {}) as McpOperation;
      if (op.kind === 'tool') {
        const r = await deps.mcp.invokeTool(server, requireString(op.toolName, 'operation.toolName'), args ?? {});
        return { data: r.structuredContent ?? r.result, isError: r.isError === true, untrustedContent: true };
      }
      if (op.kind === 'resource') {
        const r = await deps.mcp.readResource(server, requireString(op.uri, 'operation.uri'));
        return { data: r.content, ...(r.mimeType ? { mimeType: r.mimeType } : {}), untrustedContent: true };
      }
      fail('validation_error', "operation.kind must be 'tool' or 'resource'");
    },

    async fetchVariable({ variableName }) {
      const name = requireString(variableName, 'variableName');
      const bag = snapshotRunVariables(deps.runId);
      // Presence, not truthiness: a variable explicitly set to `null` is found.
      if (bag && Object.prototype.hasOwnProperty.call(bag, name)) return { found: true, value: bag[name] };
      return { found: false, value: undefined };
    },

    async transform({ expression, language, data }) {
      return { result: await evaluateJsonata(expression, language, data) };
    },

    async applyBinding(args) {
      return applyBinding(deps.canvasScope, args, evaluateJsonata);
    },

    async fetchA2A(args) {
      checkFetchA2AArgs(args); // before the peer is resolved: a bad call never probes it
      const src = await resolveSource(deps, args.peerId);
      return fetchA2A({
        tenantId: deps.tenantId!,
        connectors: deps.connectors!,
        ...(deps.recordNegotiation ? { recordNegotiation: deps.recordNegotiation } : {}),
      }, src, args.peerId as string, args);
    },

    async fetchRest({ sourceId, method, path, params, body, paginate, idempotencyKey }) {
      const verb = (typeof method === 'string' ? method : 'GET').toUpperCase();
      if (!WRITE_METHODS.has(verb) && verb !== 'GET') throw sourceError('unsupported_operation', `method ${verb} is not supported; use GET, POST, PUT, PATCH or DELETE`);
      if (verb === 'GET' && body !== undefined) throw sourceError('validation_error', 'a GET carries no body');
      if (verb !== 'GET' && paginate === true) throw sourceError('validation_error', 'only a GET can paginate');
      const src = await resolveSource(deps, sourceId);
      let url = buildSourceUrl(src.base, path, params);
      const fetchedAt = (): string => new Date().toISOString();

      if (verb !== 'GET') {
        // REST non-GET is explicitly a write on this surface. The general
        // broker permits POST read APIs, so its verb gate cannot enforce this.
        if (getProvider(src.provider)?.readOnly) throw sourceError('connector_read_only', 'This data source is read-only; it does not accept writes.');
        const text = encodeBody(body);
        const r = await ledgeredWrite(deps.tenantId!, src.provider, idempotencyKey, (headers) => deps.connectors!.invoke(src.provider, {
          url, method: verb, connectionId: src.connectionId, extraHeaders: headers,
          ...(text !== undefined ? { body: text, contentType: 'application/json' } : {}),
        }));
        if (r.error && !r.status) invokeFailure(r.error);
        return { data: r.data ?? null, status: r.status ?? 0, fetchedAt: fetchedAt() };
      }

      const call = async (target: string) => deps.connectors!.invoke(src.provider, { url: target, method: 'GET', connectionId: src.connectionId });

      if (paginate !== true) {
        const r = await call(url);
        if (r.error && !r.status) invokeFailure(r.error);
        // An HTTP status is the SOURCE's answer, passed through as the schema's
        // `status`; the workflow branches on it.
        return { data: r.data ?? null, status: r.status ?? 0, fetchedAt: fetchedAt() };
      }

      const started = Date.now();
      const assertDeadline = (): void => {
        if (Date.now() - started >= PAGINATION_LIMITS.maxWallMs) {
          throw sourceError('pagination_limit_exceeded', 'pagination exceeded its wall-clock deadline');
        }
      };
      const all: unknown[] = [];
      let bytes = 0;
      for (let page = 1; ; page++) {
        assertDeadline();
        if (page > PAGINATION_LIMITS.maxPages) {
          throw sourceError('pagination_limit_exceeded', `pagination stopped at its limit (${PAGINATION_LIMITS.maxPages} pages / ${PAGINATION_LIMITS.maxWallMs / 1000}s) before the last page`);
        }
        const r = await call(url);
        // The terminal page is subject to the same deadline as every other hop.
        assertDeadline();
        if (r.error && !r.status) invokeFailure(r.error);
        if (!r.ok) throw sourceError('source_http_error', `page ${page} answered HTTP ${r.status}`);
        if (!Array.isArray(r.data)) throw sourceError('pagination_unsupported_shape', `page ${page} is not a JSON array, so pages cannot be aggregated`);
        bytes += byteSizeOf(r.data);
        if (bytes > PAGINATION_LIMITS.maxBytes) throw sourceError('pagination_limit_exceeded', `the pages exceed ${PAGINATION_LIMITS.maxBytes} bytes`);
        // The byte cap permits dense arrays larger than the JS argument limit.
        for (const item of r.data) all.push(item);
        const next = nextLink(r.link, url);
        assertDeadline();
        if (next === null) return { data: all, status: r.status ?? 200, pages: page, fetchedAt: fetchedAt() };
        // Every hop is confined to the source, exactly like the first request.
        if (!isWithinBase(new URL(next), src.base)) throw sourceError('validation_error', 'a pagination link pointed outside the data source');
        url = next;
      }
    },

    async fetchGraphql({ sourceId, operation, operationName, variables, idempotencyKey }) {
      if (typeof operation !== 'string' || operation.trim() === '') throw sourceError('validation_error', 'operation must be a non-empty string');
      if (operationName !== undefined && typeof operationName !== 'string') throw sourceError('validation_error', 'operationName must be a string');
      if (variables !== undefined && (variables === null || typeof variables !== 'object' || Array.isArray(variables))) {
        throw sourceError('validation_error', 'variables must be an object');
      }
      const kinds = graphqlOperationKinds(operation);
      if (kinds.has('subscription')) throw sourceError('unsupported_operation', 'GraphQL subscriptions are not supported');
      const src = await resolveSource(deps, sourceId);
      const body = JSON.stringify({ query: operation, ...(operationName ? { operationName } : {}), ...(variables ? { variables } : {}) });
      const post = (headers?: Record<string, string>) => deps.connectors!.invoke(src.provider, {
        url: src.base, method: 'POST', body, contentType: 'application/json', connectionId: src.connectionId,
        ...(headers ? { extraHeaders: headers } : {}),
      });
      let r: InvokeResult;
      if (kinds.has('mutation')) {
        // A mutation is a write. GraphQL is always POST, so the invoker's read-only
        // method gate cannot see it: the provider's posture is checked here (D8),
        // and the write goes through the ledger (D7).
        if (getProvider(src.provider)?.readOnly) throw sourceError('connector_read_only', 'This data source is read-only; it does not accept mutations.');
        r = await ledgeredWrite(deps.tenantId!, src.provider, idempotencyKey, post);
      } else {
        r = await post();
      }
      if (r.error && !r.status) invokeFailure(r.error);
      if (!r.ok) throw sourceError('source_http_error', `the GraphQL endpoint answered HTTP ${r.status}`);
      const payload = r.data;
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw sourceError('source_invalid_response', 'the GraphQL endpoint did not answer with a JSON object');
      if (byteSizeOf(payload) > PAGINATION_LIMITS.maxBytes) throw sourceError('payload_too_large', `the response exceeds ${PAGINATION_LIMITS.maxBytes} bytes`);
      const { data, errors } = payload as { data?: unknown; errors?: unknown };
      // `200 + errors` is GraphQL partial success, passed through as such.
      return { data: data ?? null, ...(Array.isArray(errors) && errors.length > 0 ? { errors } : {}), fetchedAt: new Date().toISOString() };
    },

    async computeVariable({ variableName, expression, language, context }) {
      const name = requireString(variableName, 'variableName');
      if (context !== undefined && (context === null || typeof context !== 'object' || Array.isArray(context))) {
        fail('validation_error', 'context must be an object');
      }
      // `variable.compute.input.json`: the context is MERGED with the run's
      // existing variables, the context winning on a shared name.
      const input = { ...(snapshotRunVariables(deps.runId) ?? {}), ...((context as Record<string, unknown> | undefined) ?? {}) };
      const value = await evaluateJsonata(expression, language, input);
      setRunVariable(deps.runId, name, value);
      return { value };
    },
  };
}
