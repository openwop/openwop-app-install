/**
 * Coverage for `byok/textRedaction.ts` — the flat-string scrub
 * complementing `stripSecretsFromPersisted`. Specifically tests that
 * HITL `comment` and `selectedKey` fields pasted with provider API
 * keys get redacted before they land in the event-log payload at
 * executor.ts resume time.
 *
 * Architect review §2 motivation: a user pastes "approved, here's the
 * key sk-ant-api-XXX in case you need it" into the approval card's
 * COMMENT (OPTIONAL) field. Without `sanitizeFreeTextDeep` on the
 * resume-time event-log write, the raw key ships into the
 * `node.completed` event payload and renders in chat history.
 *
 * Protected (SR-1 free-text secret redaction). What breaks if this goes red:
 * a pasted provider key survives into the durable event log. The array branch
 * of the deep walk and the 32-char hex boundary are each fed a value that only
 * that branch/boundary redacts (wave-61 probes rd-deep-array, rd-hex-boundary).
 */

import { describe, expect, it } from 'vitest';
import { sanitizeFreeText, sanitizeFreeTextDeep } from '../src/byok/textRedaction.js';

describe('sanitizeFreeText', () => {
  it('redacts sk-* prefixed keys', () => {
    expect(sanitizeFreeText('hello sk-ant-api-AAAAAAAAAAAAAAAA world')).toBe('hello sk-*** world');
    expect(sanitizeFreeText('OPENAI sk-proj-1234567890abcdefghij')).toBe('OPENAI sk-***');
  });

  it('redacts xai-* prefixed keys', () => {
    expect(sanitizeFreeText('xai-abcdefghijklmnopqrstuvwxyz123456')).toBe('xai-***');
  });

  it('redacts Bearer * tokens', () => {
    expect(sanitizeFreeText('Authorization: Bearer abc.def.ghi-jkl-mnop'))
      .toBe('Authorization: Bearer ***');
  });

  it('redacts long hex digests', () => {
    expect(sanitizeFreeText('digest=' + 'a'.repeat(40)))
      .toBe('digest=***');
    // The boundary: 32 hex chars is a digest, 31 is not (no other rule matches).
    expect(sanitizeFreeText('f'.repeat(32))).toBe('***');
    expect(sanitizeFreeText('f'.repeat(31))).toBe('f'.repeat(31));
  });

  it('leaves non-secret text alone', () => {
    expect(sanitizeFreeText('approved the clarity critic')).toBe('approved the clarity critic');
    expect(sanitizeFreeText('hex but too short: abc123')).toBe('hex but too short: abc123');
  });
});

describe('sanitizeFreeTextDeep', () => {
  it('walks objects and redacts string leaves', () => {
    const input = {
      action: 'approve',
      content: 'sk-ant-api-AAAAAAAAAAAAAAAAAAA',
      selectedKey: 'Clarity critic',
      comment: 'thanks for the key Bearer abcdefghijklmnopqr',
    };
    const out = sanitizeFreeTextDeep(input) as Record<string, string>;
    expect(out.action).toBe('approve');
    expect(out.selectedKey).toBe('Clarity critic');
    expect(out.content).toBe('sk-***');
    expect(out.comment).toBe('thanks for the key Bearer ***');
  });

  it('handles nested arrays + non-string leaves untouched', () => {
    const input = {
      outputs: {
        output: {
          action: 'approve',
          comment: 'sk-1234567890abcdefghij',
          attempts: 3,
          ok: true,
          choices: ['Clarity critic', 'sk-ABCDEFGHIJKLMNOPQRST'],
          nestedKey: null,
        },
      },
    };
    const out = sanitizeFreeTextDeep(input);
    const inner = (out as { outputs: { output: Record<string, unknown> } }).outputs.output;
    expect(inner.comment).toBe('sk-***');
    expect(inner.attempts).toBe(3);
    expect(inner.ok).toBe(true);
    expect(inner.nestedKey).toBe(null);
    // A secret inside an ARRAY is redacted too (the array branch of the walk).
    expect(inner.choices).toEqual(['Clarity critic', 'sk-***']);
  });

  it('preserves shape — arrays stay arrays, objects keep keys', () => {
    const input = ['plain', { k: 'v' }, ['nested', 'Bearer abcdefghijklmnopqr']];
    const out = sanitizeFreeTextDeep(input);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual(['plain', { k: 'v' }, ['nested', 'Bearer ***']]);
  });

  it('scrubs the HITL resumeValue shape that executor.ts writes to node.completed', () => {
    // Mirrors what executor.ts:780 writes to the node.completed event
    // payload: `{outputs: {output: <resumeValue>}}` where resumeValue is
    // the approval card's `{action, content, selectedKey, comment}` shape.
    const payload = {
      outputs: {
        output: {
          action: 'approve',
          content: 'critique.clarity',
          selectedKey: 'Clarity critic',
          comment: 'Looks good. PS, here is the key sk-ant-api-AAAAAAAAAAAAAAAAAAAA for your reference.',
        },
      },
    };
    const scrubbed = sanitizeFreeTextDeep(payload) as typeof payload;
    expect(scrubbed.outputs.output.comment).not.toContain('sk-ant-api-AAAAAAAAAAAAAAAAAAAA');
    expect(scrubbed.outputs.output.comment).toContain('sk-***');
    // Non-secret fields untouched.
    expect(scrubbed.outputs.output.action).toBe('approve');
    expect(scrubbed.outputs.output.selectedKey).toBe('Clarity critic');
  });
});
