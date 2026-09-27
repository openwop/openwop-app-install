/** ADR 0344 2a — the session tree/style clipboard store. */
import { describe, it, expect, beforeEach } from 'vitest';
import { clearTreeClipboards, getStyleClip, getTreeClip, setStyleClip, setTreeClip } from '../treeClipboard.js';

beforeEach(clearTreeClipboards);

describe('treeClipboard', () => {
  it('round-trips a subtree per canvas type', () => {
    const node = { type: 'stack', children: [{ type: 'text', props: { text: 'hi' } }] };
    setTreeClip('canvas.app-builder', node);
    expect(getTreeClip('canvas.app-builder')).toEqual(node);
  });

  it('NEVER crosses canvas types (the closed-world guard)', () => {
    setTreeClip('canvas.app-builder', { type: 'button' });
    expect(getTreeClip('canvas.slides')).toBeNull();
  });

  it('deep-clones on write AND read — a held copy is unreachable', () => {
    const node = { type: 'stack', props: { padding: 'md' } };
    setTreeClip('canvas.app-builder', node);
    node.props.padding = 'MUTATED-AFTER-COPY';
    const first = getTreeClip<typeof node>('canvas.app-builder')!;
    expect(first.props.padding).toBe('md');
    first.props.padding = 'MUTATED-AFTER-PASTE';
    expect(getTreeClip<typeof node>('canvas.app-builder')!.props.padding).toBe('md');
  });

  it('style clip rides beside the node clip, same type keying', () => {
    setStyleClip('canvas.app-builder', { sourceType: 'card', props: { radius: 'lg', shadow: 'md' } });
    expect(getStyleClip('canvas.app-builder')).toEqual({ sourceType: 'card', props: { radius: 'lg', shadow: 'md' } });
    expect(getStyleClip('canvas.slides')).toBeNull();
    expect(getTreeClip('canvas.app-builder')).toBeNull(); // independent stores
  });
});
