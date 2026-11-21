/**
 * ADR 0600 §2 (`ISU-10`: an approver sees what they are signing) — P9 of the
 * 2026-10-28 pass, commit `794157d40`. `GateEvidence` renders `AssetPreview`,
 * which now routes untyped JSON here: it reads as fields, not as a raw
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
 * ADR 1031 P2: the envelope cases ride the test-only `testOutlineRenderer`
 * fixture type (it was KickTodo's challenge-plan, now in its own package), so
 * the matcher is a FIXTURE; what is under test is that ReadableJson and the
 * registry APPLY it (`getReviewArtifactMatch`).
 *
 * Sabotage that turns it red: routing JSON back to Markdown in AssetPreview;
 * dropping the awaiting-review line or quoting a non-awaiting state as awaiting;
 * the registry ignoring a type's matcher (a shapeless payload, or a type with no
 * matcher, dressed up as the type); never matching an envelope; dropping the
 * "not checked" note or the "All saved fields" view; rendering strings as HTML;
 * removing the item cap; dropping the stored-key tooltip; humanizing without
 * kebab keys; parsing malformed JSON as an empty object. Measured by wave 79
 * sabotage probes and re-probed in wave 116 (w116g3-rj-*).
 *
 * Issue #5844 (an approval artifact reads as a document): a single wrapper key not
 * collapsed; checksums left on the face (the key rule and the hex rule are a DOUBLE
 * guard on the 64-hex `contentHash` fixture, so only breaking both reds); markdown
 * not rendered, or plain multi-line text rendered as markdown; the inert link or
 * image override removed; "All saved fields" dropped or missing the checksum.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { AssetPreview } from '../AssetPreview.js';
import { humanizeKey } from '../ReadableJson.js';
// ADR 1031 P2 — a fixture typed renderer (it was KickTodo's challenge-plan).
import { TEST_NO_MATCHER_TYPE, TEST_OUTLINE_TYPE } from './testOutlineRenderer.js';

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
const envelope = { plan, artifact: { artifactTypeId: TEST_OUTLINE_TYPE, title: plan.title, payload: plan } };

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
    // The fixture renderer is synchronous, so everything is asserted on the first paint.
    expect(screen.getAllByText(/Saved as plain data, so its format was not checked/)).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Twenty-One Days of Focus' }).tagName).toBe('H3');
    expect(screen.getByText('Day 1: First block').tagName).toBe('LI');
    const details = screen.getByText('All saved fields').closest('details');
    expect(details?.open).toBe(false);
    const all = within(details!);
    expect(all.getByText('Artifact type id')).toBeTruthy();
    // Every field, nested ones too: the day's alternative (the field whose loss sent this
    // outline down the untyped path) is kept, once under `plan` and once under the payload.
    expect(all.getAllByText('Walk for 10 minutes.')).toHaveLength(2);
    expect(all.getAllByText('d1-alt')).toHaveLength(2);
  });

  it('an envelope whose payload lacks the shape is NOT dressed up as that type', () => {
    show({ artifact: { artifactTypeId: TEST_OUTLINE_TYPE, payload: { title: 'No days here' } } });
    expect(screen.queryByText(/format was not checked/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'No days here' })).toBeNull();
    expect(screen.getByText('No days here')).toBeTruthy(); // shown as a plain field
  });

  it('an envelope for a type with no shape matcher stays a field view', () => {
    show({ artifact: { artifactTypeId: TEST_NO_MATCHER_TYPE, payload: { commands: [], rationale: 'r' } } });
    expect(screen.queryByText(/format was not checked/)).toBeNull();
    expect(screen.getByText('Rationale')).toBeTruthy();
  });

  it('humanizes camel, snake and kebab keys', () => {
    expect(humanizeKey('approvalId')).toBe('Approval id');
    expect(humanizeKey('due_date')).toBe('Due date');
    expect(humanizeKey('stable-activity-id')).toBe('Stable activity id');
  });
});

describe('issue 5844 — an approval artifact reads as a document, not a data dump', () => {
  const HASH = 'a'.repeat(64);
  it('a gate-bundled { artifact: { markdown, contentHash } } shows rendered markdown and no checksum on its face', () => {
    const { container } = show({ artifact: { markdown: '# Who buys it: Kitchen\n\nThe **buyer** is the household.', contentHash: HASH } });
    expect(container.querySelector('h1')?.textContent).toBe('Who buys it: Kitchen');
    expect(container.querySelector('strong')?.textContent).toBe('buyer');
    const roots = container.querySelectorAll('.readable-json-root');
    expect(roots).toHaveLength(1);
    const face = roots[0]!;
    // Exactly one "All saved fields" view, so a card that tidied nothing reds on the count.
    const allDetails = face.querySelectorAll('details');
    expect(allDetails).toHaveLength(1);
    const details = allDetails[0]!;
    const faceText = (face.textContent ?? '').replace(details.textContent ?? '', '');
    expect(faceText, 'no unrendered markdown on the face').not.toMatch(/# Who|\*\*/);
    expect(faceText, 'no checksum on the face').not.toContain(HASH);
    expect(faceText, 'the wrapper key is not a row').not.toMatch(/^Artifact/);
    expect(details.textContent, 'every saved field is still there').toContain(HASH);
  });

  it('markdown stays inert: a link shows as text and an image as its alt text', () => {
    const { container } = show({ markdown: '# T\n\nSee [the site](https://example.test/x) ![pixel](https://tracker.test/p.png)' });
    const prose = container.querySelectorAll('.readable-json__prose');
    expect(prose).toHaveLength(1);
    const face = prose[0]!;
    expect(face.querySelector('h1')?.textContent).toBe('T');
    expect(face.querySelectorAll('a')).toHaveLength(0);
    expect(face.querySelectorAll('img')).toHaveLength(0);
    // The link reads as its text plus its URL, the image as its bracketed alt text.
    expect(face.querySelector('p')?.textContent).toBe('See the site (https://example.test/x) [pixel]');
  });

  it('plain multi-line text keeps the text path', () => {
    const { container } = show({ note: 'line one\nline two' });
    expect(container.querySelectorAll('.readable-json__prose')).toHaveLength(0);
    // The field view's text span, with its line break kept rather than reflowed.
    const texts = container.querySelectorAll('.readable-json__text');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.textContent).toBe('line one\nline two');
  });
});
