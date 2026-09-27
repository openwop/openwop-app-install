/**
 * Canvas framework factory tests (ADR 0310 Phase A). The app-builder suites
 * (canvasTree.test / screenOps.test) pin the extracted logic through the
 * app-builder binding; these pin the PARAMETRIZATION — a second, non-app-builder
 * trait config (slides-shaped: `slides` + `items` + `body` keys, no route stamp)
 * must behave identically.
 */
import { describe, expect, it } from 'vitest';
import { treeOps, type TreeNodeBase } from '../treeOps.js';
import { frameOps } from '../frameOps.js';

interface Item extends TreeNodeBase { body?: Item[] }
interface Slide { id: string; name: string; isCover?: boolean; items?: Item[] }
interface Deck { name: string; slides: Slide[] }

const tree = treeOps<Item, Slide>({ rootKey: 'items', childrenKey: 'body' });
const frames = frameOps<Deck, Slide>({
  key: 'slides',
  max: 3,
  homeFlag: 'isCover',
  makeFrame: (id, name) => ({ id, name, items: [] }),
});

const slide = (): Slide => ({
  id: 's1',
  name: 'One',
  items: [
    { type: 'text', props: { text: 'a' } },
    { type: 'group', body: [{ type: 'text', props: { text: 'b' } }] },
  ],
});

describe('treeOps with non-default keys', () => {
  it('addresses, adds, moves, and duplicates through rootKey/childrenKey', () => {
    const s = slide();
    expect(tree.nodeAt(s, [1, 0])?.props?.text).toBe('b');
    tree.addChild(s, [1], { type: 'text', props: { text: 'c' } });
    expect(s.items?.[1]?.body?.length).toBe(2);
    const landed = tree.moveNode(s, [0], [1], 0);
    expect(landed).toEqual([0, 0]);
    expect(s.items?.length).toBe(1);
    expect(s.items?.[0]?.body?.[0]?.props?.text).toBe('a');
    const dup = tree.duplicateAt(s, [0, 0]);
    expect(dup).toEqual([0, 1]);
    tree.setPropAt(s, [0, 1], 'text', 'z');
    expect(s.items?.[0]?.body?.[1]?.props?.text).toBe('z');
    tree.deleteAt(s, [0, 1]);
    expect(s.items?.[0]?.body?.length).toBe(3); // a, b, c remain after the duplicate is removed
  });

  it('refuses a move into the node\'s own subtree', () => {
    const s = slide();
    expect(tree.moveNode(s, [1], [1, 0], 0)).toBeNull();
  });
});

describe('frameOps with a slides-shaped trait', () => {
  it('adds frames with the custom shape and flags the first as home', () => {
    const deck: Deck = { name: 'Deck', slides: [] };
    expect(frames.addFrame(deck, 'Cover')).toBe(0);
    expect(frames.addFrame(deck, 'Body')).toBe(1);
    expect(deck.slides[0]).toMatchObject({ id: 'cover', isCover: true, items: [] });
    expect(deck.slides[1]?.isCover).toBeUndefined();
  });

  it('enforces the max cap and the last-frame delete guard', () => {
    const deck: Deck = { name: 'Deck', slides: [] };
    frames.addFrame(deck, 'a'); frames.addFrame(deck, 'b'); frames.addFrame(deck, 'c');
    expect(frames.addFrame(deck, 'd')).toBe(-1);
    frames.deleteFrame(deck, 2); frames.deleteFrame(deck, 1);
    expect(frames.deleteFrame(deck, 0)).toBe(false);
  });

  it('reassigns the home flag when the home frame is deleted', () => {
    const deck: Deck = { name: 'Deck', slides: [] };
    frames.addFrame(deck, 'a'); frames.addFrame(deck, 'b');
    expect(frames.deleteFrame(deck, 0)).toBe(true);
    expect(deck.slides[0]?.isCover).toBe(true);
  });

  it('duplicates without the home flag and with unique deterministic ids', () => {
    const deck: Deck = { name: 'Deck', slides: [] };
    frames.addFrame(deck, 'Cover');
    const i = frames.duplicateFrame(deck, 0);
    expect(i).toBe(1);
    expect(deck.slides[1]?.id).toBe('cover-copy');
    expect(deck.slides[1]?.isCover).toBeUndefined();
  });

  it('instantiates templates through the content map', () => {
    const deck: Deck = { name: 'Deck', slides: [] };
    const idx = frames.addFrameFromTemplate(deck, { name: 'Quote', content: { items: [{ type: 'text' }] } });
    expect(idx).toBe(0);
    expect(deck.slides[0]?.items?.length).toBe(1);
    expect(deck.slides[0]?.isCover).toBe(true);
  });

  it('setHomeFrame keeps a single home', () => {
    const deck: Deck = { name: 'Deck', slides: [] };
    frames.addFrame(deck, 'a'); frames.addFrame(deck, 'b');
    frames.setHomeFrame(deck, 1);
    expect(deck.slides[0]?.isCover).toBeUndefined();
    expect(deck.slides[1]?.isCover).toBe(true);
  });
});
