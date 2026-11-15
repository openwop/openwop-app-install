import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ConfigInput } from '../ConfigInput.js';
import type { ConfigField } from '../../palette/nodeCatalog.js';

afterEach(cleanup);

/**
 * Issue 5897 — a deferred chain copy binds `provider`/`model` to a run variable.
 * The inspector shows that the value is chosen when the run starts, as read-only
 * text named by its label, instead of a picker with no value whose first change
 * would overwrite the binding.
 */
describe('ConfigInput — a config value bound to a run variable', () => {
  const fields: ConfigField[] = [
    { key: 'provider', label: 'Provider', kind: 'provider-picker' },
    { key: 'model', label: 'Model', kind: 'model-picker', dependsOn: 'provider' },
  ];

  it('renders the binding read-only, with the bare parameter name, and no picker', () => {
    const config = { provider: 'anthropic', model: { type: 'variable', variableName: 'test_chain_0123456789ab_model' } };
    render(<ConfigInput nodeId="n1" config={config} field={fields[1]!} allFields={fields} />);
    const out = screen.getByLabelText('Model');
    expect(out.tagName).toBe('OUTPUT');
    expect(out.textContent).toBe('Set when the run starts (model)');
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
