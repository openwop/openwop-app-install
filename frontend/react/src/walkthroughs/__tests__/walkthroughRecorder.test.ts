/**
 * ADR 0368 Phase 6a — the recorder core + the registry reverse-lookup: a
 * clicked element maps to its registered actionId (Tier-1), an unregistered
 * one records a describe-only stub (Tier-2), input VALUES are never captured
 * (PII), and the recorder's own chrome is ignored.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registerWalkthroughAction, findWalkthroughActionForElement, __resetWalkthroughRegistryForTests } from '../actionRegistry.js';
import { startRecording, stopRecording, isRecording, __resetRecorderForTests } from '../walkthroughRecorder.js';

beforeEach(() => {
  __resetWalkthroughRegistryForTests();
  __resetRecorderForTests();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/demo');
});
afterEach(() => __resetRecorderForTests());

describe('registry reverse-lookup (anti-rot core)', () => {
  it('matches an element (or its ancestor) to the registered action on the same route', () => {
    const btn = document.createElement('button');
    const inner = document.createElement('span');
    btn.appendChild(inner);
    document.body.appendChild(btn);
    registerWalkthroughAction('demo.go.click', { route: '/demo', resolve: () => btn, verb: 'click' });

    expect(findWalkthroughActionForElement(btn, '/demo')).toBe('demo.go.click');
    expect(findWalkthroughActionForElement(inner, '/demo')).toBe('demo.go.click'); // click on inner span
    expect(findWalkthroughActionForElement(btn, '/other')).toBeNull(); // wrong route
    expect(findWalkthroughActionForElement(document.createElement('a'), '/demo')).toBeNull(); // unregistered
  });

  it('a throwing resolve() never breaks the lookup', () => {
    registerWalkthroughAction('demo.bad', { route: '/demo', resolve: () => { throw new Error('boom'); }, verb: 'click' });
    expect(findWalkthroughActionForElement(document.createElement('button'), '/demo')).toBeNull();
  });
});

describe('tour recorder', () => {
  it('Tier-1: a click on a registered target records its actionId', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    registerWalkthroughAction('demo.go.click', { route: '/demo', resolve: () => btn, verb: 'click' });

    startRecording();
    expect(isRecording()).toBe(true);
    btn.click();
    const rec = stopRecording();
    expect(rec?.steps).toEqual([{ actionId: 'demo.go.click', route: '/demo', verb: 'click' }]);
    expect(isRecording()).toBe(false);
  });

  it('Tier-2: a click on an unregistered element records a describe-only stub (no actionId, never a value)', () => {
    const link = document.createElement('a');
    link.setAttribute('role', 'link');
    link.textContent = 'Somewhere';
    const wrap = document.createElement('div');
    wrap.setAttribute('data-walkthrough', 'nav');
    wrap.appendChild(link);
    document.body.appendChild(wrap);

    startRecording();
    link.click();
    const rec = stopRecording();
    expect(rec?.steps).toHaveLength(1);
    const step = rec!.steps[0]!;
    expect(step.actionId).toBeUndefined();
    expect(step.verb).toBe('click');
    expect(step.describe).toContain('link');
    expect(step.describe).toContain('[data-walkthrough=nav]');
  });

  it('NEVER captures the typed value on a fill (PII boundary)', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    registerWalkthroughAction('demo.name.fill', { route: '/demo', resolve: () => input, verb: 'fill' });

    startRecording();
    input.value = 'my secret name';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const rec = stopRecording();
    expect(rec?.steps).toEqual([{ actionId: 'demo.name.fill', route: '/demo', verb: 'fill' }]);
    // The value must not appear anywhere in the recording.
    expect(JSON.stringify(rec)).not.toContain('secret');
  });

  it('drops an unmatched click on a NON-interactive element (route-focus/text noise)', () => {
    const heading = document.createElement('h1');
    heading.textContent = 'Documents';
    document.body.appendChild(heading);
    startRecording();
    heading.click();                 // bare heading, no registered action, not interactive
    document.body.click();           // layout click
    const rec = stopRecording();
    expect(rec?.steps).toHaveLength(0);
  });

  it('keeps an unmatched click inside a data-walkthrough region or interactive control (a registerable anchor)', () => {
    const wrap = document.createElement('div');
    wrap.setAttribute('data-walkthrough', 'nav');
    const btn = document.createElement('button');
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
    startRecording();
    btn.click();
    const rec = stopRecording();
    expect(rec?.steps).toHaveLength(1);
    expect(rec!.steps[0]!.actionId).toBeUndefined(); // Tier-2 describe stub
  });

  it('no longer records focus events (route-focus for a11y is not a tour step)', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    startRecording();
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    const rec = stopRecording();
    expect(rec?.steps).toHaveLength(0);
  });

  it('ignores interactions inside the recorder chrome (data-walkthrough-recorder)', () => {
    const chrome = document.createElement('div');
    chrome.setAttribute('data-walkthrough-recorder', '');
    const stopBtn = document.createElement('button');
    chrome.appendChild(stopBtn);
    document.body.appendChild(chrome);

    startRecording();
    stopBtn.click();
    const rec = stopRecording();
    expect(rec?.steps).toHaveLength(0);
  });
});
