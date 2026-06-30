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
import { isDeniedWebhookHost, webhookEgressDispatcher, webhookPrivateEgressAllowed } from './webhookEgressGuard.js';
import { createLogger } from '../observability/logger.js';
import type { SandboxExecRequest, SandboxExecResult } from '../executor/types.js';
import { checkCodeExecBudget, recordCodeExec } from './codeExecBudget.js';
import { runWasiSandboxedCode, wasiRuntimeEnabled, wasiAllowedLanguages } from './wasiSandbox.js';

const log = createLogger('host.sandbox');

const MAX_CODE_BYTES = 200_000;
const MAX_STDIN_BYTES = 200_000; // CXE-5: cap stdin like code (was forwarded uncapped)
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

/** CXE-4: per-process cap on concurrent external sandbox dispatches (a backstop against a
 *  programmatic burst exhausting the external sandbox + cost; code-exec is HITL-gated so
 *  real concurrency is low). Fail-fast `resource_exhausted` over the cap — no queue. */
function maxConcurrent(): number {
  const n = parseInt(process.env.OPENWOP_CODE_EXEC_MAX_CONCURRENT ?? '8', 10);
  return Number.isFinite(n) && n > 0 ? n : 8;
}
let inFlight = 0;

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

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export async function runSandboxedCode(req: SandboxExecRequest): Promise<SandboxExecResult> {
  if (typeof req.code !== 'string' || req.code.length === 0) throw err('validation_error', '`code` is required.');
  if (req.code.length > MAX_CODE_BYTES) throw err('content_too_long', `code exceeds the ${MAX_CODE_BYTES}-byte cap.`);
  // CXE-5: cap stdin (was forwarded verbatim — an oversize stdin could DoS the sandbox / cost).
  if (typeof req.stdin === 'string' && req.stdin.length > MAX_STDIN_BYTES) throw err('content_too_long', `stdin exceeds the ${MAX_STDIN_BYTES}-byte cap.`);
  // ADR 0114 Phase 7 — language allowlist (defense-in-depth, before any egress).
  const language = (req.language || 'python').toLowerCase();
  if (!allowedLanguages().includes(language)) throw err('validation_error', `language "${language}" is not allowed on this host.`);
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

  // CXE-4: fail-fast over the concurrency cap (the check→increment pair is synchronous, so
  // it's race-free; the only await is after the increment). Decrement in finally below.
  if (inFlight >= maxConcurrent()) throw Object.assign(new Error('code execution is at capacity; try again shortly.'), { code: 'resource_exhausted' });
  inFlight++;

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
    const body = (await res.json().catch(() => ({}))) as Partial<SandboxExecResult>;
    const result = {
      exitCode: typeof body.exitCode === 'number' ? body.exitCode : (res.ok ? 0 : 1),
      stdout: body.stdout ?? '',
      stderr: body.stderr ?? '',
      timedOut: body.timedOut ?? false,
      files: Array.isArray(body.files) ? body.files : [],
    };
    // CXE-6: audit the dispatch outcome (language + exit + timed-out; never code/stdin/endpoint).
    log.info('code_exec_dispatched', { language, exitCode: result.exitCode, timedOut: result.timedOut });
    return result;
  } catch (e) {
    // §D — never echo the endpoint location; a timeout reads as a transport error.
    const aborted = e instanceof Error && e.name === 'AbortError';
    throw err('sandbox_transport_error', aborted ? 'sandbox_timeout' : 'sandbox_transport_error');
  } finally {
    clearTimeout(timer);
    inFlight--;
  }
}

/** ADR 0146 — resolve the active sandbox executor: the external Code-API ALWAYS wins when an
 *  endpoint is configured (strong-isolation / polyglot); else the in-process CPython-WASI runtime
 *  when opted in AND its asset is present (`OPENWOP_CODE_EXEC_RUNTIME=wasi`); else none
 *  (honest-off → `capability_not_provided`). */
function resolveSandboxExecutor(): ((req: SandboxExecRequest) => Promise<SandboxExecResult>) | undefined {
  if (sandboxEndpoint()) return runSandboxedCode;        // external Code-API
  if (wasiRuntimeEnabled()) return runWasiSandboxedCode; // in-process CPython-WASI (no host FFI)
  return undefined;
}

/** The `ctx.runSandboxedCode` binding — `undefined` (honest-off) unless a sandbox executor is
 *  available (an external endpoint OR the opt-in WASI runtime). Wiring it only-when-available
 *  preserves the Phase-1 `capability_not_provided` behavior on a host with no sandbox. */
export function createSandboxRunner(tenantId?: string): ((req: SandboxExecRequest) => Promise<SandboxExecResult>) | undefined {
  const exec = resolveSandboxExecutor();
  if (!exec) return undefined;
  if (!tenantId) return exec; // no tenant context → no budget (back-compat)
  // ADR 0114 Phase 5 — gate each run on the tenant's daily exec budget; record on
  // success. Over budget ⇒ `resource_exhausted` (no execution, no charge).
  return async (req: SandboxExecRequest): Promise<SandboxExecResult> => {
    const day = new Date().toISOString().slice(0, 10);
    const budget = await checkCodeExecBudget(tenantId, day);
    if (!budget.allowed) {
      log.info('code_exec_budget_exceeded', { tenantId, used: budget.used, max: budget.max }); // CXE-6
      throw Object.assign(new Error(`code execution daily budget reached (${budget.used}/${budget.max}).`), { code: 'resource_exhausted' });
    }
    const result = await exec(req);
    await recordCodeExec(tenantId, day);
    return result;
  };
}
