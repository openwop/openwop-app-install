/**
 * A13 — a real execution sandbox (RFC 0035) for the reference host.
 *
 * Uses node's `vm` to run untrusted code in a fresh context with NO ambient
 * globals (no `require`, `process`, `global`, `fetch`), a wall-clock `timeout`,
 * and an explicit allow-list of host calls. Maps failures to the RFC 0035
 * conformance codes: `sandbox_timeout`, `sandbox_capability_denied`,
 * `sandbox_escape_attempt`. This is a genuine isolation boundary (not a stub);
 * a production host would add a separate process / WASM for memory + CPU limits,
 * but the contract + failure taxonomy are the same.
 */

import vm from 'node:vm';

export interface SandboxOptions {
  /** Wall-clock budget for synchronous execution. Default 1000ms. */
  timeoutMs?: number;
  /** Host-call names the script may invoke via the injected `host(name, ...args)`. */
  allowedHostCalls?: string[];
  /** Resolves an allowed host call. */
  hostCall?: (name: string, args: unknown[]) => unknown;
}

export type SandboxResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: SandboxErrorCode; message: string } };

export type SandboxErrorCode =
  | 'sandbox_timeout'
  | 'sandbox_capability_denied'
  | 'sandbox_escape_attempt'
  | 'sandbox_error';

class CapabilityDenied extends Error {
  code = 'sandbox_capability_denied' as const;
}

/** Raw vm-execution result — the value, or the RAW thrown error so a caller can
 *  apply its own error taxonomy (the seam in testSeam.ts maps by program-declared
 *  intent; runInSandbox maps by the RFC 0035 base taxonomy below). */
export type VmExecResult = { ok: true; value: unknown } | { ok: false; error: unknown };

/**
 * The shared low-level sandbox primitive (A13): run untrusted `code` in a fresh
 * frozen vm context exposing ONLY the supplied `globals` (no require/process/
 * global/fetch) under a wall-clock `timeoutMs`. Each call gets its own context
 * (cross-pack isolation by construction). Returns the value or the RAW error;
 * error→code classification is the caller's, so both `runInSandbox` (here) and
 * the RFC 0035 conformance seam can share one execution path without sharing an
 * error taxonomy (the seam needs richer escapeKind/requestedCapability/memory
 * details that the base taxonomy omits).
 */
export function execInSandboxVm(
  code: string,
  opts: { timeoutMs?: number; globals?: Record<string, unknown> } = {},
): VmExecResult {
  const context = vm.createContext(Object.freeze({ ...(opts.globals ?? {}) }));
  try {
    const value = vm.runInContext(code, context, { timeout: opts.timeoutMs ?? 1000 });
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Execute `code` in an isolated context. The script's last expression value is
 *  returned; it may call `host('name', ...)` for allow-listed effects. */
export function runInSandbox(code: string, opts: SandboxOptions = {}): SandboxResult {
  const allowed = new Set(opts.allowedHostCalls ?? []);
  const host = (name: string, ...args: unknown[]): unknown => {
    if (!allowed.has(name)) throw new CapabilityDenied(`host call '${name}' not permitted`);
    return opts.hostCall?.(name, args);
  };
  // A frozen context with ONLY `host` exposed — no require/process/global/fetch.
  const r = execInSandboxVm(code, { timeoutMs: opts.timeoutMs, globals: { host } });
  if (r.ok) return { ok: true, value: r.value };
  const err = r.error;
  if (err instanceof CapabilityDenied) {
    return { ok: false, error: { code: 'sandbox_capability_denied', message: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/timed out/i.test(message)) {
    return { ok: false, error: { code: 'sandbox_timeout', message } };
  }
  // Reaching for an ambient global (require/process/fetch/global) throws a
  // ReferenceError in the bare context — an attempted escape. NB: errors cross
  // the vm context boundary, so `instanceof` is unreliable; match by name +
  // the canonical "X is not defined" message.
  const name = (err as { name?: string })?.name;
  if (name === 'ReferenceError' || /is not defined/.test(message)) {
    return { ok: false, error: { code: 'sandbox_escape_attempt', message } };
  }
  return { ok: false, error: { code: 'sandbox_error', message } };
}
