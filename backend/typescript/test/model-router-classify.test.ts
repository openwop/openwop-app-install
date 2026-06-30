/**
 * ADR 0130 Phase 4b — intent label parser.
 */
import { describe, it, expect } from 'vitest';
import { parseIntentLabel, INTENTS } from '../src/features/model-router/classifyIntent.js';

describe('parseIntentLabel', () => {
  it('accepts an exact single-word reply', () => {
    expect(parseIntentLabel('code')).toBe('code');
    expect(parseIntentLabel('  MATH  ')).toBe('math');
  });
  it('extracts a known label from chatty output', () => {
    expect(parseIntentLabel('The intent here is clearly code.')).toBe('code');
    expect(parseIntentLabel('This looks like a research question')).toBe('research');
  });
  it('defaults to chat when no known label appears', () => {
    expect(parseIntentLabel('hello there')).toBe('chat');
    expect(parseIntentLabel('')).toBe('chat');
  });
  it('only returns labels in the closed vocabulary', () => {
    expect((INTENTS as readonly string[]).includes(parseIntentLabel('banana'))).toBe(true);
  });
});
