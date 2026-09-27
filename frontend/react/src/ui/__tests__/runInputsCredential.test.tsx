/**
 * ADR 0712 Phase 2 — the run form names a stored BYOK key for the run.
 *
 * The chosen key rides `configurable.ai.credentialRef` (which the host checks and
 * registers), and an optional credential variable is dropped from `inputs`: a ref
 * passed as the node's own input hits the dispatcher's EXPLICIT rung, which does
 * not check the provider, so a Google key picked for an Anthropic chain would be
 * sent to Anthropic.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  RunInputsForm,
  bareVariableName,
  isCredentialRefVariable,
  splitRunCredential,
} from '../RunInputsForm.js';
import type { RunVariable } from '../../workflows/workflowsClient.js';

afterEach(cleanup);

const DEFERRED = 'kicktodo_challenge_factory_a2ec352bceed_credentialRef';

describe('credential-ref variables', () => {
  it('recognises the authored name through the RFC 0124 deferred prefix, and nothing else', () => {
    expect(bareVariableName(DEFERRED)).toBe('credentialRef');
    expect(isCredentialRefVariable({ name: DEFERRED, required: false })).toBe(true);
    expect(isCredentialRefVariable({ name: 'credentialRef', type: 'string', required: false })).toBe(true);
    expect(isCredentialRefVariable({ name: 'credentialRefs', required: false })).toBe(false);
    expect(isCredentialRefVariable({ name: 'my_credentialRef', required: false }), 'no hex expansion id ⇒ not deferred').toBe(false);
    expect(isCredentialRefVariable({ name: 'credentialRef', type: 'number', required: false })).toBe(false);
  });
});

describe('splitRunCredential', () => {
  const vars: RunVariable[] = [
    { name: 'topic', type: 'string', required: true },
    { name: DEFERRED, type: 'string', required: false },
  ];

  it('moves an optional picked key OFF the inputs and ONTO configurable.ai.credentialRef', () => {
    expect(splitRunCredential(vars, { topic: 'watercolor', [DEFERRED]: 'byok:google' })).toEqual({
      inputs: { topic: 'watercolor' },
      configurable: { version: 1, ai: { credentialRef: 'byok:google' } },
    });
  });

  it('keeps a REQUIRED credential variable as an input as well — the run cannot start without it', () => {
    const req: RunVariable[] = [{ name: 'credentialRef', type: 'string', required: true }];
    expect(splitRunCredential(req, { credentialRef: 'anthropic:prod' })).toEqual({
      inputs: { credentialRef: 'anthropic:prod' },
      configurable: { version: 1, ai: { credentialRef: 'anthropic:prod' } },
    });
  });

  it('sends nothing for no key, a blank key, or a managed ref (the host refuses managed on this field)', () => {
    expect(splitRunCredential(vars, { topic: 't' })).toEqual({ inputs: { topic: 't' } });
    expect(splitRunCredential(vars, { topic: 't', [DEFERRED]: '  ' })).toEqual({ inputs: { topic: 't', [DEFERRED]: '  ' } });
    expect(splitRunCredential(vars, { topic: 't', [DEFERRED]: 'managed:openwop-free' }))
      .toEqual({ inputs: { topic: 't', [DEFERRED]: 'managed:openwop-free' } });
  });

  it('leaves a workflow with no credential variable untouched', () => {
    const plain: RunVariable[] = [{ name: 'topic', type: 'string', required: true }];
    expect(splitRunCredential(plain, { topic: 't' })).toEqual({ inputs: { topic: 't' } });
  });
});

describe('RunInputsForm credential picker', () => {
  const vars: RunVariable[] = [{ name: DEFERRED, type: 'string', required: false }];

  it('renders a select over the stored key names, with a "workspace default" empty choice', () => {
    render(<RunInputsForm variables={vars} values={{ [DEFERRED]: '' }} onChange={() => {}} credentialRefs={['byok:google', 'anthropic:prod']} />);
    const select = screen.getByLabelText('Credential ref') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect([...select.options].map((o) => o.value)).toEqual(['', 'byok:google', 'anthropic:prod']);
  });

  it('keeps an authored value that is not a stored key visible, so the control never lies about what it submits', () => {
    render(<RunInputsForm variables={vars} values={{ [DEFERRED]: 'google:old' }} onChange={() => {}} credentialRefs={['byok:google']} />);
    const select = screen.getByLabelText('Credential ref') as HTMLSelectElement;
    expect(select.value).toBe('google:old');
  });

  it('falls back to the text field when the stored keys could not be read', () => {
    render(<RunInputsForm variables={vars} values={{ [DEFERRED]: '' }} onChange={() => {}} />);
    expect((screen.getByLabelText('Credential ref') as HTMLElement).tagName).toBe('INPUT');
  });
});
