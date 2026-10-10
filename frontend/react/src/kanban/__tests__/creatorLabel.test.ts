import { describe, it, expect } from 'vitest';
import { creatorLabel } from '../KanbanBoardView.js';

describe('creatorLabel — the card\'s "who" line never prints a raw id (ADR 0785, 2026-10-05)', () => {
  it('the viewer\'s own canonical id reads as "You"', () => {
    expect(creatorLabel('user:460db9a9-46cf-4158-a143-3d568682704a', 'user:460db9a9-46cf-4158-a143-3d568682704a', 'You')).toBe('You');
  });
  it('someone else\'s id is not shown (an id is not a name)', () => {
    expect(creatorLabel('user:460db9a9-46cf-4158-a143-3d568682704a', 'user:other', 'You')).toBeNull();
    expect(creatorLabel('oidc:abc123', undefined, 'You')).toBeNull();
    expect(creatorLabel('anon:xyz', 'user:me', 'You')).toBeNull();
  });
  it('free text (a name, a channel) is shown as written; absent is nothing', () => {
    expect(creatorLabel('Discord', 'user:me', 'You')).toBe('Discord');
    expect(creatorLabel('Ana Souza', 'user:me', 'You')).toBe('Ana Souza');
    expect(creatorLabel('Username: bob', 'user:me', 'You')).toBe('Username: bob');
    expect(creatorLabel(undefined, 'user:me', 'You')).toBeNull();
  });
});
