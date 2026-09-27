/**
 * Phase 4 run-inputs helpers — the pure coercion/validation behind RunInputsDialog.
 * (The dialog wiring is UI; these are the testable invariants.)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { humanizeVariableName } from '../RunInputsForm.js';
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
  it('keeps the live region mounted when there is nothing missing', () => {
    // The trap: `{missing.length > 0 ? <p role="status">…</p> : null}` mounts the
    // region TOGETHER with its content, and a screen reader only announces
    // insertions into an ALREADY-PRESENT live region — so the hint was silent.
    // Asserting the attribute alone passes against the broken form; this asserts
    // the region exists even in the empty state, which is the actual fix.
    const src = readFileSync(join(import.meta.dirname, '..', 'RunInputsForm.tsx'), 'utf8');
    expect(src, 'the region must not be conditionally mounted').not.toMatch(
      /\{missing\.length > 0 \? \(\s*<p[^>]*role="status"/,
    );
    expect(src, 'the region is rendered unconditionally with conditional TEXT').toMatch(
      /<p[^>]*role="status"[\s\S]{0,120}missing\.length > 0 \?/,
    );
  });
});
