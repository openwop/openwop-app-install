/**
 * Run-inputs helpers (ADR 0184 line, reusable-workflow Phase 4) — the coercion /
 * validation behind RunInputsDialog, the ADR 0507 deferred-name humanizer, and the
 * SESS-4 (/grade-ux 2026-08-01) always-mounted missing-fields live region.
 *
 * Red under: sending whitespace or NaN as an input, treating `false` as unanswered or a
 * blank string as answered, raw (unstringified) defaults, not stripping — or
 * over-stripping — the 12-hex deferred prefix, and mounting the status region together
 * with its text (probes w32g3-ri-*).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { humanizeVariableName, RunInputsDialog } from '../RunInputsForm.js';
import { initialRunInputValues, toRunInputs, missingRequired } from '../RunInputsForm.js';
import type { RunVariable } from '../../workflows/workflowsClient.js';

const vars: RunVariable[] = [
  { name: 'topic', type: 'string', required: true },
  { name: 'limit', type: 'number', required: false, defaultValue: 10 },
  { name: 'dryRun', type: 'boolean', required: false, defaultValue: true },
  { name: 'note', type: 'string', required: false },
];

describe('initialRunInputValues', () => {
  it('seeds from defaults and gives booleans a definite state', () => {
    const v = initialRunInputValues(vars);
    expect(v.topic).toBe('');       // no default → empty
    expect(v.limit).toBe('10');     // number default stringified for the input
    expect(v.dryRun).toBe(true);    // boolean default
    expect(v.note).toBe('');
  });
});

describe('missingRequired', () => {
  it('flags a required field left blank, clears once answered', () => {
    expect(missingRequired(vars, initialRunInputValues(vars)).map((x) => x.name)).toEqual(['topic']);
    expect(missingRequired(vars, { topic: 'launch', limit: '', dryRun: false })).toEqual([]);
  });
  it('does not flag a required boolean set to false (false is an answer)', () => {
    const req: RunVariable[] = [{ name: 'ack', type: 'boolean', required: true }];
    expect(missingRequired(req, { ack: false })).toEqual([]);
  });
});

describe('toRunInputs', () => {
  it('coerces numbers, keeps booleans, drops empty optionals so defaults apply', () => {
    const out = toRunInputs(vars, { topic: 'launch', limit: '25', dryRun: false, note: '  ' });
    expect(out).toEqual({ topic: 'launch', limit: 25, dryRun: false });
    expect('note' in out).toBe(false); // blank optional dropped → variable default applies
  });
  it('drops a non-numeric number field rather than sending NaN', () => {
    const out = toRunInputs(vars, { topic: 'x', limit: 'abc', dryRun: true });
    expect('limit' in out).toBe(false);
    expect(out.dryRun).toBe(true);
  });
});

// Day-1 UX P12/F1 — field labels humanize the wire name; the submission key
// is untouched (toRunInputs still keys by the raw name).

describe('humanizeVariableName', () => {
  it('spaces camelCase / snake / kebab and sentence-cases', () => {
    expect(humanizeVariableName('attendeeCompanyId')).toBe('Attendee company id');
    // The exact names a chat refusal showed raw on production (2026-10-02).
    expect(humanizeVariableName('lighthouse_lead_triage_a64874f5f94a_senderEmail')).toBe('Sender email');
    expect(humanizeVariableName('lighthouse_lead_triage_a64874f5f94a_recipientEmail')).toBe('Recipient email');
    expect(humanizeVariableName('meeting_context')).toBe('Meeting context');
    expect(humanizeVariableName('time-min')).toBe('Time min');
    expect(humanizeVariableName('topic')).toBe('Topic');
  });
});

describe('ADR 0507 — deferred variable names are not shown raw', () => {
  it('strips the chain/expansion prefix RFC 0124 materialisation adds', () => {
    // Before: "Finance invoice ap a2ec352bceed invoice text" — a hex id in a label.
    expect(humanizeVariableName('finance_invoice_ap_a2ec352bceed_invoiceText')).toBe('Invoice text');
    expect(humanizeVariableName('campaign_journeys_welcome_series_9f2c11ab77de_senderEmail')).toBe('Sender email');
  });

  it('leaves an ordinary underscored name alone', () => {
    // The strip is anchored on a 12-hex segment precisely so this stays intact.
    expect(humanizeVariableName('sender_email')).toBe('Sender email');
    expect(humanizeVariableName('orgId')).toBe('Org id');
    expect(humanizeVariableName('my_deadbeef_value')).toBe('My deadbeef value');
  });
});

describe('SESS-4 — the missing-fields hint is an ANNOUNCEABLE live region', () => {
  afterEach(cleanup);

  it('keeps the live region mounted when there is nothing missing', async () => {
    // The trap: `{missing.length > 0 ? <p role="status">…</p> : null}` mounts the
    // region TOGETHER with its content, and a screen reader only announces
    // insertions into an ALREADY-PRESENT live region — so the hint was silent.
    // Behavioural check: the SAME status node exists while a field is missing AND
    // after it is answered (identity, not just presence), with only its text changing.
    render(createElement(RunInputsDialog, {
      workflowName: 'W',
      variables: [{ name: 'topic', type: 'string', required: true }],
      onRun: () => undefined,
      onCancel: () => undefined,
    }));
    const region = screen.getByRole('status');
    expect(region.textContent, 'the hint is shown while the required field is empty').not.toBe('');
    await act(async () => { fireEvent.change(screen.getByRole('textbox'), { target: { value: 'launch' } }); });
    expect(screen.getByRole('status'), 'the region must survive with nothing missing').toBe(region);
    expect(region.textContent).toBe('');
  });
});
