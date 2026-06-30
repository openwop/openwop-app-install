/**
 * A13 — a real execution sandbox (RFC 0035) for the reference host.
 *
 * Runs untrusted code in a fresh `node:vm` context with NO ambient globals
 * (no `require`, `process`, `global`, `fetch`), a wall-clock `timeout`, and an
 * explicit allow-list of host calls. Maps failures to the RFC 0035 conformance
 * codes: `sandbox_timeout`, `sandbox_capability_denied`, `sandbox_escape_attempt`.
 *
 * Isolation hardening — why this is more than `vm.createContext({ host })`:
 *   `node:vm` is *not* escape-proof on its own. The classic break is the
 *   prototype chain of any value injected from the outer realm:
 *       host.constructor.constructor('return process')()   // → real process
 *   works whenever `host` (or `args`, or any injected object — or even an Error
 *   thrown by a host call) is an outer-realm object, because its `.constructor`
 *   is the OUTER `Function`, whose constructor compiles code in the outer realm.
 *   To close this we keep *every reference the sandbox can reach* inside the
 *   context's own realm:
 *     1. `host`/`args` are built INSIDE the context by a bootstrap script;
 *        the raw outer-realm bridge is captured in an IIFE closure (never a
 *        reachable property) and then deleted from the global.
 *     2. The bridge ALWAYS returns a JSON envelope *string*. Host-call results
 *        are re-parsed by the context's own `JSON.parse`, and a thrown host-call
 *        error is carried across as `{ok:false}` and re-thrown as an IN-CONTEXT
 *        `Error` — so even `try { host.x() } catch (e) { e.constructor... }`
 *        stays in-realm.
 *   With both in place, `*.constructor.constructor('return process')()` resolves
 *   to the context `Function`, where `process` is undefined → ReferenceError,
 *   which the taxonomy classifies as `sandbox_escape_attempt` (proven in
 *   `test/sandbox.test.ts`). This is a genuine isolation boundary for code
 *   confidentiality. A production host running *adversarial multi-tenant* code
 *   would still add a separate process / WASM / `isolated-vm` for hard memory +
 *   CPU limits — but the in-realm contract and failure taxonomy are the same.
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

/** A host-call dispatcher: given a call name + positional args, return a
 *  JSON-serializable value (or undefined). May throw to signal a denied/failed
 *  call — the thrown error is carried across the realm boundary and re-thrown
 *  in-context for the caller to classify. */
export type SandboxDispatch = (name: string, args: unknown[]) => unknown;

export interface GuardedSandboxOptions {
  timeoutMs?: number;
  /** Resolves `host(name, ...args)` / `host.name(...args)` calls. */
  dispatch?: SandboxDispatch;
  /** Data exposed in-context as the read-only `args` global (deep-cloned). */
  args?: unknown;
}

/**
 * The shared low-level sandbox primitive (A13): run untrusted `code` in a fresh
 * `node:vm` context whose ONLY reachable bindings are an in-context `host`
 * dispatcher and a cloned-in `args` value. Both are constructed inside the
 * context (see the file header) so no outer-realm reference is reachable — the
 * prototype-chain escape is closed by construction. Returns the value or the
 * RAW error; error→code classification is the caller's, so both `runInSandbox`
 * (here) and the RFC 0035 conformance seam can share one execution path without
 * sharing an error taxonomy.
 *
 * `host` supports both call shapes: `host('kv.get', 'k')` and `host.kv_get('k')`;
 * each routes to `dispatch(name, argsArray)`. Host-call results AND thrown
 * host-call errors are JSON round-tripped across the realm boundary.
 */
export function execGuardedSandboxVm(code: string, opts: GuardedSandboxOptions = {}): VmExecResult {
  const dispatch = opts.dispatch;
  const context = vm.createContext({});
  // The raw outer-realm bridge: enforces nothing itself — it ALWAYS returns a
  // JSON envelope STRING (never a live object, never a thrown error) so that
  // EVERYTHING re-entering the sandbox is reconstructed by the context's own
  // JSON.parse / Error — never an outer-realm object whose prototype chain
  // (`.constructor.constructor`) could be walked back to the host `Function`.
  Object.defineProperty(context, '__openwopBridge__', {
    value: (name: string, args: unknown[]): string => {
      try {
        const out = dispatch ? dispatch(name, args) : undefined;
        // value:undefined is dropped by JSON.stringify → parsed back to undefined.
        return JSON.stringify({ ok: true, value: out });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const code = (e as { code?: unknown })?.code;
        return JSON.stringify({ ok: false, message, code: typeof code === 'string' ? code : undefined });
      }
    },
    configurable: true,
  });
  Object.defineProperty(context, '__openwopArgs__', {
    value: opts.args === undefined ? undefined : JSON.stringify(opts.args),
    configurable: true,
  });
  // Bootstrap: capture the raw bridge + args in an IIFE closure (so they are
  // never reachable as a property), build the in-context `host`/`args`, then
  // delete the raw globals. After this runs, sandbox code can reach only
  // context-native objects — including any Error raised from a host call.
  const bootstrap = `(function (__bridge__, __rawArgs__) {
    const call = (name, a) => {
      const env = JSON.parse(__bridge__(name, a));
      if (!env.ok) { const err = new Error(env.message); if (env.code) err.code = env.code; throw err; }
      return env.value;
    };
    Object.defineProperty(globalThis, 'host', {
      value: new Proxy(function () {}, {
        apply(_t, _this, a) { return call(String(a[0]), a.slice(1)); },
        get(_t, prop) { if (typeof prop !== 'string') return undefined; return (...a) => call(prop, a); },
      }),
    });
    Object.defineProperty(globalThis, 'args', {
      value: __rawArgs__ === undefined ? undefined : JSON.parse(__rawArgs__),
    });
  })(__openwopBridge__, __openwopArgs__);
  delete globalThis.__openwopBridge__; delete globalThis.__openwopArgs__;`;
  try {
    vm.runInContext(bootstrap, context, { timeout: opts.timeoutMs ?? 1000 });
    const value = vm.runInContext(code, context, { timeout: opts.timeoutMs ?? 1000 });
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Execute `code` in an isolated context. The script's last expression value is
 *  returned; it may call `host('name', ...)` (or `host.name(...)`) for
 *  allow-listed effects. Hardened against prototype-chain escapes via
 *  `execGuardedSandboxVm` — see the file header. */
export function runInSandbox(code: string, opts: SandboxOptions = {}): SandboxResult {
  const allowed = new Set(opts.allowedHostCalls ?? []);
  const dispatch: SandboxDispatch = (name, args) => {
    if (!allowed.has(name)) throw new CapabilityDenied(`host call '${name}' not permitted`);
    return opts.hostCall?.(name, args);
  };
  const r = execGuardedSandboxVm(code, { timeoutMs: opts.timeoutMs, dispatch });
  if (r.ok) return { ok: true, value: r.value };
  const err = r.error;
  const message = err instanceof Error ? err.message : String(err);
  // A capability-denied throw from `dispatch` is carried across the bridge and
  // re-thrown as an IN-CONTEXT Error stamped with `.code` (so it is NOT a
  // `CapabilityDenied` instance anymore — `instanceof` across the vm realm is
  // unreliable). Classify by the preserved code.
  if ((err as { code?: unknown })?.code === 'sandbox_capability_denied') {
    return { ok: false, error: { code: 'sandbox_capability_denied', message } };
  }
  if (/timed out/i.test(message)) {
    return { ok: false, error: { code: 'sandbox_timeout', message } };
  }
  // Reaching for an ambient global (require/process/fetch/global) — or walking a
  // constructor chain that now resolves to the bare in-context realm — throws a
  // ReferenceError ("X is not defined"): an attempted escape. NB: errors cross
  // the vm context boundary, so `instanceof` is unreliable; match by name +
  // the canonical "X is not defined" message.
  const name = (err as { name?: string })?.name;
  if (name === 'ReferenceError' || /is not defined/.test(message)) {
    return { ok: false, error: { code: 'sandbox_escape_attempt', message } };
  }
  return { ok: false, error: { code: 'sandbox_error', message } };
}
