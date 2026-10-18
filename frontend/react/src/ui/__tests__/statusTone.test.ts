import { describe, it, expect } from 'vitest';
import { statusTone } from '../StatusBadge.js';

describe('statusTone', () => {
  it('passes through the CSS-defined status classes', () => {
    for (const s of ['completed', 'failed', 'cancelled', 'running', 'paused', 'waiting-approval', 'waiting-input']) {
      expect(statusTone(s)).toBe(s);
    }
  });

  it('maps synonyms onto a colored class (not the dead status-* tones)', () => {
    expect(statusTone('succeeded')).toBe('completed');
    expect(statusTone('error')).toBe('failed');
    expect(statusTone('waiting')).toBe('waiting-approval');
    expect(statusTone('in-progress')).toBe('waiting-approval');
    // Every synonym the map carries, not four of twelve (w49 probe
    // `tone-success-syn`: dropping 'success' stayed green). Literals, never derived.
    for (const s of ['success', 'done', 'active']) expect(statusTone(s), s).toBe('completed');
    for (const s of ['suspended', 'input-required', 'needs-reconsent', 'expired']) expect(statusTone(s), s).toBe('waiting-approval');
    expect(statusTone('revoked')).toBe('cancelled');
  });

  it('is case-insensitive', () => {
    expect(statusTone('COMPLETED')).toBe('completed');
  });

  it('returns empty (base muted) for unknown statuses', () => {
    expect(statusTone('zonk')).toBe('');
  });
});
