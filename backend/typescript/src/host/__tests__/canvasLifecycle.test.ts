/**
 * Canvas-lifecycle seam tests (ADR 0334 DATA-1) — keyed registration, best-effort
 * fan-out that never throws, and the event shape consumers gate on.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { onCanvasDeleted, fireCanvasDeleted, __resetCanvasLifecycleHooks } from '../canvasLifecycle.js';

afterEach(() => __resetCanvasLifecycleHooks());

const evt = { tenantId: 't1', canvasId: 'c1', canvasTypeId: 'canvas.document' };

describe('canvas lifecycle seam', () => {
  it('runs every registered handler with the event and returns the count', async () => {
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});
    onCanvasDeleted('a', a);
    onCanvasDeleted('b', b);
    expect(await fireCanvasDeleted(evt)).toBe(2);
    expect(a).toHaveBeenCalledWith(evt);
    expect(b).toHaveBeenCalledWith(evt);
  });

  it('is keyed — a repeat registration overwrites (no duplicate fan-out)', async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    onCanvasDeleted('same', first);
    onCanvasDeleted('same', second);
    expect(await fireCanvasDeleted(evt)).toBe(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('is best-effort — a throwing handler never blocks the others or the delete', async () => {
    const ok = vi.fn(async () => {});
    onCanvasDeleted('boom', async () => { throw new Error('cleanup failed'); });
    onCanvasDeleted('ok', ok);
    await expect(fireCanvasDeleted(evt)).resolves.toBe(1); // only the ok handler counted
    expect(ok).toHaveBeenCalledOnce();
  });

  it('reset clears all registrations', async () => {
    onCanvasDeleted('x', async () => {});
    __resetCanvasLifecycleHooks();
    expect(await fireCanvasDeleted(evt)).toBe(0);
  });
});
