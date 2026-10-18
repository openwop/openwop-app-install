/**
 * ADR 0344 2a (CV-04) — the session tree/style clipboard store. What breaks it:
 * a paste crossing canvas types (an app-builder component landing in slides —
 * the closed-world guard), or a held copy reachable by later edits / the paste
 * side (deep clone on write AND read, for BOTH clips).
 */
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

  it('the style clip is deep-cloned on write AND read too', () => {
    const entry = { sourceType: 'card', props: { radius: 'lg' } };
    setStyleClip('canvas.app-builder', entry);
    entry.props.radius = 'MUTATED-AFTER-COPY';
    const got = getStyleClip('canvas.app-builder')!;
    expect(got.props.radius).toBe('lg');
    got.props.radius = 'MUTATED-AFTER-PASTE';
    expect(getStyleClip('canvas.app-builder')!.props.radius).toBe('lg');
  });
});
