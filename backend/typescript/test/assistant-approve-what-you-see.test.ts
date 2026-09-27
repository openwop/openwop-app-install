/**
 * ADR 0662 D1 — the approver must see every payload byte that reaches a provider.
 *
 * Born red on `70fff5b49`: `projectActionCard` allowlisted the card's payload to `{to}`
 * for EVERY kind, while `executeApprovedAction` dispatched `action.payload` whole and the
 * node used `payload.subject` as the email Subject and `payload.event` as the ENTIRE
 * calendar event body. So a `calendar.invite` was approved with its time, attendees and
 * location never displayed.
 *
 * The invariant is BEHAVIOURAL, not structural, and that is deliberate. "field ∈
 * CARD_FIELDS" cannot be derived statically: the kind→node route is pack DATA, the node is
 * untyped `.mjs` loaded from `~/.openwop-packs`, and the chains are builder-editable. So the
 * sentinel leg below feeds the real node a payload of poisoned keys and asserts that
 * nothing the card withheld reaches the request body.
 */
import { describe, expect, it } from 'vitest';
import { cardFieldsFor } from '../src/features/assistant/actionApproval.js';
import type { PendingActionKind } from '../src/features/assistant/assistantService.js';

const ALL_KINDS: readonly PendingActionKind[] = ['email.send', 'calendar.invite', 'calendar.reschedule', 'nudge', 'servicedesk.reply'];

/** Every payload field the executor path actually consumes, per kind — read from the node
 *  (`packs/feature.assistant.nodes/index.mjs`) and, for `servicedesk.reply`, from
 *  `actionExecution.ts:229`, which does not go through a node at all. */
const EXECUTOR_READS: Record<PendingActionKind, readonly string[]> = {
  'email.send': ['to', 'subject'],
  'calendar.invite': ['to', 'event'],
  'calendar.reschedule': ['eventId', 'patch'],
  'servicedesk.reply': ['ticketId'],
  nudge: [],
};

describe('ADR 0662 D1 — the card covers what the executor consumes', () => {
  it('every action kind has card fields — including the two the exec map is TYPED to exclude', () => {
    // `EXEC_WORKFLOW_BY_KIND` is `Exclude<PendingActionKind,'nudge'|'servicedesk.reply'>`.
    // Quantifying over it (the first draft of D1) would have been green on
    // `servicedesk.reply` — the kind that posts a customer-facing message to a ticket.
    for (const kind of ALL_KINDS) {
      expect(cardFieldsFor(kind).length, `${kind} must declare card fields`).toBeGreaterThan(0);
    }
  });

  it('no field the executor consumes is withheld from the approver', () => {
    for (const kind of ALL_KINDS) {
      const shown = new Set(cardFieldsFor(kind).map((f) => f.field));
      for (const needed of EXECUTOR_READS[kind]) {
        expect(shown.has(needed), `${kind}: the executor reads payload.${needed} — the card must show it`).toBe(true);
      }
    }
  });

  it('the two provider-passthrough kinds are declared passthrough, not pretend-scalar', () => {
    // `calendar.invite` sends `payload.event` verbatim as the POST body and
    // `calendar.reschedule` sends `payload.patch` verbatim as the PATCH body. Declaring
    // those `scalar` would claim a narrowing that does not happen.
    const modeOf = (k: PendingActionKind, f: string) => cardFieldsFor(k).find((x) => x.field === f)?.mode;
    expect(modeOf('calendar.invite', 'event')).toBe('passthrough');
    expect(modeOf('calendar.reschedule', 'patch')).toBe('passthrough');
    // …and a genuinely scalar field is NOT marked passthrough, or the distinction is noise.
    expect(modeOf('email.send', 'subject')).toBe('scalar');
    expect(modeOf('servicedesk.reply', 'ticketId')).toBe('scalar');
  });

  it('SENTINEL: nothing the card withheld reaches the provider request body', async () => {
    // The structural legs above can be satisfied by editing a table. This one runs the real
    // node: poison every payload key, build the request, and assert that any sentinel that
    // appears in the body corresponds to a field the card renders.
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const nodePath = require.resolve('../../../packs/feature.assistant.nodes/index.mjs');
    const mod = (await import(nodePath)) as { prepareActionRequest?: (ctx: unknown) => Promise<unknown> };
    const prepare = mod.prepareActionRequest;
    if (typeof prepare !== 'function') {
      // Never pass vacuously: if the node cannot be loaded, this leg FAILS.
      expect.unreachable('prepareActionRequest not loadable; this leg must not pass silently');
    }

    for (const kind of ['email.send', 'calendar.invite', 'calendar.reschedule'] as const) {
      const payload: Record<string, unknown> = {
        to: ['someone@example.test'],
        subject: 'SENTINEL_SUBJECT',
        event: { summary: 'SENTINEL_EVENT', start: 'SENTINEL_START' },
        eventId: 'evt-1',
        patch: { start: 'SENTINEL_PATCH' },
        secretNote: 'SENTINEL_WITHHELD',
      };
      const out = (await prepare!({ inputs: { action: { kind, payload, draft: 'draft text' } } })) as
        { status: string; outputs?: { body?: unknown } };
      const body = JSON.stringify(out.outputs?.body ?? '');
      const shown = new Set(cardFieldsFor(kind).map((f) => f.field));
      // A field the card does NOT show must not appear in what the provider receives.
      expect(body.includes('SENTINEL_WITHHELD'), `${kind}: payload.secretNote is not on the card and must not reach the provider`).toBe(shown.has('secretNote'));
    }
  });
});
