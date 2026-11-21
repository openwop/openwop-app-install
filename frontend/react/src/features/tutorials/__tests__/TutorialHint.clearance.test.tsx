/** Measured ownership/lifecycle only. Rectangles are controlled test data;
 * physical overlap and real CSS remain the separate Chromium viewport oracle. */
import { StrictMode, useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { useTutorialHintClearance } from '../../../ui/useTutorialHintClearance.js';
type Client = typeof import('../tutorialsClient.js');
const client = vi.hoisted(() => ({
  fetchTutorialProgress: vi.fn<Client['fetchTutorialProgress']>(),
  saveTutorialProgress: vi.fn<Client['saveTutorialProgress']>(),
  fetchTutorials: vi.fn<Client['fetchTutorials']>(), fetchTutorial: vi.fn<Client['fetchTutorial']>(),
}));
vi.mock('../tutorialsClient.js', () => client);
import { TutorialHint } from '../TutorialHint.js';

const PROPERTY = '--tutorial-hint-occupied-bottom';
const metrics = new Map<string, { height: number; visible: boolean }>();
class Observer implements ResizeObserver {
  static instances: Observer[] = [];
  target: Element | null = null;
  constructor(private callback: ResizeObserverCallback) { Observer.instances.push(this); }
  observe(target: Element): void { this.target = target; }
  unobserve(): void {}
  disconnect(): void {}
  notify(): void { this.callback([], this); }
}
function Host({ id, offered = true, bottom = 12 }: { id: string; offered?: boolean; bottom?: number }) {
  const ref = useRef<HTMLElement>(null);
  useTutorialHintClearance(ref, offered);
  return <aside ref={ref} data-owner={id} style={{ bottom }} />;
}
const value = (): string => document.body.style.getPropertyValue(PROPERTY);
let stylesheet: HTMLStyleElement;
beforeEach(() => {
  metrics.clear(); Observer.instances = [];
  vi.stubGlobal('ResizeObserver', Observer);
  vi.stubGlobal('visualViewport', new EventTarget());
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const row = metrics.get(this.dataset.owner ?? 'tutorial') ?? { height: 0, visible: false };
    return new DOMRect(0, 0, row.visible ? 200 : 0, row.visible ? row.height : 0);
  });
  stylesheet = document.createElement('style');
  stylesheet.textContent = '.tutorial-hint { position: fixed; bottom: 12px; }';
  document.head.append(stylesheet);
  localStorage.removeItem('openwop-app.tutorials.hintsDismissed');
  client.fetchTutorialProgress.mockResolvedValue({ ok: true, persisted: false, rows: [] });
});
afterEach(() => {
  cleanup(); stylesheet.remove();
  document.body.style.removeProperty(PROPERTY);
  localStorage.removeItem('openwop-app.tutorials.hintsDismissed');
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('tutorial hint occupied-bottom ownership', () => {
  it('registers the actual offered tutorial and releases its clearance when dismissed', () => {
    metrics.set('tutorial', { height: 74, visible: true });
    render(<MemoryRouter initialEntries={['/funnels']}><TutorialHint /></MemoryRouter>);
    expect(screen.getByRole('complementary', { name: 'Tutorial suggestion' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Teach me this' }).getAttribute('href')).toBe('/tutorials/build-your-first-funnel');
    expect(value()).toBe('86px');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('complementary', { name: 'Tutorial suggestion' })).toBeNull();
    expect(value()).toBe('');
    act(() => { for (const observer of Observer.instances) observer.notify(); });
    expect(value()).toBe('');
  });

  it('does not reserve space for a route with no offered tutorial', () => {
    metrics.set('tutorial', { height: 74, visible: true });
    render(<MemoryRouter initialEntries={['/not-a-tutorial-surface']}><TutorialHint /></MemoryRouter>);
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(value()).toBe('');
    expect(Observer.instances).toHaveLength(0);
  });

  it('retains the remaining owner maximum and restores the prior inline value and priority', () => {
    document.body.style.setProperty(PROPERTY, '9px', 'important');
    expect(document.body.style.getPropertyPriority(PROPERTY)).toBe('important');
    metrics.set('small', { height: 20, visible: true }); metrics.set('large', { height: 60, visible: true });
    const small = render(<Host id="small" />);
    const large = render(<Host id="large" />);
    expect(value()).toBe('72px');
    large.unmount();
    expect(value()).toBe('32px');
    small.unmount();
    expect(value()).toBe('9px');
    expect(document.body.style.getPropertyPriority(PROPERTY)).toBe('important');
  });

  it('updates height, hidden state and unchanged-height bottom offsets from real resize seams', () => {
    metrics.set('one', { height: 40, visible: true });
    const view = render(<Host id="one" />);
    expect(value()).toBe('52px');
    metrics.set('one', { height: 80, visible: true });
    act(() => { for (const observer of Observer.instances) observer.notify(); });
    expect(value()).toBe('92px');
    view.rerender(<Host id="one" bottom={24} />);
    fireEvent(window, new Event('resize'));
    expect(value()).toBe('104px');
    metrics.set('one', { height: 80, visible: false });
    act(() => { window.visualViewport?.dispatchEvent(new Event('resize')); });
    expect(value()).toBe('0px');
    metrics.set('one', { height: 30, visible: true });
    act(() => { window.visualViewport?.dispatchEvent(new Event('resize')); });
    expect(value()).toBe('54px');
  });

  it('neutralizes old callbacks after a StrictMode owner leaves while another owner stays live', () => {
    metrics.set('first', { height: 70, visible: true }); metrics.set('second', { height: 20, visible: true });
    const first = render(<StrictMode><Host id="first" /></StrictMode>);
    const second = render(<StrictMode><Host id="second" /></StrictMode>);
    const old = Observer.instances.filter((observer) => observer.target instanceof HTMLElement && observer.target.dataset.owner === 'first');
    expect(old.length).toBeGreaterThan(0);
    expect(value()).toBe('82px');
    first.unmount();
    expect(value()).toBe('32px');
    metrics.set('first', { height: 400, visible: true });
    act(() => { for (const observer of old) observer.notify(); });
    expect(value()).toBe('32px');
    second.unmount();
    act(() => { for (const observer of Observer.instances) observer.notify(); });
    expect(value()).toBe('');
  });

  it('preserves a later foreign inline writer instead of erasing it during callback or cleanup', () => {
    metrics.set('one', { height: 40, visible: true });
    const view = render(<Host id="one" />);
    expect(value()).toBe('52px');
    document.body.style.setProperty(PROPERTY, '111px', 'important');
    expect(document.body.style.getPropertyPriority(PROPERTY)).toBe('important');
    metrics.set('one', { height: 50, visible: true });
    act(() => { for (const observer of Observer.instances) observer.notify(); });
    expect(value()).toBe('111px');
    view.unmount();
    expect(value()).toBe('111px');
    expect(document.body.style.getPropertyPriority(PROPERTY)).toBe('important');
  });
});
