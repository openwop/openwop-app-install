/**
 * Slash-picker trigger detection (fix: `/` showed no command/workflow menu once
 * an `@agent` was already in the composer).
 */
import { describe, expect, it } from 'vitest';
import { detectSlashTrigger } from '../workflowMentions.js';

describe('detectSlashTrigger', () => {
  it('triggers on a bare/started slash with no prefix', () => {
    expect(detectSlashTrigger('/')).toEqual({ prefix: '', query: '' });
    expect(detectSlashTrigger('/upp')).toEqual({ prefix: '', query: 'upp' });
    expect(detectSlashTrigger('   /upp')).toEqual({ prefix: '', query: 'upp' }); // leading ws ignored
  });

  it('triggers after an @agent hand-off and preserves the prefix', () => {
    expect(detectSlashTrigger('@devon /')).toEqual({ prefix: '@devon ', query: '' });
    expect(detectSlashTrigger('@devon /upp')).toEqual({ prefix: '@devon ', query: 'upp' });
  });

  it('hides in args mode (a space after the query) and for non-slash text', () => {
    expect(detectSlashTrigger('/help search')).toBeNull(); // args mode
    expect(detectSlashTrigger('@devon /upp hello')).toBeNull(); // args mode after hand-off
    expect(detectSlashTrigger('hello')).toBeNull();
    expect(detectSlashTrigger('@devon')).toBeNull(); // mention only, no slash
    expect(detectSlashTrigger('@devon/')).toBeNull(); // needs a space after the agent
  });
});
