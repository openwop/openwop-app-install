import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { A2uiSurfaceCard } from '../A2uiSurfaceCard.js';
import { A2UI_V09_CATALOG_ID } from '../v09/profile.js';
import { foldSurface, setAt, getAt } from '../v09/fold.js';
import { a2uiInterruptCard } from '../interruptBridge.js';
import type { CardProps } from '../../registry/types.js';

afterEach(cleanup);

/** RFC 0209 §C.9–§C.10 renderer behaviour (ADR 0749): the fold, data binding,
 *  the confined actions, and the positive fixture from the corpus. */
const ctx: CardProps['context'] = { runId: 'run-1', nodeId: 'node-1', tenantId: 'demo' };
const SID = 'approve-brief';
const POSITIVE = {
  version: 'v0.9', catalogId: A2UI_V09_CATALOG_ID, surfaceId: SID,
  messages: [
    { version: 'v0.9', createSurface: { surfaceId: SID, catalogId: A2UI_V09_CATALOG_ID } },
    { version: 'v0.9', updateComponents: { surfaceId: SID, components: [
      { id: 'root', component: 'Column', children: ['h', 'name', 'submit'] },
      { id: 'h', component: 'Text', text: 'Launch brief', variant: 'h2' },
      { id: 'name', component: 'TextField', label: 'Product name', value: { path: '/name' },
        checks: [{ condition: { call: 'required', args: { value: { path: '/name' } } }, message: 'Required' }] },
      { id: 'submit_label', component: 'Text', text: 'Submit' },
      { id: 'submit', component: 'Button', child: 'submit_label',
        action: { event: { name: 'resume', context: { name: { path: '/name' } } } } },
    ] } },
    { version: 'v0.9', updateDataModel: { surfaceId: SID, value: { name: '' } } },
  ],
};

function renderCard(p: unknown) {
  const onAction = vi.fn().mockResolvedValue(undefined);
  render(<A2uiSurfaceCard payload={p} cardType="ui.a2ui-surface" context={ctx} onAction={onAction} />);
  return onAction;
}

describe('the v0.9 fold', () => {
  it('upserts components by id, sets and removes data at a JSON Pointer, and ignores messages before createSurface', () => {
    const s = foldSurface([{ ...POSITIVE, messages: [
      { version: 'v0.9', updateDataModel: { surfaceId: SID, value: { ignored: true } } },
      ...POSITIVE.messages,
      { version: 'v0.9', updateComponents: { surfaceId: SID, components: [{ id: 'h', component: 'Text', text: 'Renamed' }] } },
      { version: 'v0.9', updateDataModel: { surfaceId: SID, path: '/a~1b', value: 1 } },
    ] } as never]);
    expect(s.renderable).toBe(true);
    expect((s.components.get('h') as { text: string }).text).toBe('Renamed');
    expect(s.dataModel).toEqual({ name: '', 'a/b': 1 });
    expect(getAt(setAt({ x: { y: 1 } }, '/x/y', undefined), '/x')).toEqual({});
  });
  it('never walks the prototype chain', () => {
    expect(setAt({}, '/__proto__/polluted', true)).toEqual({});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('the v0.9 renderer', () => {
  it('renders the corpus positive fixture; the required check gates the resume action; the action submits the resolved context', () => {
    const onAction = renderCard(POSITIVE);
    expect(screen.getByRole('heading', { name: 'Launch brief' })).toBeTruthy();
    const btn = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Product name/), { target: { value: 'Orbit' } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledWith('resolve', { name: 'Orbit' });
  });

  it('a failing required check gates resume but never an exchange (asking a question needs no complete form)', () => {
    const p = { ...POSITIVE, messages: [...POSITIVE.messages, { version: 'v0.9', updateComponents: { surfaceId: SID, components: [
      { id: 'root', component: 'Column', children: ['h', 'name', 'submit', 'ask'] },
      { id: 'ask_l', component: 'Text', text: 'Ask' },
      { id: 'ask', component: 'Button', child: 'ask_l', action: { event: { name: 'exchange' } } },
    ] } }] };
    renderCard(p);
    expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('an exchange action with no context submits the whole data model', () => {
    const p = { ...POSITIVE, messages: [
      POSITIVE.messages[0],
      { version: 'v0.9', updateComponents: { surfaceId: SID, components: [
        { id: 'root', component: 'Row', children: ['ok', 'go'] },
        { id: 'ok', component: 'CheckBox', label: 'Looks good', value: { path: '/ok' } },
        { id: 'go_l', component: 'Text', text: 'Send' },
        { id: 'go', component: 'Button', child: 'go_l', action: { event: { name: 'exchange' } } },
      ] } },
      { version: 'v0.9', updateDataModel: { surfaceId: SID, path: '/ok', value: false } },
    ] };
    const onAction = renderCard(p);
    fireEvent.click(screen.getByLabelText(/Looks good/));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onAction).toHaveBeenCalledWith('exchange', { ok: true });
  });

  it('agent headings never reach the document outline as real h1–h3', () => {
    renderCard({ ...POSITIVE, messages: [POSITIVE.messages[0], { version: 'v0.9', updateComponents: { surfaceId: SID, components: [
      { id: 'root', component: 'Text', text: 'Hijack', variant: 'h1' },
    ] } }] });
    expect(document.querySelector('h1, h2, h3')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Hijack' }).getAttribute('aria-level')).toBe('4');
  });

  it('a component cycle renders once and terminates', () => {
    renderCard({ ...POSITIVE, messages: [POSITIVE.messages[0], { version: 'v0.9', updateComponents: { surfaceId: SID, components: [
      { id: 'root', component: 'Column', children: ['c'] },
      { id: 'c', component: 'Card', child: 'root' },
    ] } }] });
    expect(document.querySelectorAll('.u-border').length).toBe(1);
  });

  it('an out-of-profile surface fails closed with the unsafe notice', () => {
    renderCard({ ...POSITIVE, messages: [POSITIVE.messages[0], { version: 'v0.9', updateComponents: { surfaceId: SID, components: [
      { id: 'root', component: 'Image', url: 'https://evil.example/x.png' },
    ] } }] });
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(/could not be rendered safely/)).toBeTruthy();
  });

  it('chips are named, pressed toggles inside the labelled group; a bound ISO date seeds the native input; a `constructor` id is just an id', () => {
    renderCard({ ...POSITIVE, messages: [POSITIVE.messages[0], { version: 'v0.9', updateComponents: { surfaceId: SID, components: [
      { id: 'root', component: 'Column', children: ['size', 'when', 'constructor'] },
      { id: 'size', component: 'ChoicePicker', label: 'Size', variant: 'mutuallyExclusive', displayStyle: 'chips', options: [{ label: 'S', value: 's' }, { label: 'M', value: 'm' }], value: { path: '/size' } },
      { id: 'when', component: 'DateTimeInput', label: 'When', value: { path: '/when' } },
      { id: 'constructor', component: 'TextField', label: 'Notes' },
    ] } }, { version: 'v0.9', updateDataModel: { surfaceId: SID, value: { size: ['m'], when: '2026-09-24T10:00:00Z' } } }] });
    expect(screen.getByRole('group', { name: 'Size' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'M' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('When') as HTMLInputElement).value).toBe('2026-09-24');
    expect((screen.getByLabelText('Notes') as HTMLInputElement).value).toBe('');
  });

  it('a vertical Divider in a Row is a visible rule: unwrapped, stretched to the row (end grade-ux)', () => {
    renderCard({ ...POSITIVE, messages: [POSITIVE.messages[0], { version: 'v0.9', updateComponents: { surfaceId: SID, components: [
      { id: 'root', component: 'Row', children: ['a', 'rule', 'b'] },
      { id: 'a', component: 'Text', text: 'Left' },
      { id: 'rule', component: 'Divider', axis: 'vertical' },
      { id: 'b', component: 'Text', text: 'Right' },
    ] } }] });
    // A block wrapper would give the rule a content height of 0 — no line at all.
    const rule = screen.getByRole('separator');
    expect(rule.parentElement?.className).toContain('u-flex-row');
    expect(rule.className).toContain('u-self-stretch');
  });

  it('the 0.9.1 tree still renders beside it (legacy-readable)', () => {
    renderCard({ catalogVersion: '0.9.1', surface: { components: [{ component: 'text', text: 'Legacy text' }] } });
    expect(screen.getByText('Legacy text')).toBeTruthy();
  });
});

describe('interrupt bridge', () => {
  it('carries a v0.9 payload from interrupt data, dropping the free-text fallback', () => {
    const card = a2uiInterruptCard({ data: { question: 'Details?', ...POSITIVE } });
    expect(card?.payload).toEqual(POSITIVE);
  });
  it('carries several envelopes of one surface as `surfaces`', () => {
    expect(a2uiInterruptCard({ data: { surfaces: [POSITIVE] } })?.payload).toEqual({ surfaces: [POSITIVE] });
  });
});
