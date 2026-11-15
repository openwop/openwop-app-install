import { describe, it, expect } from 'vitest';
import { runInputsRead, type RunVariable } from '../workflowsClient.js';

/**
 * Issue 5897 — the Run dialog offers a deferred copy's variable only when the
 * definition reads it. A copy made before provider/model were bound per run froze
 * `model` into node config, so its `model` variable is read by nothing, and
 * offering it told people a choice the run then ignored was recorded and used.
 */
const P = 'test_chain_0123456789ab_';
const v = (name: string, required = false): RunVariable => ({ name, required });

function def(nodes: unknown[], metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodes,
    edges: [],
    metadata: { deferredParameterAliases: { topic: `${P}topic`, model: `${P}model`, orgId: `${P}orgId` }, ...metadata },
  };
}

describe('runInputsRead', () => {
  it('drops a deferred variable nothing reads (a frozen model, a frozen orgId)', () => {
    const d = def([{ nodeId: 'n', typeId: 'core.ai.chatCompletion', config: { model: 'claude-sonnet-5-5', orgId: 'org-1' }, inputs: { topic: { type: 'variable', variableName: `${P}topic` } } }]);
    const out = runInputsRead(d, [v(`${P}topic`), v(`${P}model`), v(`${P}orgId`, true)]).map((x) => x.name);
    expect(out).toEqual([`${P}topic`]);
  });

  it('keeps a variable a node config binds, and one a lifted prompt template reads', () => {
    const d = def(
      [{ nodeId: 'n', typeId: 'core.ai.chatCompletion', config: { model: { type: 'variable', variableName: `${P}model` }, systemPromptRef: 'prompt:t@1' } }],
      { mintedPromptTemplates: [{ templateId: 't', text: 'About {{' + `${P}topic` + '}}' }] },
    );
    expect(runInputsRead(d, [v(`${P}topic`), v(`${P}model`), v(`${P}orgId`)]).map((x) => x.name)).toEqual([`${P}topic`, `${P}model`]);
  });

  it('a longer name that starts with the variable does not count as reading it', () => {
    const d = def([{ nodeId: 'n', typeId: 'x', inputs: { a: { type: 'variable', variableName: `${P}modelName` } } }]);
    expect(runInputsRead(d, [v(`${P}model`)])).toEqual([]);
  });

  it('fails open: keeps everything when a prompt ref has no template in the definition, or the copy is not deferred', () => {
    const vars = [v(`${P}topic`), v(`${P}model`)];
    const unseenTemplate = def([{ nodeId: 'n', typeId: 'x', config: { userPromptRef: 'prompt:t@1' } }]);
    expect(runInputsRead(unseenTemplate, vars)).toEqual(vars);
    expect(runInputsRead({ nodes: [], metadata: {} }, vars)).toEqual(vars);
  });

  it('keeps variables that are not deferred-materialized, read or not', () => {
    const d = def([]);
    expect(runInputsRead(d, [v('customerEmail')])).toEqual([v('customerEmail')]);
  });
});
