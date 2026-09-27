/**
 * ADR 0114 Phase 8 — first-party E2B sandbox adapter (a selectable implementation of the same
 * `runSandboxedCode` contract, chosen via `OPENWOP_CODE_EXEC_PROVIDER=e2b`).
 *
 * HONESTY / OPERATOR CONTRACT: this targets E2B's DOCUMENTED REST API (control plane at
 * `api.e2b.dev` — create/kill sandbox; data plane on the per-sandbox `<id>.e2b.dev` envd host —
 * run code). It is **operator-validated**, NOT verified against a live E2B tenant in this repo:
 * the live wire shape is ASSERTED by the operator who configures `OPENWOP_E2B_API_KEY` (the same
 * operator contract as the sibling Code-API adapter's `OPENWOP_CODE_EXEC_ENDPOINT`). E2B's exact
 * current request/response field names + the envd exec path may differ across E2B versions; the
 * request construction and the response→`SandboxExecResult` mapping are therefore CENTRALIZED
 * (`e2bRequest` + `mapE2bExec`) so an operator can adjust them in ONE place without touching the
 * SSRF / concurrency / budget wrapping. Do NOT read this as a tested-against-live-E2B integration.
 *
 * SSRF (CXE-1, reused verbatim from `runSandboxedCode`): every call goes through
 * `webhookEgressDispatcher()` (connect-time re-resolution closes DNS-rebind) + `redirect:'error'`
 * + https-only + deny-private-host. HOST PIN: the E2B exec host is a PER-SANDBOX subdomain
 * (`<id>.e2b.dev`), so the pin is the **e2b.dev eTLD+1** — dot-anchored containment (RFC 0120
 * `apiHosts` model): allow `e2b.dev` and `*.e2b.dev`, reject everything else. (If an operator's E2B
 * tenant serves sandboxes under a different eTLD+1, `E2B_ETLD1` below is the single point to adjust.)
 *
 * §D endpoint/key non-disclosure: the API key and the per-sandbox host are NEVER logged or echoed;
 * any transport failure surfaces as `sandbox_transport_error` (a timeout as `sandbox_timeout`),
 * mirroring `runSandboxedCode`'s catch — no host/key ever leaks into an error message.
 */
import { fetch as undiciFetch } from 'undici';
import { isDeniedWebhookHost, webhookEgressDispatcher, webhookPrivateEgressAllowed } from '../webhookEgressGuard.js';
import { createLogger } from '../../observability/logger.js';
import { classifySandboxError, recordSandboxExecution } from '../../observability/metricSeams.js';
import type { SandboxExecRequest, SandboxExecResult } from '../../executor/types.js';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  e2bApiKey,
  err,
  validateCodeRequest,
  withSandboxConcurrency,
} from '../sandboxAdapter.js';

const log = createLogger('host.sandbox.e2b');

/** E2B control-plane host + the sandbox-host eTLD+1 the SSRF pin allows. Both under `e2b.dev`. */
const E2B_API = 'https://api.e2b.dev';
const E2B_ETLD1 = 'e2b.dev';

/** Dot-anchored containment (RFC 0120 apiHosts model): `e2b.dev` itself or any `*.e2b.dev`. */
function isE2bHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === E2B_ETLD1 || h.endsWith(`.${E2B_ETLD1}`);
}

/**
 * SSRF-guard a candidate E2B URL BEFORE egress (the connect-time dispatcher closes DNS-rebind the
 * string check can't). Enforces: https-only + host under `e2b.dev` + not a private/denied host.
 * Throws the scrubbed `sandbox_transport_error` (never echoing the URL, §D) on any violation.
 */
function assertE2bUrl(raw: string): void {
  let url: URL;
  try { url = new URL(raw); } catch { throw err('sandbox_transport_error', 'sandbox_transport_error'); }
  if (webhookPrivateEgressAllowed()) return; // local dev / tests: loopback mock allowed
  if (url.protocol !== 'https:') throw err('sandbox_transport_error', 'sandbox_transport_error');
  if (!isE2bHost(url.hostname)) throw err('sandbox_transport_error', 'sandbox_transport_error');
  if (isDeniedWebhookHost(url.hostname)) throw err('sandbox_transport_error', 'sandbox_transport_error');
}

interface E2bResponse {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

/**
 * The ONE centralized E2B request primitive: SSRF-pin the URL, then POST/DELETE JSON through the
 * egress dispatcher with the X-API-Key header + an AbortController timeout. Returns status + parsed
 * body (never throws on a non-2xx — the caller maps status→exit). CXE-1 posture identical to
 * `runSandboxedCode`. NOTE: header name / body field names are the operator-adjustable surface.
 */
async function e2bRequest(
  url: string,
  method: 'POST' | 'DELETE',
  key: string,
  timeoutMs: number,
  jsonBody?: unknown,
): Promise<E2bResponse> {
  assertE2bUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await undiciFetch(url, {
      method,
      // E2B authenticates team-level operations with `X-API-Key` (operator-validated).
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
      redirect: 'error',
      dispatcher: webhookEgressDispatcher(),
      signal: ctrl.signal,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function asString(v: unknown): string { return typeof v === 'string' ? v : ''; }
function asNumber(v: unknown, dflt: number): number { return typeof v === 'number' && Number.isFinite(v) ? v : dflt; }

function isE2bFile(v: unknown): v is { name: string; mimeType?: string; base64: string } {
  return typeof v === 'object' && v !== null
    && typeof (v as { name?: unknown }).name === 'string'
    && typeof (v as { base64?: unknown }).base64 === 'string';
}

/**
 * Centralized E2B-exec-response → `SandboxExecResult` mapping (the second operator-adjustable
 * surface). Tolerant of field-name drift: reads exitCode/stdout/stderr/timedOut/files defensively.
 */
function mapE2bExec(res: E2bResponse): SandboxExecResult {
  const b = res.body;
  const files = Array.isArray(b.files)
    ? b.files.filter(isE2bFile).map((f) => ({ name: f.name, mimeType: f.mimeType ?? 'application/octet-stream', base64: f.base64 }))
    : [];
  return {
    exitCode: asNumber(b.exitCode, res.ok ? 0 : 1),
    stdout: asString(b.stdout),
    stderr: asString(b.stderr),
    timedOut: b.timedOut === true,
    files,
  };
}

/**
 * ADR 0114 Phase 8 — run `req` in a fresh ephemeral E2B micro-VM (OQ-8a: one-sandbox-per-run):
 * create → exec → map → best-effort kill. Wrapped by `createSandboxRunner` (budget + concurrency),
 * so it does NOT bypass the Phase-5 daily budget or the CXE-4 cap.
 */
export async function runE2bSandboxedCode(req: SandboxExecRequest): Promise<SandboxExecResult> {
  // ADR 0556 P1 — metered inside the EXPORTED function so the reference
  // `resolveSandboxExecutor` hands out is unchanged (the Phase-8 selector tests
  // assert on it). One try/catch per executor rather than one wrapper around
  // all of them; the CLASSIFICATION still has a single owner
  // (`classifySandboxError`), which is the part that could drift.
  try {
    const result = await runE2bSandbox(req);
    recordSandboxExecution('e2b', result.timedOut ? 'timeout' : 'ok');
    return result;
  } catch (err_) {
    recordSandboxExecution('e2b', classifySandboxError(err_));
    throw err_;
  }
}

async function runE2bSandbox(req: SandboxExecRequest): Promise<SandboxExecResult> {
  const language = validateCodeRequest(req); // size caps + language allowlist BEFORE any egress
  const key = e2bApiKey();
  if (!key) throw err('capability_not_provided', 'no e2b api key configured.');

  return withSandboxConcurrency(async () => {
    const timeoutMs = Math.min(typeof req.timeoutMs === 'number' && req.timeoutMs > 0 ? req.timeoutMs : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    let sandboxId: string | undefined;
    try {
      // 1. Create an ephemeral sandbox (control plane). `timeout` is E2B's TTL in seconds.
      const created = await e2bRequest(`${E2B_API}/sandboxes`, 'POST', key, timeoutMs, {
        templateID: language, // operator-adjustable: E2B template id for the interpreter
        timeout: Math.max(1, Math.ceil(timeoutMs / 1000) + 5),
      });
      sandboxId = asString(created.body.sandboxID) || undefined;
      if (!created.ok || !sandboxId) throw err('sandbox_transport_error', 'sandbox_transport_error');
      // E2B returns the base domain for sandbox traffic; default to the pinned eTLD+1.
      const domain = asString(created.body.domain) || E2B_ETLD1;

      // 2. Run the code on the per-sandbox envd host (`<id>.<domain>`) — pinned under e2b.dev.
      const execUrl = `https://${sandboxId}.${domain}/exec`;
      const exec = await e2bRequest(execUrl, 'POST', key, timeoutMs, {
        language,
        code: req.code,
        ...(typeof req.stdin === 'string' ? { stdin: req.stdin } : {}),
      });
      const result = mapE2bExec(exec);
      // CXE-6 audit: language + exit + timed-out only — never code/stdin/host/key.
      log.info('code_exec_dispatched', { provider: 'e2b', language, exitCode: result.exitCode, timedOut: result.timedOut });
      return result;
    } catch (e) {
      // §D — never echo the sandbox host or the key; a timeout reads as a transport error.
      const aborted = e instanceof Error && e.name === 'AbortError';
      throw err('sandbox_transport_error', aborted ? 'sandbox_timeout' : 'sandbox_transport_error');
    } finally {
      // 3. Best-effort teardown (never surface a kill failure to the caller; never leak the host).
      if (sandboxId) {
        void e2bRequest(`${E2B_API}/sandboxes/${encodeURIComponent(sandboxId)}`, 'DELETE', key, timeoutMs)
          .catch(() => { /* best-effort: the TTL reaps the sandbox regardless */ });
      }
    }
  });
}
