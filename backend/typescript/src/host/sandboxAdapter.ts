/**
 * ADR 0114 Phase 2 — external Code-API sandbox adapter (the real execution path).
 *
 * Backs `ctx.runSandboxedCode` ONLY when `OPENWOP_CODE_EXEC_ENDPOINT` is configured
 * — otherwise `createSandboxRunner()` returns `undefined` and the node stays
 * honest-off (`capability_not_provided`, Phase 1).
 *
 * OPERATOR CONTRACT (CXE-2): the sandbox is EXTERNAL — this host CANNOT enforce CPU,
 * memory, or filesystem/network isolation of code it does not run. Configuring
 * `OPENWOP_CODE_EXEC_ENDPOINT` is the operator's ASSERTION that the endpoint is a real
 * sandbox enforcing mem/CPU/time limits + filesystem + network isolation. The in-repo
 * backstops here are a wall-clock timeout, a code/stdin size cap, a per-process
 * concurrency cap, a language allowlist, the HITL approval gate, and the CXE-1 SSRF pin
 * — they bound abuse but do NOT substitute for the external sandbox's own enforcement.
 *
 * The dispatch is SSRF-guarded — CXE-1: pinned at connect time through
 * `webhookEgressDispatcher()` (closes DNS-rebind, not just the registration-time host
 * string check) + https-required + `redirect:'error'`; the endpoint location is NEVER
 * echoed in an error (§D-style scrub).
 */
import { fetch as undiciFetch } from 'undici';
import { resolveOne } from './featureToggles/service.js';
import { isDeniedWebhookHost, webhookEgressDispatcher, webhookPrivateEgressAllowed } from './webhookEgressGuard.js';
import { createLogger } from '../observability/logger.js';
import { classifySandboxError, recordSandboxExecution, type SandboxRuntime } from '../observability/metricSeams.js';
import type { SandboxExecRequest, SandboxExecResult } from '../executor/types.js';
import { releaseCodeExec, reserveCodeExec } from './codeExecBudget.js';
import { meterPlatformUnits } from './managedCredits.js';
import { runWasiSandboxedCode, wasiRuntimeEnabled, wasiAllowedLanguages } from './wasiSandbox.js';
import { runE2bSandboxedCode } from './sandboxAdapters/e2bAdapter.js';
import { recordAuthorityAction } from './authorityContext.js';

const log = createLogger('host.sandbox');

/** The code-exec feature's toggle id (`features/code-exec/feature.ts`). */
const CODE_EXEC_TOGGLE = 'code-exec';

export const MAX_CODE_BYTES = 200_000;
export const MAX_STDIN_BYTES = 200_000; // CXE-5: cap stdin like code (was forwarded uncapped)
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;

/** CXE-4: per-process cap on concurrent external sandbox dispatches (a backstop against a
 *  programmatic burst exhausting the external sandbox + cost; code-exec is HITL-gated so
 *  real concurrency is low). Fail-fast `resource_exhausted` over the cap — no queue. */
function maxConcurrent(): number {
  const n = parseInt(process.env.OPENWOP_CODE_EXEC_MAX_CONCURRENT ?? '8', 10);
  return Number.isFinite(n) && n > 0 ? n : 8;
}
let inFlight = 0;

/** CXE-4 — run `fn` under the shared per-process concurrency cap. Fail-fast `resource_exhausted`
 *  over the cap (the check→increment pair is synchronous, so it's race-free). Shared by BOTH the
 *  Code-API adapter and the E2B adapter (ADR 0114 Phase 8) so the cap is GLOBAL across adapters,
 *  not per-adapter. */
export async function withSandboxConcurrency<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= maxConcurrent()) throw Object.assign(new Error('code execution is at capacity; try again shortly.'), { code: 'resource_exhausted' });
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
  }
}

/** ADR 0114 Phase 7 — the languages this host will dispatch to the sandbox. An
 *  operator narrows/widens it with `OPENWOP_CODE_EXEC_LANGUAGES` (comma list); the
 *  default is the common interpreters. An unlisted language is rejected BEFORE the
 *  egress call — defense-in-depth so a node can't smuggle an arbitrary runtime past
 *  the sandbox's own policy. */
const DEFAULT_LANGUAGES = ['python', 'javascript', 'typescript', 'bash', 'ruby', 'go'];

export function allowedLanguages(): string[] {
  const env = process.env.OPENWOP_CODE_EXEC_LANGUAGES?.trim();
  if (env) return env.split(',').map((l) => l.trim().toLowerCase()).filter((l) => l.length > 0);
  // ADR 0146 Phase 3 — advertise only what the ACTIVE adapter honors. When the in-process WASI
  // runtime is the executor (no external endpoint), the host runs Python only — not the external
  // adapter's polyglot default. (An explicit OPENWOP_CODE_EXEC_LANGUAGES override still wins.)
  if (!sandboxEndpoint() && wasiRuntimeEnabled()) return wasiAllowedLanguages();
  return DEFAULT_LANGUAGES;
}

export function sandboxEndpoint(): string | undefined {
  return process.env.OPENWOP_CODE_EXEC_ENDPOINT?.trim() || undefined;
}

/** ADR 0114 Phase 8 — the adapter selector. `code-api` (or unset + an endpoint) ⇒ the external
 *  Code-API adapter; `e2b` ⇒ the first-party E2B adapter; `wasi` ⇒ the in-process WASI runtime.
 *  Read per-call (trimmed, lowercased) so tests + env updates take effect without a restart. */
export function codeExecProvider(): string | undefined {
  return process.env.OPENWOP_CODE_EXEC_PROVIDER?.trim().toLowerCase() || undefined;
}

/** ADR 0114 Phase 8 — the E2B API key, an OPERATOR env var (mirrors how the sibling Code-API
 *  adapter reads `OPENWOP_CODE_EXEC_KEY`). Code-exec is operator-global infra, not a per-tenant
 *  Connection credential — see the Phase-8 correction note in ADR 0114. */
export function e2bApiKey(): string | undefined {
  return process.env.OPENWOP_E2B_API_KEY?.trim() || undefined;
}

/** True when the operator has selected E2B AND supplied a key. Provider `e2b` with no key falls
 *  through to the endpoint→wasi→off chain (honest-off), never a hard error. */
export function e2bConfigured(): boolean {
  return codeExecProvider() === 'e2b' && !!e2bApiKey();
}

export function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** The cap on captured stdout/stderr: the same `OPENWOP_CODE_EXEC_MAX_OUTPUT_BYTES` knob and default the WASI runtime reads for its read-back cap (`wasiSandbox.ts` keeps its own reader to avoid an import cycle). */
export function maxOutputBytes(): number {
  const n = parseInt(process.env.OPENWOP_CODE_EXEC_MAX_OUTPUT_BYTES ?? '1000000', 10);
  return Number.isFinite(n) && n > 0 ? n : 1_000_000;
}
export const MAX_RESULT_FILES = 16;
export const MAX_RESULT_FILE_BASE64 = 8_000_000;

/** ADR 0995 D5 — the largest response body an external sandbox may send: room for both capped
 *  streams, the files and JSON overhead. A larger body is refused, never buffered. */
export function maxResponseBytes(): number {
  return 4 * maxOutputBytes() + MAX_RESULT_FILE_BASE64 + 64_000;
}

function capText(v: unknown, cap: number): string {
  const s = typeof v === 'string' ? v : '';
  return s.length > cap ? `${s.slice(0, cap)}\n…[output truncated at ${cap} bytes]` : s;
}

/**
 * ADR 0995 D5 — the ONE place an external sandbox's answer becomes a `SandboxExecResult`. Every
 * field is type-checked (the Code-API path used to pass `body.stdout ?? ''` through, whatever it
 * was), stdout/stderr are capped like the WASI runtime caps them, and files are capped by count
 * and total base64. That output goes to the event log, an artifact and the model, so it is bounded
 * before it leaves this module.
 */
export function normalizeSandboxResult(body: Record<string, unknown>, fallbackExit: number): SandboxExecResult {
  const cap = maxOutputBytes();
  const files: Array<{ name: string; mimeType: string; base64: string }> = [];
  let budget = MAX_RESULT_FILE_BASE64;
  let dropped = 0;
  for (const f of Array.isArray(body.files) ? body.files : []) {
    const r = f && typeof f === 'object' ? (f as Record<string, unknown>) : undefined;
    if (!r || typeof r.name !== 'string' || typeof r.base64 !== 'string') continue;
    if (files.length >= MAX_RESULT_FILES || r.base64.length > budget) { dropped++; continue; }
    budget -= r.base64.length;
    files.push({ name: r.name.slice(0, 255), mimeType: typeof r.mimeType === 'string' ? r.mimeType : 'application/octet-stream', base64: r.base64 });
  }
  const stderr = capText(body.stderr, cap);
  return {
    exitCode: typeof body.exitCode === 'number' && Number.isFinite(body.exitCode) ? body.exitCode : fallbackExit,
    stdout: capText(body.stdout, cap),
    stderr: dropped > 0 ? `${stderr}${stderr ? '\n' : ''}…[${dropped} file(s) dropped: over the ${MAX_RESULT_FILES}-file / ${MAX_RESULT_FILE_BASE64}-byte cap]` : stderr,
    timedOut: body.timedOut === true,
    files,
  };
}

/** ADR 0995 D5 — read a JSON response body, refusing one larger than `maxBytes` without buffering
 *  it. An unparseable body reads as `{}` (the adapters map that to their fallback exit code). */
export async function readJsonCapped(res: { body: AsyncIterable<Uint8Array> | null }, maxBytes: number): Promise<Record<string, unknown>> {
  if (!res.body) return {};
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw err('sandbox_transport_error', 'sandbox_response_too_large');
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** ADR 0114 Phase 2/7 — the pre-egress request validation shared by EVERY adapter: code required +
 *  size-capped, stdin size-capped (CXE-5), and the language allowlist (defense-in-depth, before any
 *  egress). Returns the normalized (lowercased) language. Shared so the E2B adapter (Phase 8)
 *  enforces the identical gate as the Code-API path — no duplicated limits. */
export function validateCodeRequest(req: SandboxExecRequest): string {
  if (typeof req.code !== 'string' || req.code.length === 0) throw err('validation_error', '`code` is required.');
  if (req.code.length > MAX_CODE_BYTES) throw err('content_too_long', `code exceeds the ${MAX_CODE_BYTES}-byte cap.`);
  // CXE-5: cap stdin (was forwarded verbatim — an oversize stdin could DoS the sandbox / cost).
  if (typeof req.stdin === 'string' && req.stdin.length > MAX_STDIN_BYTES) throw err('content_too_long', `stdin exceeds the ${MAX_STDIN_BYTES}-byte cap.`);
  // ADR 0114 Phase 7 — language allowlist (defense-in-depth, before any egress).
  const language = (req.language || 'python').toLowerCase();
  if (!allowedLanguages().includes(language)) throw err('validation_error', `language "${language}" is not allowed on this host.`);
  return language;
}

export async function runSandboxedCode(req: SandboxExecRequest): Promise<SandboxExecResult> {
  // ADR 0556 P1 — metered HERE, inside the exported function, so the exported
  // reference stays the one `resolveSandboxExecutor` hands out (the Phase-8
  // selector tests pin that identity). Every gate below — validation, the size
  // caps, the SSRF refusal, the concurrency cap, the abort — throws inside this
  // call, so wrapping the body counts them all without a per-gate emit.
  //
  // `timedOut: true` on a RESOLVED result is still a timeout: the Code-API
  // returns a body rather than throwing when the far end enforced the limit, so
  // reading only the throw path would under-report the capacity signal an
  // operator sizes the pool from.
  // ADR 0556 P3 / RFC 0154 §D — a sandbox execution is an action taken under
  // someone's authority even though the code inside it has none of its own.
  recordAuthorityAction('sandbox', 'attempt');
  try {
    const result = await runCodeApiSandbox(req);
    recordSandboxExecution('code-api', result.timedOut ? 'timeout' : 'ok');
    return result;
  } catch (err) {
    recordSandboxExecution('code-api', classifySandboxError(err));
    throw err;
  }
}

async function runCodeApiSandbox(req: SandboxExecRequest): Promise<SandboxExecResult> {
  const language = validateCodeRequest(req); // code/stdin size + language allowlist (before egress)
  const endpoint = sandboxEndpoint();
  if (!endpoint) throw err('capability_not_provided', 'no sandbox endpoint configured.');

  // SSRF guard (ADR 0108 pattern) — first-line registration-time host string check.
  let url: URL;
  try { url = new URL(endpoint); } catch { throw err('sandbox_transport_error', 'sandbox_transport_error'); }
  if (!webhookPrivateEgressAllowed() && isDeniedWebhookHost(url.hostname)) {
    throw err('sandbox_transport_error', 'sandbox_transport_error');
  }
  if (url.protocol !== 'https:' && !webhookPrivateEgressAllowed()) {
    throw err('sandbox_transport_error', 'sandbox_transport_error');
  }

  // CXE-4: run under the shared per-process concurrency cap (fail-fast `resource_exhausted`).
  return withSandboxConcurrency(async () => {
    const timeoutMs = Math.min(typeof req.timeoutMs === 'number' && req.timeoutMs > 0 ? req.timeoutMs : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const key = process.env.OPENWOP_CODE_EXEC_KEY?.trim();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // CXE-1: pin egress through the connect-time-validating dispatcher (closes DNS-rebind
      // the string check can't) + refuse redirects. `undiciFetch` so `dispatcher` types cleanly.
      const res = await undiciFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ language, code: req.code, stdin: req.stdin, timeoutMs }),
        redirect: 'error',
        dispatcher: webhookEgressDispatcher(),
        signal: ctrl.signal,
      });
      const result = normalizeSandboxResult(await readJsonCapped(res, maxResponseBytes()), res.ok ? 0 : 1);
      // CXE-6: audit the dispatch outcome (language + exit + timed-out; never code/stdin/endpoint).
      log.info('code_exec_dispatched', { language, exitCode: result.exitCode, timedOut: result.timedOut });
      return result;
    } catch (e) {
      // §D — never echo the endpoint location; a timeout reads as a transport error.
      const aborted = e instanceof Error && e.name === 'AbortError';
      const tooLarge = e instanceof Error && e.message === 'sandbox_response_too_large';
      throw err('sandbox_transport_error', aborted ? 'sandbox_timeout' : tooLarge ? 'sandbox_response_too_large' : 'sandbox_transport_error');
    } finally {
      clearTimeout(timer);
    }
  });
}

/** ADR 0114 Phase 8 / ADR 0146 — resolve the active sandbox executor. Precedence:
 *  1. `OPENWOP_CODE_EXEC_PROVIDER=e2b` + a key ⇒ the first-party E2B micro-VM adapter (Phase 8);
 *  2. else an external Code-API endpoint (strong-isolation / polyglot);
 *  3. else the in-process CPython-WASI runtime when opted in AND its asset is present;
 *  4. else none (honest-off → `capability_not_provided`).
 *  `provider=e2b` with NO key falls through to 2→3→4 (honest-off), never a hard error. Every
 *  branch is wrapped by `createSandboxRunner` (budget + concurrency) — E2B does NOT bypass it. */
function resolveSandboxExecutor():
  | { runtime: SandboxRuntime; exec: (req: SandboxExecRequest) => Promise<SandboxExecResult> }
  | undefined {
  // ADR 0556 P1 — the resolver NAMES the runtime as well as returning it, so the
  // budget refusal below can label its metric without re-implementing this
  // precedence ladder. (The two would disagree the first time the ladder
  // changed, and the disagreement would be invisible — a metric attributing E2B
  // failures to the Code-API adapter still looks like a working metric.)
  //
  // The `exec` returned here is the executor ITSELF, never a wrapper: the
  // Phase-8 selector tests assert `createSandboxRunner() === runE2bSandboxedCode`,
  // and that reference identity is how "which executor was selected" is pinned.
  // Per-execution metering therefore lives INSIDE each executor rather than
  // around it — see the `record…` calls in `runSandboxedCode`,
  // `runWasiSandboxedCode` and `runE2bSandboxedCode`.
  if (codeExecProvider() === 'e2b' && e2bConfigured()) return { runtime: 'e2b', exec: runE2bSandboxedCode }; // first-party E2B (Phase 8)
  if (sandboxEndpoint()) return { runtime: 'code-api', exec: runSandboxedCode };        // external Code-API
  if (wasiRuntimeEnabled()) return { runtime: 'wasi', exec: runWasiSandboxedCode }; // in-process CPython-WASI (no host FFI)
  return undefined;
}

/** ADR 0995 D7 — which executor is selected, for the tests that pin the precedence ladder by
 *  reference identity. Production code never calls an executor directly: it goes through
 *  `createSandboxRunner(tenantId)`, which adds the toggle, the budget and the metering. */
export function selectSandboxExecutor(): ((req: SandboxExecRequest) => Promise<SandboxExecResult>) | undefined {
  return resolveSandboxExecutor()?.exec;
}

/** ADR 0995 D6 — refusals raised before anything reached a sandbox. These release the budget
 *  reservation; everything else (a result, a far-end timeout, a transport error) was a dispatch
 *  and stays charged. */
const PRE_DISPATCH_CODES: ReadonlySet<string> = new Set(['validation_error', 'content_too_long', 'resource_exhausted', 'capability_not_provided']);

/** The `ctx.runSandboxedCode` binding — `undefined` (honest-off) unless a sandbox executor is
 *  available (an external endpoint OR the opt-in WASI runtime). Wiring it only-when-available
 *  preserves the Phase-1 `capability_not_provided` behavior on a host with no sandbox.
 *
 *  CORRECTED (ADR 0995 D7) — `tenantId` used to be optional, and with none the bare executor came
 *  back with no toggle check and no budget. Both callers passed one, so the gate held by
 *  convention; it is now required, so a third caller cannot skip it. */
export function createSandboxRunner(tenantId: string): ((req: SandboxExecRequest) => Promise<SandboxExecResult>) | undefined {
  const resolved = resolveSandboxExecutor();
  if (!resolved) return undefined;
  const exec = resolved.exec;
  // ADR 0114 Phase 5 — gate each run on the tenant's daily exec budget.
  return async (req: SandboxExecRequest): Promise<SandboxExecResult> => {
    // ADR 0820 §8.2 — the `code-exec` ACCESS gate (toggle + plan; the feature is sold
    // in the Developer bundle). Here, in the one runner both lanes share (the
    // executor's `ctx.runSandboxedCode` and the chat code tool), so no lane can skip
    // it. Checked per execution, not when the runner is built, so a plan change
    // lands on the next call. Fail-closed: an unreadable answer refuses, and a
    // refusal neither executes nor counts against the budget.
    const access = await resolveOne(CODE_EXEC_TOGGLE, { tenantId }).catch(() => null);
    if (access?.enabled !== true) {
      log.info('code_exec_feature_refused', { tenantId, blockedBy: access?.blockedBy ?? 'off' });
      throw Object.assign(new Error('code execution is not enabled for this workspace.'), { code: 'feature_disabled' });
    }
    // ADR 0995 D6 — RESERVE before dispatch. This used to check, run, then record on success
    // only: an execution that threw (a far-end timeout, a transport error) was never counted, so
    // code that always ran out the clock ran without limit, and N concurrent calls at max-1 all
    // passed the check. The reservation is an atomic CAS increment below the max; the day is
    // captured so a run that crosses midnight releases the bucket it took.
    const day = new Date().toISOString().slice(0, 10);
    const budget = await reserveCodeExec(tenantId, day);
    if (!budget.allowed) {
      log.info('code_exec_budget_exceeded', { tenantId, used: budget.used, max: budget.max }); // CXE-6
      // ADR 0556 P1 — a budget refusal never reaches `meteredSandboxExec` (no
      // execution happens), so it is counted here or not at all. Same series on
      // purpose: from the caller's side "the sandbox refused me for capacity
      // reasons" is one condition, whether the cap was per-tenant-daily or
      // per-process-concurrent.
      recordSandboxExecution(resolved.runtime, 'resource_exhausted');
      throw Object.assign(new Error(budget.contended
        ? 'code execution budget is busy; try again shortly.'
        : `code execution daily budget reached (${budget.used}/${budget.max}).`), { code: 'resource_exhausted' });
    }
    const startedAt = Date.now();
    let dispatched = true;
    try {
      return await exec(req);
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && PRE_DISPATCH_CODES.has(code)) {
        dispatched = false;
        if (budget.reserved) await releaseCodeExec(tenantId, day);
      }
      throw e;
    } finally {
      // ADR 0821 D3 — every runtime here is platform-paid (E2B / Code-API on the
      // operator's key, WASI on the host's CPU): meter whole seconds beside the
      // daily exec budget (no draw while `codeExecSecond` has no rate). ADR 0995 D6 —
      // in `finally`, so a failed dispatch is metered too.
      if (dispatched) {
        // A metering failure must neither mask the execution's own error nor turn a result the
        // caller already paid for into a throw.
        await meterPlatformUnits({ tenantId, unit: 'codeExecSecond', quantity: Math.max(1, Math.ceil((Date.now() - startedAt) / 1000)), featureId: 'code-exec' })
          .catch((e: unknown) => log.warn('code_exec_meter_failed', { tenantId, error: e instanceof Error ? e.message : String(e) }));
      }
    }
  };
}
