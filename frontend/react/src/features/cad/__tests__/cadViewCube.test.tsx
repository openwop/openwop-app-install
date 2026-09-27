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
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { CadViewCube } from '../CadViewCube.js';
import { Cad3dView } from '../Cad3dView.js';
import { EL_MAX, HOME_AZ, HOME_EL } from '../cad3d.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const HOME = { az: HOME_AZ, el: HOME_EL };

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
    const onView = vi.fn();
    render(<CadViewCube {...HOME} onView={onView} />);
    fireEvent.click(screen.getByRole('button', { name: /front view/i }));
    expect(onView).toHaveBeenLastCalledWith(0, 0);
    fireEvent.click(screen.getByRole('button', { name: /bottom view/i }));
    expect(onView).toHaveBeenLastCalledWith(HOME_AZ, -EL_MAX); // yaw preserved
  });

  it('a face is keyboard-operable (Enter)', () => {
    const onView = vi.fn();
    render(<CadViewCube {...HOME} onView={onView} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /right view/i }), { key: 'Enter' });
    expect(onView).toHaveBeenCalledWith(-Math.PI / 2, 0);
  });
});

describe('CadViewCube arrows + home', () => {
  it('arrows step 90° matching the viewer keyboard mapping, pitch clamped at ±EL_MAX', () => {
    const onView = vi.fn();
    render(<CadViewCube {...HOME} onView={onView} />);
    fireEvent.click(screen.getByRole('button', { name: /rotate left/i }));
    expect(onView).toHaveBeenLastCalledWith(HOME_AZ - Math.PI / 2, HOME_EL);
    fireEvent.click(screen.getByRole('button', { name: /tilt up/i }));
    expect(onView).toHaveBeenLastCalledWith(HOME_AZ, -EL_MAX); // -0.45 - π/2 clamps
  });

  it('home returns to the shared ¾ view from anywhere', () => {
    const onView = vi.fn();
    render(<CadViewCube az={2.2} el={1.1} onView={onView} />);
    fireEvent.click(screen.getByRole('button', { name: /reset to the home view/i }));
    expect(onView).toHaveBeenCalledWith(HOME_AZ, HOME_EL);
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
    expect(svg.innerHTML).not.toBe(initial); // the orbit actually moved the scene
    fireEvent.click(screen.getByRole('button', { name: /reset to the home view/i }));
    expect(svg.innerHTML).toBe(initial);
  });
});
