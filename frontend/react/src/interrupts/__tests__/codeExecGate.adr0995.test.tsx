/**
 * ADR 0995 D2/D10 — the code-exec approval shows the code, and its result renders as output.
 *
 * Before: the node suspended with `prompt: {title, body}` (an object where this card renders a
 * text child) and named only the language and character count, so the approver approved code
 * they could not see. The gate now carries a `codeExec` evidence block, which the ONE shared
 * `GateEvidence` renders on both cards. And a `code.execution-result` artifact had no renderer,
 * so the workbench showed a JSON blob.
 *
 * (TST) Red when: `gateEvidenceOf` drops `codeExec`, `hasGateEvidence` stops counting it, the
 * code block is removed, the card fetches the gate-preview artifact instead, or the renderer
 * interprets output as markup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, within } from '@testing-library/react';

const art = vi.hoisted(() => ({ getArtifact: vi.fn(), getArtifactRevision: vi.fn() }));
vi.mock('../../chat/artifacts/artifactClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getArtifact: art.getArtifact, getArtifactRevision: art.getArtifactRevision };
});

const { ApprovalCard } = await import('../ApprovalCard.js');
const { hasGateEvidence } = await import('../../chat/reviews/GateEvidence.js');
const { CodeResultRenderer } = await import('../../chat/artifacts/CodeResultRenderer.js');

const CODE = 'import os\nprint("<b>not markup</b>")';

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => cleanup());

describe('ADR 0995 D2 — the code-exec gate shows what it runs', () => {
  const data = {
    prompt: 'Run this python code in the sandbox?',
    actions: ['approve', 'reject'],
    codeExec: { language: 'python', code: CODE, stdinPreview: 'abc', stdinLength: 5_000 },
    artifactId: 'run-event:r:n', revisionId: 'run-event:r:n:1',
  };

  it('counts as evidence and renders the exact code as text, with the truncated stdin', () => {
    expect(hasGateEvidence(data)).toBe(true);
    render(<ApprovalCard runId="r-1" nodeId="run" token="tok" data={data} onResolved={() => {}} />);
    const block = screen.getByTestId('gate-evidence-code');
    expect(within(block).getByText('python')).toBeTruthy();
    expect(block.querySelector('pre code')?.textContent).toBe(CODE);
    expect(block.querySelector('b'), 'node-authored code is text, never markup').toBeNull();
    expect(block.textContent).toContain('3');
    expect(block.textContent).toContain('5000');
    // The evidence IS the code: the gate-preview artifact (port inputs) is never fetched.
    expect(art.getArtifact).not.toHaveBeenCalled();
    expect(screen.queryByTestId('gate-evidence-none')).toBeNull();
  });

  it('a codeExec block missing its code is not evidence (no empty code box)', () => {
    expect(hasGateEvidence({ codeExec: { language: 'python' } })).toBe(false);
  });
});

describe('ADR 0995 D10 — code.execution-result renders as output, not JSON', () => {
  const artifact = { artifactId: 'a', title: 't' } as never;

  it('shows the exit status, stdout and stderr as text', () => {
    render(<CodeResultRenderer artifact={artifact} content={JSON.stringify({ exitCode: 1, stdout: '<i>x</i>\n', stderr: 'Traceback', timedOut: false, language: 'python' })} />);
    const root = screen.getByTestId('code-result');
    expect(root.textContent).toContain('1');
    const pres = root.querySelectorAll('pre code');
    expect(pres[0]?.textContent).toBe('<i>x</i>\n');
    expect(pres[1]?.textContent).toBe('Traceback');
    expect(root.querySelector('i')).toBeNull();
  });

  it('a timeout reads as a timeout, and an unreadable body says so', () => {
    render(<CodeResultRenderer artifact={artifact} content={JSON.stringify({ exitCode: 124, stdout: '', stderr: '', timedOut: true })} />);
    expect(screen.getByTestId('code-result').querySelector('.chip--warning')).toBeTruthy();
    cleanup();
    render(<CodeResultRenderer artifact={artifact} content="not json" />);
    expect(screen.queryByTestId('code-result')).toBeNull();
  });
});
