/**
 * P9 (2026-10-28) — untyped JSON under review reads as fields, not as a raw
 * `{ … }` dump. The Challenge Factory outline (saved untyped because its schema
 * copy lacked `alternatives`) and the run's final `{approvalId, state}` result
 * both reached the approver as JSON.
 *
 * What this pins: every field shows (nested and unknown ones too), strings stay
 * inert text, a submitted request reads as awaiting review and never as
 * published, a saved envelope uses a type's layout only when its payload has
 * that shape (and says it was not type-checked), and malformed JSON keeps the
 * text path.
 *
 * Sabotage that turns it red: routing JSON back to Markdown in AssetPreview;
 * dropping the awaiting-review line or mapping `submitted` to "Published";
 * removing the plan's `matches` (the envelope case falls to fields); letting a
 * matcher accept a payload with no days; rendering strings as HTML; removing
 * the item cap.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { AssetPreview } from '../AssetPreview.js';
import { humanizeKey } from '../ReadableJson.js';

afterEach(cleanup);

const plan = {
  title: 'Twenty-One Days of Focus', promise: 'Focus daily.', audience: 'Makers', durationDays: 21, dailyMinutesBudget: 20,
  outcomes: [{ outcomeId: 'o1', measurableOutcome: 'Five focus blocks a week', method: 'log' }],
  achievements: [],
  days: [
    { day: 1, stableActivityId: 'd1', title: 'First block', actionInstruction: 'Focus for 10 minutes.', userFacingWhy: 'Small wins.', estimatedMinutes: 10, achievementIds: [], evidencePolicy: 'note', claimRefs: [],
      alternatives: [{ stableActivityId: 'd1-alt', title: 'Walk instead', actionInstruction: 'Walk for 10 minutes.', evidencePolicy: 'note' }] },
  ],
};
const envelope = { plan, artifact: { artifactTypeId: 'kicktodo.challenge-plan', title: plan.title, payload: plan } };

const show = (value: unknown, extra: Record<string, unknown> = {}) =>
  render(<AssetPreview asset={{ content: JSON.stringify(value, null, 2), ...extra }} hideLabel />);

describe('ReadableJson — untyped JSON under review', () => {
  it('a submitted approval request reads as awaiting review, never as published', () => {
    show({ approvalId: 'appr:5fb0', state: 'submitted' });
    expect(screen.getByRole('status').textContent).toBe('Submitted and awaiting review. Not published yet.');
    expect(screen.getByText('Approval id')).toBeTruthy();
    expect(screen.getByText('appr:5fb0')).toBeTruthy();
    expect(screen.getByText('submitted')).toBeTruthy(); // the stored state is shown as stored
    expect(screen.queryByText(/^published$/i)).toBeNull();
    expect(screen.queryByText(/^\{/)).toBeNull();
  });

  it('a request in any other state is quoted, not interpreted', () => {
    show({ approvalId: 'appr:1', state: 'approved' });
    expect(screen.getByRole('status').textContent).toBe('Approval request: approved');
  });

  it('every field shows, nested and unknown ones included, with the stored key kept as the tooltip', () => {
    const { container } = show({ weirdField_x: 'kept', nested: { innerList: ['a', 'b'], empty: null } });
    expect(screen.getByText('Weird field x').getAttribute('title')).toBe('weirdField_x');
    expect(screen.getByText('kept')).toBeTruthy();
    expect(screen.getByText('Inner list')).toBeTruthy();
    expect(screen.getByText('a')).toBeTruthy();
    expect(screen.getByText('b')).toBeTruthy();
    expect(screen.getByText('Empty')).toBeTruthy();
    expect(container.querySelector('pre')).toBeNull(); // not a code dump
  });

  it('strings stay inert text: markup in a value is never rendered', () => {
    const { container } = show({ note: '<img src=x onerror="alert(1)"><a href="javascript:alert(1)">x</a>' });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeTruthy();
  });

  it('long collections say how much is cut, instead of hiding it silently', () => {
    show({ items: Array.from({ length: 105 }, (_, i) => `item ${i}`) });
    expect(screen.getByText('item 99')).toBeTruthy();
    expect(screen.queryByText('item 100')).toBeNull();
    expect(screen.getByText('5 more not shown. Open Raw to see everything.')).toBeTruthy();
  });

  it('malformed JSON keeps the text path (no partial field view)', () => {
    render(<AssetPreview asset={{ content: '{ "title": "half' }} hideLabel />);
    expect(screen.getByText(/"title": "half/)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a SAVED plan envelope uses the outline layout, says it was not type-checked, and keeps every field', () => {
    show(envelope);
    expect(screen.getByText(/Saved as plain data, so its format was not checked/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Twenty-One Days of Focus' })).toBeTruthy();
    expect(screen.getByText('Day 1: First block')).toBeTruthy();
    expect(screen.getByText('Walk instead: Walk for 10 minutes.')).toBeTruthy();
    const details = screen.getByText('All saved fields').closest('details')!;
    expect(within(details).getByText('Artifact type id')).toBeTruthy();
  });

  it('an envelope whose payload lacks the shape is NOT dressed up as that type', () => {
    show({ artifact: { artifactTypeId: 'kicktodo.challenge-plan', payload: { title: 'No days here' } } });
    expect(screen.queryByText(/format was not checked/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'No days here' })).toBeNull();
    expect(screen.getByText('No days here')).toBeTruthy(); // shown as a plain field
  });

  it('an envelope for a type with no shape matcher stays a field view', () => {
    show({ artifact: { artifactTypeId: 'kicktodo.plan-revision', payload: { commands: [], rationale: 'r' } } });
    expect(screen.queryByText(/format was not checked/)).toBeNull();
    expect(screen.getByText('Rationale')).toBeTruthy();
  });

  it('humanizes camel, snake and kebab keys', () => {
    expect(humanizeKey('approvalId')).toBe('Approval id');
    expect(humanizeKey('due_date')).toBe('Due date');
    expect(humanizeKey('stable-activity-id')).toBe('Stable activity id');
  });
});
