/**
 * TOCU-6 (ADR 0604) + review M9 — the witness `ToolCallCard` never had.
 *
 * TOCU-6 shipped a real fix (three hardcoded English literals removed from a
 * live path) with NO test anywhere — no `ToolCallCard` test, no `toolErr` test
 * — while ADR 0604 §5 carries a witness row for every other change in the
 * batch. It then built the key dynamically, which made
 * `chat:toolErr_forbidden` and `chat:toolErr_invalid_args` ORPHANS to
 * `check-i18n`: nothing verified they existed, and `/cleanup` deletes orphans
 * by name. A hardcoded-English defect had been traded for a gate-invisible one.
 *
 * Two properties, and the second is the one with teeth:
 *   1. each known code renders its own localized sentence;
 *   2. an UNKNOWN code renders the generic sentence and NEVER the raw machine
 *      token as the message — the whole point of TOCU-6. (The code itself is
 *      still shown deliberately, as the `<strong>` prefix, so an operator can
 *      report it; what must not happen is the code standing in for prose.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { ToolCallCard, toolErrorMessage } from '../AgentEventCards.js';
import { messages as en } from '../i18n/en.js';
import type { AgentToolCall } from '../hooks/useChatSession.js';

afterEach(cleanup);

function call(over: Partial<AgentToolCall> = {}): AgentToolCall {
  return {
    callId: 'c1',
    toolName: 'openwop:documents.get',
    agentId: 'a1',
    startedAt: new Date(Date.now() - 1000).toISOString(),
    finishedAt: new Date().toISOString(),
    ...over,
  } as AgentToolCall;
}

/** The real `t` for the `chat` namespace, so the assertions are about the
 *  CATALOG and not about a stub that would pass with the keys deleted. */
const catalog = new Map<string, string>();
for (const [k, v] of Object.entries(en)) if (typeof v === 'string') catalog.set(k, v);
const t = (k: string): string => catalog.get(k) ?? `MISSING:${k}`;

describe('tool-call error copy (TOCU-6 / review M9)', () => {
  it('anti-vacuity — every key the switch can reach exists in the en catalog', () => {
    // Without this the tests below could pass on `MISSING:` sentinels.
    for (const k of ['toolErr_forbidden', 'toolErr_invalid_args', 'toolErrGeneric']) {
      expect(t(k), `${k} is not in chat/i18n/en.ts`).not.toMatch(/^MISSING:/);
      expect(t(k).length).toBeGreaterThan(5);
    }
  });

  it('each known code maps to its OWN sentence, not the generic one', () => {
    expect(toolErrorMessage(t, 'forbidden')).toBe(en.toolErr_forbidden);
    expect(toolErrorMessage(t, 'invalid_args')).toBe(en.toolErr_invalid_args);
    expect(toolErrorMessage(t, 'forbidden')).not.toBe(en.toolErrGeneric);
    expect(toolErrorMessage(t, 'invalid_args')).not.toBe(en.toolErrGeneric);
  });

  it('an UNKNOWN code falls back to the generic sentence, never a bare token', () => {
    for (const code of ['tool_timeout', 'quota_exceeded', '', undefined]) {
      const msg = toolErrorMessage(t, code as string | undefined);
      expect(msg).toBe(en.toolErrGeneric);
      expect(msg).not.toMatch(/^MISSING:/);
      if (code) expect(msg).not.toBe(code);
    }
  });

  /** The card's detail sits behind a collapsed disclosure; open it. */
  function renderOpened(c: AgentToolCall): void {
    render(<ToolCallCard call={c} />);
    fireEvent.click(screen.getByRole('button'));
  }

  it('renders the sentence in the card for a known code', () => {
    renderOpened(call({ error: { code: 'forbidden' } }));
    expect(screen.getByText(/forbidden/)).toBeTruthy(); // the code prefix, deliberately kept
    expect(screen.getByText(en.toolErr_forbidden)).toBeTruthy();
  });

  it('renders the GENERIC sentence for a code nobody has translated', () => {
    renderOpened(call({ error: { code: 'some_new_transport_status' } }));
    expect(screen.getByText(en.toolErrGeneric)).toBeTruthy();
  });

  it('a transport-supplied message WINS over the catalog sentence', () => {
    const supplied = 'The upstream provider returned 503 after 3 attempts.';
    renderOpened(call({ error: { code: 'forbidden', message: supplied } }));
    expect(screen.getByText(supplied)).toBeTruthy();
    expect(screen.queryByText(en.toolErr_forbidden)).toBeNull();
  });
});
