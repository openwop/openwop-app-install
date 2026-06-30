/**
 * MiniMax-M emits tool calls as inline TEXT (an `<invoke>` block wrapped in `]<]minimax[>[`
 * delimiter noise) instead of structured `tool_calls`. parseInlineToolCalls must extract +
 * execute them and strip the markup. Format captured from a live deployed-demo response.
 */
import { describe, it, expect } from 'vitest';
import { parseInlineToolCalls } from '../src/providers/dispatchProviderTools.js';

const TOOLS = [{ name: 'openwop:feature.code-exec.nodes.run', description: 'run code', inputSchema: { type: 'object' } }];

describe('parseInlineToolCalls (MiniMax inline-text tool calls)', () => {
  it('parses the observed `]<]minimax[>[`-noised <invoke> block', () => {
    const raw = [
      ']<]minimax[>[<tool_call>',
      ']<]minimax[>[<invoke name="feature.code-exec.nodes.run">]<]minimax[>[<parameter',
      'name="code">import sys; print(sys.platform); print(6*7)]<]minimax[>[</parameter>]<]minimax[>',
      '[</invoke>',
      ']<]minimax[>[</tool_call>',
    ].join('\n');
    const { toolUses, cleanedText } = parseInlineToolCalls(raw, TOOLS);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe('openwop:feature.code-exec.nodes.run'); // fuzzy-resolved from the prefix-less emitted name
    expect(toolUses[0].input).toEqual({ code: 'import sys; print(sys.platform); print(6*7)' });
    expect(cleanedText).toBe(''); // markup stripped, nothing leaks
  });

  it('parses a clean <invoke> block (no delimiter noise)', () => {
    const raw = '<tool_call><invoke name="openwop:feature.code-exec.nodes.run"><parameter name="code">print(1)</parameter></invoke></tool_call>';
    const { toolUses, cleanedText } = parseInlineToolCalls(raw, TOOLS);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].input).toEqual({ code: 'print(1)' });
    expect(cleanedText).toBe('');
  });

  it('leaves ordinary text untouched (no false positives)', () => {
    const { toolUses, cleanedText } = parseInlineToolCalls('Here is the answer: 42.', TOOLS);
    expect(toolUses).toHaveLength(0);
    expect(cleanedText).toBe('Here is the answer: 42.');
  });
});
