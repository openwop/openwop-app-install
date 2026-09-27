/**
 * ADR 0305 Phase D — the interactive viewer: one screen at a time, navigateTo
 * tap-through via the delegated [data-cv-nav] handler, tab-strip fallback,
 * client-side theme override, and the empty state.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppBuilderInteractiveViewer } from '../AppBuilderInteractiveViewer.js';

afterEach(cleanup);

const APP = {
  name: 'Todo',
  theme: 'default',
  screens: [
    { id: 'home', name: 'HomeScreen', isInitial: true, components: [{ type: 'button', props: { label: 'Open list', navigateTo: 'list' } }] },
    { id: 'list', name: 'ListScreen', components: [{ type: 'text', props: { text: 'The list body' } }] },
  ],
};

const mount = (app: Record<string, unknown>, theme?: 'light' | 'dark') =>
  render(<MemoryRouter><AppBuilderInteractiveViewer app={app} {...(theme ? { themeOverride: theme } : {})} /></MemoryRouter>);

describe('AppBuilderInteractiveViewer', () => {
  it('renders the initial screen only', () => {
    const { container } = mount(APP);
    expect(container.textContent).toContain('Open list');
    expect(container.textContent).not.toContain('The list body');
  });

  it('navigateTo tap switches the active screen (delegated data-cv-nav)', () => {
    const { container } = mount(APP);
    const btn = container.querySelector('[data-cv-nav="list"]');
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(container.textContent).toContain('The list body');
    expect(container.textContent).not.toContain('Open list');
  });

  it('the screen-tab strip is the keyboard-accessible navigation fallback', () => {
    mount(APP);
    fireEvent.click(screen.getByRole('tab', { name: 'ListScreen' }));
    expect(screen.getByRole('tab', { name: 'ListScreen' }).getAttribute('aria-selected')).toBe('true');
  });

  it('a navigateTo pointing at a missing screen is a no-op', () => {
    const { container } = mount({ ...APP, screens: [{ ...APP.screens[0], components: [{ type: 'button', props: { label: 'Broken', navigateTo: 'ghost' } }] }] });
    fireEvent.click(container.querySelector('[data-cv-nav="ghost"]')!);
    expect(container.textContent).toContain('Broken');
  });

  it('themeOverride swaps the doc theme client-side', () => {
    const { container } = mount(APP, 'dark');
    expect(container.querySelector('.canvas-ab')?.getAttribute('data-theme')).toBe('dark');
  });

  it('renders the empty state when the doc has no screens', () => {
    const { container } = mount({ name: 'Empty', screens: [] });
    expect(container.querySelector('.cv-viewer')).toBeNull();
    expect(container.textContent?.length).toBeGreaterThan(0);
  });
});

describe('preview runtime (ADR 0345 3b)', () => {
  const RUNTIME_APP = {
    name: 'Runtime',
    stateVariables: [{ id: 'filter', type: 'string', initial: 'all' }],
    screens: [
      {
        id: 'home', name: 'Home', isInitial: true,
        components: [
          { type: 'text', props: { text: 'placeholder' }, bindings: { text: { path: 'state.filter', fallback: 'none' } } },
          { type: 'button', props: { label: 'Done filter' }, actions: [{ on: 'click', kind: 'set-state', state: 'filter', value: 'done' }] },
          { type: 'button', props: { label: 'Go next' }, actions: [{ on: 'click', kind: 'navigate', to: 'next' }] },
          { type: 'button', props: { label: 'Show terms' }, actions: [{ on: 'click', kind: 'open-modal', modal: 'terms' }] },
        ],
      },
      { id: 'next', name: 'Next', components: [{ type: 'text', props: { text: 'NEXT BODY' } }] },
      { id: 'terms', name: 'Terms', components: [{ type: 'text', props: { text: 'TERMS BODY' } }] },
    ],
  };
  it('state bindings render live values and set-state updates them', () => {
    const { container } = mount(RUNTIME_APP);
    expect(container.textContent).toContain('all'); // initial state, not the authored placeholder
    expect(container.textContent).not.toContain('placeholder');
    fireEvent.click(container.querySelector('[data-cv-act="1"]')!);
    expect(container.textContent).toContain('done');
  });
  it('a navigate ACTION switches screens through the runtime', () => {
    const { container } = mount(RUNTIME_APP);
    fireEvent.click(container.querySelector('[data-cv-act="2"]')!);
    expect(container.textContent).toContain('NEXT BODY');
  });
  it('open-modal overlays the frame as a dialog; Close dismisses it', () => {
    const { container } = mount(RUNTIME_APP);
    fireEvent.click(container.querySelector('[data-cv-act="3"]')!);
    const dialog = container.querySelector('.cv-viewer__modal');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('TERMS BODY');
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(container.querySelector('.cv-viewer__modal')).toBeNull();
  });

  it('renders semantic controls and keeps a declared two-way state binding interactive', () => {
    const app = {
      name: 'Form runtime',
      stateVariables: [{ id: 'email', type: 'string', initial: '' }],
      screens: [{ id: 'home', name: 'Home', isInitial: true, components: [
        { type: 'textInput', props: { label: 'Email', kind: 'email', placeholder: 'you@example.test' }, bindings: { value: { path: 'state.email' } } },
        { type: 'text', props: { text: 'empty' }, bindings: { text: { path: 'state.email', fallback: 'empty' } } },
      ] }],
    };
    mount(app);
    const input = screen.getByRole('textbox', { name: 'Email' });
    expect(input.tagName).toBe('INPUT');
    fireEvent.input(input, { target: { value: 'ada@example.test' } });
    expect(screen.getByText('ada@example.test')).toBeTruthy();
  });

  it('routes a native form submit through the declared closed submit action', () => {
    const app = {
      name: 'Submit runtime',
      stateVariables: [{ id: 'status', type: 'string', initial: 'draft' }],
      screens: [{ id: 'home', name: 'Home', isInitial: true, components: [
        { type: 'form', props: { title: 'Newsletter' }, actions: [{ on: 'submit', kind: 'set-state', state: 'status', value: 'sent' }], children: [
          { type: 'textInput', props: { label: 'Email' } },
          { type: 'button', props: { label: 'Subscribe' } },
          { type: 'text', props: { text: 'draft' }, bindings: { text: { path: 'state.status' } } },
        ] },
      ] }],
    };
    const { container } = mount(app);
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    const submit = screen.getByRole('button', { name: 'Subscribe' });
    expect(submit.getAttribute('type')).toBe('submit');
    // jsdom's fireEvent.click does not perform native form submission. The
    // semantic button type is asserted above; submit models the browser event
    // the viewer owns at its stage boundary.
    fireEvent.submit(form!);
    expect(screen.getByText('sent')).toBeTruthy();
  });
});
