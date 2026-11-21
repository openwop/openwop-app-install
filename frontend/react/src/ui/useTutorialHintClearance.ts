/** Shell-owned clearance for the one contextual tutorial offer (ADR 0488/0768).
 * Measure the rendered hint, not a copied tutorial height or JS breakpoint.
 * Body inheritance also reaches the existing ChatPocket body portal. */
import { useLayoutEffect, type RefObject } from 'react';

const PROPERTY = '--tutorial-hint-occupied-bottom';
const owners = new Map<symbol, number>();
let body: HTMLElement | null = null;
let priorValue = '';
let priorPriority = '';
let lastValue: string | null = null;

function stillOwnsProperty(): boolean {
  return body !== null && lastValue !== null
    && body.style.getPropertyValue(PROPERTY) === lastValue
    && body.style.getPropertyPriority(PROPERTY) === '';
}
function publish(): void {
  if (!body || (lastValue !== null && !stillOwnsProperty())) return;
  const value = `${Math.max(0, ...owners.values())}px`;
  if (value !== lastValue) body.style.setProperty(PROPERTY, value);
  lastValue = value;
}
function register(): { update: (value: number) => void; release: () => void } {
  if (owners.size === 0) {
    body = document.body;
    priorValue = body.style.getPropertyValue(PROPERTY);
    priorPriority = body.style.getPropertyPriority(PROPERTY);
    lastValue = null;
  }
  const owner = Symbol('tutorial-hint');
  owners.set(owner, 0);
  return {
    update(value) {
      if (!owners.has(owner)) return;
      owners.set(owner, Number.isFinite(value) ? Math.max(0, value) : 0);
      publish();
    },
    release() {
      if (!owners.delete(owner)) return;
      if (owners.size > 0) { publish(); return; }
      if (body && stillOwnsProperty()) {
        if (priorValue) body.style.setProperty(PROPERTY, priorValue, priorPriority);
        else body.style.removeProperty(PROPERTY);
      }
      body = null; lastValue = null;
    },
  };
}

export function useTutorialHintClearance(ref: RefObject<HTMLElement>, offered: boolean): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!offered || !element) return;
    const owner = register();
    let live = true;
    const measure = (): void => {
      if (!live) return;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const bottom = Number.parseFloat(style.bottom);
      const visible = element.isConnected && style.display !== 'none'
        && style.visibility !== 'hidden' && style.visibility !== 'collapse' && rect.width > 0 && rect.height > 0;
      // The hint's bottom depends on navigation only, never on this property.
      owner.update(visible ? rect.height + (Number.isFinite(bottom) ? Math.max(0, bottom) : 0) : 0);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', measure);
    return () => {
      live = false;
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      viewport?.removeEventListener('resize', measure);
      owner.release();
    };
  }, [ref, offered]);
}
