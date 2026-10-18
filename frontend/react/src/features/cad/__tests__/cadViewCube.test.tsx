/**
 * CAD-R2-1 — the orientation widget (view cube). The invariants worth pinning:
 *   - the cube is HONEST: only sufficiently front-facing faces are offered
 *     (both polarities — visible faces are buttons, culled faces are absent)
 *   - a face click snaps to that axis view (Top/Bottom keep the current yaw)
 *   - the 90° arrows clamp pitch at ±EL_MAX and mirror the viewer's OWN
 *     keyboard-arrow directions; home returns to HOME_AZ/HOME_EL
 *   - integrated: orbiting Cad3dView then pressing home restores the exact
 *     initial projection (the scene, not just the state)
 */
import { describe, it, expect, afterEach, vi, type Mock } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { CadViewCube } from '../CadViewCube.js';
import { Cad3dView } from '../Cad3dView.js';
import { HOME_AZ, HOME_EL } from '../cad3d.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const HOME = { az: HOME_AZ, el: HOME_EL };
// Expected values are LITERALS, never the module's own constants: the ¾ home
// view is (-0.6, -0.45) and the pitch clamp is exactly ±π/2 (the header's
// "honest Top/Bottom" contract). Compared at a fixed precision — computed
// floats are never matched with ===.
const AZ0 = -0.6, EL0 = -0.45, QUARTER = Math.PI / 2;
type OnView = (az: number, el: number) => void;
const onViewFn = (): Mock<OnView> => vi.fn<OnView>();
/** Assert the LAST (az, el) the cube asked for, to 9 decimals. */
const expectView = (fn: Mock<OnView>, az: number, el: number): void => {
  const call = fn.mock.calls.at(-1);
  expect(call, 'onView was never called').toBeDefined();
  expect(call![0]).toBeCloseTo(az, 9);
  expect(call![1]).toBeCloseTo(el, 9);
};

describe('CadViewCube faces — honest culling + snap', () => {
  it('offers ONLY the front-facing faces at the home view (both polarities)', () => {
    render(<CadViewCube {...HOME} onView={() => {}} />);
    for (const visible of ['front', 'right', 'bottom']) {
      expect(screen.getByRole('button', { name: new RegExp(`${visible} view`, 'i') })).toBeTruthy();
    }
    for (const culled of ['back', 'left', 'top']) {
      expect(screen.queryByRole('button', { name: new RegExp(`${culled} view`, 'i') })).toBeNull();
    }
  });

  it('a face click snaps to that axis view; Top/Bottom keep the current yaw', () => {
    const onView = onViewFn();
    render(<CadViewCube {...HOME} onView={onView} />);
    fireEvent.click(screen.getByRole('button', { name: /front view/i }));
    expectView(onView, 0, 0);
    fireEvent.click(screen.getByRole('button', { name: /bottom view/i }));
    expectView(onView, AZ0, -QUARTER); // yaw preserved, straight up from below
  });

  it('a face is keyboard-operable (Enter)', () => {
    const onView = onViewFn();
    render(<CadViewCube {...HOME} onView={onView} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /right view/i }), { key: 'Enter' });
    expect(onView).toHaveBeenCalledTimes(1);
    expectView(onView, -QUARTER, 0);
  });
});

describe('CadViewCube arrows + home', () => {
  it('arrows step 90° matching the viewer keyboard mapping, pitch clamped at ±EL_MAX', () => {
    const onView = onViewFn();
    const { unmount } = render(<CadViewCube {...HOME} onView={onView} />);
    fireEvent.click(screen.getByRole('button', { name: /rotate left/i }));
    expectView(onView, AZ0 - QUARTER, EL0);
    fireEvent.click(screen.getByRole('button', { name: /rotate right/i }));
    expectView(onView, AZ0 + QUARTER, EL0);
    fireEvent.click(screen.getByRole('button', { name: /tilt up/i }));
    expectView(onView, AZ0, -QUARTER); // -0.45 - π/2 clamps to -π/2
    fireEvent.click(screen.getByRole('button', { name: /tilt down/i }));
    expectView(onView, AZ0, EL0 + QUARTER); // -0.45 + π/2 is inside the clamp
    unmount();
    // From a steep pitch, Tilt down clamps at the OTHER bound: 1.1 + π/2 → +π/2.
    render(<CadViewCube az={AZ0} el={1.1} onView={onView} />);
    fireEvent.click(screen.getByRole('button', { name: /tilt down/i }));
    expectView(onView, AZ0, QUARTER);
  });

  it('home returns to the shared ¾ view from anywhere', () => {
    const onView = onViewFn();
    render(<CadViewCube az={2.2} el={1.1} onView={onView} />);
    fireEvent.click(screen.getByRole('button', { name: /reset to the home view/i }));
    expect(onView).toHaveBeenCalledTimes(1);
    expectView(onView, AZ0, EL0);
  });
});

describe('Cad3dView integration', () => {
  it('orbit then home restores the EXACT initial projection', () => {
    const { container } = render(
      <Cad3dView solids={[{ kind: 'box', width: 40, height: 30, depth: 20 }]} label="model" />,
    );
    const svg = container.querySelector('.canvas-cad__svg')!;
    const initial = svg.innerHTML;
    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    const yawed = svg.innerHTML;
    expect(yawed).not.toBe(initial); // the yaw actually moved the scene
    // Pitch too, so Home must restore BOTH axes of the camera.
    fireEvent.keyDown(svg, { key: 'ArrowUp' });
    expect(svg.innerHTML).not.toBe(yawed);
    fireEvent.click(screen.getByRole('button', { name: /reset to the home view/i }));
    expect(svg.innerHTML).toBe(initial);
  });
});
