/**
 * ADR 1136 D1/D2/D4 — the browser-executor protocol.
 *
 * An executor is the thing that holds a real browser: the desktop shell pane,
 * the companion's Playwright Chromium (lane A), or a CDP endpoint (lane B). The
 * host never drives Chromium itself. It sends one operation at a time and reads
 * a page as a scoped accessibility snapshot whose elements carry refs.
 *
 * Rules taken from OpenCode's browser plugin (ADR 1136 "How OpenCode does it"):
 *  - every result is validated against its operation's output shape, and a
 *    result that fails is a typed `bad_result`, never retried;
 *  - an operation that timed out is never replayed;
 *  - `replaced` is terminal: a second attach for the same key retires the first;
 *  - refs belong to the page they were read on and go stale on navigation;
 *  - control frames carry ids only, never arguments.
 *
 * Non-normative: nothing here is on the OpenWOP wire (ADR 1136 D9).
 */

export const EXECUTOR_PROTOCOL_VERSION = 1;

export type ExecutorOp =
  | { op: 'snapshot' }
  | { op: 'screenshot' }
  | { op: 'scroll'; dy: number }
  | { op: 'navigate'; url: string }
  | { op: 'click'; ref: string }
  | { op: 'type'; ref: string; text: string }
  | { op: 'press'; ref: string; key: 'Enter' | 'Tab' | 'Escape' };

export type ExecutorOpName = ExecutorOp['op'];

/** One element of a snapshot, as the executor reports it. The tier table reads
 *  these fields only (ADR 1136 D3). */
export interface ElementReport {
  ref: string;
  role: string;
  name: string;
  /** For textboxes: the input's `type` attribute (`password`, `email`, …). */
  inputType?: string;
  /** The `autocomplete` token (`one-time-code`, `cc-number`, …). */
  autocomplete?: string;
  /** True when activating it submits a form. */
  submits?: boolean;
  /** For links: the absolute target URL. */
  href?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: ElementReport[];
  /** Visible text, as the executor scoped it. Untrusted page content. */
  text: string;
}

export type ExecutorErrorCode =
  /** A ref the current page does not have (it went stale on navigation). */
  | 'stale_ref'
  /** The operation did not finish in time. It is never replayed. */
  | 'timeout'
  /** The executor refused the URL on its own (private, loopback, credentialed). */
  | 'navigation_refused'
  /** No browser is attached any more. */
  | 'detached'
  /** Another executor attached for the same key. Terminal. */
  | 'replaced'
  /** The result did not match its operation's shape. Never retried. */
  | 'bad_result';

export type ExecutorResult =
  | { ok: true; snapshot?: PageSnapshot }
  | { ok: false; error: ExecutorErrorCode };

export interface BrowserExecutor {
  readonly executorId: string;
  readonly protocolVersion: number;
  /** `replaced` and `detached` are terminal for this executor. */
  state(): 'attached' | 'replaced' | 'detached';
  /** Perform one operation. The raw result is validated by the caller
   *  (`validateResult`), so an executor cannot smuggle an unchecked shape in. */
  perform(op: ExecutorOp, opts: { timeoutMs: number }): Promise<unknown>;
  markReplaced(): void;
}

const ERROR_CODES: ReadonlySet<string> = new Set<ExecutorErrorCode>([
  'stale_ref', 'timeout', 'navigation_refused', 'detached', 'replaced', 'bad_result',
]);

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

function parseElement(raw: unknown): ElementReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (!isStr(e.ref, 64) || !e.ref || !isStr(e.role, 64) || !isStr(e.name, 500)) return null;
  for (const k of ['inputType', 'autocomplete', 'href'] as const) {
    if (e[k] !== undefined && !isStr(e[k], 2048)) return null;
  }
  if (e.submits !== undefined && typeof e.submits !== 'boolean') return null;
  return {
    ref: e.ref, role: e.role, name: e.name,
    ...(e.inputType !== undefined ? { inputType: e.inputType as string } : {}),
    ...(e.autocomplete !== undefined ? { autocomplete: e.autocomplete as string } : {}),
    ...(e.submits !== undefined ? { submits: e.submits as boolean } : {}),
    ...(e.href !== undefined ? { href: e.href as string } : {}),
  };
}

const MAX_ELEMENTS = 2_000;
const MAX_TEXT = 200_000;

export function parseSnapshot(raw: unknown): PageSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!isStr(s.url, 4096) || !isStr(s.title, 1000) || !isStr(s.text, MAX_TEXT)) return null;
  if (!Array.isArray(s.elements) || s.elements.length > MAX_ELEMENTS) return null;
  const elements: ElementReport[] = [];
  const refs = new Set<string>();
  for (const r of s.elements) {
    const e = parseElement(r);
    if (!e || refs.has(e.ref)) return null;
    refs.add(e.ref);
    elements.push(e);
  }
  return { url: s.url, title: s.title, text: s.text, elements };
}

/** Which operations must return a page (the rest return none). */
const RETURNS_SNAPSHOT: Record<ExecutorOpName, boolean> = {
  snapshot: true,
  screenshot: false,
  scroll: false,
  navigate: true,
  click: false,
  type: false,
  press: false,
};

/** Validate a raw executor result against its operation's output shape. */
export function validateResult(op: ExecutorOp, raw: unknown): ExecutorResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'bad_result' };
  const r = raw as Record<string, unknown>;
  if (r.ok === false) {
    return typeof r.error === 'string' && ERROR_CODES.has(r.error) && Object.keys(r).length === 2
      ? { ok: false, error: r.error as ExecutorErrorCode }
      : { ok: false, error: 'bad_result' };
  }
  if (r.ok !== true) return { ok: false, error: 'bad_result' };
  const wants = RETURNS_SNAPSHOT[op.op];
  if (!wants) return r.snapshot === undefined && Object.keys(r).length === 1 ? { ok: true } : { ok: false, error: 'bad_result' };
  const snapshot = parseSnapshot(r.snapshot);
  return snapshot && Object.keys(r).length === 2 ? { ok: true, snapshot } : { ok: false, error: 'bad_result' };
}

export type ControlFrame =
  | { type: 'attach'; executorId: string; protocolVersion: number }
  | { type: 'detach'; executorId: string }
  | { type: 'replaced'; executorId: string };

/** A control frame carries ids only. Anything else (an argument, a URL, text)
 *  is refused, so the control channel can never be used to drive the page. */
export function parseControlFrame(raw: unknown): ControlFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  if (!isStr(f.executorId, 128) || !/^[A-Za-z0-9_-]{1,128}$/.test(f.executorId)) return null;
  const keys = Object.keys(f).sort().join(',');
  if (f.type === 'attach') {
    return keys === 'executorId,protocolVersion,type' && f.protocolVersion === EXECUTOR_PROTOCOL_VERSION
      ? { type: 'attach', executorId: f.executorId, protocolVersion: EXECUTOR_PROTOCOL_VERSION }
      : null;
  }
  if ((f.type === 'detach' || f.type === 'replaced') && keys === 'executorId,type') return { type: f.type, executorId: f.executorId };
  return null;
}
