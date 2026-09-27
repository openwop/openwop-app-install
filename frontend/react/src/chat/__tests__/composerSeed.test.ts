/**
 * composerSeed tests (ADR 0334 5b) — the one-shot staged-draft handoff a surface
 * uses to open the chat with a pre-filled composer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { stageComposerDraft, takeStagedComposerDraft } from '../composerSeed.js';

describe('composerSeed', () => {
  beforeEach(() => { takeStagedComposerDraft(); }); // drain any residue

  it('returns null when nothing is staged', () => {
    expect(takeStagedComposerDraft()).toBeNull();
  });

  it('stages a draft and hands it back exactly once (one-shot)', () => {
    stageComposerDraft('improve this');
    expect(takeStagedComposerDraft()).toBe('improve this');
    expect(takeStagedComposerDraft()).toBeNull();
  });

  it('a later stage replaces an unconsumed one', () => {
    stageComposerDraft('first');
    stageComposerDraft('second');
    expect(takeStagedComposerDraft()).toBe('second');
  });

  it('treats empty text as nothing staged', () => {
    stageComposerDraft('');
    expect(takeStagedComposerDraft()).toBeNull();
  });
});
