/**
 * ADR 1136 D2 — the driver decides the next browser operation from a scoped
 * accessibility snapshot. The executor holds the browser; the driver holds the
 * model. They meet only through `hostLoopAdapter`.
 *
 * The snapshot reaches the model as text with refs, capped, with the page's
 * own words fenced as untrusted (the MCP inbound rule, CLAUDE.md): a page that
 * says "ignore your instructions" is data, not a command.
 */
import type { ExecutorOp, PageSnapshot } from './executorProtocol.js';

export const SNAPSHOT_CAP_CHARS = 8_000;

export interface DriverStep {
  /** What the host recorded for this step. Labels never carry typed text. */
  label: string;
  outcome: 'done' | 'stale_ref' | 'uncertain' | 'refused' | 'error';
}

export type DriverDecision =
  | { kind: 'op'; op: ExecutorOp }
  | { kind: 'done'; summary: string }
  | { kind: 'fail'; error: string };

export interface BrowserDriver {
  next(input: { task: string; snapshot: string; history: readonly DriverStep[] }): Promise<DriverDecision>;
}

/** Render a snapshot for the model: elements first (they are what it acts on),
 *  then the page text, all under one cap. */
export function renderSnapshot(s: PageSnapshot, cap = SNAPSHOT_CAP_CHARS): string {
  const head = `Page: ${s.title}\nURL: ${s.url}\nElements:\n`;
  const lines = s.elements.map((e) => {
    const extra = [e.inputType ? `type=${e.inputType}` : '', e.submits ? 'submits' : '', e.href ? `href=${e.href}` : ''].filter(Boolean).join(' ');
    return `[${e.ref}] ${e.role} "${e.name.replace(/\s+/g, ' ').slice(0, 120)}"${extra ? ` (${extra})` : ''}`;
  });
  const body = `${lines.join('\n')}\n<UNTRUSTED source="page">\n${s.text}\n</UNTRUSTED>`;
  const out = head + body;
  if (out.length <= cap) return out;
  const marker = '\n…[snapshot truncated]\n</UNTRUSTED>';
  return out.slice(0, cap - marker.length) + marker;
}

/** A driver that replays fixed decisions. The reference for tests, and for any
 *  caller that wants the loop without a model. */
export function scriptedDriver(decisions: readonly DriverDecision[]): BrowserDriver & { seen: Array<{ snapshot: string; history: readonly DriverStep[] }> } {
  let i = 0;
  const seen: Array<{ snapshot: string; history: readonly DriverStep[] }> = [];
  return {
    seen,
    async next(input) {
      seen.push({ snapshot: input.snapshot, history: [...input.history] });
      return decisions[i++] ?? { kind: 'done', summary: 'script finished' };
    },
  };
}
