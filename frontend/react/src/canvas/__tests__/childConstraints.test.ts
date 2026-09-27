/** ADR 0344 2c — the shared adoption rule every FE gate consults. */
import { describe, it, expect } from 'vitest';
import { canAdopt } from '../childConstraints.js';

describe('canAdopt', () => {
  it('the frame root (null def) adopts anything', () => {
    expect(canAdopt(null, 'button', 999)).toBe(true);
  });
  it('a non-container adopts nothing', () => {
    expect(canAdopt({ acceptsChildren: false }, 'text', 0)).toBe(false);
    expect(canAdopt({}, 'text', 0)).toBe(false);
  });
  it('allowedChildTypes is a closed list', () => {
    const form = { acceptsChildren: true, allowedChildTypes: ['textInput', 'select'] };
    expect(canAdopt(form, 'textInput', 0)).toBe(true);
    expect(canAdopt(form, 'image', 0)).toBe(false);
  });
  it('maxChildren bounds the count', () => {
    const pair = { acceptsChildren: true, maxChildren: 2 };
    expect(canAdopt(pair, 'text', 1)).toBe(true);
    expect(canAdopt(pair, 'text', 2)).toBe(false);
  });
  it('an unconstrained container adopts freely', () => {
    expect(canAdopt({ acceptsChildren: true }, 'anything', 199)).toBe(true);
  });
});
